# Implementation Plan: 帧解码硬件加速

**Branch**: `fix/frame-export-connection-pool` | **Date**: 2026-06-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/013-frame-decode-hw-accel/spec.md`

## Summary

工坊（frame-forge）当前所有帧提取（缩略图、动图拼接、全景图拼接）都通过 `jfs-common::decoder` 里基于 `ffmpeg-next`（纯软解）的 `decode_range`/`decode_and_encode` 完成。本功能在该解码路径上新增 GPU 硬件加速分支：Intel/AMD 走 VAAPI，NVIDIA 走 NVDEC/CUDA，由用户在播放器增强 modal（`FrameExportModal` 内的 `AdvancedPanel`）的工坊设置区域里用一个开关（默认开启）+ 一个仅在多设备时显示的"性能优先/优先使用闲置资源"策略选择器控制；硬解失败（初始化或运行中）必须对该帧静默回退软解并写诊断日志，绝不让用户可见的功能失败。

由于当前使用的 `ffmpeg-next` 安全封装层完全不暴露硬件设备上下文 API（`hw_device_ctx`/`AVHWDeviceType`），实现必须下沉到其底层 `ffmpeg-sys-next` 的 unsafe FFI 调用，并新增构建期依赖（`libva-dev` 供 VAAPI、`nv-codec-headers` 供 NVDEC）。设备选择策略复用 `DeviceEnumerationService.cs` 的设备枚举框架，但需要补全目前死代码状态的独显/核显分类（`IsIntegrated` 现在硬编码 `false`），并新增"优先使用闲置资源"所需的实时负载查询。配置持久化使用 Jellyfin 标准的 `PluginConfiguration`（XML，重启存活），不能照搬现有 `QualityThresholds` 那种纯内存 `static` 字段模式（重启即丢）。

## Technical Context

**Language/Version**: Rust（workspace edition，`crates/frame-forge` daemon + `crates/jfs-common` 共享解码库）、C#/.NET 9（`packages/JellyfinSuite.Plugin`，Jellyfin 插件 SDK）、TypeScript/React（`apps/player-enhancer`，状态用 jotai atom）

**Primary Dependencies**:
- `ffmpeg-next = "7"`（现有，仅 `codec/format/software-scaling` feature，**不含硬解 API**）
- `ffmpeg-sys-next`（`ffmpeg-next` 的底层依赖，bindgen 在构建期针对实际安装的 `libavutil/hwcontext.h` 等头文件生成绑定，包含 `av_hwdevice_ctx_create`/`AVHWDeviceType` 等符号，但必须以 `unsafe` FFI 方式调用）
- 新增构建期系统依赖：`libva-dev`（VAAPI，Intel/AMD 共用）、`nv-codec-headers`（`ffnvcodec`，NVDEC/CUDA hwaccel 编译期头文件）
- `Jellyfin.Plugin.JellyfinSuite.Configuration.PluginConfiguration : BasePluginConfiguration`（现有，新增两个字段）

**Storage**: `PluginConfiguration`（Jellyfin 插件框架的 XML 持久化文件，经 `Plugin.Instance.SaveConfiguration()` 落盘，**不是**现有 `FrameExportController._thresholds` 那种纯内存 `static` 字段，也不是前端 `ExportSettings` 用的浏览器 `localStorage`）

**Testing**: `cargo test -p frame-forge && cargo test -p jfs-common`（经 `mise run check-frame-forge-opencv-linux` 容器，因涉及 `opencv`/`ort` feature 组合）、`dotnet test packages/JellyfinSuite.Plugin.Tests`、前端 `bun test`/`vitest`——一律走 `mise run test`，不单独调用底层命令

**Target Platform**: Linux 服务器（`jellyfin-dev` 测试容器 + 用户生产 NAS/TrueNAS），GPU 厂商覆盖 NVIDIA / AMD / Intel（含 Arc A380，仅生产环境可验证）

**Project Type**: 现有多语言单体仓库（Rust daemon + C# Jellyfin 插件 + React 前端），本功能是在三者既有分层上的横向扩展，不引入新顶层模块

**Performance Goals**: SC-001——1080p/4K、H.264/HEVC 典型素材，硬解开启后总耗时相比纯软解至少缩短 30%

**Constraints**:
- `ffmpeg-next` 无硬解安全封装 → 硬解路径只能用 `unsafe` FFI（经 `ffmpeg_next::ffi`，即 `ffmpeg-next` 重新导出的 `ffmpeg_sys_next`，不需要新增显式依赖），每个 `unsafe` 块必须有 `// SAFETY:` 注释（CLAUDE.md Rust 规范强制要求）
- ~~当前 Docker 构建镜像没有 libva-dev/nv-codec-headers，必须先补充构建依赖~~ ——**已在实现阶段实测纠正**：`ffmpeg-sys-next` 的 bindgen 只解析通用的 `libavutil/hwcontext.h`（不解析厂商专属的 `hwcontext_vaapi.h`/`hwcontext_cuda.h`），`av_hwdevice_ctx_create()` 等所需符号全部在通用头文件里，现有构建依赖已经足够，详见 research.md §2
- `jellyfin-dev` 容器及生产 NAS 对 `/dev/dri`（VAAPI）、NVIDIA 设备节点（NVDEC/CUDA）的透传现状，以及 `/usr/lib/jellyfin-ffmpeg/lib`（运行时实际链接的 ffmpeg，而非构建容器里 apt 装的那份）是否编译了 VAAPI/NVDEC 支持——这两项都是**运行时**而非构建时问题，之前 OpenVINO GPU EP、CUDA ONNX EP 已经在这两台机器上跑通过推理侧硬件访问，可作为参考，但视频解码走的是不同的内核子系统/不同的 ffmpeg 构建，**实现阶段第一步必须实测确认**，不能假设
- Intel 侧硬件实时负载（"优先使用闲置资源"策略需要）比 NVIDIA（`nvidia-smi`）、AMD（`/sys/class/drm/cardX/device/gpu_busy_percent`）更难获取，需要在 research.md 里明确每个厂商的具体取值来源，取不到时必须按 spec FR-012 降级为静态"独显优先"
- 不能把硬解开关/策略设置做成现有 `QualityThresholds` 那种内存 `static` 字段（不满足 FR-007 的重启存活要求）

