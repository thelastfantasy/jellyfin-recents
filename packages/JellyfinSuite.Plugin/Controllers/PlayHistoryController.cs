using System.Security.Claims;
using Jellyfin.Plugin.JellyfinSuite.Models;
using Jellyfin.Plugin.JellyfinSuite.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinSuite.Controllers;

[ApiController]
[Route("JellyfinSuite")]
[Authorize]
public class PlayHistoryController : ControllerBase
{
    private readonly PlayHistoryService _playHistoryService;

    public PlayHistoryController(PlayHistoryService playHistoryService)
    {
        _playHistoryService = playHistoryService;
    }

    [HttpGet("PlayHistory")]
    [ProducesResponseType(typeof(PlayHistoryResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<PlayHistoryResponse>> GetPlayHistory(
        [FromQuery] string groupBy = "week",
        [FromQuery] int page = 0,
        [FromQuery] string tz = "UTC",
        [FromQuery] string sortBy = "playedDate",
        [FromQuery] string sortOrder = "desc",
        [FromQuery] string? mediaType = null,
        [FromQuery] bool showRepeats = true,
        [FromQuery] bool groupDedup = false,
        [FromQuery] int pageSize = 0)
    {
        var userIdStr = User.FindFirstValue("Jellyfin-UserId");
        if (!Guid.TryParse(userIdStr, out var userId) || userId == Guid.Empty)
            return Unauthorized();

        var result = await _playHistoryService
            .GetPlayHistoryAsync(userId, groupBy, page, tz, mediaType, sortBy, sortOrder, showRepeats, groupDedup, pageSize, HttpContext.RequestAborted)
            .ConfigureAwait(false);

        return Ok(result);
    }
}
