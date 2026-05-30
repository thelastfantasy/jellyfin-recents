# Implementation Plan: Monorepo Restructure

**Branch**: `feature/009-frame-export-stitch` | **Date**: 2026-05-30 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/010-monorepo-restructure/spec.md`

## Summary

将项目从多个独立的 npm 包 + 独立 Cargo crate 改造为 **pnpm workspace + Cargo workspace** 双体系 monorepo：
- **TS 侧**：新建 `@jfs/shared` 包，将当前双写的 `jellyfin-api.ts` 合并为单一来源，两个 app 通过 workspace 引用
- **Rust 侧**：新建 `jfs-common` crate，提取 `decoder.rs`、`disk_cache.rs`、`fps_utils.rs` 共享逻辑，两个 daemon 改为依赖共享 crate
- 不改任何业务逻辑，不改 HTTP API，不改 C# 代码

## Technical Context

**Language/Version**: Rust 1.88 (crates), TypeScript 5.7 (apps), C# .NET 9 (plugin)  
**Primary Dependencies**: pnpm 9 (workspace), Cargo workspace, Vite 6/8, ffmpeg-next 7  
**Storage**: N/A（此 feature 为结构重组，无新存储）  
**Testing**: bun test (frontend), cargo test (Rust), dotnet test (C#)  
**Target Platform**: Windows 开发环境，Linux 构建（Docker）  
**Project Type**: monorepo 工程改造（无新功能）  
**Performance Goals**: N/A（结构重组不影响运行时性能）  
**Constraints**: 改造过程不中断现有功能；`mise run test` 全通过  
**Scale/Scope**: 5 个源码包（2 TS app + 1 TS shared + 2 Rust crate + 1 Rust shared）

## Constitution Check

Constitution 文件尚未填写（模板状态），跳过 gate 检查。

## Project Structure

### Documentation (this feature)

```text
specs/010-monorepo-restructure/
├── plan.md              # 本文件
├── research.md          # Phase 0: 架构决策记录
├── data-model.md        # Phase 1: 目录结构与配置文件结构
├── contracts/
│   └── workspace-configs.md  # 包名约定、API 边界、Docker 挂载合约
└── tasks.md             # Phase 2 output（/speckit-tasks 生成）
```

### Source Code（迁移后布局）

```text
jellyfin-recents/                    ← repo 根
├── package.json                     ← NEW: pnpm workspace 根
├── pnpm-workspace.yaml              ← NEW
├── pnpm-lock.yaml                   ← NEW（替换子包 package-lock.json）
│
└── src/
    ├── Cargo.toml                   ← NEW: Cargo workspace 根
    ├── Cargo.lock                   ← NEW（合并两个独立 lock）
    ├── target/                      ← (gitignore)
    │
    ├── JellyfinSuite.Plugin/        ← 不变
    ├── poster-gen/                  ← 不变（不入 workspace）
    │
    ├── crates/                      ← NEW namespace
    │   ├── jfs-common/              ← NEW crate（共享逻辑）
    │   ├── seek-preview/            ← 原 src/seek-preview/
    │   └── frame-forge/             ← 原 src/frame-forge/
    │
    ├── packages/                    ← NEW namespace
    │   └── shared/                  ← NEW package（@jfs/shared）
    │
    └── apps/                        ← NEW namespace
        ├── player-enhancer/         ← 原 src/player-enhancer/
        └── frontend/                ← 原 src/frontend/
