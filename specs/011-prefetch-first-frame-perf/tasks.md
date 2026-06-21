# Tasks: Prefetch First-Frame Latency & Frame Delivery

**Input**: Design documents from `specs/011-prefetch-first-frame-perf/`  
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/prefetch-sse.md ✅

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行执行（不同文件，无未完成依赖）
- **[Story]**: 对应 spec.md 中的 User Story（US1/US2/US3）
- Setup/Foundational 阶段无 Story 标签

---

## Phase 1: Setup

**Purpose**: 无需额外环境初始化，项目结构完整，跳过此阶段。

---

## Phase 2: Foundational（Stage 1a 已实现）

**Purpose**: Stage 1a（best_effort_timestamp + ±2 帧容差 + decoder flush）代码已完成并通过 `mise run check-frame-forge`，覆盖 FR-003、FR-004、FR-005。部署验证统一在 Phase 6 T017 执行，无中间部署。

**Checkpoint**: 无阻塞依赖，Phase 3–5 可立即并行开展。

---

## Phase 3: User Story 2 — All Requested Frames Delivered (P1) 🎯

**Goal**: 方案三——在 demux 阶段通过 Codec Packet Parser 获取真实 PTS，彻底消除跨阶段时间戳不一致，确保任意编码格式、任意位置 0 丢帧（FR-002, FR-003, FR-007, FR-008）。

**Independent Test**: 在 AV1 5360664ms（1:29:20）触发 120 帧 prefetch，验证 `DONE cache_hits+decoded=120 failed=0`；在 H.264 B 帧位置重复验证。

- [X] T002 [US2] 在 `crates/jfs-common/src/decoder.rs` 的 `demux_frames` 中引入 `av_parser_parse2` FFI（`ffmpeg-sys-next` 已暴露），通过 Codec Parser 获取每个数据包的真实 PTS，替代 `pkt.pts().or_else(|| pkt.dts())` 回退 DTS 的方式；若 `av_parser_init` 返回 NULL 则以 `warn` 日志标记后回退（不得静默，FR-002 例外条款）；`output_size == 0` 的包（AV1 non-show frames）不记录到帧索引
- [X] T003 [US2] `mise run check-frame-forge` 验证 0 error（Parser FFI 代码是 unsafe，需仔细检查内存管理：`av_parser_init` / `av_parser_close` 配对，`AVCodecContext` 分配与释放）
- [ ] T004 [US2] 验证（在 T017 最终部署后执行）：AV1 5360664ms → `decoded=120 failed=0`；H.264 B 帧视频测试位置同等验证（注：Stage 1a ±2 帧容差可能 119/120；Parser PTS 后应精确=120）

**Checkpoint**: US2 完成——任意 B 帧视频 prefetch 丢帧率 0%。

---

## Phase 4: User Story 1 — First Thumbnail Appears Quickly (P1) 🎯

**Goal**: Anchor 帧优先解码策略——用户跳转后，anchor 帧（当前播放位置）的缩略图必须最先出现在 UI，而非等待从范围起点顺序扫描到 anchor 位置（FR-009, SC-001, SC-002）。

**Independent Test**: 在任意视频位置触发 prefetch，bench 日志中 `FIRST_DECODE_READY fi=<anchor_fi>`；计时从跳转到首图渲染成功 ≤1s（23fps）/ ≤5s（4K AV1）。

- [X] T005 [P] [US1] 在 `crates/frame-forge/src/server.rs` 的 `handle_prefetch_range_stream` 中实现 anchor 帧优先策略：先检查 anchor 帧是否在 DiskCache；若未命中则调用 `decode_and_encode(anchor_ms)` 单帧解码（单次 seek，最快），写入 DiskCache 并立即 SSE 推送 frameReady；再启动 `decode_range` 扫描其余帧（anchor 已缓存，range scan 遇到时直接 cache_hits++）
- [X] T006 [US1] `mise run check-frame-forge` 验证 0 error
- [ ] T007 [US1] 验证（在 T017 最终部署后执行）：bench 日志 `FIRST_DECODE_READY fi` 始终等于 anchor 帧的 fi_idx；23fps 首图 ≤1s，4K AV1 首图 ≤5s；确认 SSE 仍以逐帧形式推送（每帧 decode 后立即一条 frameReady，非批量，FR-001 回归检查）

**Checkpoint**: US1 完成——anchor 帧总是第一个推送，首帧延迟达标。

---

## Phase 5: User Story 3 — 进度条拖动体验流畅 (P2)

