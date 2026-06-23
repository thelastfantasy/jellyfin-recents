using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite.Models;

// ── Hardware-decode settings (spec 013) ──────────────────────────────

/// <summary>
/// GET /FrameExport/HwDecodeSettings response — merges the persisted toggle/strategy
/// (<see cref="Configuration.PluginConfiguration"/>) with the daemon's once-at-startup capability
/// probe (FR-010) and device count, so the frontend gets everything it needs to render the
/// switch + (conditionally) the strategy picker in a single request.
/// </summary>
public sealed class HwDecodeSettingsDto
{
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }

    /// <summary>"performance" | "idle-resource".</summary>
    [JsonPropertyName("deviceStrategy")] public string DeviceStrategy { get; set; } = "performance";

    /// <summary>FR-010: whether the daemon detected at least one supported hw-decode vendor.</summary>
    [JsonPropertyName("supported")] public bool Supported { get; set; }

    /// <summary>Set when <see cref="Supported"/> is false — shown next to the disabled switch.</summary>
    [JsonPropertyName("unsupportedReason")] public string? UnsupportedReason { get; set; }

    /// <summary>
    /// FR-012: whether the strategy picker should be shown at all (only when &gt;1 hw-decode-capable
    /// vendor was detected by the daemon's own probe). Deliberately NOT derived from
    /// DeviceEnumerationService's GPU count — that service enumerates ONNX EP devices via
    /// /sys/class/drm, which under-counts here: an NVIDIA GPU passed into a container via the
    /// nvidia-container-toolkit only exposes /dev/nvidia*, not a DRM card node, so on an
    /// NVIDIA+AMD dev host it would see only the AMD card and report false despite both vendors
    /// being genuinely hw-decode-capable (confirmed via the daemon's caps probe, which checks
    /// NVIDIA directly through CUDA device-context creation, not sysfs).
    /// </summary>
    [JsonPropertyName("multiDeviceAvailable")] public bool MultiDeviceAvailable { get; set; }
}

/// <summary>
/// PUT /FrameExport/HwDecodeSettings request body — only the user-writable fields. The
/// server-detected fields (<see cref="HwDecodeSettingsDto.Supported"/> etc.) are deliberately
/// absent here; they can't be set by the client.
/// </summary>
public sealed class HwDecodeSettingsUpdateDto
{
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }

    [JsonPropertyName("deviceStrategy")] public string DeviceStrategy { get; set; } = "performance";
}

/// <summary>
/// Parsed result of <c>MSG_HW_DECODE_CAPS</c> (FrameExportService.GetHwDecodeCapsAsync) — not a
/// wire/JSON DTO itself, just the piece the controller folds into <see cref="HwDecodeSettingsDto"/>.
/// </summary>
public sealed record HwDecodeCapsResult(bool Supported, string? UnsupportedReason, int SupportedVendorCount = 0);
