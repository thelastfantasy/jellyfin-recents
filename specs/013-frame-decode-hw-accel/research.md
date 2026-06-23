# Phase 0 Research: 帧解码硬件加速

## 1. 硬件解码 API 接入方式

**Decision**: 在 `crates/jfs-common/src/hwaccel.rs` 新增模块，直接通过 `ffmpeg-sys-next` 的 `unsafe` FFI 调用 `av_hwdevice_ctx_create` / 设置 `AVCodecContext.hw_device_ctx` / `av_hwframe_transfer_data`，而不是改用 `ffmpeg` CLI 子进程或寻找第三方硬解 binding crate。

**Rationale**:
- 当前 `crates/jfs-common/Cargo.toml`、`crates/frame-forge/Cargo.toml` 都依赖 `ffmpeg-next = "7"`（仅 `codec/format/software-scaling` feature），confirmed 全 crate 源码无 `hwaccel`/`hw_device_ctx`/`AVHWDeviceType` 任何字样——这层安全封装**没有**暴露硬件设备上下文 API。
- `ffmpeg-sys-next`（`ffmpeg-next` 的底层依赖）的 `build.rs` 第1566/1609/1612 行确认会对实际安装的 `libavutil/hwcontext.h`（含 `hwcontext_drm.h`）跑 bindgen，构建期会生成 `av_hwdevice_ctx_create` 等符号——只是注册表缓存的源码包里看不到（绑定是编译期对着真实头文件生成的，不是提交在 crate 源码里的静态文件）。这意味着该 API 在我们的构建环境里实际可用，只是必须以 unsafe 方式调用。
- 改走 `ffmpeg` CLI 子进程会破坏现有 `decode_range`/`decode_and_encode` 的进程内、按 PTS 容差精确匹配帧的设计（当前依赖的是 in-process 的 `BTreeMap` ±2 帧容差查找），且会让"硬解失败回退软解"这种逐帧级别的优雅降级在多进程边界上变得更复杂（管道解析、错误传播延迟），不可取。
- 没有发现成熟、维护活跃的第三方"安全"硬解 binding crate 能同时覆盖 VAAPI + NVDEC 且和现有 `ffmpeg-next` 版本（7.x）兼容，引入会增加一条独立的依赖风险线，性价比低于直接用已经在依赖树里的 `ffmpeg-sys-next`。

**Alternatives considered**:
- Shell 出 `ffmpeg` 二进制（`-hwaccel cuda`/`-hwaccel vaapi`）：被拒绝，原因见上（破坏现有按 PTS 精确匹配 + 优雅降级设计）。
- 寻找独立的 Rust hwaccel binding crate：未找到满足"同时支持 VAAPI 与 NVDEC、活跃维护、兼容 ffmpeg 7.x"的候选，放弃。

## 2. 构建期系统依赖补充（已修正——实测确认不需要新增依赖）

**Decision**: **不需要**新增 `libva-dev`/`nv-codec-headers` 构建依赖。`scripts/build-frame-forge-linux.sh`、`scripts/check-frame-forge-opencv-linux.sh`、Makefile 现状（只装 `libavcodec-dev libavformat-dev libavutil-dev libswscale-dev`）已经足够。

**Rationale**（实现阶段实测纠正了本节最初的判断）：直接读取了 `ffmpeg-sys-next` 的 `build.rs`（第1495-1620行）确认它喂给 bindgen 的硬解相关头文件只有 `libavutil/hwcontext.h`（必选）和 `libavutil/hwcontext_drm.h`（`maybe_search_include`，可选）——**没有** `hwcontext_vaapi.h`/`hwcontext_cuda.h`，也就是说 bindgen 根本不解析需要 `<va/va.h>`（libva-dev）或 CUDA 专属头文件（nv-codec-headers）的厂商专属 struct（`AVVAAPIDeviceContext`/`AVCUDADeviceContext`）。

