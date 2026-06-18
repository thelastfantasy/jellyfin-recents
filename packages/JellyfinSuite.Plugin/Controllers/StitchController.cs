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
    private readonly ILogger<StitchController> _logger;

    public StitchController(
        DeviceEnumerationService deviceEnum,
        ModelCatalogService modelCatalog,
        OrtVersionService ortVersion,
        ILogger<StitchController> logger)
    {
        _deviceEnum = deviceEnum;
        _modelCatalog = modelCatalog;
        _ortVersion = ortVersion;
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
}
