using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite.Models;

public enum JobStatus { Queued, Running, Done, Error, Cancelled }
public enum JobMode { Deterministic, Random }
public enum ColorTheme { Classic, Dark, Light, Cinematic, Minimal }
public enum FontFamily { NotoSans, NotoSerif }
public enum TimestampPosition { InsideTopLeft, InsideTopCenter, InsideTopRight, InsideBottomLeft, OutsideBottomLeft, InsideBottomCenter, OutsideBottomCenter, InsideBottomRight, OutsideBottomRight }

public class OverlaySettings
{
    [JsonPropertyName("brandingEnabled")]
    public bool BrandingEnabled { get; set; } = true;
    [JsonPropertyName("brandingText")]
    public string BrandingText { get; set; } = "Jellyfin Suite";
    [JsonPropertyName("videoInfoEnabled")]
    public bool VideoInfoEnabled { get; set; } = true;
    [JsonPropertyName("showFileSize")]
    public bool ShowFileSize { get; set; } = true;
    [JsonPropertyName("showResolutionFps")]
    public bool ShowResolutionFps { get; set; } = true;
    [JsonPropertyName("showVideoEncoding")]
    public bool ShowVideoEncoding { get; set; } = true;
    [JsonPropertyName("showAudioEncoding")]
    public bool ShowAudioEncoding { get; set; } = true;
    [JsonPropertyName("showDuration")]
    public bool ShowDuration { get; set; } = true;
    [JsonPropertyName("showSubtitles")]
    public bool ShowSubtitles { get; set; } = true;
    [JsonPropertyName("showFrameTimestamp")]
    public bool ShowFrameTimestamp { get; set; } = false;
    [JsonPropertyName("timestampFont")]
    public string TimestampFont { get; set; } = "roboto-mono";
    [JsonPropertyName("timestampBg")]
    public bool TimestampBg { get; set; } = true;
    [JsonPropertyName("timestampShadow")]
    public bool TimestampShadow { get; set; } = false;
    [JsonPropertyName("colorTheme")]
    public string ColorTheme { get; set; } = "classic";
    [JsonPropertyName("fontFamily")]
    public string FontFamily { get; set; } = "noto-sans";
    [JsonPropertyName("brandingLatinFont")]
    public string BrandingLatinFont { get; set; } = "noto-sans";
    [JsonPropertyName("brandingCjkFont")]
    public string BrandingCjkFont { get; set; } = "noto-sans-jp";
    [JsonPropertyName("lang")]
    public string Lang { get; set; } = "en";
    [JsonPropertyName("timestampPosition")]
    public string TimestampPosition { get; set; } = "inside-bottom-left";
}

public class MediaInfoDto
{
    [JsonPropertyName("filename")]
    public string Filename { get; set; } = string.Empty;
    [JsonPropertyName("fileSize")]
    public string FileSize { get; set; } = string.Empty;
    [JsonPropertyName("fileSizeBytes")]
    public long FileSizeBytes { get; set; }
    [JsonPropertyName("resolution")]
    public string Resolution { get; set; } = string.Empty;
    [JsonPropertyName("fps")]
    public double Fps { get; set; }
    [JsonPropertyName("videoCodec")]
    public string VideoCodec { get; set; } = string.Empty;
    [JsonPropertyName("bitDepth")]
    public int? BitDepth { get; set; }
    [JsonPropertyName("hdrType")]
    public string? HdrType { get; set; }
    [JsonPropertyName("colourSpace")]
    public string? ColourSpace { get; set; }
    [JsonPropertyName("audioCodec")]
    public string? AudioCodec { get; set; }
    [JsonPropertyName("audioFormat")]
    public string? AudioFormat { get; set; }
    [JsonPropertyName("audioBitrate")]
    public string? AudioBitrate { get; set; }
    [JsonPropertyName("audioSampleRate")]
    public int? AudioSampleRate { get; set; }
    [JsonPropertyName("audioTracks")]
    public int AudioTracks { get; set; }
    [JsonPropertyName("subtitleCount")]
    public int SubtitleCount { get; set; }
    [JsonPropertyName("duration")]
    public string Duration { get; set; } = string.Empty;
}

public class PosterSheetJob
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string ItemId { get; set; } = string.Empty;
    public string ItemTitle { get; set; } = string.Empty;
    public string CacheKey { get; set; } = string.Empty;
    public int Rows { get; set; }
    public int Cols { get; set; }
    public int ThumbWidth { get; set; } = 320;
    public JobMode Mode { get; set; }
    public string Seed { get; set; } = string.Empty;
    public OverlaySettings Overlay { get; set; } = new();
    public List<SkipSegmentDto>? SkipSegments { get; set; }
    public JobStatus Status { get; set; } = JobStatus.Queued;
    public int Progress { get; set; }
    public int Total { get; set; }
    public string? OutputPath { get; set; }
    public MediaInfoDto? MediaInfo { get; set; }
    public string? Error { get; set; }
    public CancellationTokenSource Cts { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
