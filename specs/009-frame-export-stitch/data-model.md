# Data Model: Frame Export & Stitch

**Feature**: 009-frame-forge-stitch  
**Date**: 2026-05-26

---

## Entity: FrameExportTask

后端异步生成任务的核心实体�?
| Field | Type | Description |
|-------|------|-------------|
| `taskId` | `string` (UUID v4) | 全局唯一任务标识�?|
| `itemId` | `string` (Jellyfin GUID) | 源视频文�?ID |
| `itemTitle` | `string` | 视频标题（用于下载文件名生成�?|
| `type` | `enum { animate, stitch }` | 任务类型：动画导�?/ 全景拼接 |
| `status` | `enum { pending, running, complete, error, cancelled }` | 任务状�?|
| `params` | `ExportParams` | 导出参数对象 |
| `frames` | `FrameReference[]` | 选中帧列�?|
| `progress` | `TaskProgress` | 当前进度（mutable�?|
| `outputPath` | `string?` | 最终产物文件路径（complete 后赋值） |
| `outputSize` | `long?` | 文件大小（bytes�?|
| `tempDir` | `string` | 临时工作目录 `{DataPath}/temp/frame-forge/{taskId}/` |
| `progressChannel` | `Channel<TaskProgress>` | C# 内部 mpsc channel（SSE 桥接源） |
| `processId` | `int?` | 关联�?Rust 子进�?PID（取消时 kill 用） |
| `createdAt` | `DateTime` (UTC) | 任务创建时间 |
| `completedAt` | `DateTime?` (UTC) | 任务完成时间 |
| `error` | `string?` | 错误消息（status=error 时） |

**State Transitions**:

```
pending �?running �?complete
                  �?error
                  �?cancelled (via Cancel endpoint)
```

**Lifecycle Rules**:
- `complete` 状态后 `outputPath` 非空，文件在 `tempDir` �?- 任务 `complete` �?5 分钟未下�?删除 �?定时器自动清�?`tempDir` + 移除内存记录
- `cancelled` �?立即 kill 子进�?�?`rm -rf tempDir` �?移除内存记录
- 服务重启时：`temp/frame-forge/` 下的孤儿目录�?EntryPoint 中递归清理

---

## Entity: ExportParams

用户配置的导出参数，由前端提交并�?localStorage 持久化�?
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `format` | `string` | animate �?`"gif"`, stitch �?`"png"` | 输出格式：`gif`/`webp`(有损动画), `png`/`webp-lossless`(全景) |
| `resizeMode` | `string` | `"width"` | 分辨率约束方向：`"width"` / `"height"` |
| `customWidth` | `int?` | null | 自定义目标宽度（px），null=使用预设 |
| `customHeight` | `int?` | null | 自定义目标高度（px），null=使用预设 |
| `resolutionPreset` | `string` | `"original"` | 分辨率预设：`original`/`1080p`/`720p`/`480p`/`360p` |
| `fps` | `int` | 5 | 帧率（仅 animate），范围 1�?0 |
| `loopCount` | `int` | 0 | 循环次数（仅 animate），0=无限�?�?9=指定次数 |

**Validation**:
- `resizeMode == "width"` �?`customWidth` 生效、`customHeight` 自动计算 �?服务端忽�?height
- `resizeMode == "height"` 时反�?- `resizeMode` 切换�?`resolutionPreset` 自动置为 `"custom"`
- 选择预设档位�?`resizeMode` 自动切回 `"width"`，`customWidth`/`customHeight` 恢复为预设�?
**localStorage 持久�?*:

```typescript
// key: jfs-frameexport-settings
interface LocalExportSettings {
  animateFormat: "gif" | "webp";
  stitchFormat: "png" | "webp-lossless";
  resizeMode: "width" | "height";
  customWidth: number | null;
  customHeight: number | null;
  resolutionPreset: string;
  fps: number;
  loopCount: number;
}
```

---

## Entity: FrameReference

