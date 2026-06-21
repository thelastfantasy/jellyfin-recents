using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Compat;

/// <summary>
/// Jellyfin 10.8.x ~ 10.11.x 兼容层。
/// 10.11.0+ 移除了 Jellyfin.Data.Entities.User 类，GetUserById 签名也变了。
/// 此兼容层用反射调用，避免直接引用 User 类型导致 TypeLoadException。
/// </summary>
public static class UserManagerCompat
{
    private static bool? _apiAvailable;
    private static System.Reflection.MethodInfo? _getUserByIdMethod;

    public static bool IsApiAvailable
    {
        get
        {
            if (!_apiAvailable.HasValue)
                _apiAvailable = ProbeApi();
            return _apiAvailable.Value;
        }
    }

    /// <summary>反射探测 IUserManager.GetUserById 是否可用。</summary>
    private static bool ProbeApi()
    {
        try
        {
            _getUserByIdMethod = typeof(IUserManager).GetMethod("GetUserById", new[] { typeof(Guid) });
            return _getUserByIdMethod != null;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>安全获取用户。返回 null 表示 API 不可用或用户不存在。</summary>
    public static bool? UserExists(this IUserManager userManager, Guid userId, ILogger? logger = null)
    {
        if (!IsApiAvailable)
        {
            logger?.LogDebug("UserManagerCompat: GetUserById not available, skipping user check");
            return null; // 未知
        }

        if (userId == Guid.Empty) return false;

        try
        {
            var user = _getUserByIdMethod!.Invoke(userManager, new object[] { userId });
            return user != null;
        }
        catch (MissingMethodException)
        {
            _apiAvailable = false;
            logger?.LogWarning("UserManagerCompat: GetUserById unavailable (Jellyfin 10.11+). User validation skipped.");
            return null;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger?.LogWarning(ex, "UserManagerCompat: error checking user {UserId}", userId);
            return null; // 出错时保守处理
        }
    }
}
