using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite.Models;

// ── Device enumeration ───────────────────────────────────────────────

public sealed class ComputeDeviceDto
{
    [JsonPropertyName("id")]          public string  Id          { get; set; } = "";
    [JsonPropertyName("displayName")] public string  DisplayName { get; set; } = "";
    [JsonPropertyName("deviceType")]  public string  DeviceType  { get; set; } = "CPU"; // "GPU" | "CPU"
    [JsonPropertyName("vendor")]      public string  Vendor      { get; set; } = "";
    [JsonPropertyName("vramMb")]      public long?   VramMb      { get; set; }
    [JsonPropertyName("isIntegrated")] public bool   IsIntegrated { get; set; }
    [JsonPropertyName("isDefault")]   public bool    IsDefault   { get; set; }
}

public sealed class DeviceListDto
{
    [JsonPropertyName("devices")] public List<ComputeDeviceDto> Devices { get; set; } = new();
}

// ── Model management ─────────────────────────────────────────────────

public sealed class ModelEntryDto
{
    [JsonPropertyName("family")]        public string  Family        { get; set; } = "";
    [JsonPropertyName("displayName")]   public string  DisplayName   { get; set; } = "";
    [JsonPropertyName("version")]       public string  Version       { get; set; } = "";
    [JsonPropertyName("fileName")]      public string  FileName      { get; set; } = "";
    [JsonPropertyName("fileSizeBytes")] public long?   FileSizeBytes { get; set; }
    [JsonPropertyName("sha256")]        public string? Sha256        { get; set; }
    [JsonPropertyName("downloadUrl")]   public string? DownloadUrl   { get; set; }
    [JsonPropertyName("releaseDate")]   public string? ReleaseDate   { get; set; }
    [JsonPropertyName("status")]        public string  Status        { get; set; } = "catalog"; // "installed" | "catalog"
    [JsonPropertyName("localPath")]     public string? LocalPath     { get; set; }
    [JsonPropertyName("lastUsedAt")]    public string? LastUsedAt    { get; set; }
    [JsonPropertyName("isLatest")]      public bool    IsLatest      { get; set; }
}

public sealed class ModelListDto
{
    [JsonPropertyName("models")]           public List<ModelEntryDto> Models           { get; set; } = new();
    [JsonPropertyName("catalogFetchedAt")] public string?             CatalogFetchedAt { get; set; }
    [JsonPropertyName("catalogStale")]     public bool                CatalogStale     { get; set; }
}

public sealed class ModelDownloadRequestDto
{
    [JsonPropertyName("family")]  public string Family  { get; set; } = "";
    [JsonPropertyName("version")] public string Version { get; set; } = "";
}

public sealed class ModelDownloadProgressDto
{
    [JsonPropertyName("family")]  public string Family  { get; set; } = "";
    [JsonPropertyName("version")] public string Version { get; set; } = "";
    [JsonPropertyName("percent")] public double Percent { get; set; }
    [JsonPropertyName("status")]  public string Status  { get; set; } = ""; // "downloading" | "installed" | "error" | "cancelled"
    [JsonPropertyName("error")]   public string? Error  { get; set; }
}

public sealed class ModelDeleteResult
{
    public bool    Success { get; init; }
    public string? Error   { get; init; }

    public static ModelDeleteResult Ok()  => new() { Success = true };
    public static ModelDeleteResult Fail(string error) => new() { Success = false, Error = error };
}

public enum ModelDownloadStartResult
{
    Started,
    NotFound,
    AlreadyInstalled,
    InProgress,
}

// ── ORT version management ───────────────────────────────────────────

public sealed class OrtAssetDto
{
    [JsonPropertyName("url")]       public string Url       { get; set; } = "";
    [JsonPropertyName("sha256")]    public string Sha256    { get; set; } = "";
    [JsonPropertyName("sizeBytes")] public long   SizeBytes { get; set; }
}

public sealed class OrtVersionDto
{
    [JsonPropertyName("version")]     public string                        Version     { get; set; } = "";
    [JsonPropertyName("releaseDate")] public string?                       ReleaseDate { get; set; }
    [JsonPropertyName("isActive")]    public bool                          IsActive    { get; set; }
    [JsonPropertyName("localDir")]    public string?                       LocalDir    { get; set; }
    [JsonPropertyName("installedAt")] public string?                       InstalledAt { get; set; }
    [JsonPropertyName("assets")]      public Dictionary<string, OrtAssetDto>? Assets  { get; set; }
}

public sealed class OrtVersionListDto
{
    [JsonPropertyName("activeVersion")]      public string?          ActiveVersion      { get; set; }
    [JsonPropertyName("versions")]           public List<OrtVersionDto> Versions        { get; set; } = new();
    [JsonPropertyName("maxRetainedVersions")] public int             MaxRetainedVersions { get; set; } = 2;
}

public sealed class OrtDownloadRequestDto
{
    [JsonPropertyName("version")] public string Version { get; set; } = "";
}

public sealed class OrtActivateRequestDto
{
    [JsonPropertyName("version")] public string Version { get; set; } = "";
}

public sealed class OrtDownloadProgressDto
{
    [JsonPropertyName("version")] public string  Version { get; set; } = "";
    [JsonPropertyName("percent")] public double  Percent { get; set; }
    [JsonPropertyName("status")]  public string  Status  { get; set; } = ""; // "downloading" | "installed" | "error" | "cancelled"
    [JsonPropertyName("error")]   public string? Error   { get; set; }
}

public enum OrtDownloadStartResult
{
    Started,
    NotFound,
    AlreadyInstalled,
    InProgress,
}

// ── Generation log ───────────────────────────────────────────────────

public sealed class FallbackEventDto
{
    [JsonPropertyName("type")]      public string Type      { get; set; } = "";
    [JsonPropertyName("reason")]    public string Reason    { get; set; } = "";
    [JsonPropertyName("timestamp")] public string Timestamp { get; set; } = "";
}

public sealed class GenerationLogDto
{
    [JsonPropertyName("algorithm")]            public string              Algorithm            { get; set; } = "";
    [JsonPropertyName("modelFileName")]        public string              ModelFileName        { get; set; } = "";
    [JsonPropertyName("modelVersion")]         public string              ModelVersion         { get; set; } = "";
    [JsonPropertyName("ortVersion")]           public string              OrtVersion           { get; set; } = "";
    [JsonPropertyName("deviceName")]           public string              DeviceName           { get; set; } = "";
    [JsonPropertyName("deviceType")]           public string              DeviceType           { get; set; } = "";
    [JsonPropertyName("deviceId")]             public string              DeviceId             { get; set; } = "";
    [JsonPropertyName("keypointMatchCount")]   public uint                KeypointMatchCount   { get; set; }
    [JsonPropertyName("inferenceDurationMs")]  public ulong               InferenceDurationMs  { get; set; }
    [JsonPropertyName("totalDurationMs")]      public ulong               TotalDurationMs      { get; set; }
    [JsonPropertyName("fallbacks")]            public List<FallbackEventDto> Fallbacks         { get; set; } = new();
}
