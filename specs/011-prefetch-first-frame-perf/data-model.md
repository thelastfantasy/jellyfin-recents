# Data Model: Prefetch First-Frame Latency & Frame Delivery

**Date**: 2026-06-07

---

## Entities

### PrefetchRequest

触发一次 prefetch 的请求，来自前端 SSE 连接。

| 字段 | 类型 | 说明 |
|------|------|------|
| item_id | String | Jellyfin 媒体 ID |
| anchor_ms | i64 | 用户当前播放位置（毫秒），必须优先解码 |
| range_start_ms | i64 | 请求范围起点（毫秒） |
| range_end_ms | i64 | 请求范围终点（毫秒） |
| width | u32 | 缩略图目标宽度（0 = 仅原图） |
| include_current | bool | anchor 帧是否包含在目标列表中 |

**约束**：全局同一时刻只允许一个 PrefetchRequest 处于 active 状态（FR-010）。

---

### TargetFrame

请求中的单个目标帧，由 demux 阶段建立的帧索引确定。

| 字段 | 类型 | 说明 |
|------|------|------|
| fi_idx | i64 | 帧号（显示顺序索引，PTS 顺序） |
| pos_ms | i64 | 帧的显示时间戳（毫秒，PTS） |
| is_anchor | bool | 是否为当前请求的 anchor 帧 |

**约束**：
- `fi_idx` 基于显示顺序（PTS 顺序），不是容器中的包序（DTS 顺序）
- `pos_ms` 是 PTS 毫秒值，用作 DiskCache 的 key（与 fi_idx 无关）
- 修复后：demux 阶段必须保证 `pos_ms` 与 decode 阶段的帧 PTS 对齐（方案三目标）

---

### DiskCacheEntry

持久化到本地磁盘的 WebP 图像缓存条目。

| 字段 | 类型 | 说明 |
|------|------|------|
| item_id | String | 媒体 ID |
| pos_ms | i64 | 帧 PTS 毫秒（cache key，不含 fi_idx） |
| width | u32 | 图像宽度（0 = 原始尺寸） |
| data | Vec\<u8\> | WebP 编码图像数据 |

**约束**：
- Key = `(item_id, pos_ms, width)` — 与 fi_idx 无关，时间戳修正不影响缓存命中
- 仅在数据成功落盘后才计为 `decoded++`（FR-008）
- 落盘失败则 `failed++`，不计为已投递

---

### SSEEvent

从 Rust frame-forge → C# Plugin → 前端的流式推送事件。

#### frameReady 事件
```json
{
  "frameReady": 123,
  "thumbPath": "/path/to/thumb.webp",
  "origPath": "/path/to/orig.webp"
}
```

#### done 事件
```json
{
  "done": true,
  "cacheHits": 23,
  "decoded": 96,
  "failed": 0
}
```

**约束**：
- 每帧解码完成后立即推送，不等待全部完成（FR-001）
- anchor 帧的 frameReady 事件必须是第一个被推送的事件（FR-009）
- `failed` 字段必须精确反映实际未落盘的帧数（FR-008）

---

### CancelToken

全局单任务控制的取消标志。

| 字段 | 类型 | 说明 |
|------|------|------|
| flag | Arc\<AtomicBool\> | 新 prefetch 到来时设为 true，decode_range 检查此值提前退出 |

**状态转换**：
```
新 prefetch 到来 → set flag=true → 旧 decode_range 退出 → flag reset=false → 新 decode 开始
```

---

## 关键不变量

1. `DiskCacheEntry.key = (item_id, pos_ms, width)` — 时间戳修正不破坏缓存
2. `TargetFrame.fi_idx` 基于 PTS 显示顺序，对应前端网格单元格位置
3. 同一时刻最多 1 个 active PrefetchRequest（CancelToken 保证）
4. `decoded + cache_hits + failed = to_process`（帧计数守恒）