但这完全不影响功能实现：`hwcontext.h` 本身已经声明了所有需要的通用 API——`enum AVHWDeviceType`（含 `AV_HWDEVICE_TYPE_VAAPI`/`AV_HWDEVICE_TYPE_CUDA`，纯枚举值，不依赖厂商头文件）、`av_hwdevice_ctx_create()`（接受一个 `device` 字符串如 `"/dev/dri/renderD128"` 或 `"0"`，内部自己完成厂商专属的设备打开逻辑，调用方完全不用碰 `VADisplay`/`CUcontext` 这些类型）、`av_hwframe_transfer_data()`（硬解输出帧→CPU 帧）。`AVCodecContext` 的 `hw_device_ctx`/`hw_frames_ctx`/`get_format` 字段也是 `avcodec.h` 里的常规字段，随 `codec` feature 一起解析，不需要任何额外头文件。已在本机 `/usr/include/x86_64-linux-gnu/libavutil/hwcontext.h`（系统装的 libavutil-dev 7:8.0.1，版本不同但这部分 API 自 ffmpeg 3.x 起就稳定不变）逐行核实以上签名属实。

也确认了 `ffmpeg_next` crate 本身 `pub extern crate ffmpeg_sys_next as sys; pub use sys as ffi;`（`ffmpeg-next-7.1.0/src/lib.rs` 第8/13行）——`ffmpeg_next::ffi::*` 已经能直接访问这些符号，**不需要**在 `Cargo.toml` 里新增 `ffmpeg-sys-next` 作为显式依赖。`codec::Context`（`Video` 解码器的基类）还公开了 `pub unsafe fn as_ptr()/as_mut_ptr() -> *const/*mut AVCodecContext`（`ffmpeg-next-7.1.0/src/codec/context.rs` 第25/29行），现有 `decoder.rs` 的解码循环可以直接拿到底层指针去设置 `hw_device_ctx`/`get_format`，不需要绕开 `ffmpeg_next` 安全封装重写整套 demux/seek 逻辑。

**真正需要确认的是运行时而非构建时**：实际解码调用的是 rpath 指向的 `/usr/lib/jellyfin-ffmpeg/lib`（见 `scripts/build-frame-forge-linux.sh` 注释），即 Jellyfin 项目自己维护的 ffmpeg 构建，而不是构建容器里 apt 装的那份。jellyfin-ffmpeg 以支持广泛硬解（VAAPI/NVDEC/QSV）作为其核心目的之一，几乎可以确定已经编译进了这些 hwaccel 后端——但"几乎确定"不等于"已验证"，需要在 T002 里连同设备节点透传一起实测确认。

**Alternatives considered**：用 Docker 多阶段构建单独编译硬解专用的 ffmpeg 静态库——不必要，且已确认现有系统依赖足够。新增 `ffmpeg-sys-next` 显式依赖手搓 binding——不必要，`ffmpeg_next::ffi` 已经重新导出。

## 3. 设备节点透传现状（已实测确认，T002）

**Decision**: 已通过 `docker exec jellyfin-dev` 直接实测确认——**两类设备节点均已透传，且 jellyfin-ffmpeg 已编译硬解支持**，可以直接开始编码，无需进一步等待验证。

**实测结果**：
- `/dev/dri/card1`、`/dev/dri/renderD128` 存在（AMD Raphael 核显的渲染节点，VAAPI 可用）
- `/dev/nvidia0`、`/dev/nvidiactl`、`/dev/nvidia-modeset`、`/dev/nvidia-uvm`、`/dev/nvidia-uvm-tools` 存在（NVIDIA 独显设备节点齐全，NVDEC/CUDA 可用）
- 容器内 `/usr/lib/jellyfin-ffmpeg/ffmpeg -version` 显示版本 `7.1.4-Jellyfin`，configure 参数含 `--enable-vaapi --enable-ffnvcodec --enable-cuda --enable-cuda-llvm --enable-cuvid --enable-nvdec --enable-nvenc`
- `ffmpeg -hwaccels` 输出包含 `cuda`、`vaapi`（以及 `qsv`/`drm`/`opencl`/`vulkan`，本功能不需要但确认硬解栈整体编译完整）
- `ffmpeg -decoders` 能看到 `h264_cuvid`/`hevc_cuvid`/`av1_cuvid` 等 NVIDIA 专属解码器——但本功能采用更通用的"标准解码器 + `hwaccel=cuda`"模式（`AV_HWDEVICE_TYPE_CUDA` + `hw_device_ctx`），不是切换到 `_cuvid` 专属解码器，原因见下方 §1 的实现模式说明，与 `decoder.rs` 现有"按 codec 自动选解码器"的设计保持一致，不需要按编码格式硬编码解码器名称

