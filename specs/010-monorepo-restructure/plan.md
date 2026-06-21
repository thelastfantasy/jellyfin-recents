# Implementation Plan: Monorepo Restructure

**Branch**: `feature/009-frame-export-stitch` | **Date**: 2026-05-30 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/010-monorepo-restructure/spec.md`

## Summary

将项目从多个独立的 npm 包 + 独立 Cargo crate 改造为 **pnpm workspace + Cargo workspace** 双体系 monorepo：
- **TS 侧**：新建 `@jfs/api-types` + `@jfs/i18n` 两个共享包，两个 TS app 通过 workspace 引用
- **Rust 侧**：新建 `jfs-common` crate，提取 `decoder.rs`、`disk_cache.rs`、`fps_utils.rs` 共享逻辑
- **目录**：消除顶级 `src/` 包装，`apps/`（TS 应用）+ `packages/`（TS 共享库）+ `crates/`（Rust）均在 repo 根；`Cargo.toml` 与 `package.json` 同级
- 不改任何业务逻辑，不改 HTTP API，不改 C# 代码

## Technical Context

**Language/Version**: Rust 1.88 (crates), TypeScript 5.7 (apps), C# .NET 9 (plugin)  
**Primary Dependencies**: pnpm 9 (workspace), Cargo workspace, Vite 6/8, ffmpeg-next 7  
**Storage**: N/A（此 feature 为结构重组，无新存储）  
**Testing**: bun test (frontend), cargo test (Rust), dotnet test (C#)  
**Target Platform**: Windows 开发环境，Linux 构建（Docker）  
**Project Type**: monorepo 工程改造（无新功能）  
**Constraints**: 改造过程不中断现有功能；`mise run test` 全通过  
**Scale/Scope**: 2 TS apps + 2 TS shared packages + 3 Rust crates（2 daemon + 1 shared）

## Constitution Check

*基于 constitution v1.0.0*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. No Functionality Loss | ✅ | 纯结构迁移，HTTP API / 二进制名称 / C# DTO 均不变 |
| II. Structural Invariance | ✅ | CSS/import 顺序不触碰，仅移动文件位置 |
| III. Test Gate | ✅ | 每 Stage 末尾 `mise run test` 通过方可继续 |
| IV. Build Gate | ✅ | `mise run update` + GitHub workflow 通过为 Stage 完成条件 |
| V. Incremental Verification | ✅ | 各 Stage 均定义独立验证命令，不跳跃 |
| VI. Git History Preservation | ✅ | 所有移动用 `git mv`，移动 commit 与内容修改 commit 分开 |
| VII. Structure/Logic Separation | ✅ | 本 feature 无业务逻辑变更，全为结构迁移 |

---

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
├── Cargo.toml                       ← NEW: Cargo workspace 根
├── Cargo.lock                       ← NEW
├── package.json                     ← NEW/更新: pnpm workspace 根
├── pnpm-workspace.yaml              ← NEW: apps/*, packages/*
├── pnpm-lock.yaml                   ← NEW
│
├── apps/                            ← NEW: TS 应用（pnpm workspace members）
│   ├── player-enhancer/             ← 原 src/player-enhancer/
│   └── frontend/                    ← 原 src/frontend/
│
├── packages/                        ← NEW: TS 共享库 + C# 插件（pnpm workspace members + 非 member）
│   ├── api-types/                   ← NEW: @jfs/api-types
│   ├── i18n/                        ← NEW: @jfs/i18n
│   └── JellyfinSuite.Plugin/        ← 原 src/JellyfinSuite.Plugin/（pnpm 忽略，无 package.json）
│
├── crates/                          ← NEW: Cargo workspace members（全部 Rust）
│   ├── jfs-common/                  ← NEW: 共享 Rust crate
│   ├── seek-preview/                ← 原 src/seek-preview/
│   ├── frame-forge/                 ← 原 src/frame-forge/
│   └── poster-gen/                  ← 原 src/poster-gen/
│
└── （src/ 目录完全删除）
```

**Structure Decision**:
- pnpm workspace: `apps/*`（应用）+ `packages/*`（共享库），两类角色明确分开
- Cargo workspace: `crates/*`，与 pnpm 完全独立，同在 repo 根
- 无顶级 `src/` 目录

---

## Phase 0: Research（已完成）

→ 见 [research.md](./research.md)

核心决策：
- pnpm workspace 根在 repo 根，`apps/*` + `packages/*` ✅
- Cargo workspace 根在 repo 根（`Cargo.toml`），`crates/*` ✅
- 共享 TS：`@jfs/api-types` + `@jfs/i18n` ✅
- 共享 Rust：decoder + disk_cache + fps_utils → `jfs-common` ✅
- Docker build 挂载 repo 根，用 `-p <crate>` 构建 ✅
- 旧 `src/` 目录完全删除 ✅

---

## Phase 1: Design（已完成）

→ 见 [data-model.md](./data-model.md) 和 [contracts/workspace-configs.md](./contracts/workspace-configs.md)

---

## Implementation Phases（供 /speckit-tasks 分解）

### Stage 1: 目录搬迁（git mv）

