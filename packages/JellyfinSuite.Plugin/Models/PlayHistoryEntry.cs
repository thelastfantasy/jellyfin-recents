using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite.Models;

public class PlayHistoryEntry
{
    [JsonPropertyName("itemId")]
    public string ItemId { get; set; } = string.Empty;
    [JsonPropertyName("playedDate")]
    public DateTime PlayedDate { get; set; }
    [JsonPropertyName("title")]
    public string? Title { get; set; }
    [JsonPropertyName("mediaType")]
    public string MediaType { get; set; } = "video";
    [JsonPropertyName("favoritedAt")]
    public DateTime? FavoritedAt { get; set; }
    [JsonPropertyName("releaseDate")]
    public DateTime? ReleaseDate { get; set; }
    [JsonPropertyName("addedDate")]
    public DateTime? AddedDate { get; set; }
    [JsonPropertyName("seriesName")]
    public string? SeriesName { get; set; }
    [JsonPropertyName("seriesId")]
    public string? SeriesId { get; set; }
    [JsonPropertyName("seasonNumber")]
    public int? SeasonNumber { get; set; }
    [JsonPropertyName("episodeNumber")]
    public int? EpisodeNumber { get; set; }
    [JsonPropertyName("imagePrimaryTag")]
    public string? ImagePrimaryTag { get; set; }
    [JsonPropertyName("hasAncestors")]
    public bool HasAncestors { get; set; }
    [JsonPropertyName("playbackPositionTicks")]
    public long? PlaybackPositionTicks { get; set; }
    [JsonPropertyName("videoDuration")]
    public double? VideoDuration { get; set; }  // RunTimeTicks / 10_000_000, null for audio
}

public class PlayHistoryResponse
{
    [JsonPropertyName("entries")]
    public List<PlayHistoryEntry> Entries { get; set; } = [];
    [JsonPropertyName("totalCount")]
    public int TotalCount { get; set; }
    [JsonPropertyName("totalPages")]
    public int TotalPages { get; set; }
}
