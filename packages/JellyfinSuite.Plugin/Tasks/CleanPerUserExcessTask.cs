using Jellyfin.Plugin.JellyfinSuite;
using Jellyfin.Plugin.JellyfinSuite.Data;
using Jellyfin.Plugin.JellyfinSuite.i18n;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Tasks;

public class CleanPerUserExcessTask : IScheduledTask
{
    private readonly RecentsDatabase _db;
    private readonly ILogger<CleanPerUserExcessTask> _logger;

    public CleanPerUserExcessTask(RecentsDatabase db, ILogger<CleanPerUserExcessTask> logger)
    {
        _db = db;
        _logger = logger;
    }

    public string Key => "JellyfinSuite.CleanPerUserExcess";

    public string Name => TaskStrings.Get("CleanPerUserExcess.Name");

    public string Description => TaskStrings.Get("CleanPerUserExcess.Desc");

    public string Category => PluginConstants.TaskCategory;

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => [];

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        const int maxRecords = 10000;
        _logger.LogInformation("CleanPerUserExcess: deleting records beyond {Max} per user", maxRecords);
        var deleted = await _db.DeletePerUserExcessAsync(maxRecords, progress, cancellationToken);
        _logger.LogInformation("CleanPerUserExcess: done, {Count} records deleted", deleted);
    }
}