**1a. 迁移前扫描 & 清理**
1. `grep -r "src/player-enhancer\|src/frontend\|src/frame-forge\|src/seek-preview\|src/JellyfinSuite.Plugin\|src/poster-gen" tests/ .mise.toml Makefile .github/` — 记录所有旧路径引用，全部同步修复后再执行 git mv
2. `git rm src/player-enhancer/package-lock.json src/frontend/package-lock.json`（如存在）— 删除 npm lock 文件，避免与 pnpm-lock.yaml 并存
3. 手动删除 `src/player-enhancer/node_modules/` 和 `src/frontend/node_modules/`（已在 .gitignore，无需 git rm）

**1b. git mv**
1. `git mv src/player-enhancer apps/player-enhancer`
2. `git mv src/frontend apps/frontend`
3. `git mv src/frame-forge crates/frame-forge`
4. `git mv src/seek-preview crates/seek-preview`
5. `git mv src/poster-gen crates/poster-gen`
6. `git mv src/JellyfinSuite.Plugin packages/JellyfinSuite.Plugin`
7. 确认 `src/` 目录已空，删除之

### Stage 2: pnpm workspace + @jfs/api-types + @jfs/i18n（TypeScript 侧）

**2a. workspace 基础设施**
1. 在 repo 根新建/更新 `package.json`（name: "jellyfin-suite", private: true）
2. 新建 `pnpm-workspace.yaml`（packages: `['apps/*', 'packages/*']`）

**2b. @jfs/api-types（OpenAPI 类型包）**
3. 创建 `packages/api-types/`，含 `package.json`（name: `@jfs/api-types`）和空 `src/jellyfin-api.ts`
4. 两个 app 的 `package.json` 加 `"@jfs/api-types": "workspace:*"` 依赖
5. 更新 `scripts/gen-plugin-types.mjs` 输出路径 → `packages/api-types/src/jellyfin-api.ts`
6. player-enhancer：import 改为 `@jfs/api-types`，删除 `src/types/jellyfin-suite-api.ts`
7. frontend：import 改为 `@jfs/api-types`，删除 `src/jellyfin-api.ts`

**2c. @jfs/i18n（i18n 工具包）**
8. 创建 `packages/i18n/`，含 `package.json`（name: `@jfs/i18n`）和 `src/index.ts`，导出 `detectLang()` + `createT<T>()`
9. 两个 app 的 `package.json` 加 `"@jfs/i18n": "workspace:*"` 依赖
10. player-enhancer `lib/i18n.ts`：import `{ createT }` from `@jfs/i18n`，删除本地 `detectLang` 实现
11. frontend `i18n/`：同上改造

**2d. 收尾**
12. 更新 `.mise.toml` 中所有旧路径引用（`src/player-enhancer` → `apps/player-enhancer` 等）
13. 若 Vite 需要别名，在 `vite.config.ts` 中加 `@jfs/api-types` 和 `@jfs/i18n` alias（`../../packages/...`）
14. 验证：`pnpm install && pnpm -r build`（两个 app 均 TS 无报错）

### Stage 3: Cargo workspace + jfs-common（Rust 侧）

1. 创建 repo 根 `Cargo.toml`（workspace 根）
2. 创建 `crates/jfs-common/`，提取共享代码：
   - `decoder.rs`（从 seek-preview 提取，合并 frame-forge 差异）
   - `disk_cache.rs`（从 seek-preview 提取）
   - `fps_utils.rs`（从 server.rs 提取 `compute_frame_idx`）
3. 更新 `crates/seek-preview/Cargo.toml`，加 `jfs-common = { path = "../jfs-common" }`
4. 更新 `crates/frame-forge/Cargo.toml`，加 `jfs-common = { path = "../jfs-common" }`
5. 替换两个 crate 内的本地 `decoder.rs`、`disk_cache.rs`，改为 `use jfs_common::...`
6. 验证：在 repo 根 `cargo check -p seek-preview && cargo check -p frame-forge`

### Stage 4: Docker build 适配

1. 更新 `make build-seek-preview`：挂载 repo 根 → `/workspace`，`cargo build -p seek-preview`
2. 更新 `make build-frame-forge`：挂载 repo 根 → `/workspace`，`cargo build -p frame-forge`
3. 更新产物 `cp` 路径：`target/release/...` → `packages/JellyfinSuite.Plugin/...`
4. 验证：`mise run build-seek-preview && mise run build-frame-forge`

### Stage 5: CI/CD 适配

1. 搜索 `.github/workflows/` 中所有旧路径引用，替换为新路径
2. 替换 `npm ci` / `npm run` → `pnpm install --frozen-lockfile` / `pnpm ...`
3. 验证：`mise run workflow-test`

### Stage 6: 完整集成验证

1. `mise run test`（全套测试通过）
2. `mise run update`（部署到 jellyfin-dev，功能验证）
3. 更新 `CLAUDE.md` 中的 plan 指向（从 009 → 010）
4. 更新 `.gitignore`（加 `target/`，`node_modules/` 在根）

---

## 关键约束提醒

- 每个 Stage 完成后运行对应验证命令，不得跳过
- Rust 每次修改后先 `cargo check`，通过后再 build
- TS 每次修改后先 `tsc --noEmit`，通过后再 build
- Stage 4（Docker build）需要 Docker Desktop 运行中
- Stage 5 需要 `mise run workflow-test` 需要 `act` 工具
