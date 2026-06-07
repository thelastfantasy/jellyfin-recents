# Implementation Plan: Prefetch First-Frame Latency & Frame Delivery

**Branch**: `feature/009-frame-export-stitch` | **Date**: 2026-06-07 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification from `specs/011-prefetch-first-frame-perf/spec.md`

## Summary

优化剪辑工坊 prefetch 的首帧延迟与帧投递完整性。核心目标：
1. 彻底修复 B 帧 DTS/PTS 不一致导致的帧匹配失败（~30% 丢帧）
2. 优先解码 anchor 帧，使首图尽快出现在 UI
3. 实现全局单任务 + 协作式取消，防止请求积压
4. 精确帧计数与前端 UI 即时重置

技术路径：Rust `crates/jfs-common/src/decoder.rs` + `crates/frame-forge/src/server.rs` + TypeScript 前端。

## Technical Context

**Language/Version**: Rust 1.x（frame-forge, jfs-common）/ TypeScript + Preact（前端）/ C#（Jellyfin 插件）  
**Primary Dependencies**: ffmpeg-next 7.1.0, ffmpeg-sys-next 7.1.3, tokio async runtime, webpx  
**Storage**: DiskCache（文件系统，key = item_id+pos_ms+width），Unix socket（Rust↔C# IPC），RAM LRU（100条）  
**Testing**: `mise run test`（cargo test + vitest + dotnet test）  
**Target Platform**: Linux Docker 容器（frame-forge Rust sidecar）+ Jellyfin .NET 插件  
**Performance Goals**: anchor 帧首图 ≤1s（23fps）/ ≤5s（4K AV1 60fps）；逐帧流式渲染，无长时间空白等待  
**Constraints**: 全局同时只允许 1 个 prefetch 任务；encode_webp_lossless 速度不是优化目标  
**Scale/Scope**: 单用户，单 Rust sidecar 进程，多 Tab 共享同一全局解码队列

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. No Functionality Loss — 无现有功能被移除或破坏 | ✅ | 纯内部优化，API 契约不变，仅新增 `failed` 字段（向后兼容） |
| II. Structural Invariance — CSS/import 顺序保持不变 | N/A | 无 CSS 改动 |
| III. Test Gate — 每 Stage 结束前 `mise run test` 通过 | ✅ | 计划中每 Stage 定义验证命令 |
| IV. Build Gate — `mise run update` + CI 通过 | ✅ | 每 Stage 部署验证 |
| V. Incremental Verification — 每 Stage 的验证命令已定义 | ✅ | 见下方各 Stage |
| VI. Git History Preservation — 无文件移动 | N/A | 纯逻辑修改，无文件迁移 |
| VII. Structure/Logic Separation — 结构与逻辑变更分离 | ✅ | 全部为逻辑改动，无目录结构变化 |

## Project Structure

### Documentation (this feature)

```text
specs/011-prefetch-first-frame-perf/
├── plan.md              ← 本文件
├── research.md          ← Phase 0 输出
├── data-model.md        ← Phase 1 输出
├── spec.md              ← 规格文档
├── contracts/
│   └── prefetch-sse.md  ← SSE 契约
└── tasks.md             ← /speckit-tasks 输出（待生成）
```

### Source Code (修改范围)

```text
crates/jfs-common/src/
└── decoder.rs           ← Stage 1a（已完成）+ Stage 1b（Parser PTS）

crates/frame-forge/src/
└── server.rs            ← Stage 2（anchor 优先）+ Stage 3（取消机制）+ Stage 4（帧计数）

apps/frontend/src/
└── [prefetch 相关组件]   ← Stage 4（UI 重置）
```

---

## Stage 1a: B 帧时间戳修正（best_effort_timestamp）✅ 已完成

> **状态**: 代码已修改，`mise run check-frame-forge` 通过，尚未部署

### 已修改

**`crates/jfs-common/src/decoder.rs`** — `decode_range` 函数：
- `frame.pts()` → `(*frame.as_ptr()).best_effort_timestamp`（FFI，避免 DTS fallback 错误）
- 容差从 ±0.5 帧（9ms）扩大到 ±2 帧（33ms at 60fps）
- 解码完成后新增 decoder flush（`decoder.send_eof()` + 剩余帧处理），防止 AV1 尾帧丢失

