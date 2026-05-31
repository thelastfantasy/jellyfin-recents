# Feature Specification: Monorepo Restructure

**Feature Branch**: `feature/009-frame-export-stitch`
**Created**: 2026-05-30
**Status**: Draft
**Input**: 将项目改造为 pnpm workspace + Cargo workspace 双体系 monorepo，消除 TypeScript 类型双写问题，提取 Rust 可复用代码为共享 crate，统一构建入口。

## Clarifications

### Session 2026-05-31

- Q: `@jfs/api-types` 导出原始 `.ts` 文件，Vite 能否仅靠 pnpm workspace 符号链接解析，还是必须加显式 alias？ → A: 始终加 alias（vite.config.ts 必改，不依赖符号链接解析的可靠性）
- Q: `tsc --noEmit` 解析 `@jfs/api-types` 是否需要在 `tsconfig.json` 加 `paths` 映射？ → A: 不需要，仅依赖 pnpm workspace 符号链接（`node_modules/@jfs/api-types`），不手写 paths
- Q: `poster-gen` 加入 Cargo workspace 后，是否要求全 workspace `cargo check`（无 `-p`）通过？ → A: 否，只用 `-p` 逐 crate 检查；`poster-gen` 单独 `cargo check -p poster-gen`，不纳入 CI 必须通过项
- Q: `tests/` 中是否有引用旧路径的配置需要在迁移前确认？ → A: 是，Stage 1 前先 `grep` 扫描 tests/ 中的旧路径引用，发现即修复，不推迟到 Stage 6
- Q: 各 app 内旧的 `package-lock.json` 和 `node_modules/` 如何处理？ → A: Stage 1a 扫描时一并删除（`git rm` 追踪的 lock 文件 + 手动清理 node_modules/），再执行 git mv，避免 npm/pnpm 混存

### Session 2026-05-30

- Q: pnpm workspace 根在哪里？  
  A: **repo 根**。`pnpm-workspace.yaml` 声明 `apps/*`（TS 应用）和 `packages/*`（TS 共享库），两类成员角色明确分开。

- Q: Cargo workspace 根在哪里？  
  A: **repo 根 `Cargo.toml`**（workspace members = `crates/*`）。Rust crate 从 `src/{crate}` 移到 `crates/{crate}`，C# 从 `src/JellyfinSuite.Plugin/` 移到 repo 根 `JellyfinSuite.Plugin/`。整个旧 `src/` 目录删除。

- Q: 共享 TS 包的内容边界是什么？  
  A: 拆为两个专职包：
  - **`@jfs/api-types`**（`packages/api-types/`）：`jellyfin-api.ts`，OpenAPI 生成类型，目前双写。
  - **`@jfs/i18n`**（`packages/i18n/`）：i18n 工具层——`detectLang()` + `createT<T>()` 工厂函数；两个 app 翻译内容域不同，各自维护翻译对象，调用 `createT()` 得到类型安全的 `t()`。

- Q: 共享 Rust crate (`jfs-common`) 包含什么？  
  A: `decoder.rs`（`decode_and_encode` FFmpeg 函数）、`disk_cache.rs`（磁盘 KV 缓存）、`fps_utils.rs`（`compute_frame_idx` 等帧号计算工具）。两个 daemon 都依赖，不在 jfs-common 内放 daemon/protocol 逻辑。

- Q: Docker 构建如何适配 Cargo workspace？  
  A: 挂载 **repo 根**（Cargo workspace 根）；在容器内用 `cargo build -p frame-forge --release`。`target/` 在 repo 根，加入 `.gitignore`。

- Q: `gen-types` 脚本如何适配 monorepo？  
  A: 生成目标由两处改为一处（`packages/api-types/src/jellyfin-api.ts`）；两个 app 通过 workspace 依赖 `@jfs/api-types` 引用该类型。

- Q: C# `.csproj` 引用路径是否需要改变？  
  A: 不需要。C# 只引用 **编译产物**（二进制文件），产物仍从 Docker 内 `cp` 到 `JellyfinSuite.Plugin/`，C# 代码不感知源码目录变化。

- Q: 是否需要改变 `poster-gen`？  
  A: `poster-gen` 从 `src/poster-gen/` 移到 repo 根 `poster-gen/`（随其他目录一并移出 `src/`），但不加入 Cargo workspace（无共享需求）。

## Research

### 当前重复代码分析

**TypeScript 双写**:
| 文件 | player-enhancer | frontend | 说明 |
|------|--------------|---------|------|
| `jellyfin-api.ts` | ✅ | ✅ | 完全相同，由 `gen-types` 双写 |

