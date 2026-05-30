# Feature Specification: Monorepo Restructure

**Feature Branch**: `feature/009-frame-export-stitch`
**Created**: 2026-05-30
**Status**: Draft
**Input**: 将项目改造为 pnpm workspace + Cargo workspace 双体系 monorepo，消除 TypeScript 类型双写问题，提取 Rust 可复用代码为共享 crate，统一构建入口。

## Clarifications

### Session 2026-05-30

- Q: pnpm workspace 根在哪里（repo 根 vs `src/`）？  
  A: **repo 根**。根 `package.json` 指向 `src/apps/*` 和 `src/packages/*`；`src/` 内的 TS 目录重组但相对 repo 根的路径只变一层（`src/player-enhancer` → `src/apps/player-enhancer`）。

- Q: Cargo workspace 根在哪里？  
  A: **`src/Cargo.toml`**（workspace members = `crates/*`）。Rust crate 从 `src/{crate}` 移到 `src/crates/{crate}`，C# 不变（仍在 `src/JellyfinSuite.Plugin/`）。

- Q: 共享 TS 包的内容边界是什么？  
  A: **仅 `jellyfin-api.ts`**（OpenAPI 生成的类型，目前双写）。i18n 两套系统域不同，不合并。共享包名 `@jfs/shared`，放在 `src/packages/shared/`。

- Q: 共享 Rust crate (`jfs-common`) 包含什么？  
  A: `decoder.rs`（`decode_and_encode` FFmpeg 函数）、`disk_cache.rs`（磁盘 KV 缓存）、`fps_utils.rs`（`compute_frame_idx` 等帧号计算工具）。两个 daemon 都依赖，不在 jfs-common 内放 daemon/protocol 逻辑。

- Q: Docker 构建如何适配 Cargo workspace？  
  A: 挂载 `src/` 而不是 `src/crates/frame-forge`；在容器内用 `cargo build -p frame-forge --release`。现有 Docker volume（`seek-cargo-home`、`forge-cargo-home`）合并为单个 `rust-cargo-home`，因为 workspace 共享 `~/.cargo` 和 `target/`。

- Q: `gen-types` 脚本如何适配 monorepo？  
  A: 生成目标由两处改为一处（`src/packages/shared/src/jellyfin-api.ts`）；两个 app 通过 workspace 依赖 `@jfs/shared` 引用该类型。脚本本身不需大改，只更新输出路径。

- Q: C# `.csproj` 中对 Rust 二进制的引用路径是否需要改变？  
  A: 不需要。C# 只引用 **编译产物**（`poster-gen-linux-x64`、`seek-preview-linux-x64`、`frame-forge-linux-x64`），这些产物仍然从 Docker 容器内 `cp` 到 `src/JellyfinSuite.Plugin/` 目录，C# 代码不感知源码目录变化。

- Q: 是否需要改变 `poster-gen`？  
  A: 不需要立即迁移。`poster-gen` 是独立 Rust 工具，与 `seek-preview`/`frame-forge` 没有共享代码需求，保留在 `src/poster-gen/` 不变，不加入 Cargo workspace（或可以加入但不提取共享 crate）。

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

根 `package.json` 声明 `workspaces`，pnpm 在 `node_modules/@jfs/shared` 创建符号链接指向本地包。各 app 的 `package.json` 加入 `"@jfs/shared": "workspace:*"` 依赖即可引用，无需发布到 npm。Vite 构建时自动 bundle 共享包内容。

### Cargo workspace 工作原理

根（或 `src/`） `Cargo.toml` 声明 `[workspace]`，所有 member crate 共享同一个 `target/` 目录和 `Cargo.lock`。各 crate 通过 `jfs-common = { path = "../jfs-common" }` 引用本地 crate，无需发布到 crates.io。Docker build 需要将整个 workspace 挂载进容器，用 `cargo build -p <crate>` 只编译目标 crate（依赖自动解析到共享 crate）。

### Docker build 变更影响

当前：每个 crate 独立挂载，各自有 `Cargo.lock`，各自有 Docker volume
```
-v "$$(cygpath -m $(CURDIR))/src/seek-preview:/workspace"
```