```

**Structure Decision**: 混合型 — repo 根为 pnpm workspace 根，`src/` 为 Cargo workspace 根；C# 保持在 `src/JellyfinSuite.Plugin/`，不移动。

## Complexity Tracking

> 无 constitution 违规。

---

## Phase 0: Research（已完成）

→ 见 [research.md](./research.md)

核心决策已全部确认：
- pnpm workspace 根在 repo 根 ✅
- Cargo workspace 根在 `src/` ✅
- 共享 TS 仅 `jellyfin-api.ts` ✅
- 共享 Rust：decoder + disk_cache + fps_utils ✅
- Docker build 挂载 `src/`，用 `-p <crate>` 构建 ✅
- poster-gen 暂不迁移 ✅

---

## Phase 1: Design（已完成）

→ 见 [data-model.md](./data-model.md) 和 [contracts/workspace-configs.md](./contracts/workspace-configs.md)

---

## Implementation Phases（供 /speckit-tasks 分解）

### Stage 1: pnpm workspace + @jfs/shared（TypeScript 侧）

1. 在 repo 根创建 `package.json` + `pnpm-workspace.yaml`
2. 用 `git mv` 移动 `src/player-enhancer` → `src/apps/player-enhancer`
3. 用 `git mv` 移动 `src/frontend` → `src/apps/frontend`
4. 创建 `src/packages/shared/`，迁入 `jellyfin-api.ts`
5. 两个 app 的 `package.json` 加 `@jfs/shared` 依赖
6. 两个 app 中的 import 路径从本地 `./jellyfin-api` → `@jfs/shared`
7. 删除两个 app 内的旧 `jellyfin-api.ts`
8. 更新 `scripts/gen-plugin-types.mjs` 输出路径
9. 更新 `.mise.toml` 中的路径引用
10. 验证：`pnpm install && pnpm -r build`

### Stage 2: Cargo workspace + jfs-common（Rust 侧）

1. 创建 `src/Cargo.toml`（workspace 根）
2. 用 `git mv` 移动 `src/frame-forge` → `src/crates/frame-forge`
3. 用 `git mv` 移动 `src/seek-preview` → `src/crates/seek-preview`
4. 创建 `src/crates/jfs-common/`，提取共享代码：
   - `decoder.rs`（从 seek-preview 提取，合并 frame-forge 差异）
   - `disk_cache.rs`（从 seek-preview 提取）
   - `fps_utils.rs`（从 server.rs 提取 `compute_frame_idx`）
5. 更新 `seek-preview` + `frame-forge` 的 `Cargo.toml`，加 jfs-common 依赖
6. 替换两个 crate 内的本地 `decoder.rs`、`disk_cache.rs`，改为 `use jfs_common::...`
7. 验证：在 `src/` 目录 `cargo check -p seek-preview && cargo check -p frame-forge`

### Stage 3: Docker build 适配

1. 更新 `make build-seek-preview`：挂载 `src/` → `/workspace`，`cargo build -p seek-preview`
2. 更新 `make build-frame-forge`：挂载 `src/` → `/workspace`，`cargo build -p frame-forge`
3. 更新产物 `cp` 路径：`src/target/release/...` → `src/JellyfinSuite.Plugin/...`
4. 验证：`mise run build-seek-preview && mise run build-frame-forge`

### Stage 4: CI/CD 适配

1. 搜索 `.github/workflows/` 中所有旧路径引用，替换为新路径
2. 替换 `npm ci` / `npm run` → `pnpm install --frozen-lockfile` / `pnpm ...`
3. 验证：`mise run workflow-test`（本地 act 运行 workflow）

### Stage 5: 完整集成验证

1. `mise run test`（全套测试通过）
2. `mise run update`（部署到 jellyfin-dev，功能验证）
3. 更新 `CLAUDE.md` 中的 plan 指向（从 009 → 010）
4. 更新 `.gitignore`（加 `src/target/`）

---

## 关键约束提醒

- 每个 Stage 完成后运行对应验证命令，不得跳过
- Rust 每次修改后先 `cargo check`，通过后再 build
- TS 每次修改后先 `tsc --noEmit`，通过后再 build
- Stage 3（Docker build）需要 Docker Desktop 运行中
- Stage 4 需要 `mise run workflow-test` 需要 `act` 工具（已在 `.mise.toml` 中配置）
