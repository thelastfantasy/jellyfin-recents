using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite.Models;

public class SkipSegmentDto
{
    [JsonPropertyName("startMs")]
    public long StartMs { get; set; }
    [JsonPropertyName("endMs")]
    public long EndMs { get; set; }
}

public class PosterSheetRequestDto
{
    [Range(1, 20)]
    [JsonPropertyName("rows")]
    public int Rows { get; set; } = 6;

    [Range(1, 12)]
    [JsonPropertyName("cols")]
    public int Cols { get; set; } = 8;

    [JsonPropertyName("mode")]
    public string Mode { get; set; } = "deterministic";

    [JsonPropertyName("seed")]
    public string? Seed { get; set; }

    [Range(160, 600)]
    [JsonPropertyName("thumbWidth")]
    public int ThumbWidth { get; set; } = 320;

    [JsonPropertyName("overlay")]
    public OverlaySettings Overlay { get; set; } = new();

    [JsonPropertyName("skipSegments")]
    public List<SkipSegmentDto>? SkipSegments { get; set; }
}

public class PreviewRequestDto
{
    [Range(1, 20)]
    [JsonPropertyName("rows")]
    public int Rows { get; set; } = 6;

    [Range(1, 12)]
    [JsonPropertyName("cols")]
    public int Cols { get; set; } = 8;

    [Range(80, 800)]
    [JsonPropertyName("thumbWidth")]
    public int ThumbWidth { get; set; } = 320;

    [JsonPropertyName("overlay")]
    public OverlaySettings Overlay { get; set; } = new();
}
