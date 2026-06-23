using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.JellyfinSuite.Configuration;

/// <summary>
/// Plugin configuration for Jellyfin Suite.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Whether to automatically inject the player enhancer ESM bundle into config.json on startup.
    /// Set to false when the user has explicitly removed the injection via the management UI.
    /// </summary>
    public bool AutoInjectEnabled { get; set; } = true;

    /// <summary>
    /// Number of seconds to seek on mobile double-tap gesture. Default 10.
    /// </summary>
    public double SeekSeconds { get; set; } = 10;

    /// <summary>
    /// Playback speed multiplier for long-press speed-up gesture. Default 2.0.
    /// </summary>
    public double SpeedRate { get; set; } = 2.0;

    /// <summary>
    /// Whether frame-forge should attempt hardware-accelerated decode (VAAPI/NVDEC) for
    /// thumbnail/animate/stitch frame extraction. Default on; failures fall back to software
    /// transparently (FR-003/FR-004), so this only controls whether the hw path is attempted at
    /// all (FR-008: off means zero hw path attempts).
    /// </summary>
    public bool HwDecodeEnabled { get; set; } = true;

    /// <summary>
    /// Device-selection strategy when multiple supported hw-decode devices exist (FR-012):
    /// <c>"performance"</c> (static, prefers the discrete GPU) or <c>"idle-resource"</c>
    /// (dynamic, prefers whichever supported device currently reports the lowest real-time
    /// load). Unknown values are treated as <c>"performance"</c> by both this property's own
    /// validation and frame-forge's wire-level decode (data-model.md §1's degrade-don't-reject
    /// philosophy).
    /// </summary>
    public string HwDecodeDeviceStrategy { get; set; } = "performance";
}
