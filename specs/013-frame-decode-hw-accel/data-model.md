# Phase 1 Data Model: 帧解码硬件加速

## 1. HwDecodeSettings（持久化，插件级别全局配置）

对应 spec Key Entities 的"硬件解码开关设置"与"硬件解码设备选择策略"。落地为 `PluginConfiguration` 的两个字段，XML 持久化，重启存活。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `HwDecodeEnabled` | bool | `true` | FR-005/006/007/008。关闭时系统完全不走硬解路径。 |
| `HwDecodeDeviceStrategy` | enum（序列化为 string）：`Performance` \| `IdleResource` | `Performance` | FR-012。仅在检测到多个受支持设备时才在 UI 暴露；单/零设备机器上该字段仍被持久化但不产生可观察行为差异、UI 不展示对应控件。 |

**校验规则**：`HwDecodeDeviceStrategy` 只接受这两个枚举值；反序列化遇到未知值时降级为 `Performance`（与"负载数据不可用时降级为静态独显优先"的整体降级哲学一致，不抛错阻断启动）。

**生命周期**：用户在播放器增强 modal 改动后立即写入 `PluginConfiguration` 并 `SaveConfiguration()`；正在进行中的帧提取任务沿用任务发起时读到的值（spec Edge Cases 已约定，不动态打断）。

## 2. HwDecodeCapabilities（运行时探测结果，daemon 进程内缓存，不持久化到磁盘）

对应 FR-010。daemon 启动时探测一次，缓存至该 daemon 进程生命周期结束（重启才重新探测）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `supported` | bool | 整体是否至少有一种受支持的硬件解码路径可用 |
| `vendors[]` | `VendorCapability[]` | 每个厂商（NVIDIA/AMD/Intel）各自的探测结果，用于 modal 提示文案与诊断日志 |

`VendorCapability`:

| 字段 | 类型 | 说明 |
|------|------|------|
| `vendor` | enum `NVIDIA`\|`AMD`\|`Intel` | |
| `supported` | bool | 该厂商的硬解路径（VAAPI/NVDEC）是否初始化成功 |
| `reason` | string（可空） | 不支持时的原因（驱动缺失/设备不支持/未检测到设备），写入 FR-011 诊断日志 |

**状态转换**：`Unknown`（daemon 刚启动，尚未探测）→（探测一次后）→ `Detected`（缓存值，daemon 生命周期内不变）。C# 侧通过新协议消息 `MSG_HW_DECODE_CAPS` 查询该缓存值，用于渲染开关的禁用态 + 提示文案（FR-010/SC-005）。

## 3. DeviceSelectionResult（单次解码操作的设备选择结果，纯运行时、不持久化）

对应 FR-012 的执行结果，用于 FR-011 诊断日志记录"这次到底用了哪个设备、为什么"。

| 字段 | 类型 | 说明 |
|------|------|------|
| `chosenDevice` | `{ vendor, isIntegrated, deviceId }` | 本次解码实际使用的设备 |
| `strategyUsed` | enum `Performance`\|`IdleResource` | 本次生效的策略（即任务发起时读到的 `HwDecodeDeviceStrategy`） |
| `loadSnapshot[]`（仅 `IdleResource` 时填充） | `{ deviceId, utilizationPercent: number \| null }[]` | `utilizationPercent` 为 `null` 表示该设备负载数据获取失败 |
| `degradedToStatic` | bool | 当 `strategyUsed = IdleResource` 但因负载数据不可用而实际按静态独显优先规则选择时为 `true` |

**已实现简化（T015）**：实际实现未落地为一个独立的结构体/序列化类型——`server.rs::resolve_hw_decode_request`（连同 `pick_performance_vendor`/`pick_idle_resource_vendor`）在每次解码调用前同步完成本表描述的全部决策（策略判断、负载查询、降级判断），但决策过程本身不落盘/不上报，只有最终失败场景（初始化失败/运行中失败）才通过 `FallbackEvent`（见 §4）写诊断日志。即"为什么选了这个设备"目前不可在成功路径下事后查询，只有失败/降级路径才留痕。这对 FR-011（"硬解失败或不支持的诊断信息"）是足够的，但不满足本表"用于记录这次到底用了哪个设备、为什么"这一更宽的描述——如果后续需要审计成功路径的设备选择历史，需要补一个轻量的结构化记录（如算上 `log::debug!`，无需新建持久化结构）。

## 4. FallbackEvent（复用现有结构，语义扩展）

复用 `crates/frame-forge/src/generation_log.rs` 第3-10行已有的 `FallbackEvent` struct（无需改字段），新增两个 `event_type` 取值用于硬解场景：

| `event_type` 取值 | 触发时机 | 对应 FR |
|---|---|---|
| `hwdecode_init_failed` | 硬解初始化失败（驱动缺失/设备不支持该编码格式），本次操作整体回退软解 | FR-003 / FR-011 |
| `hwdecode_runtime_fallback` | 硬解已开始但某帧执行中途失败，该帧及后续帧回退软解 | FR-004 / FR-011 |

`reason` 字段写入具体失败原因（如 `"VAAPI init failed: no /dev/dri/renderD128"`），供生产环境（如 A380）事后核实硬解是否真正生效。

## 5. ComputeDeviceDto（现有 DTO，补全字段语义）

`packages/JellyfinSuite.Plugin/Models/StitchDto.cs` 第7-25行已有：

| 字段 | 现状 | 本功能要求 |
|------|------|-----------|
| `Vendor` | 已正确按 PCI vendor ID 映射（`NormaliseVendor()`） | 不变，直接复用 |
| `IsIntegrated` | **硬编码 `false`**（死字段） | 必须实现真实判定：NVIDIA 设备直接 `false`；AMD/Intel 按已知芯片代号/PCI device ID 区间查表判定 |

不新增字段——`IsIntegrated` 修复后即可同时服务于 Real-ESRGAN 的设备选择（如果未来需要）与本功能的 FR-012。

## 实体关系图（文字版）

```
PluginConfiguration (持久化)
  └─ HwDecodeSettings { HwDecodeEnabled, HwDecodeDeviceStrategy }
        │ 任务发起时读取一次，整任务期间不变
        ▼
FrameExportService.SubmitXxxTaskAsync()
  └─ 经 socket 协议把 { hw_decode_enabled, device_strategy } 写入
     AnimateReq / StitchReq / PrefetchRangeReq 等现有请求结构体
        │
        ▼
frame-forge daemon (server.rs)
  ├─ HwDecodeCapabilities（daemon 启动时探测一次，缓存）
  │     └─ 经 MSG_HW_DECODE_CAPS 暴露给 C#，渲染开关禁用态（FR-010）
  ├─ DeviceEnumerationService 同款独显/核显分类 + 负载查询
  │     └─ 产出 DeviceSelectionResult（每次解码操作）
  └─ 解码失败/回退
        └─ 写 FallbackEvent（hwdecode_init_failed / hwdecode_runtime_fallback）到诊断日志（FR-011）
```