**Scale/Scope**:
- 影响 3 条现有解码调用路径（缩略图 `decode_range`/`decode_and_encode`、动图拼接 `stitch_*`、全景图拼接）背后的同一份 `jfs-common::decoder` 共享代码，不是 3 套独立实现
- 新增 1 个 socket 协议消息类型（硬解能力/状态查询，预留 `MSG_HW_DECODE_CAPS = 0x1D`，下一个未使用的 msg_type）
- 现有 3 个请求结构体（`AnimateReq`/`StitchReq` 对应的解码调用、`PrefetchRangeReq` 等）需要新增字段传递"是否启用硬解"与"设备选择策略"（具体哪些结构体需要改动见 data-model.md）
- C# 侧新增 2 个持久化配置字段 + 1 个 GET/PUT 设置端点 + `DeviceEnumerationService` 的独显/核显分类补完
- 前端 `AdvancedPanel.tsx` 新增 1 个开关 + 1 个条件显示的二选一策略控件

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

本功能是**新功能开发**，不是目录结构调整/依赖体系改造/包拆分合并类工作，因此宪章里限定"适用于重构与迁移类工作"的原则 I（功能无损）、II（结构不变性）、VI（Git 历史保留）、VII（结构与逻辑分离）**不适用**于本功能本身的范围判定（但其"通用质量门槛"部分仍然适用，见下）。

适用的通用门槛：

