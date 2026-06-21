# Feature Specification: Prefetch First-Frame Latency & Frame Delivery

**Feature Branch**: `feature/009-frame-export-stitch`  
**Created**: 2026-06-07  
**Status**: Draft  
**Input**: User description: "api请求后第一帧出现速度（对应img在ui上渲染成功）不满意；方案三（demux 阶段引入 Parser 拿到真正 PTS，彻底消除跨阶段时间戳偏差）；彻底改良prefetch API性能瓶颈"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - First Thumbnail Appears Quickly (Priority: P1)

剪辑工坊用户在播放器拖动进度条或跳转到某一时间点后，系统触发 prefetch 请求。用户期望在界面上尽快看到第一张缩略图出现——这是用户判断"系统在工作"的关键视觉反馈。目前 4K AV1 60fps 视频首帧需 3–4 秒，体验明显滞后。

**Why this priority**: 首帧延迟是用户感知响应速度的核心指标。首帧出现后，后续帧逐步流式加载是可接受的；但首帧长时间空白会让用户感到系统无响应。

**Independent Test**: 在剪辑工坊界面跳转到任意视频位置，计时从跳转操作完成到第一张缩略图在 UI 上渲染成功所需时间，该时间应满足 Success Criteria 中的目标。

**Acceptance Scenarios**:

1. **Given** 用户在 23fps 普通视频的剪辑工坊界面，**When** 跳转到任意位置触发 prefetch，**Then** anchor 帧（当前播放位置所在帧）的缩略图在 1 秒内出现在 UI 上。
2. **Given** 用户在 60fps AV1 4K 视频的剪辑工坊界面，**When** 跳转到任意位置触发 prefetch，**Then** anchor 帧的缩略图在 5 秒内出现在 UI 上。
3. **Given** prefetch 正在进行中，**When** 每一帧解码完成后，**Then** 该帧缩略图立即流式推送到前端并渲染，不等待所有帧完成。
4. **Given** prefetch 开始，**When** anchor 帧尚未完成解码，**Then** anchor 帧是第一个被优先解码并推送的目标，其余帧在 anchor 帧之后按顺序扩散。

---

### User Story 2 - All Requested Frames Delivered (Priority: P1)

用户在剪辑工坊请求某时间范围内的所有帧缩略图时，最终应收到该范围内的全部帧，无丢帧。目前因时间戳跨阶段不一致（demux DTS 顺序 vs decode PTS 顺序），AV1 等含 B 帧视频在某些位置会有约 30% 的帧匹配不上而丢失。

**Why this priority**: 丢帧直接导致用户在剪辑工坊界面看到空白格，无法完成精确帧级剪辑操作，影响核心功能可用性。

**Independent Test**: 在已知含 B 帧的视频位置（如 AV1 视频 1:29:20 处）触发 120 帧 prefetch，确认 UI 上所有 120 个格子均有缩略图，decoded + cache_hits = to_process。

**Acceptance Scenarios**:

1. **Given** 含 B 帧的 AV1 视频，**When** prefetch 请求 120 帧，**Then** 全部 120 帧均成功解码并推送，无任何帧丢失（decoded + cache_hits = 120）。
2. **Given** 含 B 帧的 H.264 视频，**When** prefetch 请求任意范围的帧，**Then** 全部请求帧均成功匹配，丢帧率为 0%。
3. **Given** 任意编码格式的视频，**When** prefetch 完成，**Then** DONE 日志中 failed=0。

---

### User Story 3 - 进度条拖动体验流畅 (Priority: P2)

用户快速在进度条上来回拖动时，之前位置的 prefetch 任务应被及时取消，新位置的 prefetch 首帧应尽快出现，界面不会出现旧帧持续占据格子或请求积压导致的卡顿。

**Why this priority**: 连续快速 seek 是高频操作场景。积压的旧请求会消耗解码资源，延误新请求的首帧时间。

**Independent Test**: 快速在进度条的 3 个以上不同位置来回拖动，确认界面不会因旧请求积压而持续加载旧位置的帧，新位置的第一帧响应时间不因先前请求而明显延长。

**Acceptance Scenarios**:

