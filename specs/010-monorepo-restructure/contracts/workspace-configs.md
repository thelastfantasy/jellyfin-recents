# Contracts: Workspace Configurations

## pnpm workspace

### 包名约定

| 包路径 | package.name | 用途 |
|--------|-------------|------|
| `packages/api-types` | `@jfs/api-types` | OpenAPI 生成的 TS 类型（唯一来源） |
| `packages/i18n` | `@jfs/i18n` | i18n 工具层：`detectLang()` + `createT<T>()` |
| `apps/player-enhancer` | `jellyfin-suite-player-enhancer` | 注入脚本（不变） |
| `apps/frontend` | `jellyfin-suite-frontend` | 配置页（不变） |

### 依赖声明约定

所有使用共享包的 app，在 `package.json` 的 `dependencies`（非 `devDependencies`）中声明：
```json
"@jfs/api-types": "workspace:*",
"@jfs/i18n": "workspace:*"
```

`workspace:*` 表示使用 workspace 内的版本，不锁定具体版本号。

### TypeScript 导入约定

**API 类型**：两个 app 中，原来的：
```typescript
import type { components } from './jellyfin-api';          // frontend
import type { components } from '../types/jellyfin-suite-api'; // player-enhancer
```
改为：
```typescript
import type { components } from '@jfs/api-types';
```

**i18n**：两个 app 的 `i18n.ts` 改为：
```typescript
import { createT } from '@jfs/i18n';

const TRANSLATIONS = { en: { ... }, zh: { ... }, ja: { ... } } as const;
export const t = createT(TRANSLATIONS);
```

在 `vite.config.ts` 中**必须**加显式别名（不依赖 pnpm workspace 符号链接——Vite 处理 TS 源文件时 `exports` 解析不稳定）：
```typescript
resolve: {
  alias: {
    '@jfs/api-types': path.resolve(__dirname, '../../packages/api-types/src/jellyfin-api.ts'),
    '@jfs/i18n':      path.resolve(__dirname, '../../packages/i18n/src/index.ts'),
  }
}
```

> 注：`apps/player-enhancer/vite.config.ts` 中 `__dirname` 为 `apps/player-enhancer/`，`../../packages/` 指向 repo 根的 `packages/`。

---

## Cargo workspace

### Crate 依赖声明约定

使用 `path` 依赖引用本地 crate（`crates/` 下各 crate 互为兄弟目录）：
```toml
[dependencies]
jfs-common = { path = "../jfs-common" }
```

### jfs-common 公共 API

`crates/jfs-common/src/lib.rs` 导出：
```rust
pub mod decoder;
pub mod disk_cache;
pub mod fps_utils;

pub use decoder::decode_and_encode;
pub use disk_cache::DiskCache;
pub use fps_utils::compute_frame_idx;
```

调用方：
```rust
use jfs_common::{decode_and_encode, DiskCache, compute_frame_idx};
```

### feature flags 约定

`jfs-common` 不使用 feature flags（所有功能默认启用）。各 crate 自行管理 `daemon`/`opencv` 等 feature。

---

## Docker 构建合约

### 挂载约定

改造后的 Docker build 命令模板（挂载 repo 根，因为 Cargo workspace 根在 repo 根）：

```makefile
build-seek-preview:
    MSYS_NO_PATHCONV=1 docker run --rm \
        -v "$$(cygpath -m $(CURDIR)):/workspace" \
        -v rust-cargo-home:/root/.cargo \
        -w /workspace \
        ubuntu:24.04 \
        sh -c "... cargo build -p seek-preview --release"
```

### 产物路径约定

Cargo workspace 时，`target/` 在 workspace 根（即 repo 根 `target/`）：

| 产物 | 原路径（迁移前） | 新路径（迁移后） |
|------|--------------|--------------|
| seek-preview | `src/seek-preview/target/release/seek-preview` | `target/release/seek-preview` |
| frame-forge | `src/frame-forge/target/release/frame-forge` | `target/release/frame-forge` |

Makefile 中的 `cp` 命令需相应更新：
```makefile
cp target/release/seek-preview packages/JellyfinSuite.Plugin/seek-preview-linux-x64
cp target/release/frame-forge packages/JellyfinSuite.Plugin/frame-forge-linux-x64
```

---

## gen-types 合约

### 调用约定（改造后）

```bash
node scripts/gen-plugin-types.mjs --url=http://localhost:8600
```

### 输出约定

| 改造前 | 改造后 |
|--------|--------|
| `src/player-enhancer/src/jellyfin-api.ts` | ← 删除 |
| `src/frontend/src/jellyfin-api.ts` | ← 删除 |
| （无共享包） | `packages/api-types/src/jellyfin-api.ts` ← 新增 |

脚本内部只需修改输出路径，OpenAPI fetch 逻辑不变。
