using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite.Models;

public sealed class FrameIndexDto
{
    [JsonPropertyName("frames")] public FrameIndexEntryDto[] Frames { get; set; } = [];
    [JsonPropertyName("fps")]    public FpsFracDto Fps { get; set; } = new();
}

public sealed class FrameIndexEntryDto
{
    [JsonPropertyName("frameIndex")] public long FrameIndex { get; set; }
    [JsonPropertyName("ms")]         public long Ms        { get; set; }
    [JsonPropertyName("isKey")]      public bool IsKey     { get; set; }
}

public sealed class FpsFracDto
{
    [JsonPropertyName("num")] public long Num { get; set; }
    [JsonPropertyName("den")] public long Den { get; set; }
}
