using Jellyfin.Plugin.JellyfinSuite.Models;
using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
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
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<FrameExportController> _logger;

    // In-memory quality threshold config (resets to defaults on restart)
    private static QualityThresholds _thresholds = new();

    public FrameExportController(
        FrameExportService frameExport,
        FrameExportTaskManager taskManager,
        ILibraryManager libraryManager,
        ILogger<FrameExportController> logger)
    {
        _frameExport = frameExport;
        _taskManager = taskManager;
        _libraryManager = libraryManager;
        _logger = logger;
    }

    /// <summary>
    /// GET /FrameExport/{itemId}?positionMs=N&width=W
    /// Returns a JPEG frame. width ≤ 320 returns thumbnail; width=0 returns original.
    /// </summary>
    [HttpGet("{itemId:guid}")]
    [ProducesResponseType(typeof(FileContentResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> GetFrame(
        [FromRoute] Guid itemId,
        [FromQuery] long positionMs = 0,
        [FromQuery] int width = 320,
        CancellationToken ct = default)
    {
        if (!_frameExport.IsAvailable)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "frame-forge not available");

        var item = _libraryManager.GetItemById(itemId);
        if (item == null || string.IsNullOrEmpty(item.Path) || !System.IO.File.Exists(item.Path))
            return NotFound(new { error = "Item not found or no file path" });

        // DRM check
        if (item.MediaStreams?.Any(s => s.IsEncoded == true) == true)
            return StatusCode(StatusCodes.Status403Forbidden, new { error = "DRM-protected content" });

        var jpeg = await _frameExport.GetFrameAsync(item.Path, positionMs, width, itemId, ct);
        if (jpeg == null || jpeg.Length == 0)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "frame decode failed" });

        return File(jpeg, "image/jpeg");
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

        if (req.Type == "animate" && (req.Params.Fps < 1 || req.Params.Fps > 30))
            return BadRequest(new { error = "fps must be 1-30" });

        var task = _taskManager.CreateTask(req.ItemId.ToString(), req.ItemTitle, req.Type);
        // TODO: Phase 6 T043 — submit to Rust daemon for actual processing

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

        var downloadName = $"{task.ItemTitle}_{task.CreatedAt:yyyyMMddHHmmss}{Path.GetExtension(filePath)}";
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