改造后：挂载 `src/` 整个目录（含 workspace `Cargo.toml` + 所有 crate）
```
-v "$$(cygpath -m $(CURDIR))/src:/workspace"
-w /workspace/crates/seek-preview
cargo build -p seek-preview --release  # 或 cargo build --release（在 crate 目录）
```

Docker volume 合并对构建时间没有负面影响（cargo cache 在 `~/.cargo/registry`，与 workspace 结构无关）。`target/` 目录位于 workspace 根（`src/target/`），需要加入 `.gitignore`。

---

## User Scenarios & Testing

### User Story 1 - 开发者：零感知地引用共享 API 类型 (Priority: P1)

开发者修改 C# DTO 后，运行 `mise run gen-types`，两个 TS app 无需任何额外操作即自动使用最新类型。

**Acceptance Scenarios**:
1. **Given** C# DTO 修改并重新部署，**When** `mise run gen-types` 执行后，**Then** `src/packages/shared/src/jellyfin-api.ts` 被更新，且两个 app 的编译不需要额外的文件操作
2. **Given** player-enhancer 引用 `@jfs/shared`，**When** `npm run build`（或 pnpm build），**Then** 共享类型被正确 bundle 到输出 JS
3. **Given** 开发者删除旧的双写文件（`src/player-enhancer/src/jellyfin-api.ts` 和 `src/frontend/src/jellyfin-api.ts`），**When** 两个 app 分别构建，**Then** 无 TS 编译错误

### User Story 2 - 开发者：Rust daemon 复用共享解码器 (Priority: P1)

修改 `decoder.rs` 的共享解码逻辑后，两个 daemon 自动获得更新，无需手动同步。

**Acceptance Scenarios**:
1. **Given** 修改 `src/crates/jfs-common/src/decoder.rs`，**When** `mise run check-seek-preview` 和 `mise run check-frame-forge`，**Then** 两者均通过（0 errors）
2. **Given** Cargo workspace 已配置，**When** 在 `src/` 目录执行 `cargo check -p frame-forge`，**Then** 自动解析 `jfs-common` 依赖，不需要发布到 crates.io
3. **Given** frame-forge 和 seek-preview 都依赖 `jfs-common`，**When** 执行 Docker build，**Then** Docker 容器内挂载 `src/` 后可成功构建

### User Story 3 - 开发者：原有 mise 任务全部保持可用 (Priority: P1)

改造前后，`mise run build`、`mise run update`、`mise run test` 等所有任务行为不变，只是内部路径调整。

**Acceptance Scenarios**:
1. **Given** 完成 monorepo 改造，**When** `mise run update`，**Then** 容器成功部署，功能与改造前一致
2. **Given** 改造完成，**When** `mise run test`，**Then** 全套测试（Rust + TS + C#）通过，无新增失败
3. **Given** 改造完成，**When** `mise run gen-types`，**Then** 只生成一个 `jellyfin-api.ts` 文件（在 shared 包内），两个 app 自动可用

---

## Requirements

### Functional Requirements

**目录结构重组**
- **FR-001**: `src/player-enhancer/` MUST 移动到 `src/apps/player-enhancer/`
- **FR-002**: `src/frontend/` MUST 移动到 `src/apps/frontend/`
- **FR-003**: `src/frame-forge/` MUST 移动到 `src/crates/frame-forge/`
- **FR-004**: `src/seek-preview/` MUST 移动到 `src/crates/seek-preview/`
- **FR-005**: 新建 `src/crates/jfs-common/`（Rust 共享 crate）
- **FR-006**: 新建 `src/packages/shared/`（TS 共享包，`@jfs/shared`）
- **FR-007**: `src/JellyfinSuite.Plugin/` 和 `src/poster-gen/` MUST 保持原路径不变

