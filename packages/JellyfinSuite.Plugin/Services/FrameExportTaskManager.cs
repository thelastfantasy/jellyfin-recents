using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

public enum TaskStatus { Pending, Running, Complete, Error, Cancelled }

public class TaskState
{
    public string TaskId { get; init; } = Guid.NewGuid().ToString("N");
    public string ItemId { get; set; } = "";
    public string ItemTitle { get; set; } = "";
    public string Type { get; set; } = ""; // "animate" or "stitch"
    public TaskStatus Status { get; set; } = TaskStatus.Pending;
    public string? OutputPath { get; set; }
    public long? OutputSize { get; set; }
    public string? Error { get; set; }
    public bool Upscaled { get; set; }
    public string TempDir { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
    public int? ProcessId { get; set; }
    public Jellyfin.Plugin.JellyfinSuite.Models.GenerationLogDto? GenerationLog { get; set; }
    public CancellationTokenSource Cts { get; } = new CancellationTokenSource();
    public Channel<TaskProgress> ProgressChannel { get; } =
        Channel.CreateUnbounded<TaskProgress>();
}

public class TaskProgress
{
    [JsonPropertyName("taskId")]   public string TaskId  { get; set; } = "";
    [JsonPropertyName("status")]   public string Status  { get; set; } = "running"; // running | complete | error | fallback
    [JsonPropertyName("phase")]    public string Phase   { get; set; } = "";
    [JsonPropertyName("current")]  public int    Current { get; set; }
    [JsonPropertyName("total")]    public int    Total   { get; set; }
    [JsonPropertyName("percent")]  public double Percent { get; set; }
    [JsonPropertyName("resultUrl")] public string? ResultUrl { get; set; }
    [JsonPropertyName("fileSize")] public long?  FileSize  { get; set; }
    [JsonPropertyName("error")]    public string? Error    { get; set; }
}

/// <summary>
/// Manages the lifecycle of frame-forge export tasks (animation & stitch).
/// Handles task dictionary, progress channel SSE bridging, and periodic temp file cleanup.
/// </summary>
public sealed class FrameExportTaskManager : IDisposable
{
    private readonly ConcurrentDictionary<string, TaskState> _tasks = new();
    private readonly ILogger<FrameExportTaskManager> _logger;
    private readonly string _tempRoot;
    private readonly Timer _cleanupTimer;
    private bool _disposed;

    public FrameExportTaskManager(
        ILogger<FrameExportTaskManager> logger,
        MediaBrowser.Common.Configuration.IApplicationPaths appPaths)
    {
        _logger = logger;
        _tempRoot = Path.Combine(appPaths.DataPath, "temp", "frame-forge", "generated");
        Directory.CreateDirectory(_tempRoot);

        // Cleanup orphan dirs on startup
        if (Directory.Exists(_tempRoot))
        {
            foreach (var dir in Directory.GetDirectories(_tempRoot))
            {
                try { Directory.Delete(dir, recursive: true); }
                catch { _logger.LogWarning("[FrameExport] Failed to clean orphan dir: {Dir}", dir); }
            }
        }

        // Periodic cleanup every 5 minutes
        _cleanupTimer = new Timer(_ => CleanupExpired(), null, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5));
    }

    public TaskState CreateTask(string itemId, string itemTitle, string type)
    {
        var taskId = Guid.NewGuid().ToString("N");
        var tempDir = Path.Combine(_tempRoot, taskId);
        Directory.CreateDirectory(tempDir);

        var state = new TaskState
        {
            TaskId = taskId,
            ItemId = itemId,
            ItemTitle = itemTitle,
            Type = type,
            Status = TaskStatus.Pending,
            TempDir = tempDir,
            CreatedAt = DateTime.UtcNow,
        };
        _tasks[taskId] = state;
        _logger.LogInformation("[FrameExport] Task created: {TaskId} type={Type}", taskId, type);
        return state;
    }

    public TaskState? GetTask(string taskId)
    {
        _tasks.TryGetValue(taskId, out var state);
        return state;
    }

    public void DeleteTask(string taskId)
    {
        if (_tasks.TryRemove(taskId, out var state))
        {
            state.ProgressChannel.Writer.TryComplete();
            state.Cts.Dispose();
            try { Directory.Delete(state.TempDir, recursive: true); }
            catch { }
            _logger.LogInformation("[FrameExport] Task deleted: {TaskId}", taskId);
        }
    }

    public void CancelTask(string taskId)
    {
        if (_tasks.TryGetValue(taskId, out var state)
            && state.Status is TaskStatus.Pending or TaskStatus.Running)
        {
            state.Status = TaskStatus.Cancelled;
            state.Error = "Cancelled by user";
            state.Cts.Cancel();
            state.ProgressChannel.Writer.TryWrite(new TaskProgress
            {
                TaskId = taskId,
                Status = "cancelled",
                Error = "Cancelled by user",
            });
            state.ProgressChannel.Writer.TryComplete();

            // Kill child process if running
            if (state.ProcessId.HasValue)
            {
                try
                {
                    var proc = Process.GetProcessById(state.ProcessId.Value);
                    proc.Kill();
                    proc.WaitForExit(3000);
                }
                catch { }
            }

            try { Directory.Delete(state.TempDir, recursive: true); }
            catch { }

            _logger.LogInformation("[FrameExport] Task cancelled: {TaskId}", taskId);
        }
    }

    public IEnumerable<TaskState> GetAllTasks() => _tasks.Values;

    /// <summary>Flags a task's result as having been upscaled at least once, so the queue widget
    /// can surface a tag — called by <see cref="UpscaleService"/> once its (otherwise fully
    /// separate) job dictionary reports success. Best-effort: silently no-ops once the source task
    /// has already expired out of <see cref="_tasks"/> (5min TTL), since there's nothing left to
    /// flag at that point.</summary>
    public void MarkUpscaled(string taskId)
    {
        if (_tasks.TryGetValue(taskId, out var state)) state.Upscaled = true;
    }

    /// <summary>Removes completed/errored/cancelled tasks older than 5 minutes, plus their temp
    /// dirs. Runs on an internal 5-minute <see cref="Timer"/> as a self-healing fallback, and is
    /// also exposed here so <see cref="Tasks.CleanFrameExportTempTask"/> can surface the same
    /// logic as a visible, manually-triggerable Jellyfin scheduled task.</summary>
    public void CleanupExpired()
    {
        var now = DateTime.UtcNow;
        var expired = new List<string>();
        foreach (var (id, state) in _tasks)
        {
            if ((state.Status == TaskStatus.Complete || state.Status == TaskStatus.Error || state.Status == TaskStatus.Cancelled)
                && now - state.CreatedAt > TimeSpan.FromMinutes(5))
            {
                expired.Add(id);
            }
        }
        foreach (var id in expired)
        {
            DeleteTask(id);
        }
        _logger.LogInformation("[FrameExport] Cleanup: removed {Count} expired tasks", expired.Count);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _cleanupTimer.Dispose();
        foreach (var id in _tasks.Keys)
        {
            DeleteTask(id);
        }
    }
}