**Rationale**：此前 OpenVINO GPU EP、CUDA ONNX Runtime EP 已经在这两台机器上验证过 GPU 可访问，但那是 ONNX Runtime 走的设备访问路径，跟 ffmpeg VAAPI/NVDEC 走的内核子系统不完全相同——这次直接对 `jellyfin-dev` 跑了 ffmpeg 自带的能力探测命令，不是从 ONNX Runtime 的结论类推，结论可直接信任。生产 NAS（Intel Arc A380）的对应验证留给部署后用户远程核实（quickstart.md 场景6 / tasks.md T037），与 spec Assumptions 的既定计划一致。

**Alternatives considered**: 假设已经透传直接开始编码——已被本次实测取代，不再是假设。

## 4. 设备实时负载查询（"优先使用闲置资源"策略，FR-012）（已修正——实现阶段发现的协议设计问题，见下方"已修正"说明）

**Decision**:
- NVIDIA：`nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits`。
- AMD：读取 `/sys/class/drm/renderD{N}/device/gpu_busy_percent`（amdgpu 驱动暴露的 sysfs 文件，APU/Raphael 核显与独立 Radeon 显卡通用；render 节点与对应 card 节点共享同一个 `device` 符号链接目标，从 renderD 节点自身路径即可直接读到，不需要额外反查 cardN）。
- Intel：暂未找到与 AMD 同等简单、跨驱动版本稳定的 sysfs 利用率文件（i915/xe 驱动对此暴露不一致，需要 `intel_gpu_top` 之类的工具或 PMU 接口，复杂度和稳定性都不如前两者）；按 spec Clarifications 已确认的规则——读取失败时该次选择直接降级为"性能优先"静态规则（独显优先），不阻塞功能上线。

**已修正（T015 实现阶段发现）**：本节最初的措辞（以及 plan.md 的描述）暗示这套负载查询由 `DeviceEnumerationService.cs`（C#）实现，每次解码任务发起前由 C# 决定好设备再传给 Rust daemon。但 `contracts/socket-protocol.md` §1 冻结的 wire 格式只传 `device_strategy: u8`（策略枚举本身），**不传 C# 解析出的具体设备 ID**——两份文档在这一点上互相矛盧。由于实际解码发生在 Rust daemon 进程内，且协议没有字段能承载"C# 已经选好的设备"，修正为：上述 NVIDIA/AMD/Intel 负载查询逻辑实际实现在 Rust 侧（`crates/jfs-common/src/hwaccel.rs::query_load_percent`），由 daemon 自己在每次解码请求时（`server.rs::resolve_hw_decode_request`）查询并做出选择；`DeviceEnumerationService.cs` 侧的同名查询（T010/T021）改为服务于播放器增强 modal 的 UI 展示（设备列表/`multiDeviceAvailable` 判定），两者读取同样的数据源但服务不同消费者，不是同一份代码路径。

**Rationale**: 与 spec 的 Clarifications 完全对齐（已和用户确认：负载数据拿不到时静态独显优先兜底），不需要为 Intel 额外造一个不稳定的检测机制；执行端下沉到 Rust 避免了新增 wire 协议字段去传递一个已解析的设备 ID，是更小的改动面。

**Alternatives considered**: 引入 `intel_gpu_top` 作为子进程探测 Intel 利用率——增加一个外部二进制依赖且该工具需要额外权限（通常需要 root 或 `CAP_PERFMON`），与当前项目"轻量 sysfs 读取"风格不符，放弃。新增 wire 协议字段让 C# 把解析好的设备 ID 传给 Rust——增加协议改动面与双端再同步成本，且 C# 容器内是否总能访问到与 Rust daemon 完全一致的 `/dev/dri`、`nvidia-smi` 视角并不确定，不如让实际执行解码的进程自己查询，放弃。

## 5. 独显/核显分类（FR-012 判定依据，服务于 modal UI 展示，已修正不再是运行时选型依据）

**Decision**: 在 `DeviceEnumerationService.cs` 新增一个按厂商 + 已知芯片代号/PCI device ID 区间分类的查表逻辑，取代当前硬编码 `false` 的 `IsIntegrated` 字段（第147行）。NVIDIA 设备直接判定为独显（无桌面级核显产品线，不需要查表）；AMD/Intel 按已知核显（APU/UHD/Iris 系列）与独显（Radeon RX/Pro 系列、Arc 系列）的 PCI device ID 区间分类。

