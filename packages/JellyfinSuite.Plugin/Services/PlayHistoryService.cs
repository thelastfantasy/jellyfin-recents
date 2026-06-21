using Jellyfin.Plugin.JellyfinSuite.Data;
using Jellyfin.Plugin.JellyfinSuite.Models;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

public class PlayHistoryService
{
    private readonly RecentsDatabase _db;
    private readonly ILibraryManager _libraryManager;
    private readonly IUserDataManager _userDataManager;
    private readonly IUserManager _userManager;

    public PlayHistoryService(RecentsDatabase db, ILibraryManager libraryManager, IUserDataManager userDataManager, IUserManager userManager)
    {
        _db = db;
        _libraryManager = libraryManager;
        _userDataManager = userDataManager;
        _userManager = userManager;
    }

    public async Task<PlayHistoryResponse> GetPlayHistoryAsync(
        Guid userId, string groupBy, int page, string timeZoneId,
        string? mediaType, string sortBy, string sortOrder, bool showRepeats, bool groupDedup,
        int pageSize, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(groupBy)) groupBy = "week";
        var tz = GetTimeZone(timeZoneId);
        var nowUtc = DateTime.UtcNow;
        var tzOffset = (int)tz.GetUtcOffset(nowUtc).TotalMinutes;
        var ps = ResolvePageSize(groupBy, pageSize);
        List<PlayHistoryEntry> entries;
        int totalPages;

