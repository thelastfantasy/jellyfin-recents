using System.Collections.Concurrent;
using Jellyfin.Plugin.JellyfinSuite.Models;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

public enum UpscaleJobStatus { Pending, Running, Succeeded, Failed, Cancelled }

public enum UpscaleStartResult { Started, SourceNotFound, AnimationRequiresNvidiaGpu }

internal sealed class UpscaleJobState
{
    public string JobId { get; init; } = Guid.NewGuid().ToString("N");
    public UpscaleJobStatus Status { get; set; } = UpscaleJobStatus.Pending;
    public double Percent { get; set; }
    public string? Error { get; set; }
    public string SourceTaskId { get; init; } = "";
    public string OriginalUrl { get; init; } = "";
    public string OriginalPath { get; init; } = "";
    public string? ResultPath { get; set; }
    public int? OriginalWidth { get; init; }
    public int? OriginalHeight { get; init; }
    public int? ResultWidth { get; set; }
    public int? ResultHeight { get; set; }
    public long? OriginalSizeBytes { get; init; }
    public long? ResultSizeBytes { get; set; }
    public bool FaceRestoreSkippedNoFace { get; set; }
    public string TempDir { get; init; } = "";
    public string OutputExt { get; init; } = ".png";
    public CancellationTokenSource Cts { get; } = new();
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;
    public int Scale { get; init; }
    public int ModelScale { get; init; }
    public string ModelStyle { get; init; } = "";
    public bool FaceRestoreRequested { get; init; }
    public string? DeviceId { get; init; }
    public UpscaleLogDto? Log { get; set; }
}

/// <summary>Tracks "提升画质" (US7) jobs — analogous to <see cref="FrameExportTaskManager"/> but
/// with its own job dictionary, since T057 places the Upscale endpoints on
/// <c>StitchController</c> rather than <c>FrameExportController</c>. Resolves the source file via
/// <see cref="FrameExportTaskManager"/> (the `resultPath` the frontend supplies is the same
/// `/JellyfinSuite/FrameExport/Result/{taskId}/...` URL already used for downloads), runs the
/// upscale through <see cref="FrameExportService.SubmitUpscaleTaskAsync"/>, and never touches
/// the original result file — both the original and the upscaled output are only ever served via
/// download (`GetResultBytes`); there used to be a "replace/save-as" confirm step that copied the
/// result over `OriginalPath`, but that path lives in <see cref="FrameExportTaskManager"/>'s own
/// temp dir (purged ~5min after creation regardless), so it never actually persisted anything a
/// plain download didn't already cover — removed rather than kept as dead ceremony.</summary>
public sealed class UpscaleService : IDisposable
{
    private readonly ConcurrentDictionary<string, UpscaleJobState> _jobs = new();
    private readonly FrameExportService _frameExport;
    private readonly ModelCatalogService _modelCatalog;
    private readonly FrameExportTaskManager _taskManager;
    private readonly DeviceEnumerationService _deviceEnum;
    private readonly ILogger<UpscaleService> _logger;
    private readonly string _tempRoot;
    private readonly Timer _cleanupTimer;
    private bool _disposed;

