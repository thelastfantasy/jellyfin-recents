# Tasks: Monorepo Restructure

**Input**: Design documents from `specs/010-monorepo-restructure/`
**Prerequisites**: [plan.md](./plan.md) (Stage 1–6), [spec.md](./spec.md) (3×P1 User Stories), [data-model.md](./data-model.md), [contracts/workspace-configs.md](./contracts/workspace-configs.md)

**Tests**: 本 feature 为纯结构迁移，spec 未要求新增测试任务；验证步骤已包含在各 Stage 的 Gate 任务中。

**Organization**: Phase 2（Foundational）= Stage 1 git mv，是所有 US 的前置条件；Phase 3–5 分别对应 US1/US2/US3。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件，无前置依赖）
- **[Story]**: 对应 spec.md 的 User Story（US1/US2/US3）

---

## Phase 1: Setup（准备工作）

**Purpose**: 迁移前扫描，发现并记录所有需要同步修改的旧路径引用

- [ ] T001 扫描旧路径引用：`grep -r "src/player-enhancer\|src/frontend\|src/frame-forge\|src/seek-preview\|src/JellyfinSuite.Plugin\|src/poster-gen" tests/ .mise.toml Makefile .github/` — 记录所有命中行，后续 Stage 逐一修复

---

## Phase 2: Foundational（Stage 1 — git mv）

**Purpose**: 将所有子目录从 `src/` 迁移到目标路径；所有 User Story 实现均依赖此阶段完成

**⚠️ CRITICAL**: 此阶段完成前不得开始任何 User Story 工作  
**Constitution Gate**: 本阶段所有 commit 必须是纯移动（无内容修改，遵循 Principle VII）

- [ ] T002 git rm 追踪的 lock 文件（若存在）：`git rm src/player-enhancer/package-lock.json src/frontend/package-lock.json` — 避免与 pnpm-lock.yaml 并存
- [ ] T003 `git mv src/player-enhancer apps/player-enhancer`
- [ ] T004 [P] `git mv src/frontend apps/frontend`
- [ ] T005 [P] `git mv src/frame-forge crates/frame-forge`
- [ ] T006 [P] `git mv src/seek-preview crates/seek-preview`
- [ ] T007 [P] `git mv src/poster-gen crates/poster-gen`
- [ ] T008 `git mv src/JellyfinSuite.Plugin packages/JellyfinSuite.Plugin`
- [ ] T009 确认 `src/` 目录已空后删除（`rmdir src` 或等价命令）
- [ ] T009b `git rm crates/seek-preview/Cargo.lock crates/frame-forge/Cargo.lock crates/poster-gen/Cargo.lock`（若存在）— 各 crate 的旧 Cargo.lock 在迁入 workspace 后由 repo 根 Cargo.lock 统一管理（FR-018），遗留文件会干扰 workspace lock 管理
- [ ] T010 提交：仅含 git mv + Cargo.lock 删除（移动 commit 与内容修改 commit 分开，Constitution Principle VI+VII）

**Checkpoint**: `src/` 目录已不存在；`apps/`、`crates/`、`packages/` 下各有对应子目录

---

## Phase 3: User Story 1 — 共享 API 类型（Stage 2）(Priority: P1) 🎯 MVP

**Goal**: `packages/api-types/` 成为唯一 OpenAPI 类型来源；两个 app 通过 `@jfs/api-types` 引用；`@jfs/i18n` 提供共享 i18n 工具

**Independent Test**: `pnpm install && pnpm -r build` 两个 app 均编译无 TS 错误；`mise run gen-types` 只写入 `packages/api-types/src/jellyfin-api.ts`

### Implementation

