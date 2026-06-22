using Jellyfin.Plugin.JellyfinSuite.i18n;
using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Tasks;

/// <summary>Surfaces <see cref="UpscaleService.CleanupExpired"/> (提升画质任务的临时文件清理) as a
/// visible, manually-triggerable Jellyfin scheduled task. The service's own 5-minute
/// <see cref="System.Threading.Timer"/> keeps running regardless — this is a complementary entry
/// point for admins, not a replacement.</summary>
public class CleanUpscaleTempTask : IScheduledTask
{
    private readonly ILogger<CleanUpscaleTempTask> _logger;
    private readonly UpscaleService _upscaleService;

    public CleanUpscaleTempTask(ILogger<CleanUpscaleTempTask> logger, UpscaleService upscaleService)
    {
        _logger = logger;
        _upscaleService = upscaleService;
    }

    public string Key => "JellyfinSuite.CleanUpscaleTemp";
    public string Name => TaskStrings.Get("CleanUpscaleTemp.Name");
    public string Description => TaskStrings.Get("CleanUpscaleTemp.Desc");
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
        _logger.LogInformation("CleanUpscaleTemp: starting");
        _upscaleService.CleanupExpired();
        _logger.LogInformation("CleanUpscaleTemp: done");
        progress.Report(100);
        return Task.CompletedTask;
    }
}
