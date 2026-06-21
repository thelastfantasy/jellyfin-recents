# API Contracts: Frame Export & Stitch

**Feature**: 009-frame-forge-stitch  
**Date**: 2026-05-26

All endpoints under base path `/JellyfinSuite/FrameExport`.

---

## 1. Get Frame (single thumbnail or original)

```
GET /JellyfinSuite/FrameExport/{itemId}
    ?positionMs={ms}
    &width={pixels}
```

**Auth**: `[AllowAnonymous]` + `?api_key=` query param (follows seek-preview pattern).

**Query Parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `positionMs` | long | 0 | Frame position in milliseconds |
| `width` | int | 320 | Target width in pixels. â‰?20 returns compressed thumbnail JPEG; 0 returns original-quality JPEG |

**Responses**:

| Status | Content-Type | Body |
|--------|-------------|------|
| 200 | `image/jpeg` | JPEG bytes |
| 404 | `application/json` | `{ "error": "Item not found or no file path" }` |
| 503 | `application/json` | `{ "error": "frame-forge daemon not available" }` |

**Response Headers** (200):

| Header | Value | Description |
|--------|-------|-------------|
| `X-Frame-Quality` | `{ "brightnessVar": ..., "laplacianVar": ..., "frameDiff": ..., "isJunk": bool, "junkReason": "..." }` | JSON-encoded quality metadata |

---

## 2. Generate (submit animation or stitch task)

```
POST /JellyfinSuite/FrameExport/Generate
Content-Type: application/json
```

**Auth**: `[AllowAnonymous]` + `?api_key=` query param.

**Request Body**:

```json
{
  "itemId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "itemTitle": "My Episode Title",
  "type": "animate",
  "frames": [
    { "positionMs": 120000 },
    { "positionMs": 125000 },
    { "positionMs": 130000 }
  ],
  "params": {
    "format": "gif",
    "resizeMode": "width",
    "customWidth": null,
    "customHeight": null,
    "resolutionPreset": "original",
    "fps": 5,
    "loopCount": 0
  }
}
```

**Field Constraints**:

| Field | Constraint |
|-------|-----------|
| `type` | `"animate"` or `"stitch"` |
| `frames` | Array of `{ positionMs: long }`, 2â€?00 items (warning at >50) |
| `params.format` | animate: `"gif"` / `"webp"`; stitch: `"png"` / `"webp-lossless"` |
| `params.resizeMode` | `"width"` or `"height"` |
| `params.resolutionPreset` | `"original"` / `"1080p"` / `"720p"` / `"480p"` / `"360p"` |
| `params.fps` | 1â€?0 (only for animate) |
| `params.loopCount` | 0â€?9 (only for animate, 0=infinite) |

**Response** (202 Accepted):

```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Error Responses**:

| Status | Body |
|--------|------|
| 400 | `{ "error": "Invalid params: fps must be 1-30" }` |
| 404 | `{ "error": "Item not found or no file path" }` |
| 422 | `{ "error": "Item is not a video" }` |
| 503 | `{ "error": "frame-forge daemon not available" }` |

---

## 3. Progress Stream (SSE)

```
GET /JellyfinSuite/FrameExport/Progress?taskId={uuid}
Accept: text/event-stream
```

**Auth**: `?api_key=` query param (EventSource cannot set custom headers).

**Response Headers**:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-store
X-Accel-Buffering: no
Connection: keep-alive
```

**SSE Event Stream**:

```
data: {"taskId":"550e8400-...","status":"running","phase":"decoding","current":3,"total":10,"percent":30}

data: {"taskId":"550e8400-...","status":"running","phase":"encoding","current":1,"total":1,"percent":90}

data: {"taskId":"550e8400-...","status":"complete","resultUrl":"/JellyfinSuite/FrameExport/Result/550e8400-.../output.gif","fileSize":1234567,"percent":100}

# OR error:
data: {"taskId":"550e8400-...","status":"error","error":"decode failed: file not accessible","percent":42}

# OR fallback (panorama downgrade):
data: {"taskId":"550e8400-...","status":"fallback","phase":"simple stack","reason":"homography estimation failed (insufficient inliers)"}
```

**Connection Lifecycle**:
- Client opens connection after receiving `taskId` from Generate response
- Server pushes events until `status` âˆ?`{ "complete", "error" }` then closes connection
- Client reconnection (max 3 retries, 1s interval) â†?server re-sends current status snapshot

---

## 4. Download Result

```
GET /JellyfinSuite/FrameExport/Result/{taskId}/{filename}
```

**Auth**: `[AllowAnonymous]` + `?api_key=` query param.

**Responses**:

| Status | Content-Type | Body |
|--------|-------------|------|
| 200 | `image/gif` / `image/webp` / `image/png` | File bytes |
| 404 | `application/json` | `{ "error": "Result not found or expired" }` |
| 409 | `application/json` | `{ "error": "Task not complete (status: running)" }` |

**Response Headers** (200):

| Header | Value |
|--------|-------|
| `Content-Disposition` | `attachment; filename="{itemTitle}_anim_{timestamp}.gif"` |

---

## 5. Delete Result (clean up)

```
DELETE /JellyfinSuite/FrameExport/Result/{taskId}
```

**Auth**: `[AllowAnonymous]` + `?api_key=` query param.

**Responses**:

| Status | Body |
|--------|------|
| 200 | `{ "deleted": true }` |
| 404 | `{ "error": "Task not found" }` (already cleaned up, idempotent) |

**Behavior**: Removes `tempDir` recursively, removes task from in-memory dictionary.

---

## 6. Cancel Task

```
POST /JellyfinSuite/FrameExport/Cancel/{taskId}
```

**Auth**: `[AllowAnonymous]` + `?api_key=` query param.

**Responses**:

| Status | Body |
|--------|------|
| 200 | `{ "cancelled": true }` |
| 404 | `{ "error": "Task not found" }` |
| 409 | `{ "error": "Task already complete" }` (cannot cancel finished task) |

**Behavior**:
- Kills associated Rust child process (`Process.Kill()` + `WaitForExit(3000)`)
- Removes `tempDir` recursively (`rm -rf`)
- Sets task status to `cancelled`
- SSE connection receives `status: "cancelled"` event before close

---

## 7. Frame Metadata (batch)

```
GET /JellyfinSuite/FrameExport/FrameMeta/{itemId}?positions=120000,125000,130000...
```

**Auth**: `[AllowAnonymous]` + `?api_key=` query param.

**Optional optimization endpoint**: Returns quality metadata for multiple frames at once without image data. Used by frontend to pre-mark junk frames before loading thumbnails.

**Response** (200):

```json
[
  { "positionMs": 120000, "brightnessVar": 45.2, "laplacianVar": 12.3, "frameDiff": 0.05, "isJunk": false, "junkReason": null },
  { "positionMs": 125000, "brightnessVar": 2.1, "laplacianVar": 18.7, "frameDiff": 0.02, "isJunk": true, "junkReason": "black_frame" }
]
```

**Note**: This endpoint is optional for v1 MVP. If unimplemented, quality metadata is returned inline via `X-Frame-Quality` header on per-frame GET.

---

## 8. Health Check

```
GET /JellyfinSuite/FrameExport/Health
```

**Auth**: None (for monitoring).

**Response** (200):

```json
{
  "available": true,
  "uptimeSeconds": 1234,
  "activeTasks": 2,
  "cpuUsagePercent": 35.0,
  "freeMemoryMB": 2048
}
```