单个选中帧的引用�?
| Field | Type | Description |
|-------|------|-------------|
| `positionMs` | `long` | 帧位置（毫秒，视频时间戳�?|
| `itemId` | `string` | 所属视�?ID（冗余，用于请求验证�?|
| `qualityFlag` | `int` (bitmask) | 质量标记：bit0=黑帧, bit1=白帧, bit2=模糊 |
| `isSelected` | `bool` | 是否被用户勾选（前端状态） |
| `timestamp` | `string` | 格式化时间戳显示文字，如 "01:23:45.200" |

---

## Entity: TaskProgress

SSE 事件推送的进度快照�?
| Field | Type | Description |
|-------|------|-------------|
| `taskId` | `string` | 关联任务 ID |
| `status` | `string` | `"running"` / `"complete"` / `"error"` / `"fallback"` |
| `phase` | `string` | 当前阶段描述（如 "decoding", "classifying", "matching", "warping", "blending", "encoding"�?|
| `current` | `int` | 当前进度计数 |
| `total` | `int` | 总步骤数 |
| `percent` | `float` | 百分�?0�?00 |
| `resultUrl` | `string?` | 完成时：`/JellyfinSuite/FrameExport/Result/{taskId}/output.{ext}` |
| `fileSize` | `long?` | 完成时：文件大小（bytes�?|
| `error` | `string?` | 错误消息（status=error 时） |

**SSE 事件格式**:

```
data: {"taskId":"...","status":"running","phase":"decoding","current":3,"total":10,"percent":30}
data: {"taskId":"...","status":"running","phase":"encoding","current":1,"total":1,"percent":90}
data: {"taskId":"...","status":"complete","resultUrl":"...","fileSize":1234567,"percent":100}
```

---

## Entity: SceneClassification

全景拼接前的场景分析结果�?
| Field | Type | Description |
|-------|------|-------------|
| `category` | `enum { anime, landscape, liveaction }` | 场景类别 |
| `confidence` | `float` | 分类置信�?0�? |
| `motionType` | `enum { pan, zoom, rotation, static }` | 镜头运动类型 |
| `dominantDirection` | `enum { horizontal, vertical }` | 主导拼接方向 |
| `edgeDensity` | `float` | Canny 边缘密度比�?|
| `colorEntropy` | `float` | 颜色直方图信息熵 |
| `motionScore` | `float` | 帧间差分运动区域占比 |

**分类逻辑（启发式规则�?*:

| 条件 | �?category |
|------|-----------|
| edgeDensity > 0.15 && colorEntropy < 3.5 | `anime` |
| edgeDensity < 0.08 | `landscape` |
| 其他 | `liveaction` |

---

## Entity: FrameQualityMeta

单帧质量检测结果（�?Rust 端计算，随缩略图响应返回）�?
| Field | Type | Description |
|-------|------|-------------|
| `positionMs` | `long` | 帧位�?|
| `brightnessVar` | `float` | 亮度方差�?5 �?黑帧�?250 �?白帧�?|
| `laplacianVar` | `float` | Laplacian 方差�?阈�?�?模糊帧） |
| `frameDiff` | `float` | 与前一帧的像素差异比（>0.9 �?转场�?|
| `isJunk` | `bool` | 综合判定为垃圾帧 |
| `junkReason` | `string?` | 垃圾原因文字（如 "black_frame", "blur_frame"�?|

---

## Directory Structure: 临时文件

```
{DataPath}/
└── temp/
    └── frame-forge/
        ├── {taskId-1}/
        �?  ├── frame_00000.jpg     # 中间解码帧（生成中）
        �?  ├── frame_00001.jpg
        �?  ├── ...
        �?  └── output.gif          # 最终产物（complete 后）
        ├── {taskId-2}/
        �?  ├── ...
        �?  └── output.png
        └── .lock                    # 定时清理互斥锁文�?```

**清理策略**:
- 服务启动：递归 `rm -rf temp/frame-forge/*`（清理孤儿目录）
- 定时器：�?5 分钟扫描，删�?`createdAt + 5min` 的过期任务目�?- 即时清理：用户点击删�?返回/关闭 Modal �?�?`DELETE /Result/{taskId}` �?即时 `rm -rf`
- 取消时：kill 子进�?+ `rm -rf {taskId}` 目录
