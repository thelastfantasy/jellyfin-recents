using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

internal sealed class PosterCacheEntry
{
    [JsonPropertyName("outputPath")]
    public string OutputPath { get; set; } = string.Empty;

    [JsonPropertyName("createdAt")]
    public DateTime CreatedAt { get; set; } // when poster generation started (used for queue sort order)
}

/// <summary>
/// Thread-safe JSON-backed index mapping cache keys to poster sheet output files.
/// Lives in DataPath; actual WebP files live in TempPath.
/// </summary>
internal sealed class PosterCacheIndex
{
    private static readonly JsonSerializerOptions _jsonOpts = new() { WriteIndented = false };

    private readonly string _indexPath;
    private readonly object _lock = new();
    private readonly Dictionary<string, PosterCacheEntry> _entries;

    public PosterCacheIndex(string dataPath)
    {
        _indexPath = Path.Combine(dataPath, "jfs-poster-cache-index.json");
        _entries = Load();
    }

    private Dictionary<string, PosterCacheEntry> Load()
    {
        try
        {
            if (!File.Exists(_indexPath)) return new();
            var json = File.ReadAllText(_indexPath);
            return JsonSerializer.Deserialize<Dictionary<string, PosterCacheEntry>>(json, _jsonOpts) ?? new();
        }
        catch { return new(); }
    }

    /// <summary>
    /// Exact key lookup. Returns false (and prunes) if the file is gone.
    /// </summary>
    public bool TryGet(string key, out PosterCacheEntry? entry)
    {
        lock (_lock)
        {
            if (_entries.TryGetValue(key, out entry))
            {
                if (File.Exists(entry.OutputPath)) return true;
                _entries.Remove(key);
                Save();
                entry = null;
            }
            return false;
        }
    }

    /// <summary>
    /// Prefix-scan: finds any entry whose key starts with <paramref name="keyPrefix"/>.
    /// Used when the caller doesn't know the full key (e.g. missing skipHash).
    /// </summary>
    public bool TryGetByPrefix(string keyPrefix, out PosterCacheEntry? entry)
    {
        lock (_lock)
        {
            foreach (var kv in _entries)
            {
                if (!kv.Key.StartsWith(keyPrefix, StringComparison.Ordinal)) continue;
                if (!File.Exists(kv.Value.OutputPath)) continue;
                entry = kv.Value;
                return true;
            }
            entry = null;
            return false;
        }
    }

    public void Set(string key, PosterCacheEntry entry)
    {
        lock (_lock) { _entries[key] = entry; Save(); }
    }

    public void Remove(string key)
    {
        lock (_lock)
        {
            if (_entries.Remove(key)) Save();
        }
    }

    /// <summary>
    /// Removes all entries whose output file no longer exists on disk.
    /// Called by the cleanup scheduled task.
    /// </summary>
    public void PruneExpired()
    {
        lock (_lock)
        {
            var stale = _entries
                .Where(kv => !File.Exists(kv.Value.OutputPath))
                .Select(kv => kv.Key)
                .ToList();
            if (stale.Count == 0) return;
            foreach (var k in stale) _entries.Remove(k);
            Save();
        }
    }

    private void Save()
    {
        try { File.WriteAllText(_indexPath, JsonSerializer.Serialize(_entries, _jsonOpts)); }
        catch { /* best-effort */ }
    }
}
