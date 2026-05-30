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
    private readonly SeekPreviewService _seekPreview;
    private readonly ILibraryManager _libraryManager;

    public JellyfinSuiteController(
        SeekPreviewService seekPreview,
        ILibraryManager libraryManager)
    {
        _seekPreview = seekPreview;
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
        if (!_seekPreview.IsAvailable)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "seek-preview not available");

        var item = _libraryManager.GetItemById(itemId);
        if (item == null || string.IsNullOrEmpty(item.Path) || !System.IO.File.Exists(item.Path))
            return NotFound();

        await _seekPreview.EnsureStartedAsync(cancellationToken);

        var result = await _seekPreview.FrameIndexAsync(item.Path, itemId, cancellationToken);
        if (result == null)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "frame index not available");

        return Ok(new FrameIndexDto
        {
            Frames = [.. result.Value.Frames
                .Select(f => new FrameIndexEntryDto { Ms = f.Ms, IsKey = f.IsKey })],
            Fps = new FpsFracDto { Num = result.Value.FpsNum, Den = result.Value.FpsDen },
        });
    }
}
