using Jellyfin.Plugin.JellyfinSuite.i18n;
using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Tasks;

/// <summary>Surfaces <see cref="FrameExportTaskManager.CleanupExpired"/> (动图/全景图导出任务的临时
/// 文件清理) as a visible, manually-triggerable Jellyfin scheduled task. The manager's own
/// 5-minute <see cref="System.Threading.Timer"/> keeps running regardless — this is a
/// complementary entry point for admins, not a replacement.</summary>
public class CleanFrameExportTempTask : IScheduledTask
{
    private readonly ILogger<CleanFrameExportTempTask> _logger;
    private readonly FrameExportTaskManager _taskManager;

    public CleanFrameExportTempTask(ILogger<CleanFrameExportTempTask> logger, FrameExportTaskManager taskManager)
    {
        _logger = logger;
        _taskManager = taskManager;
    }

    public string Key => "JellyfinSuite.CleanFrameExportTemp";
    public string Name => TaskStrings.Get("CleanFrameExportTemp.Name");
    public string Description => TaskStrings.Get("CleanFrameExportTemp.Desc");
    public string Category => PluginConstants.TaskCategory;

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() =>
    [
        new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.DailyTrigger,
            TimeOfDayTicks = TimeSpan.FromHours(4).Ticks,
        }
    ];

    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        _logger.LogInformation("CleanFrameExportTemp: starting");
        _taskManager.CleanupExpired();
        _logger.LogInformation("CleanFrameExportTemp: done");
        progress.Report(100);
        return Task.CompletedTask;
    }
}
