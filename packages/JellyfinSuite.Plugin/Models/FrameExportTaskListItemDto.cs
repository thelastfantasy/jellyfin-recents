using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite.Models;

public class FrameExportTaskListItemDto
{
    [JsonPropertyName("taskId")]    public string  TaskId    { get; set; } = "";
    [JsonPropertyName("itemId")]    public string  ItemId    { get; set; } = "";
    [JsonPropertyName("itemTitle")] public string  ItemTitle { get; set; } = "";
    [JsonPropertyName("type")]      public string  Type      { get; set; } = "";
    [JsonPropertyName("status")]    public string  Status    { get; set; } = "";
    [JsonPropertyName("resultUrl")] public string? ResultUrl { get; set; }
    [JsonPropertyName("fileSize")]  public long?   FileSize  { get; set; }
    [JsonPropertyName("error")]     public string? Error     { get; set; }
    [JsonPropertyName("createdAt")] public long    CreatedAt { get; set; }
    [JsonPropertyName("upscaled")]  public bool    Upscaled  { get; set; }
    [JsonPropertyName("upscaledResultUrl")]  public string? UpscaledResultUrl  { get; set; }
    [JsonPropertyName("upscaledFileSize")]   public long?   UpscaledFileSize   { get; set; }
    [JsonPropertyName("upscaledMimeType")]   public string? UpscaledMimeType   { get; set; }
}
