namespace Jellyfin.Plugin.JellyfinSuite.Models;

// ── POST /FrameExport/Generate ──────────────────────────────────────

public class GenerateRequest
{
    public Guid ItemId { get; set; }
    public string ItemTitle { get; set; } = "";
    public string Type { get; set; } = "animate"; // "animate" | "stitch"
    public List<FrameReference> Frames { get; set; } = new();
    public ExportParams Params { get; set; } = new();
}

public class FrameReference
{
    public long PositionMs { get; set; }
}

public class ExportParams
{
    public string Format { get; set; } = "gif"; // animate: gif/webp; stitch: png/webp-lossless
    public string ResizeMode { get; set; } = "width";
    public int? CustomWidth { get; set; }
    public int? CustomHeight { get; set; }
    public string ResolutionPreset { get; set; } = "original";
    public int Fps { get; set; } = 5;
    public int LoopCount { get; set; }
}

public class GenerateResponse
{
    public string TaskId { get; set; } = "";
}

// ── GET /FrameExport/Progress (SSE) ─────────────────────────────────

public class TaskProgressDto
{
    public string TaskId { get; set; } = "";
    public string Status { get; set; } = ""; // running | complete | error | fallback | cancelled
    public string Phase { get; set; } = "";
    public int Current { get; set; }
    public int Total { get; set; }
    public double Percent { get; set; }
    public string? ResultUrl { get; set; }
    public long? FileSize { get; set; }
    public string? Error { get; set; }
}

// ── Frame quality metadata ──────────────────────────────────────────

public class FrameQualityMeta
{
    public long PositionMs { get; set; }
    public double BrightnessVar { get; set; }
    public double LaplacianVar { get; set; }
    public double FrameDiff { get; set; }
    public bool IsJunk { get; set; }
    public string? JunkReason { get; set; }
}

// ── Quality thresholds config ───────────────────────────────────────

public class QualityThresholds
{
    public double BlackBrightnessVarMin { get; set; } = 5.0;
    public double WhiteBrightnessVarMax { get; set; } = 250.0;
    public double BlurLaplacianVarMin { get; set; } = 10.0;
}
