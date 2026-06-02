using System.Text;
using Jellyfin.Plugin.JellyfinSuite.Models;
using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Controllers;

[ApiController]
[Route("JellyfinSuite/SeekPreview")]
[AllowAnonymous]
public class SeekPreviewController : ControllerBase
{
    private const int DefaultWidth = 320;

    private readonly SeekPreviewService _seekPreview;
    private readonly SeekPreviewBatchService _batchService;
    private readonly FrameExportService _frameExport;
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<SeekPreviewController> _logger;

    public SeekPreviewController(
        SeekPreviewService seekPreview,
        SeekPreviewBatchService batchService,
        FrameExportService frameExport,
        ILibraryManager libraryManager,
        ILogger<SeekPreviewController> logger)
    {
        _seekPreview = seekPreview;
        _batchService = batchService;
        _frameExport = frameExport;
        _libraryManager = libraryManager;
        _logger = logger;
    }

    /// <summary>
    /// Returns a JPEG frame for the given item at positionMs.
    /// Add &amp;prefetch=true to trigger background caching without waiting for JPEG.
    /// </summary>
    [HttpGet("{itemId}")]
    [ProducesResponseType(typeof(FileContentResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> GetFrame(
        [FromRoute] Guid itemId,
        [FromQuery] long positionMs = 0,
        [FromQuery] bool prefetch = false,
        [FromQuery] int width = DefaultWidth,
        CancellationToken cancellationToken = default)
    {
        if (!_seekPreview.IsAvailable)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "seek-preview not available");

        await _seekPreview.EnsureStartedAsync(cancellationToken);

        var item = _libraryManager.GetItemById(itemId);
        if (item == null)
            return NotFound();

        var filePath = item.Path;
        if (string.IsNullOrEmpty(filePath) || !System.IO.File.Exists(filePath))
            return NotFound();

        if (prefetch)
        {
            _ = _seekPreview.PrefetchAsync(filePath, positionMs, width, itemId, cancellationToken);
            return Ok();
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var jpeg = await _seekPreview.FetchAsync(filePath, positionMs, width, itemId, cancellationToken);
        sw.Stop();

        if (jpeg == null || jpeg.Length == 0)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "frame decode failed");

        _logger.LogInformation(
            "[SeekPreview] {FileName} {PosMs}ms → {Size}B in {Ms}ms",
            Path.GetFileName(filePath), positionMs, jpeg.Length, sw.ElapsedMilliseconds);

        return File(jpeg, "image/jpeg");
    }

    /// <summary>
    /// Returns the accurate frame index and frame-start timestamp for a given playback position.
    /// Rust decodes the frame at positionMs and returns actual pts + fps so C# can compute
    /// the frame-boundary time. Used by the screenshot feature for precise filenames.
    /// </summary>
    [HttpGet("{itemId}/frame-info")]
    [ProducesResponseType(typeof(FrameInfoDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> GetFrameInfo(
        [FromRoute] Guid itemId,
        [FromQuery] long positionMs = 0,
        CancellationToken cancellationToken = default)
    {
        if (!_seekPreview.IsAvailable)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "seek-preview not available");

        var item = _libraryManager.GetItemById(itemId);
        if (item == null || string.IsNullOrEmpty(item.Path) || !System.IO.File.Exists(item.Path))
            return NotFound();

        await _seekPreview.EnsureStartedAsync(cancellationToken);

        var result = await _seekPreview.FrameInfoAsync(item.Path, positionMs, itemId, cancellationToken);
        if (result == null)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "frame decode failed");

        return Ok(new FrameInfoDto { FrameIdx = result.Value.FrameIdx, FrameStartMs = result.Value.FrameStartMs });
    }

    /// <summary>
    /// Returns all video frame timestamps (demux-only, no decode) for exact frame-boundary seeks.
    /// Result is cached in the Rust daemon per item_id.
    /// </summary>
    [HttpGet("{itemId}/frame-index")]
    [ProducesResponseType(typeof(FrameIndexDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> GetFrameIndex(
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
    /// Server-Sent Events stream that emits positionMs values as frames become available on disk.
    /// The frontend subscribes once per video and uses events to warm the browser cache and
    /// populate _loadedKeys, enabling instant display during drag-seek.
    /// Authenticate via ?api_key= query param (EventSource cannot set custom headers).
    /// Frame generation continues in the background even after this stream disconnects.
    /// </summary>
    [HttpGet("{itemId}/ready-stream")]
    public async Task ReadyStream(
        [FromRoute] Guid itemId,
        [FromQuery] long positionMs = 0,
        CancellationToken cancellationToken = default)
    {
        if (!_seekPreview.IsAvailable)
        {
            Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            return;
        }

        var item = _libraryManager.GetItemById(itemId);
        if (item == null || string.IsNullOrEmpty(item.Path))
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        var durationMs = item.RunTimeTicks.HasValue
            ? item.RunTimeTicks.Value / TimeSpan.TicksPerMillisecond
            : 0L;

        if (durationMs <= 0)
        {
            Response.StatusCode = StatusCodes.Status204NoContent;
            return;
        }

        await _seekPreview.EnsureStartedAsync(cancellationToken);

        var itemIdStr = itemId.ToString("N");
        var filePath = item.Path;

        _logger.LogInformation("[SeekPreview] ReadyStream {ItemId} → {FilePath}", itemId, filePath);

        // Query Rust daemon for already-cached positions (avoids all disk I/O in C#).
        var cachedPositions = await _seekPreview.ListCachedAsync(itemId, DefaultWidth, cancellationToken);

        // Register with batch service: set priority center and enqueue pending frames.
        // Pass already-cached positions so they are skipped in the work queue.
        // Batch continues even after this SSE stream disconnects.
        _batchService.SetActive(itemIdStr, positionMs);
        _batchService.Enqueue(itemIdStr, filePath, durationMs, cachedPositions);

        Response.Headers["Content-Type"] = "text/event-stream; charset=utf-8";
        Response.Headers["Cache-Control"] = "no-cache, no-store";
        Response.Headers["X-Accel-Buffering"] = "no";

        var seen = new HashSet<long>();

        // Subscribe BEFORE emitting initial state to avoid missing notifications during flush.
        var (channel, unsub) = _batchService.Subscribe(itemIdStr);
        using (unsub)
        {
            // Emit frames already cached (reported by Rust daemon) immediately.
            foreach (var ms in cachedPositions)
            {
                seen.Add(ms);
                try
                {
                    var json = $"{{\"frameReady\":{ms}}}";
                    await Response.Body.WriteAsync(Encoding.UTF8.GetBytes($"data: {json}\n\n"), cancellationToken);
                }
                catch (OperationCanceledException) { return; }
            }

            try { await Response.Body.FlushAsync(cancellationToken); }
            catch (OperationCanceledException) { return; }

            // Stream new completions from the batch service.
            await foreach (var ms in channel.Reader.ReadAllAsync(cancellationToken))
            {
                if (!seen.Add(ms)) continue;

                try
                {
                    var json = $"{{\"frameReady\":{ms}}}";
                    await Response.Body.WriteAsync(Encoding.UTF8.GetBytes($"data: {json}\n\n"), cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                }
                catch (OperationCanceledException) { return; }
            }
        }
    }
}