**Rust 可共享代码**:
| 模块 | seek-preview | frame-forge | 可提取 |
|------|------------|------------|-------|
| `decoder.rs` | ✅（`decode_and_encode`）| ✅（同函数签名） | ✅ |
| `disk_cache.rs` | ✅（`DiskCache` struct）| ✅（同结构） | ✅ |
| fps 计算 | `compute_frame_idx` in server.rs | 内联 | ✅ |

**共享 Rust 依赖**:
- `ffmpeg-next = "7"` — 两者都有
- `lru = "0.18"` — 两者都有
- `anyhow = "1"` — 两者都有

### pnpm workspace 工作原理

repo 根 `pnpm-workspace.yaml` 声明 `apps/*` 和 `packages/*`。pnpm 在 `node_modules/@jfs/api-types` 创建符号链接指向本地包，各 app 的 `package.json` 加入 `"@jfs/api-types": "workspace:*"` 即可引用，无需发布到 npm。

### Cargo workspace 工作原理

repo 根 `Cargo.toml` 声明 `[workspace]`，members 为 `crates/*`，所有 member crate 共享同一个 `target/` 和 `Cargo.lock`。各 crate 通过 `jfs-common = { path = "../jfs-common" }` 引用本地 crate。

pnpm 与 Cargo 两套 workspace 完全独立——各自在 repo 根配置，互不干扰，正是业界混合语言 monorepo 的标准实践（参考 Rspack、Turbo 等工具链）。

### Docker build 变更影响

当前：每个 crate 独立挂载  
```
-v "$$(cygpath -m $(CURDIR))/src/seek-preview:/workspace"
```

改造后：挂载 repo 根
```
-v "$$(cygpath -m $(CURDIR)):/workspace"
cargo build -p seek-preview --release
```

---

## User Scenarios & Testing

### User Story 1 - 开发者：零感知地引用共享 API 类型 (Priority: P1)

**Acceptance Scenarios**:
1. **Given** C# DTO 修改并重新部署，**When** `mise run gen-types` 执行后，**Then** `packages/api-types/src/jellyfin-api.ts` 被更新，且两个 app 的编译不需要额外的文件操作
2. **Given** player-enhancer 引用 `@jfs/api-types`，**When** `pnpm build`，**Then** 共享类型被正确 bundle 到输出 JS
3. **Given** 开发者删除旧的双写文件，**When** 两个 app 分别构建，**Then** 无 TS 编译错误

### User Story 2 - 开发者：Rust daemon 复用共享解码器 (Priority: P1)

**Acceptance Scenarios**:
1. **Given** 修改 `crates/jfs-common/src/decoder.rs`，**When** `mise run check-seek-preview` 和 `mise run check-frame-forge`，**Then** 两者均通过（0 errors）
2. **Given** Cargo workspace 已配置，**When** 在 repo 根执行 `cargo check -p frame-forge`，**Then** 自动解析 `jfs-common` 依赖
3. **Given** frame-forge 和 seek-preview 都依赖 `jfs-common`，**When** 执行 Docker build，**Then** 挂载 repo 根后可成功构建

### User Story 3 - 开发者：原有 mise 任务全部保持可用 (Priority: P1)

**Acceptance Scenarios**:
1. **Given** 完成 monorepo 改造，**When** `mise run update`，**Then** 容器成功部署，功能与改造前一致
2. **Given** 改造完成，**When** `mise run test`，**Then** 全套测试（Rust + TS + C#）通过，无新增失败
3. **Given** 改造完成，**When** `mise run gen-types`，**Then** 只生成一个 `jellyfin-api.ts` 文件（在 `packages/api-types/` 内），两个 app 自动可用

---

## Requirements

### Functional Requirements

**目录结构重组**
- **FR-001**: `src/player-enhancer/` MUST 移动到 `apps/player-enhancer/`
- **FR-002**: `src/frontend/` MUST 移动到 `apps/frontend/`
- **FR-003**: `src/frame-forge/` MUST 移动到 `crates/frame-forge/`
- **FR-004**: `src/seek-preview/` MUST 移动到 `crates/seek-preview/`
- **FR-005**: 新建 `crates/jfs-common/`（Rust 共享 crate）
- **FR-006**: 新建 `packages/api-types/`（TS OpenAPI 类型包，`@jfs/api-types`）
- **FR-006b**: 新建 `packages/i18n/`（TS i18n 工具包，`@jfs/i18n`）
- **FR-007**: `src/JellyfinSuite.Plugin/` 移到 `packages/JellyfinSuite.Plugin/`；`src/poster-gen/` 移到 `crates/poster-gen/`（加入 Cargo workspace）；旧 `src/` 目录完全删除
- **FR-007b**: 移动后相关 Makefile、mise.toml、workflow 内路径引用 MUST 全部更新

