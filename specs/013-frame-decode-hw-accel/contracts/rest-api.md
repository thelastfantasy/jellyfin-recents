# Contract: C# REST API（前端 ↔ 插件后端）

新增端点遵循 `FrameExportController.cs` 现有的 GET/PUT 配对风格（参照 `QualityThresholds`，但持久化机制不同——见下方"持久化"小节，不能照搬 `QualityThresholds` 的内存 `static` 模式）。所有 DTO 属性按 CLAUDE.md 的 JSON 规范强制加 `[JsonPropertyName]`，camelCase。

## GET /FrameExport/HwDecodeSettings

读取当前硬件解码设置 + 能力探测结果（合并两者，前端一次请求拿到渲染开关所需的全部信息）。

**Response DTO** `HwDecodeSettingsDto`：

```csharp
public sealed class HwDecodeSettingsDto
{
    [JsonPropertyName("enabled")]          public bool Enabled { get; set; }
    [JsonPropertyName("deviceStrategy")]   public string DeviceStrategy { get; set; } = "performance"; // "performance" | "idle-resource"
    [JsonPropertyName("supported")]        public bool Supported { get; set; }          // FR-010：整体是否检测到受支持设备
    [JsonPropertyName("unsupportedReason")] public string? UnsupportedReason { get; set; } // Supported=false 时的提示文案
    [JsonPropertyName("multiDeviceAvailable")] public bool MultiDeviceAvailable { get; set; } // 决定前端是否显示策略选择器
}
```

`Supported`/`UnsupportedReason`/`MultiDeviceAvailable` 来自查询 daemon 的 `MSG_HW_DECODE_CAPS`（见 socket-protocol.md）与 `DeviceEnumerationService` 的设备数量，不是 `PluginConfiguration` 里的持久化字段——这两类信息在同一个 DTO 里返回，但来源不同，`PUT` 时只接受可写字段（见下）。

## PUT /FrameExport/HwDecodeSettings

**Request Body** `HwDecodeSettingsUpdateDto`（只包含用户可写字段，不接受 `supported`/`unsupportedReason`/`multiDeviceAvailable`——这些是服务端探测结果，不可由前端写入）：

```csharp
public sealed class HwDecodeSettingsUpdateDto
{
    [JsonPropertyName("enabled")]        public bool Enabled { get; set; }
    [JsonPropertyName("deviceStrategy")] public string DeviceStrategy { get; set; } = "performance";
}
```

服务端校验：`DeviceStrategy` 不是 `"performance"`/`"idle-resource"` 之一时，按 data-model.md 的校验规则降级为 `"performance"`，不返回 400（与硬解功能整体"绝不因配置异常导致功能失败"的哲学一致）。

**Response**：返回更新后的完整 `HwDecodeSettingsDto`（与 GET 一致），便于前端用同一个类型刷新 UI。

**持久化**：Controller action 内部调用 `Plugin.Instance!.Configuration.HwDecodeEnabled = dto.Enabled;` / `...HwDecodeDeviceStrategy = dto.DeviceStrategy;` 然后 `Plugin.Instance!.SaveConfiguration();`——**不**使用类似 `_thresholds` 的 `private static` 内存字段（那种模式重启即丢，不满足 FR-007）。

## 前端调用点

两处均接入，共用同一后端设置（无冲突——都靠 GET 读服务端真值，PUT 后也用响应体校正本地状态）：

- `apps/frontend/src/components/PlayerEnhancerPanel.tsx`（"播放器增强" modal，主入口——原始需求"前端在播放器增强 modal 里新增一个工坊相关设置项"指的就是这个 modal）：modal 打开时 `GET` 一次填充开关初始状态，UI 上紧跟在"拖动进度条时显示缩略图预览"开关之后——这两者都依赖 frame-forge 的帧提取路径，放在一起合理。用户切换开关/策略时 `PUT`，乐观更新本地 UI 状态后用响应体校正。
- `apps/player-enhancer/src/components/AdvancedPanel.tsx`（工坊独立工具自身的高级面板，供单独打开工坊工具时也能直接调整）：同样的 `GET`/`PUT` 乐观更新模式。

**不**写入 `localStorage`（现有 `ExportSettings`/`saveSettings` 那条路径是前端本地偏好，语义上不适用于这个"插件级别全局设置"，必须走新端点）。

## 类型生成

新增/修改 DTO 后必须执行 `mise run gen-types`（需要 `jellyfin-dev` 容器运行），重新生成 `packages/api-types/src/jellyfin-api.ts`，前端从 `components['schemas']['HwDecodeSettingsDto']` 取类型，不手写重复接口定义。
