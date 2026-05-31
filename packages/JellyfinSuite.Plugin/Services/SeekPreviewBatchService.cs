using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

/// <summary>
/// Persistent background service that drives seek-preview frame generation
/// with a 4-level priority queue across multiple videos:
///   0 = current video, within ±3 min of current playback position
///   1 = current video, other frames
///   2 = previously played video, within ±3 min of last known position
///   3 = previously played video, other frames
///
/// Batch work continues even after the SSE stream disconnects.
/// </summary>
public sealed class SeekPreviewBatchService : BackgroundService
{
    private const long NearRangeMs = 3 * 60_000L;
    private const int PrefetchBatchSize = 4; // Rust side has a bounded queue with 2 workers
    private const int PollIntervalMs = 500;
    private const int DefaultWidth = 320;

    private readonly record struct BatchFrame(string ItemId, string FilePath, long PosMs);

    private readonly SeekPreviewService _seekPreview;
    private readonly ILogger<SeekPreviewBatchService> _logger;

    // Pending frames — protected by _lock
    private readonly List<BatchFrame> _pending = [];
    private readonly HashSet<(string, long)> _pendingKeys = [];

    // Priority state — protected by _lock
    private string? _activeItemId;
    private long _activePositionMs;
    private readonly Dictionary<string, long> _lastPos = [];
    private readonly Dictionary<string, (long posMs, DateTime time)> _posThrottle = [];

    // Per-frame dispatch priority tracking (for batch completion stats) — protected by _lock
    private readonly Dictionary<(string, long), int> _dispatchPriority = [];
    // Per-item batch stats: start time + frames completed at each priority — protected by _lock
    private readonly Dictionary<string, (DateTime Start, int[] ByPriority)> _batchStats = [];

    // SSE notification channels — protected by _subsLock
    private readonly Dictionary<string, List<Channel<long>>> _subs = [];
    private readonly object _subsLock = new();

    private readonly object _lock = new();

    public SeekPreviewBatchService(SeekPreviewService seekPreview, ILogger<SeekPreviewBatchService> logger)
    {
        _seekPreview = seekPreview;
        _logger = logger;
    }

    /// <summary>Declare a new video as currently active and set its priority center.</summary>
    public void SetActive(string itemId, long positionMs)
    {
        lock (_lock)
        {
            if (_activeItemId != null && _activeItemId != itemId)
                _lastPos[_activeItemId] = _activePositionMs;

            _activeItemId = itemId;
            _activePositionMs = positionMs;
            _lastPos[itemId] = positionMs;
        }
        _logger.LogInformation("[seek-preview] active → {ItemId} @ {PosSec}s (priority center: ±3 min)",
            itemId[..8], positionMs / 1000);
    }

    /// <summary>
    /// Update the playback position for an active item (from progress events).
    /// Throttled: only propagates if position moved &gt;1 min or &gt;60 s have elapsed.
    /// </summary>
    public void UpdatePosition(string itemId, long positionMs)
    {
        lock (_lock)
        {
            if (_posThrottle.TryGetValue(itemId, out var last))
            {
                var movedFar = Math.Abs(positionMs - last.posMs) > 60_000;
                var enoughTime = (DateTime.UtcNow - last.time).TotalSeconds > 60;
                if (!movedFar && !enoughTime) return;
            }
            _posThrottle[itemId] = (positionMs, DateTime.UtcNow);
            _lastPos[itemId] = positionMs;
            if (itemId == _activeItemId)
                _activePositionMs = positionMs;
        }
        _logger.LogInformation("[seek-preview] position → {ItemId} @ {PosSec}s", itemId[..8], positionMs / 1000);
    }

    /// <summary>
    /// Enqueue all 30 s-aligned frames for an item.
    /// Frames in alreadyCached are skipped (caller obtains this via ListCachedAsync).
    /// </summary>
    public void Enqueue(string itemId, string filePath, long durationMs, IEnumerable<long>? alreadyCached = null)
    {
        var skip = alreadyCached != null ? new HashSet<long>(alreadyCached) : null;
        var added = 0;
        lock (_lock)
        {
            for (var ms = 0L; ms <= durationMs; ms += 30_000)
            {
                if (skip != null && skip.Contains(ms)) continue;
                if (_pendingKeys.Add((itemId, ms)))
                {
                    _pending.Add(new BatchFrame(itemId, filePath, ms));
                    added++;
                }
            }
        }

        if (added > 0)
        {
            if (!_batchStats.ContainsKey(itemId))
                _batchStats[itemId] = (DateTime.UtcNow, new int[4]);
            _logger.LogInformation("[seek-preview] enqueued {Added} frames for {ItemId} (total pending: {Total})",
                added, itemId, _pending.Count);
        }
    }

    /// <summary>
    /// Subscribe to frame-ready notifications for an item.
    /// Frames already on disk are NOT sent retroactively — scan disk first in ReadyStream.
    /// Dispose the returned token to unsubscribe.
    /// </summary>
    public (Channel<long> Channel, IDisposable Unsubscribe) Subscribe(string itemId)
    {
        var ch = Channel.CreateUnbounded<long>(new UnboundedChannelOptions { SingleReader = true });
        lock (_subsLock)
        {
            if (!_subs.TryGetValue(itemId, out var list))
                _subs[itemId] = list = [];
            list.Add(ch);
        }
        return (ch, new Unsubscriber(this, itemId, ch));
    }