**Goal**: 全局单任务 + 协作式取消——新 prefetch 请求到来时，正在运行的旧任务在帧级别被取消，资源立即释放，新任务首帧不受积压延迟影响（FR-010, FR-006, SC-005）。

**Independent Test**: 两个浏览器 Tab 快速连续触发 prefetch；第一个任务的 bench 日志显示提前终止（to_process 未满就结束），第二个任务正常完成。前端旧缩略图立即清空并重置为加载状态。

- [X] T008 [US3] 在 `crates/jfs-common/src/decoder.rs` 的 `decode_range` 函数签名中新增 `cancel: Arc<AtomicBool>` 参数，内层帧循环中每帧处理后检查 `cancel.load(Ordering::Relaxed)`，若为 true 则 `break 'outer`（协作退出，不是强制中断）；同步更新 `pub use` 声明和 `lib.rs`
- [X] T009 [US3] 在 `crates/frame-forge/src/server.rs` 的 `State` 结构体中新增 `cancel_flag: Arc<AtomicBool>` 字段；`handle_prefetch_range_stream` 开始时 `cancel_flag.store(true, SeqCst)` 通知旧任务退出，再通过 `decode_sem.acquire().await` 等待旧任务释放锁（旧任务在当前帧处理结束后检查 cancel_flag 并 break，释放 sem），然后 `cancel_flag.store(false, SeqCst)` 重置并传入 cancel_flag 调用 `decode_range`；不使用固定 sleep（单帧编码最长 2.5s，固定值不安全）；FR-010：全局同时只允许一个 prefetch 任务
- [X] T010 [US3] `mise run check-frame-forge` 验证 0 error（注意 decode_range 调用方的参数都需要同步更新）
- [ ] T011 [US3] 验证（在 T017 最终部署后执行）：并发 prefetch 测试（两 Tab 快速切换），旧任务提前终止，新任务首帧正常出现；前端新 prefetch 触发时旧缩略图立即清空

**Checkpoint**: US3 完成——快速 seek 场景下新 prefetch 不受旧任务积压影响。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 精确帧计数、前端 UI 重置，以及全套验证。

- [X] T012 [P] 在 `crates/frame-forge/src/server.rs` 的所有 prefetch 完成路径统一输出 `done` 事件时包含 `failed=N` 字段（FR-008）；`on_frame` 回调内 DiskCache 写入失败时 `failed++` 而非 panic/abort；DONE 日志格式：`cache_hits=X decoded=Y failed=Z`
- [X] T013 [P] ~~在前端 prefetch 状态管理代码中，新 prefetch 开始时立即清空所有缩略图格子~~ → 已被 T020 会话感知版本取代，当前实现为无条件重置（临时）
- [X] T014 `mise run check-frame-forge` 验证 Rust 修改 0 error
- [X] T015 `pnpm -C apps/frontend run lint` 或等价 eslint 命令验证前端修改
- [X] T016 `mise run test` 全套测试（Rust + TypeScript + C#）

---

## Phase 7: Prefetch 会话感知（Session-Aware Cancel）

**Goal**: 引入 `prefetchSessionId`，使同一 modal 上下文内的连续 prefetch 请求（如"前进 1s"）不中断当前解码、不清空已渲染缩略图；只有切换位置或切换视频（session 变更）才触发协作取消和 UI 重置（FR-006, FR-010, FR-011）。

**Independent Test**: 同一 modal 中正在加载帧时点击"后 1s"，确认已加载的缩略图保持显示（不闪烁清空），新帧持续追加；快速在两个不同位置来回切换，确认旧帧被清空、新 session 首帧正常出现。