1. **Given** prefetch 正在进行，**When** 用户跳转到新位置，**Then** 旧 prefetch 任务被取消，资源释放给新任务。
2. **Given** 用户连续快速跳转 3 次，**When** 在最终位置停止，**Then** 最终位置的首帧延迟不超过单次 prefetch 首帧延迟的 2 倍。
3. **Given** 旧 prefetch 已渲染部分缩略图，**When** 用户跳转到新位置触发新 prefetch，**Then** 前端立即清空所有已渲染的旧位置缩略图，全部重置为加载占位状态。

---

### Edge Cases

- 视频文件中某些数据包的 PTS 字段缺失（`AV_NOPTS_VALUE`），应使用最可靠的替代时间戳，不得影响帧匹配精度。
- 可变帧率（VFR）视频，帧间隔不均匀，时间戳匹配容差策略必须适应帧间隔变化。
- AV1 中存在不可见参考帧（invisible/non-show frames），这类帧不应被计入用户请求的目标帧。
- 视频编码中解码器内部缓冲了尚未输出的帧（decoder delay），prefetch 结束时必须确保这些帧被完整取出。
- 所有目标帧均已在 DiskCache 中命中（cache_hits = to_process），直接返回无需解码。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 解码服务在完成每一帧的解码和编码后，必须立即将该帧通过流式通道推送给前端，不得在所有帧完成后才批量发送。
- **FR-002**: 帧时间戳的获取必须在 demux 阶段和 decode 阶段使用同一参照系（均以视频显示时间 PTS 为准），消除跨阶段时间戳不一致问题。对于 `av_parser_init` 返回 NULL 的编码格式（FFmpeg Parser 不支持），允许回退到 DTS 获取，但必须以 `warn` 级别记录日志，不得静默回退；H.264 和 AV1 的 Parser 均有 FFmpeg 内置支持，不应触发此降级。
- **FR-003**: 当容器中数据包的 PTS 字段缺失时，系统必须通过可靠的估算机制（如解码器的 best-effort timestamp）补全该帧的显示时间戳。
- **FR-004**: 解码完成后，系统必须对解码器内部缓冲进行冲刷（flush），确保因双向参考延迟而滞留在解码器中的帧被完整取出并推送。
- **FR-005**: 帧匹配容差策略必须能容纳至少 2 个帧周期的时间偏差（以处理 B 帧 DTS/PTS 偏移），同时不引入跨帧的错误匹配。
- **FR-006**: prefetch 任务支持**会话感知**的取消机制。每个 prefetch 请求必须携带 `prefetchSessionId`（由前端确定性生成，标识当前 modal 的操作上下文，见 FR-011）。
  - **同一会话**（`prefetchSessionId` 相同）：新请求不中断当前任务，在 semaphore 后排队顺序执行；前端不清空已渲染的缩略图，保持连续加载体验（适用于"前进 1s"等窗口扩展操作）。
  - **不同会话**（`prefetchSessionId` 变更，即用户跳转到新位置或切换视频）：立即向当前任务发出协作取消信号，等待其在帧边界退出后，前端清空所有已渲染缩略图并重置为加载占位状态，再启动新任务。
- **FR-007**: 所有 prefetch 完成事件的 DONE 日志必须包含 `failed` 计数字段，其值应为 0；若不为 0，视为功能异常。
- **FR-008**: 一帧仅在其数据成功解码、编码并写入 DiskCache 后，才能计入已投递帧数（decoded 或 cache_hits）；未能落盘的帧必须计入 `failed`，系统不得虚报缓存成功。单帧失败时系统应跳过该帧并继续处理剩余帧，不中止整个 prefetch。
- **FR-009**: prefetch 解码策略必须优先处理 anchor 帧（用户当前播放位置所在帧），确保该帧是第一个完成解码并推送到前端的帧；anchor 帧推送完成后，再按顺序扩散解码范围内其余帧。
- **FR-010**: 系统全局同一时刻只允许运行一个 prefetch 解码任务（无论来自多少个客户端 tab）。新请求必须先获得 semaphore 独占权才能启动解码；是否在等待前发出协作取消信号，取决于 `prefetchSessionId` 是否变更（见 FR-006）。
- **FR-011**: 每个 prefetch SSE 请求必须在 query string 中携带 `prefetchSessionId` 参数（非空字符串）。该 ID 由前端以 `${itemId}:${Math.round(anchorMs / 5000) * 5000}` 格式确定性生成（5s 粒度取整），使得同一视频、同一锚定位置（±5s 内）的 modal 关闭后重新打开时恢复相同 ID，不依赖随机数。后端以此字段判断会话归属，进而决定取消行为（FR-006, FR-010）。

