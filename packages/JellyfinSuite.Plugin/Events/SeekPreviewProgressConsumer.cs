using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinSuite.Events;

/// <summary>
/// Receives Jellyfin playback progress events (fired when clients call
/// /Sessions/Playing/Progress) and updates the seek-preview batch service's
/// priority center so frames nearest the current playback position are
/// generated first. Throttling is handled inside SeekPreviewBatchService.
/// </summary>
public class SeekPreviewProgressConsumer : IEventConsumer<PlaybackProgressEventArgs>
{
    private readonly SeekPreviewBatchService _batchService;

    public SeekPreviewProgressConsumer(SeekPreviewBatchService batchService)
    {
        _batchService = batchService;
    }

    public Task OnEvent(PlaybackProgressEventArgs e)
    {
        if (e.Item is null || !e.Item.RunTimeTicks.HasValue) return Task.CompletedTask;

        var itemId = e.Item.Id.ToString("N");
        var posMs = (e.PlaybackPositionTicks ?? 0) / TimeSpan.TicksPerMillisecond;
        _batchService.UpdatePosition(itemId, posMs);
        return Task.CompletedTask;
    }
}
