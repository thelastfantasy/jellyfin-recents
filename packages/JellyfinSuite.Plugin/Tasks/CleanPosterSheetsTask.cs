using Jellyfin.Plugin.JellyfinSuite;
using Jellyfin.Plugin.JellyfinSuite.i18n;
using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Tasks;

public class CleanPosterSheetsTask : IScheduledTask
{
    private readonly ILogger<CleanPosterSheetsTask> _logger;
    private readonly PosterSheetJobService _jobService;

    private static readonly TimeSpan Ttl = TimeSpan.FromHours(24);

    public CleanPosterSheetsTask(ILogger<CleanPosterSheetsTask> logger, PosterSheetJobService jobService)
    {
        _logger = logger;
        _jobService = jobService;
    }

    public string Key => "JellyfinSuite.CleanPosterSheets";
    public string Name => TaskStrings.Get("CleanPosterSheets.Name");
    public string Description => TaskStrings.Get("CleanPosterSheets.Desc");
    public string Category => PluginConstants.TaskCategory;

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() =>
    [
        new TaskTriggerInfo
        {
            Type = TaskTriggerInfo.TriggerDaily,
            TimeOfDayTicks = TimeSpan.FromHours(3).Ticks,
        }
    ];

    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        var tempDir = Path.GetTempPath();
        var cutoff = DateTime.UtcNow - Ttl;
        var deleted = 0;

        foreach (var file in Directory.EnumerateFiles(tempDir, $"{PluginConstants.PosterTempPrefix}*.webp"))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                if (File.GetCreationTimeUtc(file) < cutoff)
                {
                    File.Delete(file);
                    deleted++;
                    _logger.LogInformation("Deleted expired poster sheet: {File}", file);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning("Could not delete {File}: {Msg}", file, ex.Message);
            }
        }

        _logger.LogInformation("CleanPosterSheets: {Count} file(s) deleted", deleted);

        _jobService.RemoveExpiredJobs();

        progress.Report(100);
        return Task.CompletedTask;
    }
}
