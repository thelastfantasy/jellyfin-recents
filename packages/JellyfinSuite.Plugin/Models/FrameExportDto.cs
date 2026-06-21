using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite.Models;

// ── POST /FrameExport/PrefetchReady/{itemId} ────────────────────────

public class PrefetchRangeStreamRequest
{
    /// <summary>Anchor position in milliseconds. Mutually exclusive with <see cref="CurrentFrameIndex"/>.</summary>
    [JsonPropertyName("currentTimeMs")]       public long?  CurrentTimeMs       { get; set; }
    /// <summary>Anchor frame index (preferred over currentTimeMs). Mutually exclusive with <see cref="CurrentTimeMs"/>.</summary>
    [JsonPropertyName("currentFrameIndex")]   public long?  CurrentFrameIndex   { get; set; }
    [JsonPropertyName("beforeSeconds")]       public double? BeforeSeconds       { get; set; }
    [JsonPropertyName("afterSeconds")]        public double? AfterSeconds        { get; set; }
    [JsonPropertyName("includeCurrentFrame")]  public bool   IncludeCurrentFrame   { get; set; } = true;
    [JsonPropertyName("width")]                public int    Width                 { get; set; } = 320;
    [JsonPropertyName("prefetchSessionId")]    public string PrefetchSessionId     { get; set; } = "";
}

// ── POST /FrameExport/Prefetch/{itemId} ─────────────────────────────

public class PrefetchRequest
{
    [JsonPropertyName("startFrameIdx")]      public int    StartFrameIdx       { get; set; }
    [JsonPropertyName("beforeSeconds")]      public double BeforeSeconds       { get; set; }
    [JsonPropertyName("afterSeconds")]       public double AfterSeconds        { get; set; }
    [JsonPropertyName("includeStart")]       public bool   IncludeStart        { get; set; } = true;
    [JsonPropertyName("width")]              public int    Width               { get; set; } = 320;
    [JsonPropertyName("positions")]          public List<long>? Positions      { get; set; }
    [JsonPropertyName("framePairs")] public List<FramePairDto>? FramePairs { get; set; }
}

public class FramePairDto
{
    [JsonPropertyName("fiIdx")]  public long FiIdx  { get; set; }
    [JsonPropertyName("posMs")]  public long PosMs  { get; set; }
}

// ── POST /FrameExport/Generate ──────────────────────────────────────

public class GenerateRequest
{
    [JsonPropertyName("itemId")]    public Guid ItemId { get; set; }
    [JsonPropertyName("itemTitle")] public string ItemTitle { get; set; } = "";
    [JsonPropertyName("type")]      public string Type { get; set; } = "animate"; // "animate" | "stitch"
    [JsonPropertyName("frames")]    public List<FrameReference> Frames { get; set; } = new();
    [JsonPropertyName("params")]    public ExportParams Params { get; set; } = new();
}

public class FrameReference
{
    // Primary: frame index from /JellyfinSuite/{itemId}/FrameInfo
    [JsonPropertyName("frameIdx")]   public int? FrameIdx   { get; set; }
    // Fallback: positionMs (used when FrameInfo unavailable)
    [JsonPropertyName("positionMs")] public long? PositionMs { get; set; }
}

public class ExportParams
{
    [JsonPropertyName("format")]           public string Format { get; set; } = "gif"; // animate: gif/webp; stitch: png/webp-lossless
    [JsonPropertyName("resizeMode")]       public string ResizeMode { get; set; } = "width";
    [JsonPropertyName("customWidth")]      public int? CustomWidth { get; set; }
    [JsonPropertyName("customHeight")]     public int? CustomHeight { get; set; }
    [JsonPropertyName("resolutionPreset")] public string ResolutionPreset { get; set; } = "original";
    [JsonPropertyName("speed")]            public float Speed { get; set; } = 1.0f;
    [JsonPropertyName("loopCount")]        public int LoopCount { get; set; }
    [JsonPropertyName("cropX")]       public float?  CropX        { get; set; }
    [JsonPropertyName("cropY")]       public float?  CropY        { get; set; }
    [JsonPropertyName("cropW")]       public float?  CropW        { get; set; }
    [JsonPropertyName("cropH")]       public float?  CropH        { get; set; }
    [JsonPropertyName("quality")]     public float   Quality      { get; set; } = 0.75f;
    // Stitch-specific: GPU/model selection (null = server default)
    [JsonPropertyName("deviceId")]    public string? DeviceId     { get; set; }
    [JsonPropertyName("modelFamily")] public string? ModelFamily  { get; set; }
    [JsonPropertyName("modelVersion")] public string? ModelVersion { get; set; }
    [JsonPropertyName("ortVersion")] public string? OrtVersion   { get; set; }
}

public class GenerateResponse
{
    [JsonPropertyName("taskId")] public string TaskId { get; set; } = "";
}

// ── GET /FrameExport/Progress (SSE) ─────────────────────────────────

public class TaskProgressDto
{
    [JsonPropertyName("taskId")]    public string  TaskId    { get; set; } = "";
    [JsonPropertyName("status")]    public string  Status    { get; set; } = ""; // running | complete | error | fallback | cancelled
    [JsonPropertyName("phase")]     public string  Phase     { get; set; } = "";
    [JsonPropertyName("current")]   public int     Current   { get; set; }
    [JsonPropertyName("total")]     public int     Total     { get; set; }
    [JsonPropertyName("percent")]   public double  Percent   { get; set; }
    [JsonPropertyName("resultUrl")] public string? ResultUrl { get; set; }
    [JsonPropertyName("fileSize")]  public long?   FileSize  { get; set; }
    [JsonPropertyName("error")]     public string? Error     { get; set; }
}

// ── Frame quality metadata ──────────────────────────────────────────

public class FrameQualityMeta
{
    [JsonPropertyName("positionMs")]    public long    PositionMs    { get; set; }
    [JsonPropertyName("brightnessVar")] public double  BrightnessVar { get; set; }
    [JsonPropertyName("laplacianVar")]  public double  LaplacianVar  { get; set; }
    [JsonPropertyName("frameDiff")]     public double  FrameDiff     { get; set; }
    [JsonPropertyName("isJunk")]        public bool    IsJunk        { get; set; }
    [JsonPropertyName("junkReason")]    public string? JunkReason    { get; set; }
}

// ── Quality thresholds config ───────────────────────────────────────

public class QualityThresholds
{
    [JsonPropertyName("blackBrightnessVarMin")] public double BlackBrightnessVarMin { get; set; } = 5.0;
    [JsonPropertyName("whiteBrightnessVarMax")] public double WhiteBrightnessVarMax { get; set; } = 250.0;
    [JsonPropertyName("blurLaplacianVarMin")]   public double BlurLaplacianVarMin   { get; set; } = 10.0;
}