| 原则 | 是否适用 | 满足方式 |
|------|---------|---------|
| III. Test Gate | 适用 | 每个 Stage（见 tasks.md）结束前 `mise run test` 必须全绿（Rust + C# + TS） |
| IV. Build Gate | 适用 | 每个 Stage 结束前 `mise run update-linux` 本地部署成功 + CI workflow 通过 |
| V. 增量验证 | 适用 | 每个 Stage 的验证命令在 Stage 开始前已在 tasks.md 中定义，不允许"留到下个 Stage 修" |

无违反项，**Constitution Check: PASS**，无需 Complexity Tracking 例外记录。

Phase 1 设计完成后已重新核对（见下方"Constitution Check（Phase 1 复核）"）。

## Project Structure

### Documentation (this feature)

```text
specs/013-frame-decode-hw-accel/
├── plan.md              # 本文件
├── research.md          # Phase 0 输出
├── data-model.md         # Phase 1 输出
├── quickstart.md         # Phase 1 输出
├── contracts/            # Phase 1 输出（socket 协议 + REST 端点 + C# 配置契约）
└── tasks.md              # Phase 2 输出（/speckit-tasks，本命令不生成）
```

### Source Code (repository root)

```text
crates/jfs-common/src/
├── decoder.rs            # 现有 decode_range/decode_and_encode；新增硬解分支入口
└── hwaccel.rs             # 新增：unsafe ffmpeg-sys-next FFI 封装
                            #   （AVHWDeviceContext 创建、VAAPI/NVDEC 设备打开、
                            #    硬解能力探测，每个 unsafe 块带 // SAFETY:）

crates/frame-forge/src/
├── protocol.rs            # 现有请求结构体新增 hw_decode_enabled/device_strategy 字段；
                            #   新增 MSG_HW_DECODE_CAPS(0x1D) 的 Req/Resp 读写函数
├── server.rs               # 新增 MSG_HW_DECODE_CAPS handler；服务启动时一次性硬解能力检测
                            #   并缓存（FR-010）；现有解码调用点接入新字段
└── generation_log.rs       # 复用现有 FallbackEvent 记录硬解初始化/运行时回退（FR-011）

packages/JellyfinSuite.Plugin/
├── Configuration/PluginConfiguration.cs   # 新增 HwDecodeEnabled(bool)、
                                            #   HwDecodeDeviceStrategy(string) 字段
├── Services/DeviceEnumerationService.cs   # 补完 IsIntegrated 的真实判定（PCI 设备分类）；
                                            #   新增设备实时负载查询（NVIDIA/AMD 容易，Intel 需调研）
├── Services/FrameExportService.cs         # 把配置项透传进发往 daemon 的请求结构体
├── Models/HwDecodeSettingsDto.cs          # 新增：HwDecodeSettingsDto（GET 响应）+
                                            #   HwDecodeSettingsUpdateDto（PUT 请求体）
└── Controllers/FrameExportController.cs   # 新增 GET/PUT HwDecodeSettings 端点
                                            #   （走 Plugin.Instance.Configuration，不是内存 static）

apps/player-enhancer/src/components/
└── AdvancedPanel.tsx       # 工坊设置区域新增"硬件解码"开关 + 条件显示的策略选择器
```

**Structure Decision**: 沿用现有三层（Rust daemon / C# 插件 / React 前端）分层与既有文件归属，不新增顶层目录；新文件仅 `crates/jfs-common/src/hwaccel.rs`（隔离所有 unsafe FFI，便于按 CLAUDE.md 的 unsafe 规范集中审查与维护 `// SAFETY:` 注释）。

## Constitution Check（Phase 1 复核）

Phase 1（data-model.md / contracts/ / quickstart.md）设计完成后复核：未引入任何与宪章冲突的设计——配置持久化選用标准 `PluginConfiguration` 机制（非重构，不触及 I/II/VI/VII 范围），各 Stage 验证命令已在 tasks.md 生成前于本计划中明确（`mise run test` / `mise run update-linux`）。**PASS**，无需 Complexity Tracking。

## Complexity Tracking

无违反项，本节为空。