- [ ] T011 [US1] 创建 repo 根 `package.json`（name: `jellyfin-suite`, private: true, packageManager: `pnpm@9`）
- [ ] T012 [US1] 创建 `pnpm-workspace.yaml`（packages: `['apps/*', 'packages/*']`）
- [ ] T013 [P] [US1] 创建 `packages/api-types/package.json`（name: `@jfs/api-types`, exports: `./src/jellyfin-api.ts`）和空占位文件 `packages/api-types/src/jellyfin-api.ts`
- [ ] T014 [P] [US1] 创建 `packages/i18n/package.json`（name: `@jfs/i18n`）和 `packages/i18n/src/index.ts`（实现 `detectLang()` + `createT<T>()` 工厂函数）
- [ ] T015 [US1] 更新 `scripts/gen-plugin-types.mjs` 输出路径 → `packages/api-types/src/jellyfin-api.ts`（删除旧的两条输出路径）
- [ ] T016 [US1] 在 `apps/player-enhancer/package.json` 的 `dependencies` 中加入 `"@jfs/api-types": "workspace:*"` 和 `"@jfs/i18n": "workspace:*"`
- [ ] T017 [P] [US1] 在 `apps/frontend/package.json` 的 `dependencies` 中加入 `"@jfs/api-types": "workspace:*"` 和 `"@jfs/i18n": "workspace:*"`
- [ ] T018 [US1] 在 `apps/player-enhancer/vite.config.ts` 的 `resolve.alias` 中加入 `@jfs/api-types` → `../../packages/api-types/src/jellyfin-api.ts` 和 `@jfs/i18n` → `../../packages/i18n/src/index.ts`
- [ ] T019 [P] [US1] 在 `apps/frontend/vite.config.ts` 的 `resolve.alias` 中加入 `@jfs/api-types` → `../../packages/api-types/src/jellyfin-api.ts` 和 `@jfs/i18n` → `../../packages/i18n/src/index.ts`（路径相对于 `apps/frontend/`）
- [ ] T020 [US1] 更新 `apps/player-enhancer/src/` 中所有从本地类型文件的 import 改为 `from '@jfs/api-types'`；`git rm apps/player-enhancer/src/types/jellyfin-suite-api.ts`
- [ ] T021 [P] [US1] 更新 `apps/frontend/src/` 中所有从本地 jellyfin-api 的 import 改为 `from '@jfs/api-types'`；`git rm apps/frontend/src/jellyfin-api.ts`
- [ ] T022 [US1] 重构 `apps/player-enhancer/src/lib/i18n.ts`：从 `@jfs/i18n` 导入 `createT`，删除本地 `detectLang` 实现，保留 `TRANSLATIONS` 对象
- [ ] T023 [P] [US1] 重构 `apps/frontend/src/i18n/` 相关文件：从 `@jfs/i18n` 导入 `createT`，删除本地 `detectLang` 实现
- [ ] T024 [US1] **Stage 2 验证 Gate**：`pnpm install && pnpm -r build`（两个 app 均无 TS 编译错误）

**Checkpoint**: User Story 1 可独立验证 — `pnpm -r build` 全部通过

---

## Phase 4: User Story 2 — Rust 共享解码器（Stage 3）(Priority: P1)

**Goal**: `crates/jfs-common/` 包含提取的共享代码；`seek-preview` 和 `frame-forge` 通过 `jfs_common::` 引用；单一 `Cargo.lock` 在 repo 根

**Independent Test**: `cargo check -p seek-preview`、`mise run check-frame-forge`、`cargo check -p poster-gen` 均通过（0 errors）

### Implementation

- [ ] T025 [US2] 创建 repo 根 `Cargo.toml`（workspace 根，members: `["crates/jfs-common","crates/frame-forge","crates/seek-preview","crates/poster-gen"]`，resolver = "2"）
- [ ] T026 [US2] 创建 `crates/jfs-common/Cargo.toml`（package name: `jfs-common`；deps: ffmpeg-next 7, lru 0.18, anyhow 1, image 0.25）
- [ ] T027a [US2] `git mv crates/seek-preview/src/decoder.rs crates/jfs-common/src/decoder.rs`（纯移动，单独 commit — Constitution Principle VI）
- [ ] T027b [US2] 对比 `crates/frame-forge/src/decoder.rs` 与 `crates/jfs-common/src/decoder.rs` 差异，将 frame-forge 的差异合并入 `crates/jfs-common/src/decoder.rs`，形成统一版本（内容修改 commit，与 T027a 分开 — Constitution Principle VII）
- [ ] T028 [P] [US2] `git mv crates/seek-preview/src/disk_cache.rs crates/jfs-common/src/disk_cache.rs`（可与 T027a 并行；T027b 依赖 T027a 完成后单独提交）
- [ ] T029 [US2] 从 `crates/seek-preview/src/server.rs` 提取 `compute_frame_idx` 等帧号计算函数到 `crates/jfs-common/src/fps_utils.rs`
- [ ] T030 [US2] 创建 `crates/jfs-common/src/lib.rs`：`pub mod decoder; pub mod disk_cache; pub mod fps_utils;` 和对应 `pub use`
- [ ] T031 [US2] 更新 `crates/seek-preview/Cargo.toml`：加 `jfs-common = { path = "../jfs-common" }`，移除已迁入 jfs-common 的重复 deps
- [ ] T032 [P] [US2] 更新 `crates/frame-forge/Cargo.toml`：加 `jfs-common = { path = "../jfs-common" }`，删除本地 `decoder.rs`/`disk_cache.rs` 的对应依赖
- [ ] T033 [US2] 更新 `crates/seek-preview/src/`：将所有 `mod decoder`/`mod disk_cache` 声明改为 `use jfs_common::{decode_and_encode, DiskCache, compute_frame_idx}` 等；**同时删除 `crates/seek-preview/src/server.rs` 中 `compute_frame_idx` 的原函数定义**（T029 已提取到 fps_utils.rs，保留会导致双定义编译失败）
- [ ] T034 [P] [US2] 更新 `crates/frame-forge/src/`：同上，删除本地 `decoder.rs`/`disk_cache.rs` 文件（`git rm`）
- [ ] T035 [US2] **Gate**：`cargo check -p seek-preview`（0 errors）
- [ ] T036 [P] [US2] **Gate**：`mise run check-frame-forge`（Docker 内含 OpenCV feature，0 errors）
- [ ] T037 [P] [US2] **Gate**：`cargo check -p poster-gen`（0 errors）

