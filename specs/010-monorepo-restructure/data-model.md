# Data Model: Monorepo Restructure

## 目录结构（迁移后）

```
jellyfin-recents/                    ← repo 根
├── package.json                     ← NEW: pnpm workspace 根
├── pnpm-lock.yaml                   ← NEW: 替换各子包的 package-lock.json
├── pnpm-workspace.yaml              ← NEW: workspaces 声明
├── .gitignore                       ← 追加: src/target/, node_modules/
├── Makefile                         ← 更新: Docker 挂载路径, cp 路径
├── .mise.toml                       ← 更新: gen-types 路径
├── scripts/                         ← 不变
│   └── gen-plugin-types.mjs         ← 更新: 输出路径改为 shared 包
├── specs/                           ← 不变
├── tests/                           ← 不变
│
└── src/
    ├── Cargo.toml                   ← NEW: Cargo workspace 根
    ├── Cargo.lock                   ← NEW: 单一 workspace lock（替换两个子包的）
    ├── target/                      ← NEW (gitignore): workspace 共享 target
    │
    ├── JellyfinSuite.Plugin/        ← 不变（C# 插件）
    │
    ├── poster-gen/                  ← 不变（独立 Rust，暂不入 workspace）
    │
    ├── crates/                      ← NEW namespace（原 src/{crate}/）
    │   ├── jfs-common/              ← NEW: 共享 Rust crate
    │   │   ├── Cargo.toml
    │   │   └── src/
    │   │       ├── lib.rs
    │   │       ├── decoder.rs       ← 从 seek-preview 提取
    │   │       ├── disk_cache.rs    ← 从 seek-preview 提取
    │   │       └── fps_utils.rs     ← 从 server.rs 提取
    │   │
    │   ├── seek-preview/            ← 原 src/seek-preview/（迁移）
    │   │   ├── Cargo.toml           ← 更新: + jfs-common dep，移除 decoder/disk_cache
    │   │   └── src/
    │   │       ├── main.rs
    │   │       ├── protocol.rs
    │   │       └── server.rs        ← 移除本地 decoder/disk_cache，改为 use jfs_common::
    │   │
    │   └── frame-forge/             ← 原 src/frame-forge/（迁移）
    │       ├── Cargo.toml           ← 更新: + jfs-common dep，移除 decoder/disk_cache
    │       └── src/
    │           ├── main.rs
    │           ├── animate.rs
    │           ├── scene_classifier.rs
    │           ├── quality.rs
    │           ├── protocol.rs
    │           ├── server.rs        ← 改为 use jfs_common::
    │           └── cli.rs
    │
    ├── packages/                    ← NEW namespace
    │   └── shared/                  ← NEW: @jfs/shared
    │       ├── package.json         ← name: "@jfs/shared"
    │       └── src/
    │           └── jellyfin-api.ts  ← 唯一来源（gen-types 写这里）
    │
    └── apps/                        ← NEW namespace（原 src/{app}/）
        ├── player-enhancer/         ← 原 src/player-enhancer/（迁移）
        │   ├── package.json         ← 更新: + "@jfs/shared": "workspace:*"，移除本地 jellyfin-api.ts
        │   └── src/
        │       ├── injector.ts
        │       ├── frame-export.ts
        │       ├── screenshot.ts
        │       ├── i18n.ts
        │       ├── ...
        │       └── jellyfin-api.ts  ← DELETE（改用 @jfs/shared）
        │
        └── frontend/                ← 原 src/frontend/（迁移）
            ├── package.json         ← 更新: + "@jfs/shared": "workspace:*"，移除本地 jellyfin-api.ts
            └── src/
                ├── jellyfin-api.ts  ← DELETE（改用 @jfs/shared）
                ├── api-types.ts     ← 按需: 若内容属于 shared，迁移；若局部则保留
                └── ...
```

---

## 配置文件结构

### `package.json`（repo 根，新建）

```json
{
  "name": "jellyfin-suite",
  "private": true,
  "packageManager": "pnpm@9"
}
```

### `pnpm-workspace.yaml`（repo 根，新建）

```yaml
packages:
  - 'src/apps/*'
  - 'src/packages/*'
```

### `src/packages/shared/package.json`（新建）

```json
{
  "name": "@jfs/shared",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./src/jellyfin-api.ts"
  }
}
```

### `src/Cargo.toml`（新建 workspace 根）

```toml
[workspace]
resolver = "2"
members = [
    "crates/jfs-common",
    "crates/frame-forge",
    "crates/seek-preview",
]
```

### `src/crates/jfs-common/Cargo.toml`（新建）

```toml
[package]
name = "jfs-common"
version = "0.1.0"
edition = "2021"

[dependencies]
ffmpeg-next = { version = "7", default-features = false, features = ["codec", "format", "software-scaling"] }
lru = "0.18"
anyhow = "1"
image = "0.25"
```

### `src/crates/seek-preview/Cargo.toml`（更新）

移除：`ffmpeg-next`（通过 jfs-common 传递），`decoder.rs` 内联依赖  
新增：`jfs-common = { path = "../jfs-common" }`

### `src/crates/frame-forge/Cargo.toml`（更新）

移除：本地 `decoder.rs`、`disk_cache.rs` 对应依赖  
新增：`jfs-common = { path = "../jfs-common" }`

---

## API 类型共享路径

**变更前**:
```
scripts/gen-plugin-types.mjs
  → src/player-enhancer/src/jellyfin-api.ts  (copy 1)
  → src/frontend/src/jellyfin-api.ts          (copy 2)
```

**变更后**:
```
scripts/gen-plugin-types.mjs
  → src/packages/shared/src/jellyfin-api.ts   (唯一来源)

player-enhancer: import type { ... } from '@jfs/shared'
frontend:        import type { ... } from '@jfs/shared'
```

---

## 状态迁移（不涉及实体状态，仅文件位置）

| 原路径 | 新路径 | 操作 |
|--------|--------|------|
| `src/player-enhancer/` | `src/apps/player-enhancer/` | git mv |
| `src/frontend/` | `src/apps/frontend/` | git mv |
| `src/frame-forge/` | `src/crates/frame-forge/` | git mv |
| `src/seek-preview/` | `src/crates/seek-preview/` | git mv |
| `src/seek-preview/src/decoder.rs` | `src/crates/jfs-common/src/decoder.rs` | git mv（并合并内容） |
| `src/seek-preview/src/disk_cache.rs` | `src/crates/jfs-common/src/disk_cache.rs` | git mv |
| `server.rs` 中的 `compute_frame_idx` | `src/crates/jfs-common/src/fps_utils.rs` | 提取 |
| `src/player-enhancer/src/jellyfin-api.ts` | `src/packages/shared/src/jellyfin-api.ts` | git mv（或重新生成） |
| `src/frontend/src/jellyfin-api.ts` | ← 同上（删除，使用 shared） | git rm |
