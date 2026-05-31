using Jellyfin.Plugin.JellyfinSuite;
using Jellyfin.Plugin.JellyfinSuite.Compat;
using Jellyfin.Plugin.JellyfinSuite.Data;
using Jellyfin.Plugin.JellyfinSuite.i18n;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Tasks;

public class CleanInvalidRecordsTask : IScheduledTask
{
    private readonly RecentsDatabase _db;
    private readonly IUserManager _userManager;
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<CleanInvalidRecordsTask> _logger;

    public CleanInvalidRecordsTask(
        RecentsDatabase db,
        IUserManager userManager,
        ILibraryManager libraryManager,
        ILogger<CleanInvalidRecordsTask> logger)
    {
        _db = db;
        _userManager = userManager;
        _libraryManager = libraryManager;
        _logger = logger;
    }

    public string Key => "JellyfinSuite.CleanInvalid";

    public string Name => TaskStrings.Get("CleanInvalid.Name");

    public string Description => TaskStrings.Get("CleanInvalid.Desc");

    public string Category => PluginConstants.TaskCategory;

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        return new[]
        {
            new TaskTriggerInfo
            {
                Type = TaskTriggerInfo.TriggerDaily,
                TimeOfDayTicks = 0
            }
        };
    }

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        var totalDeleted = 0;

        // ── 清理无效用户 ──────────────────────────────────────────────
        _logger.LogInformation("CleanInvalidRecords: checking for invalid users");
        var userIds = await _db.GetDistinctUserIdsAsync(cancellationToken);
        var invalidUserIds = new HashSet<string>();

        foreach (var uid in userIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!Guid.TryParse(uid, out var userGuid) || userGuid == Guid.Empty)
            {
                invalidUserIds.Add(uid);
                continue;
            }

            var userExists = _userManager.UserExists(userGuid, _logger);
            if (userExists == false)
                invalidUserIds.Add(uid);
        }

        if (invalidUserIds.Count > 0)
        {
            _logger.LogInformation("CleanInvalidRecords: found {Count} invalid users", invalidUserIds.Count);
            totalDeleted += await _db.DeleteRecordsByFieldAsync("user_id", invalidUserIds, null, cancellationToken);
        }

        // ── 清理无效媒体 ──────────────────────────────────────────────
        _logger.LogInformation("CleanInvalidRecords: checking for invalid items");
        var itemIds = await _db.GetDistinctItemIdsAsync(cancellationToken);
        var invalidItemIds = new HashSet<string>();

        var checked_ = 0;
        foreach (var iid in itemIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!Guid.TryParse(iid, out var itemGuid) || itemGuid == Guid.Empty)
            {
                invalidItemIds.Add(iid);
                continue;
            }

            try
            {
                var item = _libraryManager.GetItemById(itemGuid);
                if (item is null)
                    invalidItemIds.Add(iid);
            }
            catch (MissingMethodException)
            {
                _logger.LogWarning("CleanInvalidRecords: GetItemById unavailable, skipping item validation");
                break;
            }

            checked_++;
            if (itemIds.Count > 0)
                progress.Report(Math.Min(50, (double)checked_ / itemIds.Count * 50));
        }

        if (invalidItemIds.Count > 0)
        {
            _logger.LogInformation("CleanInvalidRecords: found {Count} invalid items", invalidItemIds.Count);
            totalDeleted += await _db.DeleteRecordsByFieldAsync("item_id", invalidItemIds, null, cancellationToken);
        }

        progress.Report(100);
        _logger.LogInformation("CleanInvalidRecords: done, {Count} total records deleted", totalDeleted);
    }
}
