# Contract: C# ↔ frame-forge daemon socket 协议扩展

沿用 `crates/frame-forge/src/protocol.rs` 现有的手写长度前缀二进制帧风格（无序列化框架，定长标量字段直接拼字节，变长字段走 `[len(4 LE)][bytes]`，且所有变长字段读取必须做 `MAX_STR_FIELD_LEN` 量级的上限检查，理由见 `protocol.rs` 第4-14行的注释——历史上出现过两次因字段错位导致的 OOM 崩溃）。

## 1. 现有请求结构体新增字段

已逐一核对 `server.rs` 各 handler 的调用链，确定需要新增字段的完整清单（不存在遗漏风险）：

| msg_type | 结构体/读取方式 | handler(s) | 解码调用方式 |
|---|---|---|---|
| `MSG_SINGLE_FRAME` (0x10) | `SingleFrameReq`（`read_single_frame_req`） | `handle_single_frame`（直接 `decode_and_encode`）、`handle_prefetch_frame`（复用同一结构体，转入 `PrefetchJob` 队列） | 直接 + 间接 |
| `MSG_ANIMATE` (0x11) | `AnimateReq` | `handle_animate` | 直接 `decode_and_encode` |
| `MSG_STITCH` (0x12) | `StitchReq` | `handle_stitch` | 直接 `decode_and_encode` |
| `MSG_PREFETCH_RANGE` (0x16) | `PrefetchRangeReq` | `handle_prefetch_range` | 间接——本身只产出 `PrefetchJob` 入队，不直接解码 |
| `MSG_PREFETCH_STREAM` (0x18) | 无独立结构体，`handle_prefetch_stream` 内联手动解析字段 | `handle_prefetch_stream` | 直接 `decode_and_encode` |
| `MSG_PREFETCH_RANGE_STREAM` (0x19) | `PrefetchRangeStreamReq` | `handle_prefetch_range_stream` | 直接，anchor 帧用 `decode_and_encode`、Pass 2 批量用 `decode_range` |

**额外要点**：`MSG_PREFETCH_RANGE`/`MSG_PREFETCH_FRAME`（经 `SingleFrameReq`）都不直接解码，而是把 `PrefetchJob`（`server.rs` 第81-86行，内部队列结构体，不是 wire 协议结构体）丢进 `state.prefetch_tx`，由后台 `prefetch_worker`（第274行）统一消费并调用 `decode_and_encode`。所以 `PrefetchJob` 也必须新增 `hw_decode_enabled: bool`、`device_strategy: DeviceStrategy` 两个字段，并在 `handle_prefetch_range`/`handle_prefetch_frame` 构造 `PrefetchJob` 时从对应请求结构体里带过去——否则这两条路径的硬解开关形同虚设。

以上结构体（`SingleFrameReq`/`AnimateReq`/`StitchReq`/`PrefetchRangeReq`/`PrefetchRangeStreamReq`）+ `handle_prefetch_stream` 的内联字段解析 + `PrefetchJob`，均追加以下两个定长字段（紧跟在现有 `width: u32` 字段之后，避免在变长 `path`/`item_id` 字段中间插入造成不必要的解析复杂度）：

```
[hw_decode_enabled: u8 (1 = true, 0 = false)]
[device_strategy: u8 (0 = Performance, 1 = IdleResource)]
```

C# 侧写入示例（伪代码，实际位置在 `FrameExportService.cs` 现有手写 `MemoryStream` 拼包处）：

```csharp
ms.WriteByte(hwDecodeEnabled ? (byte)1 : (byte)0);
ms.WriteByte(deviceStrategy == "idle-resource" ? (byte)1 : (byte)0);
```

Rust 侧读取示例（伪代码，对应 `protocol.rs` 各 `read_*_req` 函数末尾追加）：

```rust
let mut flag_buf = [0u8; 2];
stream.read_exact(&mut flag_buf).await?;
let hw_decode_enabled = flag_buf[0] != 0;
let device_strategy = if flag_buf[1] == 1 { DeviceStrategy::IdleResource } else { DeviceStrategy::Performance };
```

**向后兼容**：这是破坏性的协议变更（新增定长字段会让旧版 C#/Rust 互相读错位），但 C# 插件 DLL 与 `frame-forge-linux-x64` 二进制总是同一次 `mise run update`/`update-linux` 一起部署、版本号绑定，不需要兼容旧协议——与现有 `tasks.md` 注释里"MSG_UPSCALE 编号占用问题"体现的项目惯例一致（协议双端始终同步发布）。

## 2. 新增消息类型：`MSG_HW_DECODE_CAPS = 0x1D`

请求（C# → daemon）：无 body，仅 1 字节 msg_type。

响应（daemon → C#）：

```
[supported: u8 (1/0)]
[vendor_count: u8]
repeated vendor_count 次:
  [vendor: u8 (0=NVIDIA, 1=AMD, 2=Intel)]
  [supported: u8 (1/0)]
  [reason_len: u32 LE]
  [reason: UTF-8 bytes, reason_len 字节；supported=1 时 reason_len 可以是 0]
```

`reason_len` 读取必须套用 `protocol.rs` 现有的 `MAX_STR_FIELD_LEN` 上限检查模式。

**调用时机**：C# 在播放器增强 modal 打开时调用一次（用于渲染开关禁用态 + 提示文案，FR-010），不在每次帧提取请求时调用——daemon 侧这个值是启动时探测一次缓存住的（见 data-model.md 的 `HwDecodeCapabilities` 状态转换），重复查询只是读缓存，没有额外探测开销，但调用方仍只在 modal 打开时查一次以减少 IPC 往返。

## 3. FallbackEvent 写入（无新协议字段，复用现有落盘机制）

硬解失败回退事件不通过 socket 实时上报给 C#，而是沿用现有模式——写入对应任务的 `generation-log.json`（`crates/frame-forge/src/generation_log.rs` 的 `GenerationLog.fallbacks`/`UpscaleLog.fallbacks` 字段），C# 已有 `GET /FrameExport/Result/{taskId}/generation-log.json` 端点（`FrameExportController.cs` 第398-422行附近）可以读到，不需要新增端点。