    public UpscaleService(
        FrameExportService frameExport,
        ModelCatalogService modelCatalog,
        FrameExportTaskManager taskManager,
        DeviceEnumerationService deviceEnum,
        IApplicationPaths appPaths,
        ILogger<UpscaleService> logger)
    {
        _frameExport = frameExport;
        _modelCatalog = modelCatalog;
        _taskManager = taskManager;
        _deviceEnum = deviceEnum;
        _logger = logger;
        _tempRoot = Path.Combine(appPaths.DataPath, "temp", "frame-forge", "upscale");
        Directory.CreateDirectory(_tempRoot);

        // Cleanup orphan dirs left over from a previous process (mirrors FrameExportTaskManager).
        foreach (var dir in Directory.GetDirectories(_tempRoot))
        {
            try { Directory.Delete(dir, recursive: true); }
            catch { _logger.LogWarning("[Upscale] Failed to clean orphan dir: {Dir}", dir); }
        }

        _cleanupTimer = new Timer(_ => CleanupExpired(), null, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5));
    }

    private static string? ExtractTaskId(string resultPath)
    {
        // resultPath looks like "/JellyfinSuite/FrameExport/Result/{taskId}/output.ext"
        var parts = resultPath.Split('/');
        var idx = Array.IndexOf(parts, "Result");
        return idx >= 0 && idx + 1 < parts.Length ? parts[idx + 1] : null;
    }

    public (UpscaleStartResult Result, UpscaleJobDto? Job) StartJob(
        string resultPath, int scale, int modelScale, string modelStyle, bool faceRestore, string? deviceId)
    {
        var taskId = ExtractTaskId(resultPath);
        var task = taskId != null ? _taskManager.GetTask(taskId) : null;
        if (task?.OutputPath is null || !File.Exists(task.OutputPath))
            return (UpscaleStartResult.SourceNotFound, null);

        var isAnimation = task.Type == "animate";

        // 动图提升画质要按帧数重复跑同一套 tile 推理流水线，成本远高于全景图的单次画布；目前只有
        // NVIDIA CUDA EP 经过真实硬件验证（见 CudaRuntimeAcquisitionService 的 libcurand/libcufft
        // 修复记录），OpenVINO(Intel)/ROCm(AMD) 分支均未在真机上验证，纯 CPU 逐帧跑 ONNX 推理更是
        // 慢到不实用 —— 没有量化的跨厂商算力评分机制（评估过，放弃），所以用"host 上是否存在任意
        // NVIDIA GPU"作为门槛的实用代理。全景图不受此限制，仍然对所有设备（含 CPU）开放。
        if (isAnimation && !_deviceEnum.EnumerateAsync().GetAwaiter().GetResult().Any(d => d.Vendor == "NVIDIA"))
            return (UpscaleStartResult.AnimationRequiresNvidiaGpu, null);

        // No anime-x2 Real-ESRGAN variant exists upstream (xinntao never released one, and no
        // trustworthy community ONNX conversion was found either — see research.md §4) — anime
        // only ever runs the x4 model regardless of what the client sent. photo genuinely has both
        // (different weights, not just a downscale of one another), so it's honoured as-is.
        var effectiveModelScale = modelStyle == "anime" ? 4 : modelScale;
        // scale (desired final output resolution) can only ever be <= the model that actually
        // runs — clamp defensively instead of producing nonsense upscale-beyond-model-output math.
        var effectiveScale = Math.Min(scale, effectiveModelScale);

        var jobId = Guid.NewGuid().ToString("N");
        var tempDir = Path.Combine(_tempRoot, jobId);
        Directory.CreateDirectory(tempDir);
        var dims = ImageDimensionReader.TryRead(task.OutputPath);

        var job = new UpscaleJobState
        {
            JobId = jobId,
            SourceTaskId = task.TaskId,
            OriginalUrl = resultPath,
            OriginalPath = task.OutputPath,
            TempDir = tempDir,
            OutputExt = Path.GetExtension(task.OutputPath),
            OriginalSizeBytes = new FileInfo(task.OutputPath).Length,
            OriginalWidth = dims?.Width,
            OriginalHeight = dims?.Height,
            Scale = effectiveScale,
            ModelScale = effectiveModelScale,
            ModelStyle = modelStyle,
            FaceRestoreRequested = faceRestore,
            DeviceId = deviceId,
        };
        _jobs[jobId] = job;

        var itemId = Guid.TryParse(task.ItemId, out var parsed) ? parsed : Guid.Empty;
        _ = RunJobAsync(job, itemId, isAnimation, effectiveScale, effectiveModelScale, modelStyle, faceRestore, deviceId);

        return (UpscaleStartResult.Started, ToDto(job));
    }

    private async Task RunJobAsync(
        UpscaleJobState job, Guid itemId, bool isAnimation, int scale, int modelScale, string modelStyle, bool faceRestore, string? deviceId)
    {
        job.Status = UpscaleJobStatus.Running;
        try
        {
            // The model that actually runs is always modelScale's native variant; the requested
            // output resolution (scale) is achieved by downscaling that model's output afterwards
            // — same mechanism the old anime-x2 fallback used, just generalized so "which model
            // runs" and "what resolution comes out" are independent choices instead of one
            // implying the other. scale == modelScale means no downscale (1.0).
            var modelVersion = $"{modelStyle}-x{modelScale}";
            var postDownscaleFactor = (float)scale / modelScale;

            // Real-ESRGAN/GFPGAN are on-demand downloads (unlike lightglue/efficient-loftr, which
            // ModelAcquisitionService prefetches at startup) and the "提升画质" flow is meant to be
            // one-click (FR-019) — there is no separate model-management UI wired into UpscalePage
            // for the user to pre-download from. So the first use of a given {style × scale} variant
            // downloads it here, surfaced as job progress, instead of failing with "not installed".
            var modelPath = await EnsureModelInstalledAsync("realesrgan", modelVersion, job, job.Cts.Token).ConfigureAwait(false);
            if (modelPath is null)
            {
                job.Status = UpscaleJobStatus.Failed;
                job.Error = $"Real-ESRGAN model not installed and download failed: {modelVersion}";
                return;
            }

            string? faceModelPath = null;
            if (faceRestore)
            {
                faceModelPath = await EnsureModelInstalledAsync("gfpgan", "latest", job, job.Cts.Token).ConfigureAwait(false);
                if (faceModelPath is null)
                    _logger.LogWarning("[Upscale] gfpgan not installed (or download failed), proceeding without face restore (job {JobId})", job.JobId);
            }

            var outputPath = Path.Combine(job.TempDir, $"output{job.OutputExt}");
            var logPath = Path.Combine(job.TempDir, "upscale-log.json");

            var result = await _frameExport.SubmitUpscaleTaskAsync(
                itemId, job.OriginalPath, outputPath, modelPath, isAnimation,
                faceModelPath, deviceId, logPath, postDownscaleFactor, job.JobId,
                prog =>
                {
                    job.Percent = prog.Percent;
                    if (!string.IsNullOrEmpty(prog.Error)) job.Error = prog.Error;
                },
                job.Cts.Token).ConfigureAwait(false);

            if (job.Status == UpscaleJobStatus.Cancelled) return;

            // SubmitUpscaleTaskAsync only reads+deletes logPath on success; on an error response
            // it returns null without touching the file, so frame-forge may still have written
            // partial diagnostics (e.g. a GPU fallback) before reporting the failure. Recover that
            // for the "下载日志" button so failures after a fallback still carry useful diagnostics.
            job.Log = result?.Log ?? TryReadOrphanLog(logPath);

            if (result is null || result.OutputBytes.Length == 0)
            {
                job.Status = UpscaleJobStatus.Failed;
                job.Error ??= "Upscale processing failed";
                return;
            }

            await File.WriteAllBytesAsync(outputPath, result.OutputBytes, job.Cts.Token).ConfigureAwait(false);
            job.ResultPath = outputPath;
            job.ResultSizeBytes = result.OutputBytes.LongLength;
            var dims = ImageDimensionReader.TryRead(outputPath);
            job.ResultWidth = dims?.Width;
            job.ResultHeight = dims?.Height;
            job.FaceRestoreSkippedNoFace = result.Log?.FaceRestoreSkippedNoFace ?? false;
            job.Percent = 100;
            job.Status = UpscaleJobStatus.Succeeded;

            // Model identity is known up-front here (unlike stitch's auto-detected model), so
            // record LRU usage directly instead of round-tripping it through the daemon's log.
            await _modelCatalog.RecordUsageAsync("realesrgan", modelVersion).ConfigureAwait(false);
            if (faceModelPath != null)
                await _modelCatalog.RecordUsageAsync("gfpgan", "latest").ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            job.Status = UpscaleJobStatus.Cancelled;
        }
        catch (Exception ex)
        {
            job.Status = UpscaleJobStatus.Failed;
            job.Error = ex.Message;
            _logger.LogWarning(ex, "[Upscale] job {JobId} failed", job.JobId);
        }
    }

    /// <summary>Resolves an installed model path, triggering an on-demand download (and surfacing
    /// its progress through <paramref name="job"/>.Percent, scaled to 0-90% to stay visually
    /// distinct from the upscale progress that follows) when the model isn't present yet. Returns
    /// null on download failure — callers decide whether that's fatal (realesrgan) or
    /// best-effort/optional (gfpgan face restore).</summary>
    private async Task<string?> EnsureModelInstalledAsync(
        string family, string version, UpscaleJobState job, CancellationToken ct)
    {
        var path = _modelCatalog.GetInstalledModelPath(family, version);
        if (path != null) return path;

        var startResult = await _modelCatalog.StartDownloadAsync(family, version, ct).ConfigureAwait(false);
        if (startResult == ModelDownloadStartResult.NotFound)
            return null;

        if (startResult != ModelDownloadStartResult.AlreadyInstalled)
        {
            await foreach (var evt in _modelCatalog.GetDownloadProgressAsync(family, version, ct).ConfigureAwait(false))
            {
                job.Percent = evt.Percent * 0.9;
                if (evt.Status == "error")
                    return null;
            }
        }

        return _modelCatalog.GetInstalledModelPath(family, version);
    }

    public UpscaleJobDto? GetStatus(string jobId) =>
        _jobs.TryGetValue(jobId, out var job) ? ToDto(job) : null;

    /// <summary>Backs the "下载日志" button (US7 parity with the stitch-only generation log) —
    /// available for any job regardless of status, since a failed job's diagnostics are often the
    /// more useful case.</summary>
    public UpscaleJobLogDto? GetLog(string jobId)
    {
        if (!_jobs.TryGetValue(jobId, out var job)) return null;
        return new UpscaleJobLogDto
        {
            JobId = job.JobId,
            Status = job.Status.ToString().ToLowerInvariant(),
            Error = job.Error,
            Scale = job.Scale,
            ModelStyle = job.ModelStyle,
            FaceRestoreRequested = job.FaceRestoreRequested,
            DeviceIdRequested = job.DeviceId,
            CreatedAt = job.CreatedAt,
            Log = job.Log,
        };
    }

    private static UpscaleLogDto? TryReadOrphanLog(string logPath)
    {
        if (!File.Exists(logPath)) return null;
        try
        {
            var json = File.ReadAllText(logPath);
            return System.Text.Json.JsonSerializer.Deserialize<UpscaleLogDto>(json);
        }
        catch { return null; }
        finally { try { File.Delete(logPath); } catch { } }
    }

    /// <summary>Serves the not-yet-confirmed upscale result for the comparison preview (FR-019).
    /// Distinct from the original, which is already reachable via the existing
    /// `/FrameExport/Result/{taskId}/...` route echoed back as <see cref="UpscaleJobDto.OriginalUrl"/>.</summary>
    public (byte[] Bytes, string ContentType)? GetResultBytes(string jobId)
    {
        if (!_jobs.TryGetValue(jobId, out var job) || job.Status != UpscaleJobStatus.Succeeded
            || job.ResultPath is null || !File.Exists(job.ResultPath))
            return null;

        var contentType = job.OutputExt switch
        {
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            _ => "image/png",
        };
        return (File.ReadAllBytes(job.ResultPath), contentType);
    }


    public bool Cancel(string jobId)
    {
        if (!_jobs.TryGetValue(jobId, out var job)) return false;

        if (job.Status is UpscaleJobStatus.Pending or UpscaleJobStatus.Running)
        {
            job.Status = UpscaleJobStatus.Cancelled;
            job.Cts.Cancel();
            // Best-effort nudge so frame-forge can drop the still-running tile/face loop early
            // instead of grinding to completion (or the 300s watchdog) after we've already
            // stopped caring about the result — see FrameExportService.CancelUpscaleTaskAsync.
            _ = _frameExport.CancelUpscaleTaskAsync(jobId);
        }
        return true;
    }

    private void DeleteJob(string jobId)
    {
        if (_jobs.TryRemove(jobId, out var job))
        {
            job.Cts.Dispose();
            try { Directory.Delete(job.TempDir, recursive: true); } catch { }
        }
    }

    private void CleanupExpired()
    {
        var now = DateTime.UtcNow;
        var expired = _jobs
            .Where(kv => kv.Value.Status is UpscaleJobStatus.Succeeded or UpscaleJobStatus.Failed or UpscaleJobStatus.Cancelled
                && now - kv.Value.CreatedAt > TimeSpan.FromMinutes(5))
            .Select(kv => kv.Key)
            .ToList();
        foreach (var id in expired) DeleteJob(id);
    }

    private static UpscaleJobDto ToDto(UpscaleJobState job) => new()
    {
        JobId = job.JobId,
        Status = job.Status.ToString().ToLowerInvariant(),
        Percent = job.Percent,
        Error = job.Error,
        OriginalUrl = job.OriginalUrl,
        ResultUrl = job.Status == UpscaleJobStatus.Succeeded
            ? $"/JellyfinSuite/Stitch/Upscale/{job.JobId}/Result"
            : null,
        OriginalWidth = job.OriginalWidth,
        OriginalHeight = job.OriginalHeight,
        ResultWidth = job.ResultWidth,
        ResultHeight = job.ResultHeight,
        OriginalSizeBytes = job.OriginalSizeBytes,
        ResultSizeBytes = job.ResultSizeBytes,
        FaceRestoreSkippedNoFace = job.FaceRestoreSkippedNoFace,
    };

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _cleanupTimer.Dispose();
        foreach (var id in _jobs.Keys.ToList()) DeleteJob(id);
    }
}
