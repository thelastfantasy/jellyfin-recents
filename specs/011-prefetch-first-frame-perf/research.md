# Research: Prefetch First-Frame Latency & Frame Delivery

**Date**: 2026-06-07  
**Feature**: 011-prefetch-first-frame-perf

---

## Decision 1: B 帧时间戳修正方案

### 问题
`demux_frames` 在包级别读取 `pkt.pts().or_else(|| pkt.dts())`，而 `decode_range` 用 `frame.pts()` 匹配目标帧。对于 B 帧，DTS ≠ PTS，最大偏差约 1–2 帧周期（60fps 时 ≈16–33ms）。原容差 ±0.5 帧（9ms）导致 ~30% B 帧匹配失败。

### 选项

**选项 A（已实现）：decode 端改用 best_effort_timestamp + 扩大容差至 ±2 帧**
- 在 `decode_range` 中改用 `(*frame.as_ptr()).best_effort_timestamp`
- 容差从 9ms 扩大到 33ms（2 帧周期）
- 加 decoder flush（防止尾帧残留）
- 实测结果：AV1 5360664ms 位置 119/119 全匹配

**选项 B（方案三）：demux 端引入 Codec Packet Parser 获取真实 PTS**
- 使用 `av_parser_init` + `av_parser_parse2`（ffmpeg-sys-next 7.1.3 FFI 绑定，✅ 已暴露）
- 需要 unsafe 代码 + 初始化 `AVCodecContext`（仅用于解析，不做全帧解码）
- 真正消除跨阶段不一致，无需容差窗口
- 复杂度：高（需处理 parser 生命周期、内存安全）

**选项 C：相关性校准（heuristic）**
- 首次 decode_range 时记录 DTS→PTS 映射关系，回写修正索引
- 复杂度：中，但对首次 prefetch 无效

### 决定
**首选选项 A**（已完成并通过 check）作为立即有效的修复。  
**选项 B 列为 Stage 1b**：结构性改进，提供长期正确性保证，但不阻塞其他 Stage 交付。

**依据**：选项 A 实测已解决测试用例；选项 B 是架构正确性投资，在 AV1 Parser FFI 实现复杂的情况下可以后续迭代。

---

## Decision 2: Anchor 帧首帧优先策略

### 问题
`decode_range` 从范围起点顺序扫描，anchor 帧（用户当前位置）在范围中段，需等待前半段所有帧解码完才出现，导致首帧延迟高于必要值。

### 选项

**选项 A：先用 decode_and_encode 解码 anchor，再起 decode_range**
- `decode_and_encode(anchor_ms)` 单帧单次 seek，独立于 range scan
- anchor 帧解码完成后立即 SSE 推送
- 同时或随后在 spawn_blocking 中执行 `decode_range` 覆盖全范围
- 缺点：anchor 帧被解码两次（一次独立，一次在 range scan 中再次命中，但因 DiskCache 缓存命中跳过编码）
- anchor 已在 DiskCache → range scan 遇到时直接从缓存取，无重复解码

**选项 B：修改 decode_range 支持"anchor first"模式**
- decode_range 先 seek 到 anchor 解码 1 帧，再 seek 回范围起点扫描
- 多一次 seek，对 AV1 长 GOP 有额外开销

**选项 C：保持现有顺序（不做优先）**
- 现状：FIRST_DECODE_READY 是范围内第一个未缓存帧（不一定是 anchor）

### 决定
**选项 A**：独立 decode_and_encode 解码 anchor，与 decode_range 并发执行（anchor 通道先推 SSE，range 继续填充其余帧）。anchor 已缓存后 range scan 直接命中缓存跳过重复编码。

---

## Decision 3: 全局单任务 + 取消机制

### 现状（server.rs 分析）
- `State.decode_sem: Arc<Semaphore>(1)`：同时只有 1 个解码任务持锁
- 6 个 prefetch worker 从 mpsc 通道取任务，竞争 semaphore
- 无显式 CancellationToken：只依赖 stream shutdown（pipe break）中止
- 问题：旧 prefetch 正在 decode_range 内解码时，新请求必须等到 semaphore 释放才能开始

### 决定
**添加 `cancel_flag: Arc<AtomicBool>` 到 State**：
- 每次新 prefetch 开始时，set cancel_flag = true（取消旧任务）
- `decode_range` 内层循环在每帧解码后检查 cancel_flag，若 true 则提前 `break 'outer`
- 新任务开始前 reset cancel_flag = false
- `handle_prefetch_range_stream` 在启动 decode_range 前 set cancel + reset

这比 CancellationToken 更轻量，与现有 AtomicBool 模式一致（参考 `IndexProgress.done`）。

---

## Decision 4: 精确帧计数（FR-008）

### 现状
- `on_frame` 回调在解码+编码完成后被调用
- 写 DiskCache 失败时回调内的 panic/error 冒泡，整个 prefetch 中止
- 没有单帧失败的跳过+计数机制

### 决定
- `decode_range` 的 `on_frame` 返回 `Result<()>`：`Ok` = 成功，`Err` = 跳过（不中止）
- 在 server.rs 的接收端捕获单帧错误，`failed++`，继续处理下一帧
- DONE 日志新增 `failed=N` 字段（已在部分测试日志中看到，补全到所有路径）

---

## Findings: ffmpeg-next v7 Parser API

| 项目 | 结果 |
|------|------|
| `av_parser_parse2` FFI 绑定 | ✅ 存在于 ffmpeg-sys-next 7.1.3 |
| `av_parser_init` / `av_parser_close` | ✅ 存在 |
| ffmpeg-next 高级 Rust 封装 | ❌ 不存在，需 unsafe |
| 需要 `AVCodecContext` | ✅ 是（仅初始化，无需解码） |
| 实现复杂度 | 高（unsafe 内存管理） |

**结论**：方案三可实现，但需要约 100+ 行 unsafe 代码。推迟到 Stage 1b。

---

## Findings: server.rs 架构

| 项目 | 结果 |
|------|------|
| 文件大小 | 1523 行 |
| 并发模型 | Tokio async + 6 prefetch workers + Semaphore(1) |
| `handle_prefetch_range_stream` 位置 | 第 1309 行 |
| 现有取消机制 | AtomicBool（done 标记）+ stream shutdown |
| 全局 State 字段 | ram(LRU), disk(DiskCache), decode_sem, prefetch_tx, in_progress, fi |
| anchor 帧优先处理 | ❌ 未实现（当前为范围起点顺序扫描） |
| failed 计数 | 部分实现（部分路径有，不完整） |
