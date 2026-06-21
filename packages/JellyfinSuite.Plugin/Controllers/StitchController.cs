using Jellyfin.Plugin.JellyfinSuite.Models;
using Jellyfin.Plugin.JellyfinSuite.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Controllers;

[ApiController]
[Route("JellyfinSuite/Stitch")]
[AllowAnonymous]
public class StitchController : ControllerBase
{
    private readonly DeviceEnumerationService _deviceEnum;
    private readonly ModelCatalogService _modelCatalog;
    private readonly OrtVersionService _ortVersion;
    private readonly UpscaleService _upscale;
    private readonly ILogger<StitchController> _logger;

    public StitchController(
        DeviceEnumerationService deviceEnum,
        ModelCatalogService modelCatalog,
        OrtVersionService ortVersion,
        UpscaleService upscale,
        ILogger<StitchController> logger)
    {
        _deviceEnum = deviceEnum;
        _modelCatalog = modelCatalog;
        _ortVersion = ortVersion;
        _upscale = upscale;
        _logger = logger;
    }

    // ── GET /JellyfinSuite/Stitch/Devices ────────────────────────────────────

    [HttpGet("Devices")]
    [ProducesResponseType(typeof(DeviceListDto), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetDevices()
    {
        var devices = await _deviceEnum.EnumerateAsync();
        return Ok(new DeviceListDto { Devices = devices });
    }

    // ── GET /JellyfinSuite/Stitch/Models ─────────────────────────────────────

    [HttpGet("Models")]
    [ProducesResponseType(typeof(ModelListDto), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetModels()
    {
        var result = await _modelCatalog.GetModelsAsync();
        return Ok(result);
    }

    // ── POST /JellyfinSuite/Stitch/Models/Download ───────────────────────────

    [HttpPost("Models/Download")]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> DownloadModel([FromBody] ModelDownloadRequestDto req)
    {
        var result = await _modelCatalog.StartDownloadAsync(req.Family, req.Version);
        return result switch
        {
            ModelDownloadStartResult.Started => Accepted(),
            ModelDownloadStartResult.NotFound => NotFound(new { error = "Version not found in catalog" }),
            ModelDownloadStartResult.AlreadyInstalled => Conflict(new { error = "Already installed" }),
            ModelDownloadStartResult.InProgress => Conflict(new { error = "Download already in progress" }),
            _ => StatusCode(500)
        };
    }

    // ── GET /JellyfinSuite/Stitch/Models/DownloadProgress ───────────────────

    [HttpGet("Models/DownloadProgress")]
    public async Task GetModelDownloadProgress([FromQuery] string family, [FromQuery] string version)
    {
        Response.Headers["Content-Type"] = "text/event-stream";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";

        await foreach (var evt in _modelCatalog.GetDownloadProgressAsync(family, version, HttpContext.RequestAborted))
        {
            var json = System.Text.Json.JsonSerializer.Serialize(evt);
            await Response.WriteAsync($"data: {json}\n\n");
            await Response.Body.FlushAsync();
        }
    }

    // ── DELETE /JellyfinSuite/Stitch/Models/{family}/{version} ──────────────

    [HttpDelete("Models/{family}/{version}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> DeleteModel(string family, string version)
    {
        var result = await _modelCatalog.DeleteModelAsync(family, version);
        if (!result.Success)
            return Conflict(new { error = result.Error });
        return Ok(new { deleted = true });
    }

    // ── GET /JellyfinSuite/Stitch/OrtVersions ────────────────────────────────

    [HttpGet("OrtVersions")]
    [ProducesResponseType(typeof(OrtVersionListDto), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetOrtVersions()
    {
        var result = await _ortVersion.GetVersionListAsync();
        return Ok(result);
    }

    // ── POST /JellyfinSuite/Stitch/OrtVersions/Download ─────────────────────

    [HttpPost("OrtVersions/Download")]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> DownloadOrtVersion([FromBody] OrtDownloadRequestDto req)
    {
        var result = await _ortVersion.StartDownloadAsync(req.Version);
        return result switch
        {
            OrtDownloadStartResult.Started => Accepted(),
            OrtDownloadStartResult.NotFound => NotFound(new { error = "Version not found in catalog" }),
            OrtDownloadStartResult.AlreadyInstalled => Conflict(new { error = "Already installed" }),
            OrtDownloadStartResult.InProgress => Conflict(new { error = "Download already in progress" }),
            _ => StatusCode(500)
        };
    }

    // ── POST /JellyfinSuite/Stitch/OrtVersions/Activate ─────────────────────

    [HttpPost("OrtVersions/Activate")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> ActivateOrtVersion([FromBody] OrtActivateRequestDto req)
    {
        var result = await _ortVersion.ActivateVersionAsync(req.Version);
        if (!result)
            return NotFound(new { error = "Version not installed" });
        return Ok(new { activeVersion = req.Version });
    }

    // ── GET /JellyfinSuite/Stitch/OrtVersions/DownloadProgress ──────────────

    [HttpGet("OrtVersions/DownloadProgress")]
    public async Task GetOrtDownloadProgress([FromQuery] string version)
    {
        Response.Headers["Content-Type"] = "text/event-stream";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";

        await foreach (var evt in _ortVersion.GetDownloadProgressAsync(version, HttpContext.RequestAborted))
        {
            var json = System.Text.Json.JsonSerializer.Serialize(evt);
            await Response.WriteAsync($"data: {json}\n\n");
            await Response.Body.FlushAsync();
        }
    }

    // ── Upscale (US7) ─────────────────────────────────────────────────────

    /// <summary>POST /JellyfinSuite/Stitch/Upscale — start an upscale job for a completed
    /// FrameExport result. <c>resultPath</c> is the same `/FrameExport/Result/{taskId}/...`
    /// URL already used for downloads.</summary>
    [HttpPost("Upscale")]
    [ProducesResponseType(typeof(UpscaleJobDto), StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult StartUpscale([FromBody] UpscaleStartRequestDto req)
    {
        var (result, job) = _upscale.StartJob(req.ResultPath, req.Scale, req.ModelScale, req.ModelStyle, req.FaceRestore, req.DeviceId);
        if (result == UpscaleStartResult.AnimationRequiresNvidiaGpu)
            return BadRequest(new { error = "Animation quality upscale requires an NVIDIA GPU; none was detected on this host" });
        if (result == UpscaleStartResult.SourceNotFound || job is null)
            return NotFound(new { error = "Source result not found or expired" });
        return Accepted(job);
    }

    /// <summary>GET /JellyfinSuite/Stitch/Upscale/{jobId} — poll job status/progress.</summary>
    [HttpGet("Upscale/{jobId}")]
    [ProducesResponseType(typeof(UpscaleJobDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult GetUpscaleStatus(string jobId)
    {
        var job = _upscale.GetStatus(jobId);
        if (job is null)
            return NotFound(new { error = "Job not found" });
        return Ok(job);
    }

    /// <summary>GET /JellyfinSuite/Stitch/Upscale/{jobId}/Result — serves the not-yet-confirmed
    /// upscaled image for the before/after comparison preview (FR-019). The original is already
    /// reachable via <see cref="UpscaleJobDto.OriginalUrl"/> (the existing FrameExport route).</summary>
    [HttpGet("Upscale/{jobId}/Result")]
    public IActionResult GetUpscaleResult(string jobId)
    {
        var result = _upscale.GetResultBytes(jobId);
        if (result is null)
            return NotFound(new { error = "Result not available" });
        return File(result.Value.Bytes, result.Value.ContentType);
    }

    /// <summary>GET /JellyfinSuite/Stitch/Upscale/{jobId}/Log — diagnostics (device actually used,
    /// GPU fallbacks) for the "下载日志" button, mirroring FrameExportController's stitch-only
    /// generation-log endpoint but available for upscale jobs regardless of source export type.</summary>
    [HttpGet("Upscale/{jobId}/Log")]
    [ProducesResponseType(typeof(UpscaleJobLogDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult GetUpscaleLog(string jobId)
    {
        var log = _upscale.GetLog(jobId);
        if (log is null)
            return NotFound(new { error = "Job not found" });
        return Ok(log);
    }

    /// <summary>POST /JellyfinSuite/Stitch/Upscale/{jobId}/Cancel — leaves the original file untouched (FR-023).</summary>
    [HttpPost("Upscale/{jobId}/Cancel")]
    public IActionResult CancelUpscale(string jobId)
    {
        if (!_upscale.Cancel(jobId))
            return NotFound(new { error = "Job not found" });
        return Ok(new { cancelled = true });
    }
}