- [X] T018 [P] [US3] 在 `apps/player-enhancer/src/components/FrameExportModal.tsx` 中：modal 收到 `itemId` 和初始 `anchorMs`（打开时的播放位置）时，生成 `prefetchSessionId = \`${itemId}:${Math.round(anchorMs / 5000) * 5000}\``（5s 粒度，确定性，关闭重开同位置恢复相同 ID）；将 `prefetchSessionId` 存入组件 state；每次调用 `openPrefetchRangeStream` 时将其作为 query param `prefetchSessionId` 传入；"前进/后退 1s"等窗口操作复用当前 `prefetchSessionId`，用户主动跳转到新位置（如重新打开 modal 到不同时间点）时才更新
- [X] T019 [P] [US3] 在 `apps/player-enhancer/src/api/frameExportApi.ts` 的 `PrefetchRangeParams` 中新增 `prefetchSessionId: string` 字段，随 POST body 发送；同步更新所有调用方
- [X] T020 [US3] 在 `crates/frame-forge/src/server.rs` 的 `handle_prefetch_range_stream` handler 中读取 `session_id`；`State` 新增 `current_session_id: std::sync::Mutex<Option<String>>` 字段；session 变更 → `cancel_flag.store(true)` + 更新 session；相同 session → 跳过 cancel；两种情况都等 semaphore 再 `cancel_flag.store(false)`；同步更新 `protocol.rs` 中的 `PrefetchRangeStreamReq` 和 C# 端的 DTO / Service / Controller
- [X] T021 [US3] 在 `apps/player-enhancer/src/components/FrameExportModal.tsx` 的 `triggerPrefetch` 中：将 T013 的无条件 `setFrames` 重置改为**仅在 session 变更时**执行（`lastSessionIdRef` 记录上次 session，不同时才清空）；同 session 内调用时跳过清空，已渲染帧保持显示
- [X] T022 [US3] `mise run check-frame-forge` 验证 Rust 修改 0 error
- [X] T023 [US3] eslint 验证前端修改 0 error
- [X] T024 `mise run test` 全套测试通过（TS 17/17，C# 76/76）
- [ ] T017 `mise run update` 最终部署，执行全局验证清单：Stage 1a 基准（AV1 5360664ms DONE decoded+cache_hits≥119 failed=0）/ Parser PTS（T004: AV1 decoded=120）/ anchor 首帧（T007: FIRST_DECODE_READY fi=anchor_fi）/ 并发取消（T011: 旧任务提前终止）/ 会话感知取消（同 session 不清空，不同 session 清空）/ DONE failed=0

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 2 (Foundational)**: 无依赖，立即开始（Stage 1a 代码已实现，无部署步骤）
- **Phase 3 (US2)**: 无阻塞依赖，可立即开始（Stage 1a 代码已实现，不等待部署）
- **Phase 4 (US1)**: 依赖 Phase 2 完成；可与 Phase 3 并行（T005 在 server.rs，T002 在 decoder.rs demux_frames，不冲突）
- **Phase 5 (US3)**: 依赖 Phase 4 完成（T009 在 server.rs 与 T005 有冲突），依赖 Phase 3 的 decoder.rs 修改稳定后再添加 cancel 参数（T008）
- **Phase 6 (Polish)**: 依赖 Phase 3、4、5 全部完成
- **Phase 7 (Session-Aware)**: 依赖 Phase 5/6 完成（在 cancel 机制稳定后叠加 session 层）；T018/T019（前端）和 T020（后端）可并行；T021（前端 UI 重置调整）依赖 T018 完成

### User Story Dependencies

- **US2 (Phase 3)**: 无阻塞依赖；可与 US1(T005 server.rs) 并行
- **US1 (Phase 4)**: 依赖 Phase 2；T005 (server.rs) 可与 T002 (decoder.rs) 并行
- **US3 (Phase 5)**: 依赖 US1 完成（server.rs 稳定后再加 cancel_flag）
- **US3 (Phase 7)**: 依赖 Phase 5 完成（在 cancel_flag 机制上叠加 session_id 判断）

### Parallel Opportunities

- T002（decoder.rs demux_frames Parser）和 T005（server.rs anchor 优先）可并行执行，文件不冲突
- T012（server.rs failed 计数）和 T013（前端 UI 重置）可并行执行
- T018/T019（前端 prefetchSessionId 生成 + API 参数）和 T020（后端 session-aware cancel）可并行执行，文件不冲突

---

## Parallel Example: Phase 3 + Phase 4 并行

```text
# 可同时开展（不同文件）：
Task T002: decoder.rs — demux_frames Parser PTS（方案三）
Task T005: server.rs — handle_prefetch_range_stream anchor 优先

# 分别完成 check 后，再各自部署验证
```

---

## Implementation Strategy

### MVP First（US1 + US2 最小可交付）

1. Phase 2: 部署 Stage 1a（T001）
2. Phase 4: Anchor 首帧优先（T005–T007）
3. Phase 3: 方案三 Parser PTS（T002–T004）
4. **STOP and VALIDATE**: 首帧延迟 ≤ 目标，丢帧率 0%
5. 用户可验收

### Incremental Delivery

1. Phase 2 → 基准建立（B 帧基本修复，已验证）
2. Phase 4（US1）→ 首帧体验改善 → 用户可感知
3. Phase 3（US2）→ 丢帧彻底消除 → 稳定性提升
4. Phase 5（US3）→ 快速 seek 体验 → 流畅感
5. Phase 6（Polish）→ 精确计数 + UI 细节 → 生产就绪