        if (groupBy == "day")
        {
            // 按天：递补机制 — UTC 转本地日期，去重，按 pageSize 天分页
            tzOffset = (int)tz.GetUtcOffset(nowUtc).TotalMinutes;
            var dates = await _db.GetDistinctLocalDatesAsync(userId, tzOffset, ct);
            var pageDates = dates.Skip(page * ps).Take(ps).ToList();
            totalPages = (int)Math.Ceiling(dates.Count / (double)ps);

            if (pageDates.Count == 0)
                return new PlayHistoryResponse { Entries = [], TotalCount = 0, TotalPages = 0 };

            var minLocal = DateTime.Parse(pageDates[^1] + "T00:00:00");
            var maxLocal = DateTime.Parse(pageDates[0] + "T23:59:59.999");
            var utcStart = ConvertLocalToUtc(minLocal, tz);
            var utcEnd = ConvertLocalToUtc(maxLocal, tz);

            entries = await _db.GetPlayHistoryByDateRangeAsync(
                userId, utcStart, utcEnd, showRepeats, mediaType, sortBy, sortOrder, ct);

            var dateSet = new HashSet<string>(pageDates);
            entries = entries.Where(e =>
                dateSet.Contains(TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(e.PlayedDate, DateTimeKind.Utc), tz).ToString("yyyy-MM-dd"))).ToList();
        }
        else
        {
            var (utcStart, utcEnd) = ComputeWindow(groupBy, page, nowUtc, tz, ps);
            entries = await _db.GetPlayHistoryByDateRangeAsync(
                userId, utcStart, utcEnd, showRepeats, mediaType, sortBy, sortOrder, ct);
            var earliest = await _db.GetEarliestPlayedAtAsync(userId, ct);
            totalPages = ComputeTotalPages(groupBy, nowUtc, tz, earliest, ps);
        }

        EnrichMetadata(entries, userId);

        var totalCount = await _db.GetTotalRecordCountAsync(userId, mediaType, showRepeats, groupDedup, groupBy, tzOffset, ct);

        return new PlayHistoryResponse { Entries = entries, TotalCount = totalCount, TotalPages = totalPages };
    }

    private void EnrichMetadata(List<PlayHistoryEntry> entries, Guid userId)
    {
        foreach (var entry in entries)
        {
            if (!Guid.TryParse(entry.ItemId, out var itemGuid)) continue;
            var item = _libraryManager.GetItemById(itemGuid);
            if (item is null) continue;
            entry.Title = item.Name;
            entry.ReleaseDate = item.PremiereDate.HasValue ? item.PremiereDate.Value
                : item.ProductionYear.HasValue ? new DateTime(item.ProductionYear.Value, 1, 1, 0, 0, 0, DateTimeKind.Utc) : null;
            entry.AddedDate = item.DateCreated == DateTime.MinValue ? null : item.DateCreated;
            if (item is IHasSeries hasSeries && !string.IsNullOrEmpty(hasSeries.SeriesName))
            {
                entry.SeriesName = hasSeries.SeriesName;
                entry.SeriesId = hasSeries.SeriesId == Guid.Empty ? null : hasSeries.SeriesId.ToString("N");
            }
            entry.SeasonNumber = item.ParentIndexNumber;
            entry.EpisodeNumber = item.IndexNumber;
            entry.ImagePrimaryTag = null;
            entry.HasAncestors = item.ParentId != Guid.Empty
                || (item is IHasSeries s && s.SeriesId != Guid.Empty);

            // 通过反射获取 UserData，避免直接引用 Jellyfin.Data.Entities.User（10.11+ 兼容）
            var userData = GetUserDataSafe(userId, item);
            if (userData?.PlaybackPositionTicks > 0 && !userData.Played)
            {
                entry.PlaybackPositionTicks = userData.PlaybackPositionTicks;
            }
            if (item.RunTimeTicks.HasValue && item.RunTimeTicks.Value > 0
                && string.Equals(entry.MediaType, "video", StringComparison.OrdinalIgnoreCase))
                entry.VideoDuration = item.RunTimeTicks.Value / 10_000_000.0;
        }
    }

    // ─── 工具函数 ────────────────────────────────────────────────────────────

    private static TimeZoneInfo GetTimeZone(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch { return TimeZoneInfo.Utc; }
    }

    private static DateTime ConvertLocalToUtc(DateTime local, TimeZoneInfo tz)
    {
        var unspecified = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
        return TimeZoneInfo.ConvertTimeToUtc(unspecified, tz);
    }

    private static int ResolvePageSize(string groupBy, int pageSize)
    {
        if (pageSize > 0) return pageSize;
        return groupBy switch
        {
            "day" => 30,
            "week" => 13,
            "month" => 6,
            "quarter" => 2,
            _ => 1,
        };
    }

    // ─── 固定窗口计算 ────────────────────────────────────────────────────────

    private static (DateTime utcStart, DateTime utcEnd) ComputeWindow(
        string groupBy, int page, DateTime nowUtc, TimeZoneInfo tz, int ps)
    {
        var nowLocal = TimeZoneInfo.ConvertTimeFromUtc(nowUtc, tz);
        DateTime localStart, localEnd;

        switch (groupBy)
        {
            case "week":
            {
                var weekOffset = page * ps;
                var dayOfWeek = (int)nowLocal.DayOfWeek;
                var mondayOffset = dayOfWeek == 0 ? -6 : 1 - dayOfWeek;
                var thisMonday = nowLocal.Date.AddDays(mondayOffset);
                localEnd = thisMonday.AddDays(-weekOffset * 7 + 6).AddDays(1).AddTicks(-1);
                localStart = thisMonday.AddDays(-(weekOffset + ps - 1) * 7);
                break;
            }
            case "month":
            {
                var monthOffset = page * ps;
                var endMonth = nowLocal.Year * 12 + nowLocal.Month - 1 - monthOffset;
                var endYear = endMonth / 12; var endM = endMonth % 12 + 1;
                localEnd = new DateTime(endYear, endM, 1).AddMonths(1).AddTicks(-1);
                var startMonth = endMonth - (ps - 1);
                var startYear = startMonth / 12; var startM = startMonth % 12 + 1;
                localStart = new DateTime(startYear, startM, 1);
                break;
            }
            case "quarter":
            {
                var monthsPerPage = ps * 3;
                var quarterOffset = page * ps;
                var currentQuarterEnd = ((nowLocal.Month - 1) / 3 + 1) * 3;
                var endMonthAbs = nowLocal.Year * 12 + currentQuarterEnd - 1 - quarterOffset * 3;
                var endYear = endMonthAbs / 12; var endM = endMonthAbs % 12 + 1;
                localEnd = new DateTime(endYear, endM, 1).AddMonths(1).AddTicks(-1);
                var startMonthAbs = endMonthAbs - (monthsPerPage - 1);
                var startYear = startMonthAbs / 12; var startM = startMonthAbs % 12 + 1;
                localStart = new DateTime(startYear, startM, 1);
                break;
            }
            case "year":
            default:
            {
                localStart = new DateTime(nowLocal.Year - page * ps, 1, 1);
                localEnd = new DateTime(nowLocal.Year - (page * ps + ps - 1), 12, 31, 23, 59, 59, 999);
                break;
            }
        }

        return (ConvertLocalToUtc(localStart, tz), ConvertLocalToUtc(localEnd, tz));
    }

    private static int ComputeTotalPages(
        string groupBy, DateTime nowUtc, TimeZoneInfo tz, DateTime? earliestUtc, int ps)
    {
        if (earliestUtc is null) return 0;
        var nowLocal = TimeZoneInfo.ConvertTimeFromUtc(nowUtc, tz);
        var earliestLocal = TimeZoneInfo.ConvertTimeFromUtc(earliestUtc.Value, tz);

        switch (groupBy)
        {
            case "week":
            {
                var dow = (int)nowLocal.DayOfWeek;
                var thisMonday = nowLocal.Date.AddDays(dow == 0 ? -6 : 1 - dow);
                var earliestDow = (int)earliestLocal.DayOfWeek;
                var earliestMonday = earliestLocal.Date.AddDays(earliestDow == 0 ? -6 : 1 - earliestDow);
                return Math.Max(1, (int)Math.Ceiling((thisMonday - earliestMonday).Days / (ps * 7.0)));
            }
            case "month":
            {
                var totalMonths = (nowLocal.Year - earliestLocal.Year) * 12 + (nowLocal.Month - earliestLocal.Month);
                return Math.Max(1, (int)Math.Ceiling((totalMonths + 1) / (double)ps));
            }
            case "quarter":
            {
                var totalMonths = (nowLocal.Year - earliestLocal.Year) * 12 + (nowLocal.Month - earliestLocal.Month);
                return Math.Max(1, (int)Math.Ceiling((totalMonths + ps * 3 - 1) / (double)(ps * 3)));
            }
            default:
            {
                return Math.Max(1, (nowLocal.Year - earliestLocal.Year) / ps + 1);
            }
        }
    }

    private static System.Reflection.MethodInfo? _getUserDataMethod;
    private static System.Reflection.MethodInfo? _getUserByIdMethod;

    private UserItemData? GetUserDataSafe(Guid userId, BaseItem item)
    {
        try
        {
            _getUserDataMethod ??= typeof(IUserDataManager).GetMethod("GetUserData");
            _getUserByIdMethod ??= typeof(IUserManager).GetMethod("GetUserById");
            if (_getUserDataMethod is null || _getUserByIdMethod is null) return null;

            var user = _getUserByIdMethod.Invoke(_userManager, [userId]);
            if (user is null) return null;

            return _getUserDataMethod.Invoke(_userDataManager, [user, item]) as UserItemData;
        }
        catch
        {
            return null;
        }
    }
}