**已修正**：本节描述的分类结果服务于播放器增强 modal 的设备列表展示与 `multiDeviceAvailable` 判定，**不是**运行时硬解设备选型的输入（见 §4 的修正说明）。Rust daemon 侧的"性能优先"策略改用更粗粒度的厂商优先级（NVIDIA > AMD > Intel，详见 `server.rs::pick_performance_vendor`），不依赖这份 PCI 查表——当前开发/测试硬件每个厂商最多一张卡，厂商级粒度已经是实际会被检验到的全部场景；若未来出现单机多张同厂商 GPU（如双 NVIDIA dGPU）的场景，需要重新评估是否要把这份分类结果也下沉到 Rust 或新增协议字段传递。

**Rationale**: 已确认（research 阶段调研 + 与用户确认）GPU 驱动不会直接报告"我是核显/独显"，唯一可行且和厂商驱动版本无关的静态判据是 PCI device ID 查表，这也是 `switcheroo-control`、Mesa 设备库等行业内同类工具的标准做法。已排除"按显示器连接状态判断"（生产 NAS 通常无显示器接入，该判据在目标硬件上完全失效）与"按主频/核心数判断"（核显主频/核心数指标不能跨架构比较，且视频解码吞吐取决于专用解码引擎代数而非着色器主频/核心数，该判据本身概念上不成立）。

**Alternatives considered**: 显示器连接状态（`boot_vga` sysfs 标志）——已与用户讨论并否决，理由见上。主频/核心数——已与用户讨论并否决，理由见上。

## 6. 配置持久化机制

**Decision**: 在 `PluginConfiguration : BasePluginConfiguration` 新增 `HwDecodeEnabled`（bool，默认 `true`）与 `HwDecodeDeviceStrategy`（string，默认 `"performance"`）两个字段，通过 Jellyfin 标准的 `Plugin.Instance.Configuration` + `Plugin.Instance.SaveConfiguration()` 读写。

**Rationale**: 确认现有 `FrameExportController.cs` 里 `QualityThresholds` 的 GET/PUT 模式（第26、500-507行）背后是 `private static QualityThresholds _thresholds = new();`——纯内存字段，进程重启即丢，**不满足** spec FR-007"重启后仍保持用户上次选择"的要求，不能照搬。`PluginConfiguration` 是 Jellyfin 插件框架标准的 XML 持久化机制，经 `BasePlugin<PluginConfiguration>` 自动落盘到 `/config/plugins/configurations/`，符合要求。

**Alternatives considered**: 复用 `QualityThresholds` 的内存 `static` 模式——已确认不满足重启存活要求，排除。前端 `localStorage`（现有 `ExportSettings` 走的路径）——spec 的 Key Entities 明确这是"插件级别的全局设置"而非"按登录用户的个人偏好"，`localStorage` 是浏览器/用户本地存储，语义上不匹配，排除。

## 7. C# ↔ Rust daemon 协议扩展

**Decision**: 新增一个 socket 消息类型 `MSG_HW_DECODE_CAPS = 0x1D`（当前已用到 0x1C，0x1D 是下一个可用值），用于 C# 在 modal 打开时查询 daemon 启动时缓存的硬解能力检测结果（FR-010）；现有解码相关请求结构体（涉及 `decode_range`/`decode_and_encode` 调用路径的 `AnimateReq`/`StitchReq`/`PrefetchRangeReq` 等）新增 `hw_decode_enabled: bool` 与 `device_strategy: u8`（枚举编码，`0=performance, 1=idle-resource`）两个字段，编码方式与现有字段一致（定长二进制，不用长度前缀，因为是固定大小的标量）。

**Rationale**: 协议是纯手写长度前缀二进制帧（无序列化框架），新增标量字段直接追加到现有读写函数即可，符合现有代码风格；msg_type 是简单递增的 `u8` 常量表（`server.rs` 第18-32行），0x1D 不与现有任何值冲突。

**Alternatives considered**: 用环境变量/配置文件在 daemon 启动时一次性传入硬解开关——不可行，因为 FR-008（"关闭开关后系统完全不尝试调用任何硬件解码路径"）和 FR-007（运行中变更不打断当前任务、下次任务生效）要求该设置可以在 daemon 长生命周期运行期间动态变化，必须走请求级字段而不是启动期固定配置。