### 验证命令

```bash
mise run check-frame-forge    # ✅ 已通过（exit code 0）
# 部署后验证：在 AV1 视频 5360664ms（1:29:20）触发 prefetch
# 预期: DONE cache_hits=X decoded=Y failed=0 且 X+Y=120
```

---

## Stage 1b: 方案三 — Parser-based demux PTS（架构正确性）

> **依赖**: Stage 1a 完成并部署

### 目标

在 `demux_frames` 阶段通过 `av_parser_parse2` 获取每个包的真实 PTS，彻底消除 demux 和 decode 阶段时间戳参照系不一致。

### 研究结论

- `av_parser_parse2` 在 ffmpeg-sys-next 7.1.3 中已有 FFI 绑定（✅）
- ffmpeg-next 无高级 Rust 封装（❌），需 unsafe 代码
- 需要初始化 `AVCodecContext`（仅解析用途，不做全帧解码）
- 实现复杂度：高（~150 行 unsafe）

### 实现要点

```rust
// 伪代码：demux_frames 中使用 Parser
unsafe {
    let parser = ffi::av_parser_init(codec_id as i32);
    let mut avctx = ffi::avcodec_alloc_context3(codec);
    ffi::avcodec_parameters_to_context(avctx, stream.parameters().as_ptr());
    
    for (stream, pkt) in ictx.packets() {
        let mut out_data = ptr::null_mut();
        let mut out_size = 0i32;
        ffi::av_parser_parse2(
            parser, avctx,
            &mut out_data, &mut out_size,
            pkt.data().as_ptr(), pkt.size() as i32,
            pkt.pts().unwrap_or(ffi::AV_NOPTS_VALUE),
            pkt.dts().unwrap_or(ffi::AV_NOPTS_VALUE),
            pkt.pos(),
        );
        // 使用 parser 输出的 pts（经 codec 规则修正）
        let corrected_pts = (*parser).pts;  // AVCodecParserContext.pts
    }
    
    ffi::av_parser_close(parser);
    ffi::avcodec_free_context(&mut avctx);
}
```

### 验证命令

```bash
mise run check-frame-forge
# 部署后：AV1 5360664ms → decoded=120, failed=0（与 Stage 1a 结果相同或更好）
# 额外验证：H.264 B 帧视频同一位置
```

---

## Stage 2: Anchor 帧首帧优先

> **依赖**: Stage 1a 完成并部署

### 目标

用户跳转后，anchor 帧（当前播放位置）必须是第一个推送到前端的 frameReady 事件（FR-009）。

### 实现方案

**`crates/frame-forge/src/server.rs`** — `handle_prefetch_range_stream`：

```rust
// 当前流程：先缓存检查，然后一次性 decode_range 顺序扫描
// 新流程：

// 步骤 1：检查 anchor 帧是否已在缓存
if disk_cache.exists(item_id, anchor_ms, width) {
    // 直接从缓存推送 anchor frameReady
    send_sse_frame(anchor_fi, anchor_ms, ...);
} else {
    // 步骤 2a：用 decode_and_encode 单独解码 anchor（单次 seek，最快）
    let anchor_result = spawn_blocking(|| decode_and_encode(path, anchor_ms, width)).await?;
    disk_cache.write(item_id, anchor_ms, width, &anchor_result.webp);
    send_sse_frame(anchor_fi, anchor_ms, ...);
}

// 步骤 3：decode_range 处理剩余帧（anchor 已在 DiskCache，range scan 会自动命中跳过）
// anchor 帧在 range scan 中 cache_hits++，不重复解码
spawn_blocking(|| decode_range(path, targets_excluding_anchor_if_cached, width, on_frame)).await?;
```

**关键点**：
- `decode_and_encode` 已有实现，专为单帧优化
- anchor 写入 DiskCache 后，后续 `decode_range` 的缓存检查会命中，不重复编码
- 并发：anchor 解码在 await，range decode 在后续 spawn_blocking（顺序，非并发）

### 验证命令