### Key Entities

- **prefetch 请求**: 由用户当前播放位置触发，包含目标时间范围和帧列表（fi_idx + pos_ms），以及 `prefetchSessionId`。
- **prefetch 会话 (prefetch session)**: 以 `prefetchSessionId` 标识的一组相关 prefetch 请求，对应用户在同一上下文（同一视频、同一锚定位置）内的整个 modal 操作序列。`prefetchSessionId` 由 `${itemId}:${Math.round(anchorMs / 5000) * 5000}` 确定性生成，关闭后重新打开同一位置的 modal 将恢复相同 ID。同一会话内的"前进/后退 1s"等窗口扩展操作不中断解码、不清空已渲染缩略图。
- **帧目标 (target frame)**: 请求中的单个帧，由帧号（显示顺序索引）和毫秒时间戳唯一标识。
- **DiskCache 条目**: 以 (item_id, pos_ms, width) 为 key 缓存的 WebP 图像，与帧号无关。
- **SSE 事件流**: 从解码服务到前端的流式推送通道，每帧解码完成立即触发一个事件。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 23fps 普通视频 prefetch 首帧在用户触发请求后 1 秒内出现在 UI 上。
- **SC-002**: 60fps AV1 4K 视频 prefetch 首帧（anchor 帧）在用户触发请求后 5 秒内出现在 UI 上（5s 为容忍上限；当前全范围顺序扫描需 3–4 秒，anchor 优先策略预期进一步缩短首帧延迟）；后续帧逐个渲染，用户能持续看到画面更新，不存在长时间"无任何变化"的等待状态。
- **SC-003**: 任意格式、任意位置的 prefetch 请求，帧投递完成率达到 100%（DONE: failed=0），不再出现 prefetch_no_match 丢帧。
- **SC-004**: 每帧完成解码后，该帧图像在 500ms 内出现在前端 UI（从 FIRST_DECODE_READY 到前端 first_thumb 的延迟，当前实测已达 1ms，维持此水平）。
- **SC-005**: 连续快速 seek 场景下，旧 prefetch 任务取消后新位置首帧响应时间不超过单次首帧时间的 2 倍。

## Clarifications

### Session 2026-06-07

- Q: 新 prefetch 触发时，前端已渲染的旧位置缩略图如何处理？→ A: 立即清空所有格子，全部重置为加载占位状态。
- Q: 单帧解码失败时系统如何处理？→ A: 仅在帧数据成功写入 DiskCache 后才计为已投递；未落盘的帧计入 failed，不得虚报成功；跳过失败帧并继续处理剩余帧。
- Q: prefetch 解码顺序是否需要优先处理 anchor 帧（当前播放位置）？→ A: 是，优先解码 anchor 帧，再按顺序扩散到范围内其余帧。
- Q: 多 tab 并发 prefetch 请求如何处理（单进程内）？→ A: 全局队列，同一时刻只允许一个 prefetch 任务运行，新请求到来时取消当前正在运行的任务。
- Q: encode_webp_lossless 是否是需要优化的性能瓶颈？→ A: 不是。用户不介意逐帧 2.5s 的编码速度，只要图像在逐个出现。真正的瓶颈是"prefetch 触发后首图长时间不出现"；性能优化目标是最小化首帧出现延迟，而非提升每帧吞吐量。

## Assumptions

- 4K AV1 60fps 视频的 encode_webp_lossless（原图全尺寸编码）约 2.5 秒/帧，但这不是用户体验瓶颈：图像逐帧流式出现时，用户对单帧 2.5s 的等待是可接受的。encode_webp_lossless 速度不在本 feature 的优化范围内。
- 帧号（fi_idx）在前端 UI 网格中以显示顺序（PTS 顺序）为准，与容器中的包序（DTS 顺序）可能不同。
- DiskCache 以 pos_ms 为 key，不依赖 fi_idx，因此时间戳修正不会影响缓存命中逻辑。
- 当前 SSE 流式传输的传输延迟（Rust → C# → 前端）已经很低（实测 ~1ms），该路径不是优化重点。
- prefetch 任务取消（FR-006）在解码器层面的实现可能受限于 ffmpeg 解码 API 的同步特性，实际取消粒度为"帧级"而非"立即中断"。
