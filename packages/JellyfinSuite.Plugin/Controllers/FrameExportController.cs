using System.Diagnostics;
using System.Text;
using Jellyfin.Plugin.JellyfinSuite.Models;
using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Controllers;

[ApiController]
[Route("JellyfinSuite/FrameExport")]
[AllowAnonymous]
public class FrameExportController : ControllerBase
{
    private readonly FrameExportService _frameExport;
    private readonly FrameExportTaskManager _taskManager;
    private readonly SeekPreviewService _seekPreview;
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<FrameExportController> _logger;

    // In-memory quality threshold config (resets to defaults on restart)
    private static QualityThresholds _thresholds = new();

    public FrameExportController(
        FrameExportService frameExport,
        FrameExportTaskManager taskManager,
        SeekPreviewService seekPreview,
        ILibraryManager libraryManager,
        ILogger<FrameExportController> logger)
    {
        _frameExport = frameExport;
        _taskManager = taskManager;
        _seekPreview = seekPreview;
        _libraryManager = libraryManager;
        _logger = logger;
    }

    /// <summary>
    /// Resolves a frameIdx (0-based index into FrameInfo) to positionMs.
    /// Returns null if the frame index is unavailable or frameIdx is out of range.
    /// </summary>
    private async Task<long?> ResolveFrameIdxAsync(string filePath, Guid itemId, int frameIdx, CancellationToken ct)
    {
        var result = await _seekPreview.FrameIndexAsync(filePath, itemId, ct);
        if (result == null || frameIdx < 0 || frameIdx >= result.Value.Frames.Length)
            return null;
        return result.Value.Frames[frameIdx].Ms;
    }

    /// <summary>
    /// GET /FrameExport/{itemId}?frameIdx=N&width=W
    /// GET /FrameExport/{itemId}?positionMs=N&width=W  (fallback)
    /// Returns a JPEG frame. width ≤ 320 returns thumbnail; width=0 returns original.
    /// Prefer frameIdx (0-based index from /JellyfinSuite/{itemId}/FrameInfo).
    /// </summary>
    [HttpGet("{itemId:guid}")]
    [ProducesResponseType(typeof(FileContentResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> GetFrame(
        [FromRoute] Guid itemId,
        [FromQuery] int? frameIdx = null,
        [FromQuery] long positionMs = 0,
        [FromQuery] int width = 320,
        CancellationToken ct = default)
    {
        if (!_frameExport.IsAvailable)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "frame-forge not available");

        var item = _libraryManager.GetItemById(itemId);
        if (item == null || string.IsNullOrEmpty(item.Path) || !System.IO.File.Exists(item.Path))
            return NotFound(new { error = "Item not found or no file path" });

        if (frameIdx.HasValue)
        {
            var resolved = await ResolveFrameIdxAsync(item.Path, itemId, frameIdx.Value, ct);
            if (resolved == null)
                return NotFound(new { error = $"frameIdx {frameIdx.Value} out of range" });
            positionMs = resolved.Value;
        }

        await _frameExport.EnsureStartedAsync(ct);
        var (jpeg, qualityFlags, actualPtsMs) = await _frameExport.GetFrameAsync(item.Path, positionMs, width, itemId, ct);
        if (jpeg == null || jpeg.Length == 0)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "frame decode failed" });

        Response.Headers["X-Frame-Quality"] = System.Text.Json.JsonSerializer.Serialize(new { qualityFlags });
        Response.Headers["X-Frame-Pts-Ms"] = actualPtsMs.ToString();
        return File(jpeg, "image/jpeg");
    }