**Checkpoint**: User Story 2 可独立验证 — 3 个 cargo check 全部通过

---

## Phase 5: User Story 3 — mise 任务保持可用（Stages 4–5）(Priority: P1)

**Goal**: `mise run update`、`mise run test`、`mise run gen-types` 等任务在迁移后继续可用；Docker build 挂载 repo 根；CI workflow 无路径错误

**Independent Test**: `mise run build-seek-preview && mise run build-frame-forge`（Docker 构建成功）；`mise run test`（Rust + TS + C# 全通过）

### Implementation

- [ ] T038 [US3] 更新 `Makefile` 的 `build-seek-preview` 目标：`-v` 挂载改为 repo 根（`$(CURDIR)` 而非 `$(CURDIR)/src/seek-preview`），构建命令改为 `cargo build -p seek-preview --release`
- [ ] T039 [P] [US3] 更新 `Makefile` 的 `build-frame-forge` 目标：同上，`cargo build -p frame-forge --release`
- [ ] T040 [US3] 更新 `Makefile` 中 `cp` 路径：`target/release/seek-preview → packages/JellyfinSuite.Plugin/seek-preview-linux-x64`；`target/release/frame-forge → packages/JellyfinSuite.Plugin/frame-forge-linux-x64`
- [ ] T041 [US3] 更新 `.mise.toml`：将所有旧路径引用（`src/player-enhancer` → `apps/player-enhancer`，`src/frontend` → `apps/frontend`，`gen-types` 输出路径等）全部替换
- [ ] T042 [US3] 更新 `.github/workflows/` 中所有旧路径引用为新路径（player-enhancer、frontend、seek-preview、frame-forge、JellyfinSuite.Plugin）
- [ ] T043 [P] [US3] 更新 `.github/workflows/`：将 `npm ci` → `pnpm install --frozen-lockfile`，`npm run` → `pnpm run`（或 `pnpm exec`）
- [ ] T043b [US3] **Stage 5 CI 验证 Gate**：`mise run workflow-test`（需本地安装 `act` 工具；如不可用，推送后在 GitHub Actions 上验证 SC-005 — CI 无路径错误、无 npm 残留）
- [ ] T044 [US3] **Stage 4 验证 Gate**：`mise run build-seek-preview && mise run build-frame-forge`（需 Docker Desktop 运行，两个 Docker build 均成功）

**Checkpoint**: User Story 3 可独立验证 — Docker build 成功（T044）；CI workflow 路径无报错（T043b）

---

## Phase 6: Polish & Integration（Stage 6）

**Purpose**: 全套集成验证，收尾清理

- [ ] T045 更新 `.gitignore`：追加 `target/`（Cargo workspace 根产物）和根目录 `node_modules/`
- [ ] T046 **集成 Gate**：`mise run test`（全套测试：Rust `cargo test` + TS `bun test` + C# `dotnet test`，无新增失败）
- [ ] T047 更新 `CLAUDE.md` 中的 plan 指向：从 `specs/009-frame-export-stitch/` 改为 `specs/010-monorepo-restructure/plan.md`
- [ ] T048 **部署 Gate**（需用户确认）：`mise run update` — 部署到 `jellyfin-dev` 容器，重启成功，功能与迁移前一致

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: 无依赖，立即开始
- **Phase 2 (Foundational)**: 依赖 Phase 1 完成 — 阻塞所有 User Story
- **Phase 3 (US1)**: 依赖 Phase 2 完成
- **Phase 4 (US2)**: 依赖 Phase 2 完成（可与 Phase 3 并行）
- **Phase 5 (US3)**: 依赖 Phase 3 + Phase 4 完成
- **Phase 6 (Polish)**: 依赖 Phase 5 完成

### User Story Dependencies

- **US1 (P1)**: Phase 2 完成后可开始 — 不依赖 US2
- **US2 (P1)**: Phase 2 完成后可开始 — 不依赖 US1（可与 US1 并行）
- **US3 (P1)**: US1 + US2 均完成后开始 — 依赖两者（Docker/CI 路径依赖最终目录结构）

