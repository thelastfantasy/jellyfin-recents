using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite.Models;

public class PosterSheetStatusDto
{
    [JsonPropertyName("jobId")]
    public string JobId { get; set; } = string.Empty;
    [JsonPropertyName("itemId")]
    public string ItemId { get; set; } = string.Empty;
    [JsonPropertyName("itemTitle")]
    public string ItemTitle { get; set; } = string.Empty;
    [JsonPropertyName("status")]
    public string Status { get; set; } = string.Empty;
    [JsonPropertyName("progress")]
    public int Progress { get; set; }
    [JsonPropertyName("total")]
    public int Total { get; set; }
    [JsonPropertyName("error")]
    public string? Error { get; set; }
    [JsonPropertyName("mediaInfo")]
    public MediaInfoDto? MediaInfo { get; set; }
    /// <summary>Unix milliseconds (UTC) when the job was created. Used by clients for stable cross-device ordering.</summary>
    [JsonPropertyName("createdAt")]
    public long CreatedAt { get; set; }
}

public class StartJobResponseDto
{
    [JsonPropertyName("jobId")]
    public string JobId { get; set; } = string.Empty;
}

public class CacheCheckResponseDto
{
    [JsonPropertyName("cached")]
    public bool Cached { get; set; }
    [JsonPropertyName("jobId")]
    public string? JobId { get; set; }
}
