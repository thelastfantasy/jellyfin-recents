using Jellyfin.Plugin.JellyfinSuite.Models;
using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinSuite.Controllers;

/// <summary>
/// Common item-level endpoints shared across all JellyfinSuite features.
/// Route: /JellyfinSuite/{itemId}/...
/// </summary>
[ApiController]
[Route("JellyfinSuite")]
[AllowAnonymous]
public class JellyfinSuiteController : ControllerBase
{
    private readonly FrameExportService _frameExport;
    private readonly ILibraryManager _libraryManager;

    public JellyfinSuiteController(
        FrameExportService frameExport,
        ILibraryManager libraryManager)
    {
        _frameExport = frameExport;
        _libraryManager = libraryManager;
    }

    /// <summary>
    /// GET /JellyfinSuite/{itemId}/FrameInfo
    /// Returns the complete demuxed frame index (timestamp + keyframe flag for every frame)
    /// and the stream's exact fps fraction. Used by all client features that need frame-accurate
    /// addressing (FrameExport, screenshots, etc.).
    /// Result is cached in the Rust daemon per item_id.
    /// </summary>
    [HttpGet("{itemId:guid}/FrameInfo")]
    [ProducesResponseType(typeof(FrameIndexDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> GetFrameInfo(
        [FromRoute] Guid itemId,
        CancellationToken cancellationToken = default)
    {
        if (!_frameExport.IsAvailable)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "frame-forge not available");

        var item = _libraryManager.GetItemById(itemId);
        if (item == null || string.IsNullOrEmpty(item.Path) || !System.IO.File.Exists(item.Path))
            return NotFound();

        await _frameExport.EnsureStartedAsync(cancellationToken);

        var result = await _frameExport.FrameIndexAsync(item.Path, itemId, cancellationToken);
        if (result == null)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "frame index not available");

        return Ok(result);
    }

    /// <summary>
    /// GET /JellyfinSuite/{itemId}/FrameInfoStream
    /// SSE stream of frame index entries. Rust daemon demuxes and sends batched JSON
    /// arrays via Unix socket; this action copies bytes directly to the HTTP response
    /// without deserializing.
    /// Frames near currentTimeMs (±1s) are prioritized and arrive first.
    /// Query: ?currentTimeMs={ms} (optional, default 0)
    /// </summary>
    [HttpGet("{itemId:guid}/FrameInfoStream")]
    public async Task FrameInfoStream(
        [FromRoute] Guid itemId,
        [FromQuery] long currentTimeMs = 0,
        CancellationToken cancellationToken = default)
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

        await _frameExport.EnsureStartedAsync(cancellationToken);

        HttpContext.Response.ContentType = "text/event-stream; charset=utf-8";
        HttpContext.Response.Headers["Cache-Control"] = "no-cache, no-store";
        HttpContext.Response.Headers["X-Accel-Buffering"] = "no";

        await _frameExport.FrameIndexStreamAsync(item.Path, itemId, currentTimeMs,
            HttpContext.Response.Body, cancellationToken);
    }
}
