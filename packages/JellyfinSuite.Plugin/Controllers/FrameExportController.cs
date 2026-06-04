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

        var fi = frameIdx ?? -1;
        await _frameExport.EnsureStartedAsync(ct);
        var (jpeg, qualityFlags, actualPtsMs) = await _frameExport.GetFrameAsync(item.Path, fi, width, itemId, ct);
        if (jpeg == null || jpeg.Length == 0)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "frame decode failed" });
        Response.Headers["X-Frame-Quality"] = System.Text.Json.JsonSerializer.Serialize(new { qualityFlags });
        Response.Headers["X-Frame-Pts-Ms"] = actualPtsMs.ToString();
        return File(jpeg, "image/jpeg");
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

        // Decode frames by frameIdx — frame-forge resolves to posMs internally
        if (req.FramePairs is { Count: > 0 })
        {
            var pairs = req.FramePairs; // capture
            _ = Task.Run(async () =>
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                var done = 0;
                foreach (var p in pairs)
                {
                    try { await _frameExport.PrefetchFrameAsync(filePath, p.FiIdx, req.Width, itemId); done++; }
                    catch { /* individual failures ignored */ }
                }
                _logger.LogInformation("[FrameExport] Prefetch done: {Done}/{Total} frames cached in {Elapsed}ms",
                    done, pairs.Count, sw.ElapsedMilliseconds);
            });
            return Accepted();
        }

        // Positions list — fallback when FramePairs not available
        if (req.Positions is { Count: > 0 })
        {
            var posList = req.Positions;
            _ = Task.Run(async () =>
            {
                var done = 0;
                foreach (var posMs in posList)
                {
                    try { await _frameExport.PrefetchFrameAsync(filePath, posMs, req.Width, itemId); done++; }
                    catch { /* individual failures ignored */ }
                }
            });
            return Accepted();
        }

        // Main path: forward range to frame-forge (used when neither framePairs nor positions provided)
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

/// <summary>POST /FrameExport/PrefetchReady/{itemId} — SSE stream of decoded frames in time range.</summary>
    [HttpPost("PrefetchReady/{itemId:guid}")]
    public async Task PrefetchReady(
        [FromRoute] Guid itemId,
        [FromBody] PrefetchRangeStreamRequest req,
        CancellationToken ct = default)
    {
        if (!_frameExport.IsAvailable)
        {
            HttpContext.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            return;
        }

        var item = _libraryManager.GetItemById(itemId);
        if (item == null || string.IsNullOrEmpty(item.Path) || !System.IO.File.Exists(item.Path))
        {
            HttpContext.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        await _frameExport.EnsureStartedAsync(ct);

        Response.Headers["Content-Type"] = "text/event-stream; charset=utf-8";
        Response.Headers["Cache-Control"] = "no-cache, no-store";
        Response.Headers["X-Accel-Buffering"] = "no";

        await _frameExport.PrefetchRangeStreamAsync(
            item.Path, itemId, req.CurrentTimeMs,
            req.BeforeSeconds, req.AfterSeconds, req.IncludeCurrentFrame,
            req.Width, Response.Body, ct);
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

                byte[]? output = req.Type switch
                {
                    "animate" => await _frameExport.SubmitAnimateTaskAsync(
                        task, filePaths, frameIndices, req.Params.Format,
                        resizeMode, targetPx, req.Params.Speed, req.Params.LoopCount,
                        req.Params.CropX ?? 0f, req.Params.CropY ?? 0f,
                        req.Params.CropW ?? 0f, req.Params.CropH ?? 0f,
                        req.Params.Quality, resolutionPreset, task.Cts.Token),
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

    /// <summary>GET /FrameExport/TaskProgress?taskId= → SSE stream</summary>
    [HttpGet("TaskProgress")]
    public async Task TaskProgress([FromQuery] string taskId, CancellationToken ct)
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

        var ext = Path.GetExtension(filePath);
        var safe = Uri.EscapeDataString($"{task.ItemTitle}_{task.CreatedAt:yyyyMMddHHmmss}_{task.TaskId[..6]}{ext}");
        Response.Headers["Content-Disposition"] = $"attachment; filename*=UTF-8''{safe}";

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

    /// <summary>GET /FrameExport/Debug — frame-forge internal state snapshot (RAM/FI cache, prefetch queue)</summary>
    [HttpGet("Debug")]
    public async Task<IActionResult> GetDebug(CancellationToken ct)
    {
        if (!_frameExport.IsAvailable)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "frame-forge not available");

        var json = await _frameExport.GetDebugDumpAsync(ct);
        return Content(json, "application/json");
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
