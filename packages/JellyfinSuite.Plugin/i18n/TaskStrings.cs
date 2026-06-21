using System.Globalization;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinSuite.i18n;

/// <summary>
/// 任务名称和描述的本地化字符串。匹配前端 src/frontend/src/i18n/ 的模式。
/// </summary>
public static class TaskStrings
{
    private static IHttpContextAccessor? _httpAccessor;

    /// <summary>由 DI 注入，用于读取请求 Accept-Language 头。</summary>
    public static void SetHttpAccessor(IHttpContextAccessor accessor) => _httpAccessor = accessor;

    public static HashSet<string> SupportedLocales => new() { "zh", "ja", "en" };
    private static readonly Dictionary<string, Dictionary<string, string>> Locales = new()
    {
        ["zh"] = new()
        {
            ["CleanExpired.Name"] = "清理 2 年前播放记录",
            ["CleanExpired.Desc"] = "删除 2 年前的所有播放记录",
            ["CleanPerUserExcess.Name"] = "按用户保留最新 10000 条",
            ["CleanPerUserExcess.Desc"] = "对每个用户各自保留最新 10000 条播放记录，超出部分删除",
            ["CleanGlobalExcess.Name"] = "全局保留最新 10000 条",
            ["CleanGlobalExcess.Desc"] = "⚠ 全局操作：仅保留最新 10000 条播放记录，其余全部删除。该操作影响所有用户。",
            ["CleanVacuum.Name"] = "优化数据库（VACUUM）",
            ["CleanVacuum.Desc"] = "执行 VACUUM 重建数据库文件，回收已删除记录占用的磁盘空间。执行期间数据库将被短暂锁定。",
            ["CleanInvalid.Name"] = "清理无效记录",
            ["CleanInvalid.Desc"] = "删除用户已不存在或媒体已删除的无效播放记录，每日自动执行",
            ["CleanPosterSheets.Name"] = "清理过期海报图片",
            ["CleanPosterSheets.Desc"] = "删除超过 24 小时的已生成海报图片文件，每日凌晨 3 点自动执行",
        },
        ["ja"] = new()
        {
            ["CleanExpired.Name"] = "2年以上の再生記録を削除",
            ["CleanExpired.Desc"] = "2年以上前のすべての再生記録を削除します",
            ["CleanPerUserExcess.Name"] = "ユーザーごとに最新10000件を保持",
            ["CleanPerUserExcess.Desc"] = "各ユーザーの最新10000件の再生記録を保持し、超過分を削除します",
            ["CleanGlobalExcess.Name"] = "全体で最新10000件を保持",
            ["CleanGlobalExcess.Desc"] = "⚠ 全体操作：最新10000件の再生記録のみを保持し、残りをすべて削除します。全ユーザーに影響します。",
            ["CleanVacuum.Name"] = "データベース最適化（VACUUM）",
            ["CleanVacuum.Desc"] = "VACUUMを実行してデータベースファイルを再構築し、削除済みレコードのディスク領域を回収します。実行中はデータベースが一時的にロックされます。",
            ["CleanInvalid.Name"] = "無効なレコードを削除",
            ["CleanInvalid.Desc"] = "存在しないユーザーまたは削除されたメディアの無効な再生記録を削除します。毎日自動実行されます。",
            ["CleanPosterSheets.Name"] = "期限切れポスター画像を削除",
            ["CleanPosterSheets.Desc"] = "生成から24時間以上経過したポスター画像ファイルを削除します。毎日午前3時に自動実行されます。",
        },
        ["en"] = new()
        {
            ["CleanExpired.Name"] = "Delete records older than 2 years",
            ["CleanExpired.Desc"] = "Deletes all playback records older than 2 years",
            ["CleanPerUserExcess.Name"] = "Keep latest 10000 per user",
            ["CleanPerUserExcess.Desc"] = "Keeps the latest 10000 playback records per user, deletes the rest",
            ["CleanGlobalExcess.Name"] = "Keep latest 10000 globally",
            ["CleanGlobalExcess.Desc"] = "⚠ Global operation: keeps only the latest 10000 playback records, deletes all others. Affects all users.",
            ["CleanVacuum.Name"] = "Optimize database (VACUUM)",
            ["CleanVacuum.Desc"] = "Runs VACUUM to rebuild the database file and reclaim disk space from deleted records. The database will be briefly locked.",
            ["CleanInvalid.Name"] = "Delete invalid records",
            ["CleanInvalid.Desc"] = "Deletes playback records from deleted users or removed media. Runs automatically every day.",
            ["CleanPosterSheets.Name"] = "Delete expired poster sheets",
            ["CleanPosterSheets.Desc"] = "Deletes generated poster sheet files older than 24 hours. Runs automatically at 3:00 AM daily.",
        },
    };

    static TaskStrings() { }

    private static Dictionary<string, string> ResolveLocale()
    {
        // 优先从 HTTP 请求 Accept-Language 读取
        var accept = _httpAccessor?.HttpContext?.Request.Headers.AcceptLanguage.ToString();
        if (!string.IsNullOrEmpty(accept))
        {
            var first = accept.Split(',')[0].Split(';')[0].Trim();
            if (Locales.TryGetValue(first, out var exact)) return exact;
            var twoLetter = first.Split('-')[0];
            if (Locales.TryGetValue(twoLetter, out var partial)) return partial;
        }
        // 无 HTTP 上下文（后台任务）→ 优先中文
        if (_httpAccessor?.HttpContext == null)
            return Locales["zh"];
        // 回退到服务器文化
        var culture = CultureInfo.CurrentUICulture;
        var code = culture.TwoLetterISOLanguageName;
        return Locales.TryGetValue(code, out var locale) ? locale : Locales["zh"];
    }

    public static string Get(string key)
    {
        var locale = ResolveLocale();
        return locale.TryGetValue(key, out var value) ? value : key;
    }
}
