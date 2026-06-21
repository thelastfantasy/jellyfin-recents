# Research: Monorepo Restructure

## Decision 1: pnpm workspace 根位置

**Decision**: repo 根（不是 `src/`）

**Rationale**: 根 `package.json` 统一管理所有 TS workspace，scripts/、mise.toml、Makefile 等工具文件已在 repo 根，pnpm hoisted `node_modules/` 也应在根。

**Alternatives considered**:
- `src/` 作为 workspace 根：pnpm 的 `node_modules/` 会在 `src/` 下，与 C# `.csproj` 同级，路径引用混乱；排除。

---

## Decision 2: Cargo workspace 根位置

**Decision**: `src/Cargo.toml`（不是 repo 根）

**Rationale**: 所有 Rust crate 都在 `src/` 下，以 `src/` 为 workspace 根使 members 路径简洁（`crates/jfs-common`）；repo 根没有 Rust 代码，放根 `Cargo.toml` 会与 C# 混在一起。

**Alternatives considered**:
- 根 `Cargo.toml`：members 路径需写 `src/crates/*`，Docker 挂载变成整个 repo 根；排除。

---

## Decision 3: TS 共享包内容

**Decision**: 只放 `jellyfin-api.ts`（OpenAPI 生成类型），不合并 i18n

**Rationale**: 两个 app 的 i18n 域完全不同（player-enhancer = 播放器控件，frontend = 配置页表单），合并后共享包变成杂货铺。`jellyfin-api.ts` 是真正重复的内容（由同一个脚本双写），是 monorepo 解决的核心痛点。

**Alternatives considered**:
- 合并 i18n：语言检测机制也不同（navigator.language vs Jellyfin 设置），合并需引入运行时统一层，成本远超收益；排除。
- 合并所有 TS 工具函数：目前无重复工具函数，YAGNI；排除。

---

## Decision 4: Rust jfs-common 内容边界

**Decision**: `decoder.rs`（`decode_and_encode`）、`disk_cache.rs`（`DiskCache`）、`fps_utils.rs`（`compute_frame_idx`）

**Rationale**: 这三个模块在两个 crate 中完全相同或高度相似，提取后各 crate 删除本地副本，不再维护两份。Protocol 处理、server 逻辑、daemon-specific 调度等不入 jfs-common（各 crate 专有）。

**Shared API surface (jfs-common)**:
```rust
pub use decoder::decode_and_encode;  // (path, pos_ms, width) -> (Vec<u8>, i64, i64, i64)
pub use disk_cache::DiskCache;       // read/write/exists/list_cached
pub use fps_utils::compute_frame_idx; // (pts_ms, fps_num, fps_den) -> i64
```

---

## Decision 5: Docker build 适配策略

**Decision**: 挂载 `src/`（workspace 根），用 `-w /workspace/crates/{crate}` + `cargo build --release`

**Rationale**: Cargo workspace 要求整个 workspace 在容器内可见（共享 `Cargo.lock` + `jfs-common` 源码）。挂载单个 crate 目录会导致 `path = "../jfs-common"` 解析失败。

**Docker volume 策略**: 保留两个独立 volume（`seek-cargo-home`、`forge-cargo-home`），避免两个 crate 的 Docker build 争抢同一 volume；两个 build 分别对应 `~/.cargo`，workspace 共享 `target/` 不是问题（在 volume 之外的挂载目录内）。

**Build 产物路径变化**:
- 旧：`src/seek-preview/target/release/seek-preview`
- 新：`src/target/release/seek-preview`（workspace target 在根）

---

## Decision 6: poster-gen 处理

**Decision**: 暂不加入 Cargo workspace，保留 `src/poster-gen/` 原路径

**Rationale**: `poster-gen` 与 `frame-forge`/`seek-preview` 无共享代码需求，独立性强；加入 workspace 只增加复杂度，不带来收益。未来若有共享需求可随时加入。

---

## Decision 7: pnpm vs npm/bun

**Decision**: 迁移到 pnpm（workspace 模式下的标准选择）

**Rationale**: pnpm workspace 是 monorepo TS 的事实标准；hoisting 策略优于 npm workspaces（幻影依赖更少）；frontend 目前用 bun 跑测试，`bun test` 命令不依赖包管理器，可以保留。

**Migration cost**: 现有 `package-lock.json`（npm） → `pnpm-lock.yaml`（pnpm），需要 `pnpm install` 重新生成，并在 CI 中替换 `npm ci` 为 `pnpm install --frozen-lockfile`。

---

## Shared Decoder API Surface

**jfs-common 的 `decoder.rs` 函数签名**（提取自两者一致的实现）：

```rust
/// 解码 path 文件在 pos_ms 处的帧，缩放到 width 宽，返回 JPEG bytes + pts_ms + fps_num + fps_den
pub fn decode_and_encode(
    path: &str,
    pos_ms: i64,
    width: u32,
) -> anyhow::Result<(Vec<u8>, i64, i64, i64)>
```

两个 crate 的当前实现应该已经是相同的（从 seek-preview 移植到 frame-forge），提取时选取 seek-preview 版本为基准。

---

## Migration Risk Assessment

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| Docker build 路径错误导致 cargo 找不到 workspace | 中 | 高 | 迁移后立即运行 `mise run check-seek-preview` 验证 |
| pnpm workspace 符号链接在 Vite bundle 时未正确解析 | 低 | 中 | Vite 5 + 6 对 workspace symlinks 有内建支持；`resolve.preserveSymlinks: false`（默认）即可 |
| TypeScript `paths` 配置需要更新 | 中 | 低 | tsconfig.json 加入 `@jfs/shared` paths 或通过 pnpm workspace 自动解析 |
| CI workflow 路径引用遗漏 | 中 | 中 | 所有 `src/player-enhancer`、`src/frontend`、`src/frame-forge`、`src/seek-preview` 在 workflow 文件中全局搜索替换 |
| `tests/frontend/` 相对路径失效 | 低 | 低 | frontend `package.json` 的 test script 路径从 `../../tests/frontend/` 改为 `../../../tests/frontend/` |
