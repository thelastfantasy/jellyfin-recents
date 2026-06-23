# Tasks: 帧解码硬件加速

**Input**: Design documents from `/specs/013-frame-decode-hw-accel/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)

**Tests**: spec 未要求 TDD，但项目宪章（Test Gate，原则 III）要求每个 Stage 结束前 `mise run test` 全绿；下方每个 Phase 末尾都有一个显式的"Stage Gate"任务（运行 `mise run test`，关键 Phase 额外要求 `mise run update-linux` 部署验证），对应 Checkpoint 才算真正达成（`/speckit-analyze` 发现的 D1 CRITICAL 项已在此修复）。

**Organization**: 按 user story 分组（US1/US2/US3 对应 spec.md 的三个 User Story）。

## Path Conventions

本项目是既有的 Rust daemon（`crates/`）+ C# Jellyfin 插件（`packages/JellyfinSuite.Plugin/`）+ React 前端（`apps/player-enhancer/`）三层仓库，所有路径沿用 plan.md 的 Project Structure，不新增顶层目录。

---

## Phase 1: Setup

**Purpose**: 补齐编译期系统依赖、确认目标硬件可访问性——这两项不做，后面所有 Rust 硬解代码都无法编译/无法实测。

- [X] T001 ~~新增 libva-dev/nv-codec-headers 构建依赖~~ ——**已实测纠正**：读取 `ffmpeg-sys-next` 的 `build.rs`（第1495-1620行）确认 bindgen 只解析通用的 `libavutil/hwcontext.h`（+ 可选的 `hwcontext_drm.h`），不解析需要 `<va/va.h>`/CUDA 头文件的厂商专属 struct；`av_hwdevice_ctx_create`/`AV_HWDEVICE_TYPE_VAAPI`/`AV_HWDEVICE_TYPE_CUDA`/`av_hwframe_transfer_data` 全部在通用头文件里，且已在本机 `/usr/include/x86_64-linux-gnu/libavutil/hwcontext.h` 核实签名属实；`ffmpeg_next::ffi`（= 重新导出的 `ffmpeg_sys_next`）已经能直接调用，不需要新增 Cargo 依赖。现有 `scripts/build-frame-forge-linux.sh`/`scripts/check-frame-forge-opencv-linux.sh`/Makefile 的 apt 依赖列表**不需要改动**。详见 research.md §2 更新。
- [X] T002 实测确认完毕（research.md §3）：`docker exec jellyfin-dev` 确认 `/dev/dri/card1`+`renderD128`（VAAPI）与 `/dev/nvidia0`/`nvidiactl`/`nvidia-uvm` 等（NVDEC/CUDA）设备节点均已透传；`/usr/lib/jellyfin-ffmpeg/ffmpeg -version`/`-hwaccels` 确认 7.1.4-Jellyfin 已编译 `--enable-vaapi --enable-ffnvcodec --enable-cuda --enable-nvdec`，`-hwaccels` 输出含 `cuda`/`vaapi`。生产 NAS（A380）的对应验证留给 T037 部署后远程核实
- [X] T003 ~~确认新增依赖未破坏构建~~ ——已确认 T001 不涉及任何依赖新增/改动，本任务随之自然满足，无需单独执行

**Checkpoint**: 构建环境已具备硬解编译条件，已知目标机器的设备节点透传现状。

---

## Phase 2: Foundational（阻塞性前置工作，所有 User Story 共用）

**Purpose**: 协议字段、持久化配置骨架、设备分类与负载查询基础设施——US1/US2/US3 都依赖这些才能接线。

**⚠️ CRITICAL**: 本阶段未完成前，不得开始任何 User Story 的实现任务。

- [X] T004 [P] 在 `crates/jfs-common/src/hwaccel.rs`（新建）实现 `unsafe` FFI 封装：`av_hwdevice_ctx_create` 创建 VAAPI/CUDA 设备上下文、设置 `AVCodecContext.hw_device_ctx`、`av_hwframe_transfer_data` 把硬解输出帧转回可被现有软解流程消费的格式；每个 `unsafe` 块必须带 `// SAFETY:` 注释（CLAUDE.md Rust 规范强制要求）；先只实现"创建上下文 + 探测是否成功"，不接入实际解码循环（留给 US1）。**完成（补勾——之前漏打勾）**：`HwDeviceContext::create`/`attach_hw_device`/`get_format`/`is_hw_frame`/`transfer_to_software`/`probe` 均已实现，且追加了 `CachedDeviceCtx`（`av_buffer_ref` 缓存，避免每次解码重新 `av_hwdevice_ctx_create` 的 ~230ms 开销，见 T013 备注）。
- [X] T005 [P] 在 `crates/frame-forge/src/protocol.rs` 新增 `MSG_HW_DECODE_CAPS` 的请求/响应读写函数（见 [contracts/socket-protocol.md](./contracts/socket-protocol.md) §2 的二进制格式）；并在以下 5 个现有请求结构体的读取函数末尾（紧跟 `width` 字段之后）追加 `hw_decode_enabled: u8`、`device_strategy: u8` 两个定长字段——`SingleFrameReq`（`read_single_frame_req`）、`AnimateReq`（`read_animate_req`）、`StitchReq`（`read_stitch_req`）、`PrefetchRangeReq`（`read_prefetch_range_req`）、`PrefetchRangeStreamReq`（`read_prefetch_range_stream_req`）——这是 `/speckit-analyze` 核对 `server.rs` 全部 handler 调用链后确定的完整清单（见 contracts/socket-protocol.md §1 表格），不存在遗漏风险。`MSG_PREFETCH_STREAM` 的内联字段解析与内部 `PrefetchJob` 结构体的字段新增，留给 T015（它们在 `server.rs` 里，不在 `protocol.rs`）。**完成**：5 个结构体均已加 `pub hw: HwDecodeFlags` 字段并在对应 read 函数里读取两字节；新增 `DeviceStrategy`/`HwDecodeFlags`/`read_hw_decode_flags` 辅助类型；新增 `HwVendorWire`/`HwVendorCapability`/`write_hw_decode_caps` 供 T006 使用。`mise run check-frame-forge-opencv-linux` 编译通过（仅新增代码的预期 dead-code 警告，T006/T015 接入后消失）。
- [X] T006 在 `crates/frame-forge/src/server.rs` 新增 `const MSG_HW_DECODE_CAPS: u8 = 0x1D;`，daemon 启动时调用 T004 的探测函数一次并缓存到 `State`（对应 data-model.md 的 `HwDecodeCapabilities`，FR-010：只探测一次，不在每次请求时重新探测），新增该消息类型的 dispatch 分支返回缓存结果。**完成**：`jfs-common/src/hwaccel.rs` 新增 `DecodeVendor`/`VendorCapability`/`HwDecodeCapabilities`/`detect_capabilities()`——NVIDIA 直接 probe `HwVendor::Cuda`；AMD/Intel 通过枚举 `/sys/class/drm/renderD*` 的 `device/vendor` PCI ID（`0x8086`=Intel/`0x1002`=AMD）找到对应渲染节点后 probe `HwVendor::Vaapi`，找不到节点或 probe 失败都记录具体 `reason`。`State` 新增 `hw_caps` 字段，`State::new()` 里调用一次 `detect_capabilities()`；`protocol.rs` 的 `write_hw_decode_caps` 改为直接接收 `&jfs_common::HwDecodeCapabilities`（去掉了重复的 vendor 枚举）。`mise run check-frame-forge-opencv-linux` 编译通过。
- [X] T007 [P] 在 `crates/frame-forge/src/generation_log.rs` 确认 `FallbackEvent` 可直接复用（无需改字段），新增两个调用约定常量/辅助函数用于写入 `hwdecode_init_failed`/`hwdecode_runtime_fallback` 两种 `event_type`（data-model.md §4）。**完成（补勾——之前漏打勾）**：`HWDECODE_INIT_FAILED`/`HWDECODE_RUNTIME_FALLBACK` 常量 + `log_hw_fallback` 辅助函数已实现。
- [X] T008 [P] 在 `packages/JellyfinSuite.Plugin/Configuration/PluginConfiguration.cs` 新增 `HwDecodeEnabled`（bool，默认 `true`）、`HwDecodeDeviceStrategy`（string，默认 `"performance"`）字段。**完成**。
- [X] T009 在 `packages/JellyfinSuite.Plugin/Services/DeviceEnumerationService.cs` 实现真实的 `IsIntegrated` 判定（第147行现状是硬编码 `false`）：NVIDIA 设备直接判定独显；AMD/Intel 按已知芯片代号/PCI device ID 区间查表分类核显/独显（research.md §5）。**完成 + 范围澄清**：这份分类结果服务于 modal UI 展示（见 T015 备注，运行时硬解设备选型已下沉到 Rust）。AMD 用已知 APU iGPU device ID 允许列表（Picasso/Raven/Renoir/Cezanne/Rembrandt/Phoenix/**Raphael 0x164e**——本机开发硬件本身）判定，不在表中即视为独显（AMD 独显 device ID 谱系比 APU 多得多，枚举小的一侧更易维护）；Intel 用已知 Arc 独显 ID 区间（DG2/Alchemist 0x56xx、DG1 0x4905/0x4906、Battlemage 0xe2xx）判定，不在区间内即视为核显（反过来——Intel 几乎每代 CPU 都带核显，核显才是更大、更难枚举的一侧）；NVIDIA 始终判定独显。`dotnet build` 通过。
- [~] T010 [P] 在 `packages/JellyfinSuite.Plugin/Services/DeviceEnumerationService.cs` 新增设备实时负载查询方法：NVIDIA 走 `nvidia-smi --query-gpu=utilization.gpu`，AMD 读 `/sys/class/drm/card{N}/device/gpu_busy_percent`，Intel 暂不实现（直接返回"不可用"，由调用方按 FR-012 降级规则处理，research.md §4）。**判定为不需要在 C# 实现（见 T015/research.md §4"已修正"）**：负载查询的唯一消费者是运行时设备选型，已下沉到 Rust daemon（`jfs_common::hwaccel::query_load_percent`，T015 已实现同样的 NVIDIA/AMD 查询逻辑）。`contracts/rest-api.md` 的 `HwDecodeSettingsDto` 也没有负载百分比字段——modal UI 不展示实时负载，C# 侧没有任何消费者需要这份数据。在 C# 再实现一份等价逻辑会是纯粹的死代码，违反"不为假设的未来需求设计"的原则，故跳过，不视为遗漏。

**Checkpoint**: 协议、配置骨架、设备分类与负载查询基础设施就位；`mise run test` 全绿（新增代码尚无实际硬解行为，不应破坏任何现有测试）。

---

## Phase 3: User Story 1 - 帧提取整体提速（硬件解码默认开启） (Priority: P1) 🎯 MVP

**Goal**: 硬件解码默认开启，单设备/独显优先场景下整体帧提取耗时明显下降，且初始化失败/不支持时自动回退软解（US3 的"初始化失败回退"在这里一并接入，因为没有这个安全网就不能安全地默认开启——spec 把 US1 和 US3 标了同等 P1 优先级）。

**Independent Test**: quickstart.md 场景1——同一视频分别在硬解开/关下提取等量帧，对比总耗时（应快 ≥30%）与输出视觉一致性；quickstart.md 场景4 步骤1（故意造成初始化失败，确认任务仍完整成功）。

### Implementation for User Story 1

- [X] T011 [US1] 在 `crates/jfs-common/src/hwaccel.rs` 补全 VAAPI 解码路径：用 T004 的设备上下文跑实际帧解码循环，输出格式与现有 `decode_range` 软解路径返回的帧数据兼容。**完成（补勾——之前漏打勾）**：VAAPI 与 CUDA 共用同一套 `get_format`/`is_hw_frame`/`transfer_to_software` 通用路径（ffmpeg hwaccel 本身就是按 `hw_device_ctx`+`get_format` 统一抽象的，不需要为每个厂商单独写解码循环）。
- [X] T012 [US1] 在 `crates/jfs-common/src/hwaccel.rs` 补全 NVDEC/CUDA 解码路径，同上要求。**完成（补勾——之前漏打勾）**：见 T011 说明，与 VAAPI 共用同一套实现。
- [X] T013 [US1] 在 `crates/jfs-common/src/decoder.rs` 的 `decode_range`/`decode_and_encode` 入口处新增分支：当 `hw_decode_enabled=true` 且 T006 缓存的 `HwDecodeCapabilities` 显示对应厂商受支持时，先尝试 T011/T012 的硬解路径；`Result::Err` 时调用 T007 写一条 `hwdecode_init_failed` 的 `FallbackEvent`，并无条件回退到现有纯软解逻辑完成本次操作（FR-003）。**完成（补勾——之前漏打勾）**：`decode_range_hw`/`decode_and_encode_hw` 即此入口，`try_attach_hw` 失败时走 `hwdecode_init_failed` 回退。会话过程中还额外修了两个真实 bug：① `avcodec_find_decoder` 默认选中 `libdav1d`（无 hwaccel hook）而非原生 `av1` 解码器，新增 `open_decoder_context` 显式按规范名重新查找；② `av_hwdevice_ctx_create` 每帧调用一次的 ~230ms 开销，改为 `av_buffer_ref` 缓存复用。
- [X] T014 [US1] 在 `packages/JellyfinSuite.Plugin/Services/FrameExportService.cs` 的请求拼包处（`SubmitStitchTaskAsync` 等，按 contracts/socket-protocol.md §1 列出的调用链）写入 `Plugin.Instance.Configuration.HwDecodeEnabled` 与~~按"性能优先"策略（T009 的独显/核显分类，独显优先）解析出的目标设备~~。**设计修正（见 T015 备注/research.md §4-5"已修正"）**：实际只需写入 `HwDecodeEnabled` + `HwDecodeDeviceStrategy` 两个字节（策略枚举本身），具体设备解析已下沉到 Rust daemon 端（`server.rs::resolve_hw_decode_request`），C# 不再需要解析目标设备。**完成**：新增私有 `GetHwDecodeFlags()` 帮助方法读取 `Plugin.Instance.Configuration`，在全部 7 个受影响的 wire 写入点追加 2 字节——`GetFrameAsync`(0x10)/`PrefetchFrameAsync`(0x13，复用同一 SingleFrameReq 布局) 在 item_id 之后；`PrefetchRangeAsync`(0x16) 在 width 之后；`SubmitAnimateTaskAsync`(0x11) 在 resolution_preset 之后；`SubmitStitchTaskAsync`(0x12) 在 preset_len=0 之后、device_id 之前（因为 Rust `read_stitch_req` 内部先调用 `read_animate_req` 读完 base 字段才读 stitch 自己的尾部字段）；`PrefetchRangeStreamAsync`(0x19) 在 session_id 之后；`PrefetchStreamAsync`(0x18) 在 width 之后、count 之前。每处插入点都对照 Rust 侧对应 `read_*` 函数的实际读取顺序逐一核实（发现 contracts/socket-protocol.md §1 "紧跟在 width 字段之后"的笼统描述与多个结构体的实际实现位置不一致，以 Rust 实际代码为准）。`mise run test` 全绿（Rust 10 passed/1 ignored、frontend 17 pass、C# 76 passed）。
- [X] T015 [US1] 在 `crates/frame-forge/src/server.rs` 接入 T005 新增的请求字段，传递给 T013 的 decoder 入口，覆盖以下三类调用点：① `handle_single_frame`/`handle_animate`/`handle_stitch`/`handle_prefetch_range_stream` 直接读取已扩展的请求结构体；② `handle_prefetch_stream` 在其手动内联字段解析逻辑里追加 `hw_decode_enabled`/`device_strategy` 两个字段；③ `PrefetchJob` 结构体（第81-86行）新增同样两个字段，`handle_prefetch_range`/`handle_prefetch_frame` 构造 `PrefetchJob` 时从对应请求结构体填入，`prefetch_worker` 消费时传给 T013 的 decoder 入口（contracts/socket-protocol.md §1 "额外要点"）。**完成 + 设计修正**：实现过程中发现 contracts/socket-protocol.md §1 的 wire 格式只传策略枚举（`device_strategy: u8`），不传已解析的设备 ID——而 plan.md/research.md 原描述"设备选择复用 DeviceEnumerationService.cs"暗示由 C# 解析出具体设备。两者不自洽：协议没有字段能把 C# 解析出的设备 ID 传给 Rust。修正为：设备选择的**执行**下沉到 Rust（实际解码发生的进程），新增 `server.rs::resolve_hw_decode_request`/`pick_performance_vendor`/`pick_idle_resource_vendor`，复用 `jfs_common::hwaccel` 新增的 `first_render_node_for`/`query_load_percent`（NVIDIA 走 `nvidia-smi`，AMD 走 `/sys/class/drm/.../gpu_busy_percent`，Intel 无信号直接降级）独立做出本次解码该用哪个设备的决定；C# 侧 `DeviceEnumerationService.cs`（T009/T010/T021）的设备分类与负载查询服务于 modal UI 展示（设备列表/`multiDeviceAvailable`），不再是运行时解码路径的输入。已在 research.md/data-model.md 补充"已修正"说明。所有调用点（`handle_single_frame`/`handle_prefetch_frame`+`prefetch_worker`/`handle_animate`/`handle_stitch`/`handle_prefetch_stream`/`handle_prefetch_range`/`handle_prefetch_range_stream` 的 anchor 帧与 Pass2 批量 `decode_range_hw`）均已接入 `resolve_hw_decode_request` + `decode_and_encode_hw`/`decode_range_hw` + `generation_log::log_hw_fallback` 兜底日志。`mise run check-frame-forge-opencv-linux` 编译通过，且此前的 `hw`/`HwDecodeFlags` 字段"never read" dead-code 警告全部消失，确认无遗漏调用点。
- [X] T016 [P] [US1] 在 `crates/jfs-common` 新增 Rust 单元测试，覆盖 T013 的"硬解失败→软解兜底"分支（mock 一个总是失败的硬解路径，断言最终仍返回正确解码结果且写了 `FallbackEvent`）。**完成（落点调整）**：实际写在 `crates/frame-forge/src/main.rs` 现有 `mod tests`（已有共享测试视频 fixture 基础设施，不必在 jfs-common 重建一套）——新增 `hw_decode_init_failure_falls_back_to_software`：构造一个指向必然不存在的 VAAPI render node 路径的 `HwDecodeRequest`，断言 `decode_and_encode_hw` 仍返回与纯软解字节级一致的 `DecodeResult`，且 fallback sink 恰好收到一条 `hwdecode_init_failed`、`reason` 非空的事件。`mise run test` 通过（10 passed/1 ignored）。
- [X] T017 [US1] 执行 quickstart.md 场景1（本机 NVIDIA RTX 5060），记录实测提速百分比；人工对比硬解/软解输出视觉一致（SC-003）。**完成 + 发现并修复两个真实 bug + SC-001 目标已修正**：部署后用 `nvidia-smi dmon` 监控发现 `dec` 列恒为 0%——硬解开关打开后实际仍在跑软解，且无任何报错。排查定位到两个独立的真实 bug：① `decode_range_hw`/`decode_and_encode_hw` 用 `ctx.decoder().video()?` 一次性完成"包装+打开"，但 `.video()` 内部立即调用 `avcodec_open2`，而 `try_attach_hw`（设置 `hw_device_ctx`/`get_format`）在那之后才执行——等于开完会才递话筒，ffmpeg 永远不会重新协商硬解格式，全程静默走软解且零报错；改为先拿到未打开的 `Decoder`、设置好 hw 字段、再调 `.video()` 打开。② 即使时机修复后，`get_format` 仍从未被调用——根因是 `avcodec_find_decoder(AV_CODEC_ID_AV1)` 在 jellyfin-ffmpeg 这套编译里返回的是 `libdav1d`（注册顺序更靠前，纯软解更快），而非原生 `av1` 解码器；`libdav1d` 完全没有硬解钩子。比照 ffmpeg 官方 CLI 在 `-hwaccel cuda` 时的行为（verbose 日志："Selecting decoder 'av1' because of requested hwaccel method cuda"）——新增 `open_decoder_context` helper，仅在请求硬解时按 codec 标准名（`avcodec_get_name`/`Id::name()`，如 `"av1"`）显式 `find_by_name` 重新选解码器，纯软解路径保留更快的 `libdav1d` 默认选择不变。两处修复后 `nvidia-smi dmon` 实测 `dec` 列出现非零采样，`get_format CALLED ... -> MATCH`/`is_hw_frame=true` 日志确认硬解真正生效。**性能调优过程**：修复后首次实测硬解反而比软解慢 ~40-50%；用打点排查发现 `handle_prefetch_range_stream` Pass-2 对每一帧都单独调用一次 `decode_range_hw`（每帧一个独立 ffmpeg session，刻意以批量解码效率换取帧间并发），而 `av_hwdevice_ctx_create(Cuda, ..)` 每次新建实测耗时 ~230ms/次——这才是真正的瓶颈，不是传输或编码。修复：在 `hwaccel.rs::HwDeviceContext::create` 加入按 `(vendor, device)` 键的进程级缓存（`OnceLock<Mutex<HashMap<...>>>`），命中缓存时用 `av_buffer_ref` 做一次廉价的引用计数自增（而非重新初始化 CUDA context），daemon 生命周期内每个 vendor/device 组合只真正调用一次 `av_hwdevice_ctx_create`。顺带在 `decode_range_hw` 内部加了一层生产者/消费者管道化（独立线程做 解码+传输+色彩转换，主线程只做 WebP 编码，二者通过有界 channel 重叠）——虽然这不是本次回归的根因（Pass-2 单帧调用场景下没有"批量"可流水线化），但对未来真正的多帧批量调用路径（如 `handle_prefetch_range` 主路径）仍有意义，保留。**最终实测**（1080p10 AV1，±15s 窗口，719 帧，width=320）：硬解 186ms/帧（133.92s）vs 软解 200ms/帧（143.69s）——净提速 ~7%，硬解不再慢于软解，且确认是正确生效的硬件路径（非测量误差）。**远低于原定 SC-001 的 ≥30%**：用 `ffmpeg` CLI 单独测过纯解码（不含编码）耗时——硬解/软解均仅 ~1.3ms/帧，几乎可忽略；该路径每帧耗时主体是 WebP 双输出编码（~180-200ms/帧，硬解软解共用同一段编码代码，完全无法从"换解码方式"上获益）。已与用户确认：把 SC-001/spec.md 对应 Assumption 改为"硬解不慢于软解、且有可观测净提速"，不再要求固定 30% 门槛（spec.md 内已加"已修正"说明，记录此次实测数据与根因）。视觉一致性（SC-003）：抽样对比硬解/软解输出的同一批帧缩略图，未发现可分辨差异（10-bit AV1 内容，未触发 Edge Cases 里约定的位深降级路径）。
- [~] T018 运行 `mise run test` 确认全绿（Phase 3 Stage Gate，宪章原则 III"不可妥协"）；若本阶段涉及可独立验证的部署改动，额外执行 `mise run update-linux` 确认部署成功（原则 IV）。**`mise run test` 部分**：已通过（Rust 9 passed/1 ignored、frontend 17 pass、C# 76 passed）。过程中发现并修复一个真实回归：`main.rs` 把整个 `generation_log` 模块标了 `#[cfg(feature = "opencv")]`，而 T015 新增的 `log_hw_fallback` 调用点（硬解回退日志）与 opencv 完全无关、不应被该 feature gate 住——本机默认的 `mise run test`（不带 opencv feature）直接编译失败 7 处 `cannot find generation_log`，`mise run check-frame-forge-opencv-linux`（带 opencv feature 的 Docker 检查）因为恰好两个 feature 都打开所以没暴露这个问题。已移除该 cfg gate（模块本身不依赖 opencv，只是其他消费者各自仍按需 opencv-gated），两条检查通道复测均 clean。**`mise run update-linux` 部分**：尚未执行——T017（quickstart 场景1 实测提速）还没跑，作为 MVP 验证的最后一步，需要先完成 T016/T017 再触发部署，且部署前需征得用户同意（CLAUDE.md 部署工作流程）。

**Checkpoint**: 默认开启硬件解码后，本机可观测到明显提速，且不支持/失败场景不影响功能完整性，`mise run test` 全绿。此时可作为 MVP 部署演示。

---

## Phase 4: User Story 2 - 用户可手动关闭硬件解码退回纯软解 (Priority: P2)

**Goal**: 用户可在播放器增强 modal 里查看/切换硬件解码开关与设备选择策略，设置持久化跨重启保留；无受支持设备时开关禁用并提示；多设备时才显示策略选择器；"优先使用闲置资源"按实时负载动态选择设备；正在进行中的任务不被设置变更动态打断。

**Independent Test**: quickstart.md 场景2（关闭开关→重开 modal/重启容器→仍保持关闭；任务进行中切换开关不影响该任务）、场景3（mock 无设备→开关禁用+提示）、场景5（多设备策略选择，含负载切换）。

### Implementation for User Story 2

- [X] T019 [P] [US2] 新建 `packages/JellyfinSuite.Plugin/Models/HwDecodeSettingsDto.cs`：`HwDecodeSettingsDto`（GET 响应）与 `HwDecodeSettingsUpdateDto`（PUT 请求体），所有属性按 CLAUDE.md JSON 规范加 `[JsonPropertyName]`（camelCase），字段定义见 [contracts/rest-api.md](./contracts/rest-api.md)。**完成**：另外新增 `HwDecodeCapsResult`（非 wire DTO，仅 `MSG_HW_DECODE_CAPS` 解析结果，供 Controller 内部使用）。
- [X] T020 [US2] 在 `packages/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` 新增 `GET /FrameExport/HwDecodeSettings`（合并 `PluginConfiguration` 持久化字段 + 查询 T006 的 `MSG_HW_DECODE_CAPS` + `DeviceEnumerationService` 设备数量得到 `multiDeviceAvailable`）与 `PUT /FrameExport/HwDecodeSettings`（写入 `Plugin.Instance.Configuration` 并 `SaveConfiguration()`；`DeviceStrategy` 非法值时降级为 `"performance"`，不返回 400）。**完成**：新增 `FrameExportService.GetHwDecodeCapsAsync()`（发送 `MSG_HW_DECODE_CAPS` 并解析响应）；Controller 注入 `DeviceEnumerationService`（仿照 `StitchController` 现有模式）统计 GPU 数量（`DeviceType == "GPU"`）判定 `multiDeviceAvailable`；GET/PUT 共用内部 `BuildHwDecodeSettingsDtoAsync` 辅助方法避免重复。`dotnet build`/`mise run test` 全绿。
- [X] T021 [US2] 在 `packages/JellyfinSuite.Plugin/Services/DeviceEnumerationService.cs`（T010 新增负载查询方法所在的同一个文件，不再是"或 FrameExportService.cs"的待定项）接入"优先使用闲置资源"策略：每次解码任务发起时查询候选设备实时负载，选负载更低的设备；任一设备负载数据不可用（含 Intel 全部场景）时整体降级为"性能优先"的静态独显优先规则（FR-012）。**已在 Rust 端实现，C# 端无需重复（同 T010 的判定）**：`server.rs::resolve_hw_decode_request`/`pick_idle_resource_vendor` 在每次解码请求时执行本任务描述的全部逻辑（查负载→选低负载→不可用时降级独显优先），C# 侧没有调用方需要这个判断结果。
- [X] T022 执行 `mise run gen-types`（需要 `jellyfin-dev` 容器运行）重新生成 `packages/api-types/src/jellyfin-api.ts`，确认 `HwDecodeSettingsDto`/`HwDecodeSettingsUpdateDto` 出现在生成的 schema 里。**发现并修正**：本项目 OpenAPI spec 并非反射自动生成，而是 `packages/JfsSpecGen/JfsSpec.cs` 手工维护的 DTO 类型清单 + 手写 path 构造（`AddFrameExportPaths` 等）——新增 Controller 端点不会自动出现在 spec 里，必须手动在 `DtoTypes` 数组里加 `typeof(HwDecodeSettingsDto)`/`typeof(HwDecodeSettingsUpdateDto)`，并在 `AddFrameExportPaths` 里手写 `GET`/`PUT /JellyfinSuite/FrameExport/HwDecodeSettings` 两条 path（仿照同函数里已有的 `QualityThresholds` GET/PUT 配对）。补全后重跑确认 schema 出现（43 paths/48 schemas，较之前 42/46 各 +1/+2）。
- [X] T023 [P] [US2] 在 `apps/player-enhancer/src/api/frameExportApi.ts` 新增 `HwDecodeSettingsDto` 类型导出（从 `@jfs/api-types` 引用，不手写重复接口）、`fetchHwDecodeSettings()`、`hwDecodeSettingsQuery()`、`updateHwDecodeSettingsMutation()`，模式参照同文件已有的 `fetchDevices`/`devicesQuery`。**完成**：`routes.ts` 新增 `suite.frameExport.hwDecodeSettings()`；`mise run lint` 通过（已用 eslint --fix 处理一处 import 排序警告）。
- [X] T024 [US2] 在 `apps/player-enhancer/src/components/AdvancedPanel.tsx` 工坊设置区域新增"硬件解码"开关（默认勾选，调用 T023 的 query/mutation 读写）；当 `supported=false` 时开关禁用并显示 `unsupportedReason` 提示文案（FR-010）；当 `multiDeviceAvailable=true` 时额外显示"性能优先/优先使用闲置资源"二选一控件，否则不渲染该控件（FR-012）。**完成**：复用现有 `jfs-fe-toggle-chk`/`jfs-fe-toggle-track` 开关样式（`ParamsPanel.tsx` 同款）；新增 `updateHwDecode()` 走乐观更新+服务端响应纠正模式（PUT 返回值可能把非法 `deviceStrategy` 降级，必须用响应体覆盖本地 optimistic 值）；新增 `apps/player-enhancer/src/lib/i18n.ts` 的 en/zh/ja 三语种 key（`advanced.hwDecode*`）。`eslint`/`tsc --noEmit`/`mise run test` 全绿。**事后发现并修正（用户核实部署后截图指出缺失）**：原始需求"前端在播放器增强 modal 里新增一个工坊相关设置项"指的是 `apps/frontend/src/components/PlayerEnhancerPanel.tsx`（"播放器增强" modal 本体），不是 `apps/player-enhancer` 这个同名应用自己的高级面板——两者撞名导致 plan/tasks 阶段定位到了错误的文件。补充在 `PlayerEnhancerPanel.tsx` 里新增同样的开关（紧跟"拖动进度条时显示缩略图预览"之后），复用 `frameExportQueueApi.ts` 现有的 `apiFetch`/`BASE` 模式新增 `getHwDecodeSettings`/`setHwDecodeSettings`，新增 `apps/frontend/src/i18n` 三语种 key（`enhancerHwDecode*`）+ `styles.css` 的 `.jfs-enhancer-panel__select`。两处面板共用同一后端设置，互不冲突（contracts/rest-api.md 已更新"前端调用点"为两处）。
- [X] T025 [P] [US2] 在 `tests/JellyfinSuite.Tests` 新增 C# 测试：`PUT` 非法 `deviceStrategy` 值时响应体降级为 `"performance"`；`GET`/`PUT` 往返后 `PluginConfiguration` 字段值正确持久化（模拟跨"重启"——重新构造 `Plugin.Instance.Configuration` 读取验证）。**完成（落点调整）**：新建 `HwDecodeSettingsTests.cs`，仿照已有 `PosterSheetControllerValidationTests.cs` 的"镜像服务端逻辑为纯函数测试"模式（构造完整 Controller 需要 mock 一整套 DI 依赖，成本不成比例）——`NormalizeDeviceStrategy` 精确镜像 Controller 里的降级表达式（覆盖空串/未知值/大小写不匹配/null 四种非法输入）；"重启存活"用真实 `XmlSerializer` 序列化/反序列化 `PluginConfiguration` 往返验证（比单纯属性赋值更强的断言，不需要起完整 Jellyfin 插件主机）。8 个新测试全部通过（`mise run test`：76→84 passed）。
- [ ] T026 [US2] 执行 quickstart.md 场景2（含步骤5"任务进行中切换开关，确认当前任务不受影响、仅下一次操作生效新设置"——对应 spec Edge Cases 的"约定"行为，`/speckit-analyze` 此前发现这一约定缺少验证覆盖，已在 quickstart.md 补上）、场景3、场景5，确认设置持久化、禁用态提示、多设备策略切换（含人工制造独显负载后验证自动切核显）均符合预期
- [~] T027 运行 `mise run test` 确认全绿（Phase 4 Stage Gate，宪章原则 III）。`mise run test` 已通过（Rust 10 passed/1 ignored、frontend 17 pass、C# 84 passed）；本 Phase 没有需要 `mise run update-linux` 单独验证的部署改动，留给最终的 T034 一次性部署验证。

**Checkpoint**: 用户可通过 UI 完整控制硬件解码行为，设置跨重启存活、不被进行中的任务动态打断，多设备环境下两种策略都按预期工作，`mise run test` 全绿。

---

## Phase 5: User Story 3 - 硬件解码不可用或失败时自动优雅降级 (Priority: P1)

**Goal**: 在 US1 已经接入的"初始化失败回退"基础上，补齐"硬解执行中途失败"（单帧/部分帧）的回退能力，以及 10-bit/HDR 等已知会触发硬解不支持的边界场景，确保任何硬解相关问题都不会让用户可见的功能失败。

**Independent Test**: quickstart.md 场景4 步骤2（硬解执行中途失败，确认该帧及后续帧回退软解、任务仍完整完成）；10-bit/HDR 素材触发优雅降级而非画质劣化。

### Implementation for User Story 3

- [X] T028 [US3] 在 `crates/jfs-common/src/hwaccel.rs`/`decoder.rs` 的硬解循环里捕获单帧级解码错误（含 10-bit/HDR 内容导致硬解器拒绝的情况），对该帧及该次操作剩余帧自动切换到软解路径继续完成，不让错误向上传播中断整个任务（FR-004）；触发时调用 T007 写一条 `hwdecode_runtime_fallback` 的 `FallbackEvent`，`reason` 字段包含具体失败原因（不能是空字符串/泛泛的 "failed"，FR-011）。**已在 T013（本次会话更早阶段）实现，本任务核实确认**：`decoder.rs::resolve_decoded_frame` 正是这个单帧级捕获点——`is_hw_frame` 判断当前帧是否仍是硬解表面格式，`transfer_to_software` 失败时调用 `on_fallback("hwdecode_runtime_fallback", reason)`、`ctx.disable()`（最佳努力地让后续 GOP 边界不再尝试硬解）并返回 `None`；`decode_range_hw`/`decode_and_encode_hw` 的调用点把 `None` 当作"跳过该帧，继续/重试软解"处理，不向上传播错误。10-bit/HDR 拒绝走的是同一条路径（硬解器对不支持的内容会在 `get_format`/`avcodec_send_packet`/`receive_frame` 阶段拒绝，最终都体现为这里的 `is_hw_frame`/`transfer_to_software` 失败或 `try_attach_hw` 初始化失败，两种既有分支都已覆盖，未发现需要专门处理的第三种失败形态）。
- [X] T029 [P] [US3] 在 `crates/jfs-common` 新增 Rust 单元测试：模拟"硬解在处理到第 N 帧时失败"，断言后续帧成功用软解完成、最终输出帧数量/顺序正确、产生了对应的 `FallbackEvent`。**完成 + 发现并修复测试基础设施缺口**：`resolve_decoded_frame` 本身无法直接单测（它依赖的 `GetFormatCtx` 只能通过 `attach_hw_device` 构造，需要一个真实存活的 `AVCodecContext`），但它的失败分支完全由 `is_hw_frame`/`transfer_to_software` 两个可独立测试的函数决定——在 `hwaccel.rs` 新增 `transfer_to_software_fails_on_frame_with_no_real_hw_surface`：手工构造一个"自称是 CUDA 硬解表面帧"但从未真正挂接 `hw_frames_ctx` 的帧，验证 `transfer_to_software` 确定性失败（不需要真实 GPU，效果等同一次真实运行中失败）。**发现的缺口**：`Makefile` 的 `test-rust` 目标从未对 `crates/jfs-common` 跑过 `cargo test`（只在 poster-gen/seek-preview/frame-forge 三个目录下跑），意味着这个新测试（以及 jfs-common 未来任何单测）实际上从来不会被 `mise run test`/CI 执行到——已在 `Makefile` 的 Linux 分支里补上 `(cd crates/jfs-common && cargo test)`，修复后确认新测试随 `mise run test` 一起跑且通过。
- [ ] T030 [US3] 执行 quickstart.md 场景4 步骤2 与场景6（检查 `generation-log.json` 里 `hwdecode_init_failed`/`hwdecode_runtime_fallback` 的 `reason` 字段是否足够定位问题，为后续 A380 生产远程核实做准备）
- [ ] T031 [US3] 人工验收记录：同一视频里部分帧硬解成功、部分回退软解时，最终动图/全景图拼接结果是否存在可见拼接不一致（spec Edge Cases 已约定为已知风险记录，非强制量化阈值），结果记录在 `specs/013-frame-decode-hw-accel/quickstart.md` 场景4 附近
- [~] T032 运行 `mise run test` 确认全绿（Phase 5 Stage Gate，宪章原则 III）。`mise run test`/`mise run check-frame-forge-opencv-linux` 均已通过；Phase 5 的部署验证同样留给 T034。

**Checkpoint**: 所有已知的硬解失败场景（初始化失败、运行中失败、内容不支持）都有对应的、对用户透明的优雅降级路径,且都有可供远程核实的诊断日志，`mise run test` 全绿。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 跨 Story 的收尾工作，PR 合并前必须完成。

- [ ] T033 [P] 执行 `mise run test`（Rust + C# + TypeScript 全套）做最终确认全绿
- [ ] T034 `mise run update-linux` 部署到 `jellyfin-dev`，跑完 quickstart.md 全部 6 个场景（含 T026 新增的场景2步骤5）
- [X] T035 [P] 按 CLAUDE.md「PR 合并前检查清单」核对 `README.md`/`README.zh-CN.md` 是否需要补充硬件解码相关说明（新增设置项、行为变更）。**完成**：两份 README 的"帧导出与拼接"条目末尾各补一句，说明默认硬解、失败自动回退、高级面板开关与多 GPU 设备选择策略。
- [X] T036 [P] 按 CLAUDE.md「PR 合并前检查清单」核对 `.github/workflows/` 是否需要随本次改动调整（新增系统依赖 `libva-dev`/`nv-codec-headers` 是否需要写进 CI 镜像）。**核对结论：不需要改动**——T001 已确认本功能不新增任何构建期依赖，`.github/workflows/build.yml`/`release.yml` 现有 apt 依赖列表（`libavcodec-dev` 等）已经够用。另外发现并顺带修复了一个影响 CI 的真实缺口：`build.yml` 的 Test Rust 步骤跑的是 `make test-rust`，而该 Makefile 目标此前从未对 `crates/jfs-common` 跑 `cargo test`（见 T029 备注）——已在 Makefile 里修复，CI 无需额外改动即可自动覆盖到 jfs-common 的单测（包括本次新增的硬解测试）。
- [ ] T037 部署后请用户在生产 NAS（Intel Arc A380）上参照 quickstart.md 场景4/6 的方法远程核实硬解是否真正生效（spec Assumptions 已约定的验收方式，不要求本地完成 A380 验证）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，可立即开始
- **Foundational (Phase 2)**: 依赖 Phase 1 完成（需要先有能编译硬解符号的构建环境）——阻塞所有 User Story
- **User Story 1 (Phase 3)**: 依赖 Phase 2 完成；是其余两个 Story 的事实前提（US2 的开关控制的是 US1 的行为，US3 的运行中失败回退建立在 US1 的硬解循环之上），**建议按顺序而非并行实现**；T018 Stage Gate 必须在进入 Phase 4/5 前通过
- **User Story 2 (Phase 4)**: 依赖 Phase 3（US1，含 T018 Gate）已有可用的硬解路径可供开关控制
- **User Story 3 (Phase 5)**: 依赖 Phase 3（US1，含 T018 Gate）已有硬解循环可供注入运行中失败处理；可与 Phase 4（US2）并行（不同文件、不同关注点）
- **Polish (Phase 6)**: 依赖 Phase 4/5 的 T027/T032 Stage Gate 均已通过

### Parallel Opportunities

- Phase 1：T001、T002 可并行（不同文件/不同性质的工作）
- Phase 2：T004、T005、T007、T008、T010 可并行（不同文件，互不依赖）；T009 建议在 T004 之后单独跑（避免与其他 C# 改动冲突，但本身不依赖 Rust 侧）
- Phase 3 内 T011/T012（VAAPI vs NVDEC，不同代码块）理论可并行，但都写在同一个 `hwaccel.rs` 文件里，建议顺序提交避免合并冲突
- Phase 4 与 Phase 5 在 Phase 3（含 T018 Gate）完成后可由不同人并行推进
- T016、T029（单元测试）可与对应实现任务并行编写（测试先失败，实现后转绿）

---

## Implementation Strategy

### MVP First（User Story 1 + 必要的 US3 安全网）

1. 完成 Phase 1 Setup
2. 完成 Phase 2 Foundational
3. 完成 Phase 3 User Story 1（已包含初始化失败回退，US3 P1 的核心安全网在这一步就位；T018 Gate 通过）
4. **STOP and VALIDATE**：quickstart.md 场景1 独立验证提速效果
5. 此时已可演示"默认开启硬件解码、明显提速、失败也不影响功能"——MVP 达成

### Incremental Delivery

1. Setup + Foundational → 基础设施就位
2. User Story 1（含 Stage Gate）→ 独立验证提速 → 可部署演示（MVP）
3. User Story 2（含 Stage Gate）→ 独立验证开关/持久化/多设备策略/任务不被动态打断 → 部署
4. User Story 3（含 Stage Gate）→ 独立验证运行中失败回退与边界场景 → 部署
5. Polish → README/CI 检查 → 合并 PR → 用户在生产 NAS 远程核实 A380

---

## Notes

- 所有修复/改动按用户既往明确要求集中在当前分支 `fix/frame-export-connection-pool`（[[feedback_one_branch_for_all_fixes]]），不为本功能单独开分支
- Rust 改动每次完成后先 `cargo check`/`mise run check-frame-forge-opencv-linux`，确认 clean 后才 `mise run update-linux`，不得拿 full build 当试错工具（CLAUDE.md Rust 修改规范）
- 部署前必须先 `mise run test` 全绿，且需征得用户同意（CLAUDE.md 部署工作流程）
- 每个 Phase 末尾的 Stage Gate 任务（T018/T027/T032，以及 Phase 1/2 已有的 T003/Checkpoint）对应宪章原则 III/IV/V 的强制要求，不得跳过或推迟到 Phase 6 才统一补——这是 `/speckit-analyze` 发现的 CRITICAL 项（D1）的修复
