using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinSuite.Data;
using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Events;

/// <summary>
/// 监听播放开始事件，将记录写入 SQLite play_history 表。
/// 使用 Session.UserId 而非 eventArgs.Users，避免依赖
/// Jellyfin.Data.Entities.User（10.11.x 中已被重构）。
/// </summary>
public class PlaybackStartedEventConsumer : IEventConsumer<PlaybackStartEventArgs>
{
    private readonly RecentsDatabase _db;
    private readonly SeekPreviewBatchService _batchService;
    private readonly ILogger<PlaybackStartedEventConsumer> _logger;

    public PlaybackStartedEventConsumer(
        RecentsDatabase db,
        SeekPreviewBatchService batchService,
        ILogger<PlaybackStartedEventConsumer> logger)
    {
        _db = db;
        _batchService = batchService;
        _logger = logger;
    }

    public Task OnEvent(PlaybackStartEventArgs eventArgs)
    {
        try
        {
            var item = eventArgs.Item;
            if (item is null) return Task.CompletedTask;

            var userId = eventArgs.Session?.UserId;
            if (userId is null || userId == Guid.Empty) return Task.CompletedTask;

            // 只记录视频和音频
            var mediaType = item.MediaType == MediaType.Audio ? "audio" : "video";
            _db.InsertPlayRecord(userId.Value, item.Id.ToString(), DateTime.UtcNow, mediaType);

            // 通知 seek-preview 批量服务：新视频开始播放，优先级中心切换
            var posMs = (eventArgs.PlaybackPositionTicks ?? 0) / TimeSpan.TicksPerMillisecond;
            _batchService.SetActive(item.Id.ToString("N"), posMs);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to record playback start event");
        }

        return Task.CompletedTask;
    }
}
