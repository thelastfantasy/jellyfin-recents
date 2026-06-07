# Contract: Prefetch SSE Stream

**Endpoint**: `GET /FrameExport/PrefetchReady`  
**Protocol**: HTTP SSE (Server-Sent Events)  
**Direction**: Server → Client (streaming)

---

## Request Parameters

| 参数 | 类型 | 说明 |
|------|------|------|
| itemId | string | Jellyfin 媒体 ID |
| currentTimeMs | i64 | anchor 帧位置（毫秒） |
| rangeMs | i64 | prefetch 范围（锚点前后各 rangeMs/2 毫秒） |
| width | u32 | 缩略图宽度（像素） |
| includeCurrent | bool | 是否包含 anchor 帧本身 |

---

## Response Events

每个事件以 `data: {json}\n\n` 格式推送。

### frameReady

每帧解码并缓存成功后立即推送。

```json
{
  "frameReady": 123,
  "thumbPath": "string",
  "origPath": "string"
}
```

| 字段 | 说明 |
|------|------|
| frameReady | fi_idx，显示顺序帧号（对应前端网格单元格） |
| thumbPath | 缩略图 WebP 的访问路径 |
| origPath | 原图 WebP 的访问路径（width=0 时可能为空） |

**约束**：anchor 帧的 `frameReady` 事件必须是流中第一个事件（FR-009）。

### done

prefetch 完成后推送一次，然后关闭连接。

```json
{
  "done": true,
  "cacheHits": 23,
  "decoded": 96,
  "failed": 0
}
```

| 字段 | 说明 |
|------|------|
| cacheHits | 从 DiskCache 直接命中的帧数 |
| decoded | 本次新解码并成功落盘的帧数 |
| failed | 未能成功落盘的帧数（应为 0） |

**守恒关系**：`cacheHits + decoded + failed = to_process`

---

## 行为约束

1. **流式**：每帧完成后立即 flush，不等待所有帧完成再批量发送
2. **anchor 优先**：anchor 帧的 frameReady 在所有其他帧之前到达客户端
3. **取消语义**：客户端发起新 prefetch 时，服务端应取消当前正在进行的任务；前端收到新 prefetch 开始信号时立即清空所有缩略图，重置为加载状态
4. **失败透明**：failed > 0 表示功能异常，对应帧号无缩略图可用

---

## 兼容性说明

- `failed` 字段为新增字段，旧客户端应忽略未知字段
- `thumbPath` / `origPath` 路径格式保持不变