    private void Unsubscribe(string itemId, Channel<long> ch)
    {
        lock (_subsLock)
        {
            if (!_subs.TryGetValue(itemId, out var list)) return;
            list.Remove(ch);
            if (list.Count == 0) _subs.Remove(itemId);
        }
        ch.Writer.TryComplete();
    }

    /// <returns>Whether there are pending frames for this item.</returns>
    public bool HasPending(string itemId)
    {
        lock (_lock)
            return _pending.Any(f => f.ItemId == itemId);
    }

    private int CalcPriority(string itemId, long posMs)
    {
        bool isCurrent = itemId == _activeItemId;
        var refPos = _lastPos.GetValueOrDefault(itemId, 0L);
        bool isNear = Math.Abs(posMs - refPos) <= NearRangeMs;

        return (isCurrent, isNear) switch
        {
            (true, true) => 0,
            (true, false) => 1,
            (false, true) => 2,
            _ => 3,
        };
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        // Start the Rust daemon eagerly so the first SSE connection is instant.
        if (_seekPreview.IsAvailable)
        {
            try { await _seekPreview.EnsureStartedAsync(ct); }
            catch (Exception ex) { _logger.LogWarning(ex, "[seek-preview] eager daemon start failed, will retry on first request"); }
        }

        while (!ct.IsCancellationRequested)
        {
            try { await TickAsync(ct); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { _logger.LogError(ex, "[seek-preview] batch worker error"); }

            try { await Task.Delay(PollIntervalMs, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        if (!_seekPreview.IsAvailable) return;

        BatchFrame? pick = null;
        int pickPriority = 3;

        lock (_lock)
        {
            if (_pending.Count == 0) return;

            var best = _pending
                .Select(f => (Frame: f, Priority: CalcPriority(f.ItemId, f.PosMs)))
                .OrderBy(x => x.Priority)
                .ThenBy(x => Math.Abs(x.Frame.PosMs - _lastPos.GetValueOrDefault(x.Frame.ItemId, 0L)))
                .FirstOrDefault();

            pick = best.Frame;
            pickPriority = best.Priority;
        }

        if (pick == null || !Guid.TryParseExact(pick.Value.ItemId, "N", out var guid)) return;

        var f = pick.Value;
        _logger.LogDebug("[seek-preview] dispatch p{P} {Id}@{Ms}ms", pickPriority, f.ItemId[..8], f.PosMs);

        var ok = await _seekPreview.PrefetchAsync(f.FilePath, f.PosMs, DefaultWidth, guid, ct);

        bool itemComplete;
        lock (_lock)
        {
            _pending.Remove(f);
            _pendingKeys.Remove((f.ItemId, f.PosMs));
            if (_dispatchPriority.TryGetValue((f.ItemId, f.PosMs), out var p))
            {
                _dispatchPriority.Remove((f.ItemId, f.PosMs));
                if (_batchStats.TryGetValue(f.ItemId, out var stats))
                    stats.ByPriority[p]++;
            }
            else
            {
                if (_batchStats.TryGetValue(f.ItemId, out var stats))
                    stats.ByPriority[pickPriority]++;
            }
            itemComplete = !_pending.Any(pf => pf.ItemId == f.ItemId);
        }

        if (ok)
        {
            lock (_subsLock)
            {
                if (_subs.TryGetValue(f.ItemId, out var channels))
                    foreach (var ch in channels)
                        ch.Writer.TryWrite(f.PosMs);
            }
        }

        if (itemComplete)
        {
            if (_batchStats.TryGetValue(f.ItemId, out var stats))
            {
                var elapsed = (DateTime.UtcNow - stats.Start).TotalSeconds;
                var bp = stats.ByPriority;
                _logger.LogInformation(
                    "[seek-preview] batch done {ItemId} in {Sec:F0}s [p0:{P0} p1:{P1} p2:{P2} p3:{P3}]",
                    f.ItemId[..8], elapsed, bp[0], bp[1], bp[2], bp[3]);
                _batchStats.Remove(f.ItemId);
            }

            lock (_subsLock)
            {
                if (_subs.TryGetValue(f.ItemId, out var channels))
                {
                    foreach (var ch in channels)
                        ch.Writer.TryComplete();
                    _subs.Remove(f.ItemId);
                }
            }
        }
    }

    private sealed class Unsubscriber : IDisposable
    {
        private readonly SeekPreviewBatchService _svc;
        private readonly string _itemId;
        private readonly Channel<long> _ch;
        private bool _disposed;

        public Unsubscriber(SeekPreviewBatchService svc, string itemId, Channel<long> ch)
        {
            _svc = svc;
            _itemId = itemId;
            _ch = ch;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _svc.Unsubscribe(_itemId, _ch);
        }
    }
}
