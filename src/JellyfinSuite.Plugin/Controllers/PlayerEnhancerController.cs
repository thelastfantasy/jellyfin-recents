using System.Security.Claims;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Common.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Controllers;

[ApiController]
[Route("JellyfinSuite/PlayerEnhancer")]
[Authorize]
public class PlayerEnhancerController : ControllerBase
{
    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<PlayerEnhancerController> _logger;
    private readonly UserSettingsService _userSettings;

    public PlayerEnhancerController(
        IApplicationPaths appPaths,
        ILogger<PlayerEnhancerController> logger,
        UserSettingsService userSettings)
    {
        _appPaths = appPaths;
        _logger = logger;
        _userSettings = userSettings;
    }

    /// <summary>
    /// Returns the Jellyfin user ID from JWT claims, or null for anonymous/system-key requests.
    /// Jellyfin's auth middleware always populates HttpContext.User even for [AllowAnonymous] endpoints.
    /// </summary>
    private string? GetCurrentUserId()
    {
        if (User.Identity?.IsAuthenticated != true) return null;
        var raw = User.FindFirst("Jellyfin-UserId")?.Value
               ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(raw, out var id) && id != Guid.Empty
            ? id.ToString("N")
            : null;
    }

    [HttpGet("Status")]
    [Authorize(Policy = "RequiresElevation")]
    [ProducesResponseType(typeof(EnhancerStatusDto), StatusCodes.Status200OK)]
    public ActionResult<EnhancerStatusDto> GetStatus()
    {
        var indexPath = Path.Combine(_appPaths.WebPath, "index.html");
        var injected = System.IO.File.Exists(indexPath) &&
            System.IO.File.ReadAllText(indexPath).Contains("/JellyfinSuite/PlayerEnhancer/Launcher");

        return Ok(new EnhancerStatusDto { AutoInjectEnabled = injected });
    }

    /// <summary>Tiny launcher injected into index.html once; directly imports the core bundle.</summary>
    [HttpGet("Launcher")]
    [AllowAnonymous]
    public ContentResult GetLauncher()
    {
        const string js = "import('/JellyfinSuite/PlayerEnhancer/Core')" +
            ".catch(e=>console.warn('[JFS] enhancer load failed',e));";
        Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        return Content(js, "application/javascript");
    }

    /// <summary>
    /// Serves the core enhancer bundle with ETag-based revalidation.
    /// Filesystem copy takes priority over the DLL-embedded fallback.
    /// </summary>
    [HttpGet("Core")]
    [AllowAnonymous]
    public IActionResult GetCore()
    {
        var fsPath = Path.Combine(_appPaths.PluginsPath, "JellyfinSuite", "jellyfin-suite-enhancer.js");
        if (System.IO.File.Exists(fsPath))
        {
            var mtime = new FileInfo(fsPath).LastWriteTimeUtc;
            var etag = $"\"{mtime.Ticks:x}\"";
            if (Request.Headers.IfNoneMatch == etag)
                return StatusCode(304);
            Response.Headers.ETag = etag;
            Response.Headers.CacheControl = "no-cache";
            return PhysicalFile(fsPath, "application/javascript");
        }

        var stream = GetType().Assembly.GetManifestResourceStream(
            "JellyfinSuite.Plugin.Web.jellyfin-suite-enhancer.js");
        if (stream is null) return NotFound();
        var dllMtime = new FileInfo(GetType().Assembly.Location).LastWriteTimeUtc;
        var dllEtag = $"\"{dllMtime.Ticks:x}\"";
        if (Request.Headers.IfNoneMatch == dllEtag)
            return StatusCode(304);
        Response.Headers.ETag = dllEtag;
        Response.Headers.CacheControl = "no-cache";
        return File(stream, "application/javascript");
    }

    [HttpPost("Inject")]
    [Authorize(Policy = "RequiresElevation")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status500InternalServerError)]
    public ActionResult Inject()
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            config.AutoInjectEnabled = true;
            Plugin.Instance.SaveConfiguration();

            PlayerEnhancerEntryPoint.RemoveEnhancerTagsFromIndexHtml(_appPaths.WebPath);
            PlayerEnhancerEntryPoint.PatchIndexHtml(
                _appPaths.WebPath,
                PlayerEnhancerEntryPoint.EnhancerUrl);

            return Ok();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PlayerEnhancer: failed to inject");
            return StatusCode(500, ex.Message);
        }
    }

    [HttpDelete("Inject")]
    [Authorize(Policy = "RequiresElevation")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status500InternalServerError)]
    public ActionResult Remove()
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            config.AutoInjectEnabled = false;
            Plugin.Instance.SaveConfiguration();

            PlayerEnhancerEntryPoint.RemoveEnhancerTagsFromIndexHtml(_appPaths.WebPath);

            return Ok();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PlayerEnhancer: failed to remove injection");
            return StatusCode(500, ex.Message);
        }
    }

    /// <summary>
    /// Returns player config for the current user.
    /// Authenticated requests (api_key or Authorization header) return user-specific settings.
    /// Anonymous requests return plugin-level defaults so the player works before login.
    /// </summary>
    [HttpGet("Config")]
    [AllowAnonymous]
    [ProducesResponseType(typeof(GestureConfigDto), StatusCodes.Status200OK)]
    public ActionResult<GestureConfigDto> GetConfig()
    {
        var userId = GetCurrentUserId();
        if (userId != null)
        {
            var s = _userSettings.Get(userId);
            return Ok(new GestureConfigDto
            {
                TrickplayEnabled = s.TrickplayEnabled,
                SeekSeconds = s.SeekSeconds,
                SpeedRate = s.SpeedRate,
            });
        }

        // Anonymous/system-key: return plugin-level defaults
        var cfg = Plugin.Instance?.Configuration;
        return Ok(new GestureConfigDto
        {
            TrickplayEnabled = true,
            SeekSeconds = cfg?.SeekSeconds ?? 10,
            SpeedRate = cfg?.SpeedRate ?? 2.0,
        });
    }

    /// <summary>Saves player config for the authenticated user.</summary>
    [HttpPatch("Config")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public ActionResult SetConfig([FromBody] GestureConfigDto dto)
    {
        var userId = GetCurrentUserId();
        if (userId == null) return Unauthorized();

        _userSettings.Save(userId, new UserPlayerSettings
        {
            TrickplayEnabled = dto.TrickplayEnabled,
            SeekSeconds = Math.Clamp(dto.SeekSeconds, 0.5, 30.0),
            SpeedRate = Math.Clamp(dto.SpeedRate, 1.25, 4.0),
        });
        return NoContent();
    }
}

public sealed class EnhancerStatusDto
{
    [JsonPropertyName("autoInjectEnabled")]
    public bool AutoInjectEnabled { get; set; }
}

public sealed class GestureConfigDto
{
    [JsonPropertyName("trickplayEnabled")]
    public bool TrickplayEnabled { get; set; } = true;

    [JsonPropertyName("seekSeconds")]
    public double SeekSeconds { get; set; }

    [JsonPropertyName("speedRate")]
    public double SpeedRate { get; set; } = 2.0;
}
