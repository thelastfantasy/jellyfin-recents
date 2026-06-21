# Data Model: Monorepo Restructure

## 目录结构（迁移后）

```
jellyfin-recents/                    ← repo 根（仅配置文件）
├── Cargo.toml                       ← NEW: Cargo workspace 根
├── Cargo.lock                       ← NEW: 单一 workspace lock
├── package.json                     ← NEW: pnpm workspace 根
├── pnpm-lock.yaml                   ← NEW: 替换各子包的 package-lock.json
├── pnpm-workspace.yaml              ← NEW: apps/*, packages/*
├── .gitignore                       ← 追加: target/, node_modules/
├── Makefile                         ← 更新: Docker 挂载路径, cp 路径
├── .mise.toml                       ← 更新: gen-types 路径, app 路径
├── scripts/                         ← 不变
│   └── gen-plugin-types.mjs         ← 更新: 输出路径改为 packages/api-types
├── specs/                           ← 不变
├── tests/                           ← 不变
│
├── apps/                            ← TS 应用（pnpm workspace members）
│   ├── player-enhancer/             ← 原 src/player-enhancer/（迁移）
│   │   ├── package.json             ← 更新: + "@jfs/api-types" + "@jfs/i18n" workspace 依赖
│   │   └── src/
│   │       ├── core/
│   │       ├── lib/
│   │       │   └── i18n.ts          ← 改用 createT()；本地只保留翻译对象
│   │       ├── types/
│   │       │   └── jellyfin-suite-api.ts  ← DELETE（改用 @jfs/api-types）
│   │       └── ...
│   │
│   └── frontend/                    ← 原 src/frontend/（迁移）
│       ├── package.json             ← 更新: + "@jfs/api-types" + "@jfs/i18n" workspace 依赖
│       └── src/
│           ├── jellyfin-api.ts      ← DELETE（改用 @jfs/api-types）
│           ├── i18n/                ← 改用 createT()；本地只保留翻译对象
│           └── ...
│
├── packages/                        ← TS 共享库（pnpm workspace members）+ C# 插件
│   ├── api-types/                   ← NEW: @jfs/api-types（pnpm workspace member）
│   │   ├── package.json             ← name: "@jfs/api-types"
│   │   └── src/
│   │       └── jellyfin-api.ts      ← 唯一 OpenAPI 类型来源（gen-types 写这里）
│   │
│   ├── i18n/                        ← NEW: @jfs/i18n（pnpm workspace member）
│   │   ├── package.json             ← name: "@jfs/i18n"
│   │   └── src/
│   │       └── index.ts             ← 导出 detectLang() + createT<T>()
│   │
│   └── JellyfinSuite.Plugin/        ← 原 src/JellyfinSuite.Plugin/（迁移，pnpm 忽略）
│       └── （C# 项目文件，无 package.json，pnpm 自动跳过）
│
└── crates/                          ← Rust crates（全部入 Cargo workspace）
    ├── jfs-common/                  ← NEW: 共享 Rust crate
    │   ├── Cargo.toml
    │   └── src/
    │       ├── lib.rs
    │       ├── decoder.rs           ← 从 seek-preview 提取
    │       ├── disk_cache.rs        ← 从 seek-preview 提取
    │       └── fps_utils.rs         ← 从 server.rs 提取
    │
    ├── seek-preview/                ← 原 src/seek-preview/（迁移）
    │   ├── Cargo.toml               ← 更新: + jfs-common dep，移除 decoder/disk_cache
    │   └── src/
    │       ├── main.rs
    │       ├── protocol.rs
    │       └── server.rs            ← 改为 use jfs_common::
    │
    ├── frame-forge/                 ← 原 src/frame-forge/（迁移）
    │   ├── Cargo.toml               ← 更新: + jfs-common dep，移除 decoder/disk_cache
    │   └── src/
    │       ├── main.rs
    │       ├── animate.rs
    │       ├── scene_classifier.rs
    │       ├── quality.rs
    │       ├── protocol.rs
    │       ├── server.rs            ← 改为 use jfs_common::
    │       └── cli.rs
    │
    └── poster-gen/                  ← 原 src/poster-gen/（迁移，不依赖 jfs-common）
        ├── Cargo.toml
        └── src/
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
  - 'apps/*'
  - 'packages/*'
```

> `packages/JellyfinSuite.Plugin/` 无 `package.json`，pnpm 自动跳过，不会报错。

### `packages/api-types/package.json`（新建）

```json
{
  "name": "@jfs/api-types",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./src/jellyfin-api.ts"
  }
}
```

### `packages/i18n/package.json`（新建）

```json
{
  "name": "@jfs/i18n",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

`packages/i18n/src/index.ts` 导出：

```ts
export function detectLang(): 'en' | 'zh' | 'ja' { /* ... */ }

export function createT<T extends Record<string, string>>(
  translations: Record<'en' | 'zh' | 'ja', T>
): (key: keyof T) => string {
  const lang = detectLang()
  return (key) => translations[lang][key] ?? translations.en[key] ?? String(key)
}
```

### `Cargo.toml`（repo 根，新建 workspace 根）

```toml
[workspace]
resolver = "2"
members = [
    "crates/jfs-common",
    "crates/frame-forge",
    "crates/seek-preview",
    "crates/poster-gen",
]
```

### `crates/jfs-common/Cargo.toml`（新建）

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

### `crates/seek-preview/Cargo.toml`（更新）

移除：`ffmpeg-next`（通过 jfs-common 传递），`decoder.rs` 内联依赖  
新增：`jfs-common = { path = "../jfs-common" }`

### `crates/frame-forge/Cargo.toml`（更新）

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
  → packages/api-types/src/jellyfin-api.ts   (唯一来源)

player-enhancer: import type { ... } from '@jfs/api-types'
frontend:        import type { ... } from '@jfs/api-types'
```

---

## 状态迁移（不涉及实体状态，仅文件位置）

| 原路径 | 新路径 | 操作 |
|--------|--------|------|
| `src/player-enhancer/` | `apps/player-enhancer/` | git mv |
| `src/frontend/` | `apps/frontend/` | git mv |
| `src/frame-forge/` | `crates/frame-forge/` | git mv |
| `src/seek-preview/` | `crates/seek-preview/` | git mv |
| `src/poster-gen/` | `crates/poster-gen/` | git mv |
| `src/JellyfinSuite.Plugin/` | `packages/JellyfinSuite.Plugin/` | git mv |
| `src/seek-preview/src/decoder.rs` | `crates/jfs-common/src/decoder.rs` | git mv（并合并内容） |
| `src/seek-preview/src/disk_cache.rs` | `crates/jfs-common/src/disk_cache.rs` | git mv |
| `server.rs` 中的 `compute_frame_idx` | `crates/jfs-common/src/fps_utils.rs` | 提取 |
| `apps/player-enhancer/src/types/jellyfin-suite-api.ts` | 删除（改用 `@jfs/api-types`） | git rm |
| `apps/frontend/src/jellyfin-api.ts` | 删除（改用 `@jfs/api-types`） | git rm |
| ← （新建） | `packages/api-types/src/jellyfin-api.ts` | gen-types 生成 |
| ← （新建） | `packages/i18n/src/index.ts` | 手写（工具函数） |
| `src/` 目录 | 完全删除（内容已全部迁移） | rmdir |
