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
    /// <summary>NVIDIA compute capability (e.g. "12.0" for Blackwell), from `nvidia-smi`. Null when unavailable (non-NVIDIA GPU, nvidia-smi missing, or Windows).</summary>
    [JsonPropertyName("computeCapability")] public string? ComputeCapability { get; set; }
    /// <summary>Specific GPU model (e.g. "NVIDIA GeForce RTX 4090") from `nvidia-smi --query-gpu=name`.
    /// Null for CPU or non-NVIDIA GPUs (no model-name source wired up for AMD/Intel yet) — the
    /// frontend falls back to <see cref="DisplayName"/> in that case.</summary>
    [JsonPropertyName("modelName")] public string? ModelName { get; set; }
    /// <summary>Host device node (e.g. "/dev/dri/card0") identifying which physical card this is —
    /// lets a multi-GPU host tell otherwise-identically-named cards apart. Null for CPU.</summary>
    [JsonPropertyName("devicePath")] public string? DevicePath { get; set; }
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
    /// <summary>"installed" | "catalog" — mirrors <see cref="ModelEntryDto"/>'s Status field.</summary>
    [JsonPropertyName("status")]     public string                        Status      { get; set; } = "installed";
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

/// <summary>Mirrors frame-forge's `UpscaleLog` (written to `UpscaleReq.log_path`). Internal —
/// not served directly over HTTP; <see cref="UpscaleService"/> reads it to populate
/// <see cref="UpscaleJobDto.FaceRestoreSkippedNoFace"/> and to log GPU-fallback warnings.</summary>
public sealed class UpscaleLogDto
{
    [JsonPropertyName("deviceName")]               public string DeviceName               { get; set; } = "";
    [JsonPropertyName("deviceType")]                public string DeviceType               { get; set; } = "";
    [JsonPropertyName("deviceId")]                  public string DeviceId                 { get; set; } = "";
    [JsonPropertyName("faceRestoreRequested")]      public bool   FaceRestoreRequested      { get; set; }
    [JsonPropertyName("faceRestoreSkippedNoFace")]  public bool   FaceRestoreSkippedNoFace  { get; set; }
    [JsonPropertyName("fallbacks")]                 public List<FallbackEventDto> Fallbacks { get; set; } = new();
}

// ── Upscale (US7) ────────────────────────────────────────────────────

/// <summary>Internal transport between <see cref="Jellyfin.Plugin.JellyfinSuite.Services.FrameExportService"/>
/// and <see cref="Jellyfin.Plugin.JellyfinSuite.Services.UpscaleService"/> — never serialized over HTTP.</summary>
public sealed class UpscaleSubmitResult
{
    public byte[] OutputBytes { get; init; } = Array.Empty<byte>();
    public UpscaleLogDto? Log { get; init; }
}

public sealed class UpscaleStartRequestDto
{
    [JsonPropertyName("resultPath")]  public string  ResultPath  { get; set; } = "";
    // Output resolution multiplier relative to the SOURCE image — independent of which model
    // actually runs. 1 means "same resolution as the source, quality only" (only offered by the
    // frontend for animations); must be <= ModelScale, since a model can only ever be downscaled
    // after running, never upscaled beyond its native output.
    [JsonPropertyName("scale")]       public int     Scale       { get; set; } = 2; // 1 | 2 | 4
    // Which native Real-ESRGAN model to run: photo has real x2 and x4 variants (different
    // weights, see research.md §4); anime only ever has x4 (no native anime-x2 was ever released)
    // so UpscaleService.StartJob forces this to 4 regardless of what's sent when ModelStyle is
    // "anime".
    [JsonPropertyName("modelScale")]  public int     ModelScale  { get; set; } = 4; // 2 | 4
    [JsonPropertyName("modelStyle")]  public string  ModelStyle  { get; set; } = "photo"; // "photo" | "anime"
    [JsonPropertyName("faceRestore")] public bool    FaceRestore { get; set; }
    [JsonPropertyName("deviceId")]    public string? DeviceId    { get; set; }
}

public sealed class UpscaleJobDto
{
    [JsonPropertyName("jobId")]                    public string  JobId                    { get; set; } = "";
    [JsonPropertyName("status")]                   public string  Status                   { get; set; } = "pending"; // pending|running|succeeded|failed|cancelled
    [JsonPropertyName("percent")]                  public double  Percent                  { get; set; }
    [JsonPropertyName("error")]                    public string? Error                    { get; set; }
    [JsonPropertyName("originalUrl")]               public string? OriginalUrl              { get; set; }
    [JsonPropertyName("resultUrl")]                 public string? ResultUrl                { get; set; }
    [JsonPropertyName("originalWidth")]             public int?    OriginalWidth            { get; set; }
    [JsonPropertyName("originalHeight")]            public int?    OriginalHeight           { get; set; }
    [JsonPropertyName("resultWidth")]                public int?    ResultWidth              { get; set; }
    [JsonPropertyName("resultHeight")]               public int?    ResultHeight             { get; set; }
    [JsonPropertyName("originalSizeBytes")]          public long?   OriginalSizeBytes        { get; set; }
    [JsonPropertyName("resultSizeBytes")]            public long?   ResultSizeBytes          { get; set; }
    [JsonPropertyName("faceRestoreSkippedNoFace")]   public bool    FaceRestoreSkippedNoFace { get; set; }
}

/// <summary>Served by GET /JellyfinSuite/Stitch/Upscale/{jobId}/Log — combines job-level context
/// (requested device/scale/style, any C#-side error) with the frame-forge-side
/// <see cref="UpscaleLogDto"/> (device actually used, GPU fallbacks), so the "下载日志" button works
/// the same way for upscale as <see cref="GenerationLogDto"/> already does for stitch — and is
/// available for both animate and stitch source types, since upscale always invokes ORT
/// regardless of how the source image was produced.</summary>
public sealed class UpscaleJobLogDto
{
    [JsonPropertyName("jobId")]                public string   JobId                { get; set; } = "";
    [JsonPropertyName("status")]               public string   Status               { get; set; } = "";
    [JsonPropertyName("error")]                public string?  Error                { get; set; }
    [JsonPropertyName("scale")]                public int      Scale                { get; set; }
    [JsonPropertyName("modelStyle")]           public string   ModelStyle           { get; set; } = "";
    [JsonPropertyName("faceRestoreRequested")] public bool     FaceRestoreRequested { get; set; }
    [JsonPropertyName("deviceIdRequested")]    public string?  DeviceIdRequested    { get; set; }
    [JsonPropertyName("createdAt")]            public DateTime CreatedAt            { get; set; }
    [JsonPropertyName("log")]                  public UpscaleLogDto? Log            { get; set; }
}