**pnpm workspace**
- **FR-008**: 在 repo 根新建 `package.json` 声明 `workspaces: ["src/apps/*", "src/packages/*"]`
- **FR-009**: `src/packages/shared/package.json` 声明 `name: "@jfs/shared"`，导出 `src/jellyfin-api.ts`
- **FR-010**: 两个 app 的 `package.json` MUST 加入 `"@jfs/shared": "workspace:*"` 依赖
- **FR-011**: `gen-types` 脚本输出路径 MUST 改为 `src/packages/shared/src/jellyfin-api.ts`（从两个路径合并为一个）
- **FR-012**: 两个 app 中现有的 `src/jellyfin-api.ts` 文件 MUST 删除，import 改为从 `@jfs/shared` 引用
- **FR-013**: 两个 app 的 `api-types.ts`（若有）MUST 按需合并到 shared 包或保留局部（按实际依赖决定）

**Cargo workspace**
- **FR-014**: 新建 `src/Cargo.toml`（workspace 根），members = `["crates/jfs-common", "crates/frame-forge", "crates/seek-preview"]`（`poster-gen` 可选加入，低优先级）
- **FR-015**: `src/crates/jfs-common/` MUST 包含从两个 daemon 提取的共享代码：`decoder.rs`、`disk_cache.rs`、`fps_utils.rs`
- **FR-016**: `frame-forge` 和 `seek-preview` 的 `Cargo.toml` MUST 替换本地重复实现，改为 `jfs-common = { path = "../jfs-common" }` 依赖
- **FR-017**: 两个 crate 内原有的 `decoder.rs` 和 `disk_cache.rs` MUST 删除，改为 `use jfs_common::...`
- **FR-018**: 单一 `src/Cargo.lock`（workspace 级，取代两个独立的 Cargo.lock）

**Docker 构建适配**
- **FR-019**: `make build-seek-preview` 和 `make build-frame-forge` 的 Docker `docker run -v` 挂载目标 MUST 从 `src/{crate}` 改为 `src`（整个 workspace）
- **FR-020**: Docker 容器内工作目录 MUST 改为 workspace 根，用 `cargo build -p {crate} --release` 构建目标 crate
- **FR-021**: Docker volume 可合并为单个 `rust-cargo-home`（可选，减少 volume 管理），或保留现有多个 volume（不影响正确性）
- **FR-022**: 构建产物 cp 路径不变（仍从 `target/release/` 复制到 `src/JellyfinSuite.Plugin/`）；注意 workspace 时 `target/` 在 `src/target/`，cp 路径需相应调整

**CI/CD 适配**
- **FR-023**: `.github/workflows/` 中所有引用旧路径的地方（`src/player-enhancer`、`src/frontend`、`src/frame-forge`、`src/seek-preview`）MUST 更新为新路径
- **FR-024**: `mise run test` 任务 MUST 在改造后继续通过（无新增测试失败）

**向后兼容**
- **FR-025**: C# 代码（`SeekPreviewService.cs`、`FrameExportService.cs` 等）引用 Rust 二进制名称（`seek-preview-linux-x64`、`frame-forge-linux-x64`）MUST 不变
- **FR-026**: 所有 HTTP API 端点、DTO 结构 MUST 不变（纯结构重组，不改功能）

---

## Success Criteria

- **SC-001**: `src/packages/shared/src/jellyfin-api.ts` 为唯一类型来源；两个 app 构建成功，无重复文件
- **SC-002**: `cargo check -p frame-forge` 和 `cargo check -p seek-preview` 均通过（0 errors），两者都通过 `jfs-common` 引用共享代码
- **SC-003**: `mise run update` 完整构建并部署到 `jellyfin-dev` 容器后，功能验证通过（seek-preview daemon、frame-forge daemon、截图、帧步进、帧导出均正常）
- **SC-004**: `mise run test` 全通过（无新增失败）
- **SC-005**: `.github/workflows/` CI 通过（build + test workflow 无路径错误）
- **SC-006**: `src/target/` 加入 `.gitignore`；`node_modules/` 在根（pnpm hoisted）不入 git

## Assumptions

- pnpm 已在开发环境可用（取代当前的 npm/bun per-package 模式）
- 改造过程中不修改任何业务逻辑（纯结构迁移）
- `poster-gen` 暂不加入 Cargo workspace（无共享需求，降低改造范围）
- `tests/` 目录结构可能需要随 app 路径变化做小幅调整（frontend tests 已引用 `../../tests/frontend/`）