**pnpm workspace**
- **FR-008**: 在 repo 根新建/更新 `package.json`；新建 `pnpm-workspace.yaml` 声明 `packages: ["apps/*", "packages/*"]`
- **FR-009**: `packages/api-types/package.json` 声明 `name: "@jfs/api-types"`，导出 `src/jellyfin-api.ts`
- **FR-009b**: `packages/i18n/package.json` 声明 `name: "@jfs/i18n"`，导出 `detectLang()` 和 `createT<T>()` 工厂函数
- **FR-010**: 两个 app 的 `package.json` MUST 加入 `"@jfs/api-types": "workspace:*"` 和 `"@jfs/i18n": "workspace:*"` 依赖
- **FR-010b**: 两个 app 的 `vite.config.ts` MUST 加入 `@jfs/api-types` 和 `@jfs/i18n` 的显式 alias（不得仅依赖 pnpm workspace 符号链接解析——因 Vite 处理 TypeScript 源文件时 `exports` 字段解析不稳定）
- **FR-011**: `gen-types` 脚本输出路径 MUST 改为 `packages/api-types/src/jellyfin-api.ts`
- **FR-012**: 两个 app 中现有的 OpenAPI 类型文件 MUST 删除（player-enhancer: `src/types/jellyfin-suite-api.ts`；frontend: `src/jellyfin-api.ts`），import 改为从 `@jfs/api-types` 引用
- **FR-013**: 两个 app 的 `i18n.ts` MUST 重构：从 `@jfs/i18n` 导入 `createT()`，保留各自翻译对象，移除重复的 `detectLang()` 实现

**Cargo workspace**
- **FR-014**: 新建 repo 根 `Cargo.toml`（workspace 根），members = `["crates/jfs-common", "crates/frame-forge", "crates/seek-preview", "crates/poster-gen"]`
- **FR-015**: `crates/jfs-common/` MUST 包含从两个 daemon 提取的共享代码：`decoder.rs`、`disk_cache.rs`、`fps_utils.rs`
- **FR-016**: `frame-forge` 和 `seek-preview` 的 `Cargo.toml` MUST 替换本地重复实现，改为 `jfs-common = { path = "../jfs-common" }` 依赖
- **FR-017**: 两个 crate 内原有的 `decoder.rs` 和 `disk_cache.rs` MUST 删除，改为 `use jfs_common::...`
- **FR-018**: 单一 `Cargo.lock`（repo 根，取代两个独立的 Cargo.lock）

**Docker 构建适配**
- **FR-019**: Docker `docker run -v` 挂载目标 MUST 改为 repo 根（整个 workspace）
- **FR-020**: Docker 容器内工作目录 MUST 改为 repo 根，用 `cargo build -p {crate} --release`
- **FR-021**: Docker volume 可合并为单个 `rust-cargo-home`（可选）
- **FR-022**: 构建产物 cp 路径更新：`target/release/{bin}` → `packages/JellyfinSuite.Plugin/{bin}-linux-x64`

**CI/CD 适配**
- **FR-023**: `.github/workflows/` 中所有引用旧路径的地方 MUST 更新为新路径
- **FR-024**: `mise run test` 任务 MUST 在改造后继续通过

**向后兼容**
- **FR-025**: C# 代码引用 Rust 二进制名称（`seek-preview-linux-x64`、`frame-forge-linux-x64`）MUST 不变
- **FR-026**: 所有 HTTP API 端点、DTO 结构 MUST 不变

---

## Success Criteria

- **SC-001**: `packages/api-types/src/jellyfin-api.ts` 为唯一 OpenAPI 类型来源；`packages/i18n/` 为唯一 i18n 工具实现；两个 app 构建成功，无重复文件
- **SC-002**: `cargo check -p frame-forge` 和 `cargo check -p seek-preview` 均通过（0 errors）；`poster-gen` 单独执行 `cargo check -p poster-gen` 通过，不要求全 workspace 无参 `cargo check`
- **SC-003**: `mise run update` 完整构建并部署到 `jellyfin-dev` 容器后功能验证通过
- **SC-004**: `mise run test` 全通过（无新增失败）
- **SC-005**: `.github/workflows/` CI 通过（无路径错误）
- **SC-006**: `target/` 加入 `.gitignore`；`node_modules/` 在根不入 git；旧 `src/` 目录不存在

## Assumptions

- pnpm 已在开发环境可用
- 改造过程中不修改任何业务逻辑（纯结构迁移）
- `tests/` 目录结构可能需要随 app 路径变化做小幅调整
