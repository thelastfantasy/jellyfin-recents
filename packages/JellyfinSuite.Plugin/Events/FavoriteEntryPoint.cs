using Jellyfin.Plugin.JellyfinSuite.Data;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinSuite.Events;

/// <summary>
/// Hosted service：订阅 IUserDataManager.UserDataSaved（老式 C# event），
/// 捕获收藏状态变化并写入 SQLite favorite_record 表。
/// IEventConsumer&lt;UserDataSaveEventArgs&gt; 无法捕获此事件，因为它不经过 IEventManager。
/// </summary>
public class FavoriteEntryPoint : IHostedService, IDisposable
{
    private readonly IUserDataManager _userDataManager;
    private readonly RecentsDatabase _db;

    public FavoriteEntryPoint(IUserDataManager userDataManager, RecentsDatabase db)
    {
        _userDataManager = userDataManager;
        _db = db;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _userDataManager.UserDataSaved += OnUserDataSaved;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _userDataManager.UserDataSaved -= OnUserDataSaved;
        return Task.CompletedTask;
    }

    private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
    {
        if (e.SaveReason != UserDataSaveReason.UpdateUserRating) return;

        var userData = e.UserData;
        var item = e.Item;
        if (userData is null || item is null) return;

        var favoritedAt = userData.IsFavorite ? DateTime.UtcNow : (DateTime?)null;
        _db.UpsertFavorite(e.UserId, item.Id.ToString(), favoritedAt);
    }

    public void Dispose()
    {
        _userDataManager.UserDataSaved -= OnUserDataSaved;
        GC.SuppressFinalize(this);
    }
}