    /// <summary>GET /FrameExport/Keyframes/{itemId}?startMs=X&amp;endMs=Y — returns I-frame timestamps via ffprobe.</summary>
    [HttpGet("Keyframes/{itemId:guid}")]
    public async Task<IActionResult> GetKeyframes(
        [FromRoute] Guid itemId,
        [FromQuery] long startMs = 0,
        [FromQuery] long endMs = -1,
        CancellationToken ct = default)
    {
        var item = _libraryManager.GetItemById(itemId);
        if (item == null || string.IsNullOrEmpty(item.Path) || !System.IO.File.Exists(item.Path))
            return NotFound(new { error = "Item not found or no file path" });

        var rangeEndMs = endMs < 0 ? startMs + 10000 : Math.Max(startMs + 500, endMs);
        var startSec = startMs / 1000.0;
        var durSec = Math.Max(0.5, (rangeEndMs - startMs) / 1000.0);

        var ffprobePath = new[] { "/usr/lib/jellyfin-ffmpeg/ffprobe", "/usr/bin/ffprobe" }
            .FirstOrDefault(System.IO.File.Exists) ?? "ffprobe";

        // "startSec%+durSec" → read durSec seconds starting at startSec
        var interval = $"{startSec.ToString("F3", System.Globalization.CultureInfo.InvariantCulture)}" +
                       $"%+{durSec.ToString("F3", System.Globalization.CultureInfo.InvariantCulture)}";

        var psi = new ProcessStartInfo(ffprobePath)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // Use ArgumentList to safely handle paths with spaces
        psi.ArgumentList.Add("-v");              psi.ArgumentList.Add("quiet");
        psi.ArgumentList.Add("-select_streams"); psi.ArgumentList.Add("v:0");
        psi.ArgumentList.Add("-show_entries");   psi.ArgumentList.Add("packet=pts_time,flags");
        psi.ArgumentList.Add("-of");             psi.ArgumentList.Add("csv=print_section=0");
        psi.ArgumentList.Add("-read_intervals"); psi.ArgumentList.Add(interval);
        psi.ArgumentList.Add(item.Path);
        psi.Environment["LD_LIBRARY_PATH"] = "/usr/lib/jellyfin-ffmpeg/lib";

        try
        {
            using var proc = Process.Start(psi)!;
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(15));

            var stdout = await proc.StandardOutput.ReadToEndAsync(timeoutCts.Token);
            await proc.WaitForExitAsync(timeoutCts.Token);

            var keyframes = new List<long>();
            foreach (var line in stdout.Split(new[] { '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var comma = line.IndexOf(',');
                if (comma < 0) continue;
                // flags field contains 'K' for keyframes (e.g. "K_", "K__" …)
                if (!line[(comma + 1)..].Contains('K')) continue;
                if (!double.TryParse(line[..comma], System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out var pts)) continue;
                keyframes.Add((long)(pts * 1000));
            }

            return Ok(new { keyframes });
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[FrameExport] keyframes query failed: {Ex}", ex.Message);
            return StatusCode(StatusCodes.Status500InternalServerError, new { error = "ffprobe failed" });
        }
    }

    /// <summary>
    /// POST /FrameExport/Prefetch/{itemId} — enqueue background thumbnail decode.
    /// </summary>
    [HttpPost("Prefetch/{itemId:guid}")]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> Prefetch([FromRoute] Guid itemId, [FromBody] PrefetchRequest req)
    {
        if (!_frameExport.IsAvailable)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "frame-forge not available");

        var item = _libraryManager.GetItemById(itemId);
        if (item == null || string.IsNullOrEmpty(item.Path))
            return NotFound(new { error = "Item not found" });

        var filePath = item.Path;

        // Fallback: positions list (FrameInfo unavailable)
        if (req.Positions is { Count: > 0 })
        {
            _ = Task.Run(async () =>
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                var done = 0;
                foreach (var posMs in req.Positions)
                {
                    try { await _frameExport.PrefetchFrameAsync(filePath, posMs, req.Width, itemId); done++; }
                    catch { /* individual failures ignored */ }
                }
                _logger.LogInformation("[FrameExport] Prefetch done: {Done}/{Total} frames cached in {Elapsed}ms",
                    done, req.Positions.Count, sw.ElapsedMilliseconds);
            });
            return Accepted();
        }

        // Main path: forward range to frame-forge. frame-forge loads its own
        // frame index internally and resolves startFrameIdx → posMs precisely.
        try
        {
            await _frameExport.PrefetchRangeAsync(filePath, req.StartFrameIdx,
                req.BeforeSeconds, req.AfterSeconds, req.IncludeStart, req.Width, itemId);
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[FrameExport] Prefetch range error: {Ex}", ex.Message);
        }
        return Accepted();
    }

