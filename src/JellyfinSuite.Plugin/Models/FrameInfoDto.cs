using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite.Models;

public sealed class FrameInfoDto
{
    [JsonPropertyName("frameIdx")]    public long FrameIdx    { get; set; }
    [JsonPropertyName("frameStartMs")] public long FrameStartMs { get; set; }
}