```bash
mise run check-frame-forge
# 部署后：bench 日志中 FIRST_DECODE_READY fi=<anchor_fi>
# 验证：在任意视频位置触发 prefetch，检查 fi_idx 是否为 anchor 帧的帧号
```

---

## Stage 3: 全局单任务 + 协作式取消

> **依赖**: Stage 2 完成并部署

### 目标

同一时刻只允许 1 个 prefetch 任务运行（FR-010）；新任务到来时，旧任务在帧级别被取消。

### 实现方案

**`crates/frame-forge/src/server.rs`** — State 结构 + decode_range：

```rust
// 1. State 新增字段
pub struct State {
    // ...现有字段...
    cancel_flag: Arc<AtomicBool>,  // 协作式取消标志
}

// 2. handle_prefetch_range_stream 开始时
state.cancel_flag.store(true, Ordering::SeqCst);   // 通知旧任务退出
// 旧任务在当前帧处理结束后检查 cancel_flag 并 break 'outer，随即释放 decode_sem。
// 通过 acquire() 等待代替固定 sleep：单帧编码最长可达 2.5s，任何固定时长都不安全。
let _permit = state.decode_sem.acquire().await?;
state.cancel_flag.store(false, Ordering::SeqCst);   // 重置为新任务准备

// 3. decode_range 内层循环（jfs-common/src/decoder.rs）
// decode_range 新增参数：cancel: Arc<AtomicBool>
if cancel.load(Ordering::Relaxed) {
    break 'outer;  // 协作退出
}
```

**注意**：`decode_and_encode`（anchor 解码）不需要取消检查，因为它是单帧操作（<5s）。

### 验证命令

```bash
mise run check-frame-forge
# 部署后：两个浏览器 tab 快速连续触发 prefetch
# 预期：第一个 prefetch 的 bench 日志出现提前终止（to_process 未完成就结束），第二个正常完成
```

---

## Stage 4: 精确帧计数 + 前端 UI 重置

> **依赖**: Stage 3 完成并部署

### 目标

- 后端：`failed` 计数精确（FR-008），仅 DiskCache 落盘成功的帧计为 decoded
- 前端：新 prefetch 触发时立即清空所有缩略图格子（FR-006）

### 后端实现

**`crates/frame-forge/src/server.rs`**：

```rust
// on_frame 回调内
let write_result = state.disk.write(item_id, target_ms, width, &webp_thumb, &webp_orig);
match write_result {
    Ok(_)  => { decoded += 1; send_sse_frame(...); }
    Err(e) => { failed  += 1; log::warn!("cache write failed: {e}"); }
}

// DONE 事件（所有路径统一包含 failed 字段）
send_sse_done(cache_hits, decoded, failed);
```

### 前端实现

**`apps/frontend/src/`** — prefetch 状态管理：

```typescript
// 新 prefetch 开始时（收到 prefetch_triggered 事件或开始 SSE 连接）
function onNewPrefetchStart() {
    // 立即清空所有缩略图格子，重置为 loading skeleton
    setThumbnails(new Array(totalFrames).fill(null));
}
```

### 验证命令

```bash
pnpm -C apps/frontend eslint
mise run test
# 部署后：
# 1. 触发 prefetch，中途跳转到新位置 → 旧缩略图立即清空，新位置开始加载
# 2. 检查 DONE 日志中 failed=0（正常情况）
# 3. 构造磁盘写失败场景（磁盘满/权限）→ 验证 failed++ 而非 crash
```

---

## 全局验证（所有 Stage 完成后）

```bash
mise run test        # Rust + TypeScript + C# 全套测试
mise run update      # 构建部署到 jellyfin-dev
```

**功能验证清单**：
- [ ] AV1 5360664ms 位置：`DONE decoded=120 failed=0`（B 帧修复）
- [ ] 任意位置：`FIRST_DECODE_READY fi=<anchor_fi>`（anchor 优先）
- [ ] 23fps 首帧 ≤1s，4K AV1 首帧 ≤5s（SC-001 / SC-002）
- [ ] 多 Tab 并发：第二个请求取消第一个（FR-010）
- [ ] re-seek：旧缩略图立即清空（FR-006）
- [ ] 所有路径 DONE 包含 `failed=0`（FR-008）