### Within Each Phase

- git mv 操作应在同一 commit（T003–T009 → T010 commit）
- 新建 package.json/Cargo.toml 先于依赖它们的 import 修改
- cargo check 先于 build（Constitution requirement）
- mise run test 先于 mise run update（CLAUDE.md 部署规范）

### Parallel Opportunities

- T003–T009b（git mv + Cargo.lock 清理）：T004–T007 可并行（不同目录）；T009b 顺序执行于 T003–T009 之后
- T013–T014（新建共享包）：可并行
- T016–T017（app package.json 更新）：可并行
- T018–T019（vite.config.ts 更新）：可并行
- T020–T021（import 迁移）：可并行
- T022–T023（i18n 重构）：可并行
- T027a + T028（decoder.rs 与 disk_cache.rs git mv）：可并行；T027b（内容合并）串行在 T027a 之后
- T031–T032, T033–T034（Cargo 双 crate 更新）：成对并行
- T035–T037（cargo check 验证）：三个可并行
- T038–T039（Makefile Docker 更新）：可并行
- T042–T043（workflow 路径更新）：可并行

---

## Parallel Example: Phase 3（US1）

```
# 2a: workspace 基础设施（串行）
T011 → T012

# 2b+2c: 两个共享包同时创建（并行）
T013 (api-types)  ||  T014 (i18n)

# 2b+2c: 两个 app 的 package.json（并行）
T016 (player-enhancer)  ||  T017 (frontend)

# 2b+2c: 两个 app 的 vite.config.ts（并行）
T018 (player-enhancer)  ||  T019 (frontend)

# 2b: import 迁移 + 旧文件删除（并行）
T020 (player-enhancer)  ||  T021 (frontend)

# 2c: i18n 重构（并行）
T022 (player-enhancer)  ||  T023 (frontend)

# 验证（串行等待所有并行完成）
T024: pnpm install && pnpm -r build
```

## Parallel Example: Phase 4（US2）

```
# 串行：workspace 根 + jfs-common 骨架
T025 → T026

# 并行：decoder.rs + disk_cache.rs 同时 git mv（纯移动，各自独立文件）
T027a (decoder.rs git mv)  ||  T028 (disk_cache.rs git mv)

# 串行：decoder.rs 内容合并（必须在 T027a 完成后，单独 commit）
T027b (合并 frame-forge 差异)

# 串行：fps_utils 提取、lib.rs
T029 → T030

# 并行：两个 crate 的 Cargo.toml 更新
T031 (seek-preview)  ||  T032 (frame-forge)

# 并行：两个 crate 的 use 语句更新
T033 (seek-preview)  ||  T034 (frame-forge)

# 并行：三个 cargo check
T035  ||  T036  ||  T037
```

---

## Implementation Strategy

### MVP First（User Story 1 Only）

1. Complete Phase 1: Setup（T001）
2. Complete Phase 2: Foundational（T002–T010）— CRITICAL
3. Complete Phase 3: US1（T011–T024）
4. **STOP and VALIDATE**: `pnpm -r build` 通过
5. 可演示共享类型功能

### Incremental Delivery

1. Phase 1+2 → git mv 完成（Foundation）
2. Phase 3（US1）→ TS 共享包验证通过
3. Phase 4（US2）→ Cargo workspace + jfs-common 验证通过
4. Phase 5（US3）→ Docker + CI 更新验证通过
5. Phase 6 → 全套集成验证，部署

### Constitution Compliance

每个 Phase 完成时对应 Gate：

| Phase | Gate 命令 | 对应 Principle |
|-------|-----------|----------------|
| Phase 2 | git log（确认 move-only commit） | VI + VII |
| Phase 3 | `pnpm install && pnpm -r build` | III + V |
| Phase 4 | `cargo check -p {seek-preview,frame-forge,poster-gen}` | III + V |
| Phase 5 | `mise run build-seek-preview && mise run build-frame-forge` + `mise run workflow-test` | IV + V |
| Phase 6 | `mise run test` → `mise run update`（确认后） | III + IV |

---

## Notes

- [P] tasks = 不同文件，无前置依赖，可并行执行
- [Story] 标签对应 spec.md 中的 User Story，便于独立追踪
- `mise run check-frame-forge` = Docker 内 `cargo check -p frame-forge`（含 OpenCV feature）
- `mise run update` 是破坏性操作，**必须获得用户确认**后执行
- Stage 1 的 git mv commit 必须单独提交（Constitution Principle VI + VII）
- 每次 Rust 修改后先 check（`cargo check -p <crate>`），0 errors 后再 build