/// <summary>GET /FrameExport/PrefetchReady/{itemId}?width=320 — SSE stream of ready frames.</summary>
    [HttpGet("PrefetchReady/{itemId:guid}")]
    public async Task PrefetchReady(
        [FromRoute] Guid itemId,
        [FromQuery] int width = 320,
        CancellationToken ct = default)
    {
        Response.Headers["Content-Type"] = "text/event-stream; charset=utf-8";
        Response.Headers["Cache-Control"] = "no-cache, no-store";
        Response.Headers["X-Accel-Buffering"] = "no";

        var reported = new HashSet<long>();
        var deadline = DateTime.UtcNow.AddSeconds(30);

        while (!ct.IsCancellationRequested && DateTime.UtcNow < deadline)
        {
            var cached = await _frameExport.ListCachedAsync(itemId, width, ct);
            foreach (var posMs in cached)
            {
                if (!reported.Add(posMs)) continue;
                await Response.Body.WriteAsync(Encoding.UTF8.GetBytes($"data: {posMs}\n\n"), ct);
                await Response.Body.FlushAsync(ct);
            }
            await Task.Delay(200, ct);
        }
    }

    /// <summary>
    /// POST /FrameExport/Generate — submit animate or stitch task.
    /// </summary>
    [HttpPost("Generate")]
    [ProducesResponseType(typeof(GenerateResponse), StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public IActionResult Generate([FromBody] GenerateRequest req)
    {
        if (req.Frames.Count < 2)
            return BadRequest(new { error = "At least 2 frames required" });

        if (req.Type == "animate" && (req.Params.Speed <= 0f || req.Params.Speed > 32f))
            return BadRequest(new { error = "speed must be > 0 and ≤ 32" });

        var task = _taskManager.CreateTask(req.ItemId.ToString(), req.ItemTitle, req.Type);

        // Fire-and-forget: submit to Rust daemon
        _ = Task.Run(async () =>
        {
            try
            {
                var item = _libraryManager.GetItemById(req.ItemId);
                if (item == null || string.IsNullOrEmpty(item.Path))
                {
                    task.Status = Services.TaskStatus.Error;
                    task.Error = "Item not found";
                    task.ProgressChannel.Writer.TryComplete();
                    return;
                }

                task.Status = Services.TaskStatus.Running;
                var filePaths = req.Frames.Select(_ => item.Path).ToList();

                // Pass frameIdx directly to frame-forge (no posMs conversion).
                // frame-forge resolves frameIdx → posMs via its own frame index.
                var frameIndices = req.Frames.Select(f => (long)(f.FrameIdx ?? -1)).ToList();

                var resolutionPreset = req.Params.ResolutionPreset;
                var resizeMode = req.Params.ResizeMode;
                var targetPx = resizeMode == "height"
                    ? req.Params.CustomHeight ?? 0
                    : req.Params.CustomWidth ?? 0;

                // Map resolution preset to target pixels
                if (targetPx == 0 && resolutionPreset != "original")
                {
                    targetPx = resolutionPreset switch
                    {
                        "1080p" => 1080,
                        "720p" => 720,
                        "480p" => 480,
                        "360p" => 360,
                        _ => 0
                    };
                    resizeMode = "width";
                }

                byte[]? output = req.Type switch
                {
                    "animate" => await _frameExport.SubmitAnimateTaskAsync(
                        task, filePaths, frameIndices, req.Params.Format,
                        resizeMode, targetPx, req.Params.Speed, req.Params.LoopCount,
                        req.Params.CropX ?? 0f, req.Params.CropY ?? 0f,
                        req.Params.CropW ?? 0f, req.Params.CropH ?? 0f,
                        req.Params.Quality, task.Cts.Token),
                    "stitch" => await _frameExport.SubmitStitchTaskAsync(
                        task, filePaths, frameIndices, req.Params.Format, req.Params.Quality,
                        task.Cts.Token),
                    _ => null
                };

                var ext = req.Type switch
                {
                    "animate" => req.Params.Format == "webp" ? "webp" : "gif",
                    "stitch" => req.Params.Format == "webp" ? "webp" : "png",
                    _ => "bin"
                };

                if (output != null && output.Length > 0)
                {
                    var outputPath = Path.Combine(task.TempDir, $"output.{ext}");
                    await System.IO.File.WriteAllBytesAsync(outputPath, output);

                    task.OutputPath = outputPath;
                    task.OutputSize = output.Length;
                    task.Status = Services.TaskStatus.Complete;
                    task.CompletedAt = DateTime.UtcNow;

                    task.ProgressChannel.Writer.TryWrite(new TaskProgress
                    {
                        TaskId = task.TaskId,
                        Status = "complete",
                        ResultUrl = $"/JellyfinSuite/FrameExport/Result/{task.TaskId}/output.{ext}",
                        FileSize = output.Length,
                        Percent = 100,
                    });
                    task.ProgressChannel.Writer.TryComplete();
                }
            }
            catch (OperationCanceledException) when (task.Status == Services.TaskStatus.Cancelled)
            {
                // Normal cancellation — CancelTask() already marked the task and completed the channel.
            }
            catch (Exception ex)
            {
                task.Status = Services.TaskStatus.Error;
                task.Error = ex.Message;
                task.ProgressChannel.Writer.TryWrite(new TaskProgress
                {
                    TaskId = task.TaskId,
                    Status = "error",
                    Error = ex.Message,
                });
                task.ProgressChannel.Writer.TryComplete();
            }
        });

        return Accepted(new GenerateResponse { TaskId = task.TaskId });
    }

    /// <summary>GET /FrameExport/Progress?taskId= → SSE stream</summary>
    [HttpGet("Progress")]
    public async Task Progress([FromQuery] string taskId, CancellationToken ct)
    {
        var task = _taskManager.GetTask(taskId);
        if (task == null)
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        Response.Headers["Content-Type"] = "text/event-stream; charset=utf-8";
        Response.Headers["Cache-Control"] = "no-cache, no-store";
        Response.Headers["X-Accel-Buffering"] = "no";

        await foreach (var progress in task.ProgressChannel.Reader.ReadAllAsync(ct))
        {
            var json = System.Text.Json.JsonSerializer.Serialize(progress);
            await Response.Body.WriteAsync(
                System.Text.Encoding.UTF8.GetBytes($"data: {json}\n\n"), ct);
            await Response.Body.FlushAsync(ct);

            if (progress.Status is "complete" or "error" or "cancelled")
                break;
        }
    }

    /// <summary>GET /FrameExport/Result/{taskId}/{filename}</summary>
    [HttpGet("Result/{taskId}/{filename}")]
    public IActionResult GetResult(string taskId, string filename)
    {
        var task = _taskManager.GetTask(taskId);
        if (task == null)
            return NotFound(new { error = "Task not found" });

        if (task.Status != Services.TaskStatus.Complete)
            return Conflict(new { error = $"Task not complete (status: {task.Status})" });

        var filePath = task.OutputPath;
        if (string.IsNullOrEmpty(filePath) || !System.IO.File.Exists(filePath))
            return NotFound(new { error = "Result file not found or expired" });

        var contentType = Path.GetExtension(filePath) switch
        {
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".png" => "image/png",
            _ => "application/octet-stream",
        };

        var downloadName = $"{task.ItemTitle}_{task.CreatedAt:yyyyMMddHHmmss}_{task.TaskId[..6]}{Path.GetExtension(filePath)}";
        Response.Headers["Content-Disposition"] = $"attachment; filename=\"{downloadName}\"";

        return File(System.IO.File.ReadAllBytes(filePath), contentType);
    }

    /// <summary>DELETE /FrameExport/Result/{taskId}</summary>
    [HttpDelete("Result/{taskId}")]
    public IActionResult DeleteResult(string taskId)
    {
        var task = _taskManager.GetTask(taskId);
        if (task == null)
            return NotFound(new { error = "Task not found" });

        _taskManager.DeleteTask(taskId);
        return Ok(new { deleted = true });
    }

    /// <summary>POST /FrameExport/Cancel/{taskId}</summary>
    [HttpPost("Cancel/{taskId}")]
    public IActionResult Cancel(string taskId)
    {
        var task = _taskManager.GetTask(taskId);
        if (task == null)
            return NotFound(new { error = "Task not found" });

        if (task.Status == Services.TaskStatus.Complete)
            return Conflict(new { error = "Task already complete" });

        _taskManager.CancelTask(taskId);
        return Ok(new { cancelled = true });
    }

    /// <summary>GET /FrameExport/Tasks — list all in-memory tasks</summary>
    [HttpGet("Tasks")]
    public IActionResult GetTasks()
    {
        var tasks = _taskManager.GetAllTasks().Select(t => new FrameExportTaskListItemDto
        {
            TaskId    = t.TaskId,
            ItemId    = t.ItemId,
            ItemTitle = t.ItemTitle,
            Type      = t.Type,
            Status    = t.Status.ToString().ToLowerInvariant(),
            ResultUrl = t.Status == Services.TaskStatus.Complete && t.OutputPath != null
                ? $"/JellyfinSuite/FrameExport/Result/{t.TaskId}/{Path.GetFileName(t.OutputPath)}"
                : null,
            FileSize  = t.OutputSize,
            Error     = t.Error,
            CreatedAt = new DateTimeOffset(t.CreatedAt, TimeSpan.Zero).ToUnixTimeMilliseconds(),
        });
        return Ok(tasks);
    }

    /// <summary>GET /FrameExport/Health</summary>
    [HttpGet("Health")]
    public IActionResult Health()
    {
        return Ok(new
        {
            available = _frameExport.IsAvailable,
            activeTasks = _taskManager.GetAllTasks().Count(),
        });
    }

    /// <summary>
    /// GET /FrameExport/QualityThresholds — read current thresholds
    /// PUT /FrameExport/QualityThresholds — update thresholds (admin-only in practice)
    /// </summary>
    [HttpGet("QualityThresholds")]
    public IActionResult GetThresholds() => Ok(_thresholds);

    [HttpPut("QualityThresholds")]
    public IActionResult SetThresholds([FromBody] QualityThresholds t)
    {
        _thresholds = t;
        return Ok(_thresholds);
    }
}
