using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinSuite.Models;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

/// <summary>
/// Manages ONNX model catalog, downloads, LRU eviction, and lastUsedAt tracking.
/// Full implementation in T021/T028/T029. This file contains the initial structure.
/// </summary>
public sealed class ModelCatalogService : BackgroundService
{
    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<ModelCatalogService> _logger;
    private readonly string _modelsDir;
    private readonly string _metaPath;

    private ModelMetadata _meta = new();
    private readonly SemaphoreSlim _metaLock = new(1, 1);

    private record CatalogEntry(
        string Family,
        string DisplayName,
        string Version,
        string FileName,
        long? FileSizeBytes,
        string? Sha256,
        string? DownloadUrl,
        string? ReleaseDate,
        bool IsLatest);

    private List<CatalogEntry> _catalog = new();
    private DateTime _catalogFetchedAt = DateTime.MinValue;
    private const int CatalogTtlHours = 24;
    private const int MaxVersionsPerFamily = 5;

    public ModelCatalogService(IApplicationPaths appPaths, ILogger<ModelCatalogService> logger)
    {
        _appPaths = appPaths;
        _logger = logger;
        _modelsDir = Path.Combine(appPaths.PluginsPath, "JellyfinSuite", "models");
        _metaPath = Path.Combine(_modelsDir, "metadata.json");
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Directory.CreateDirectory(_modelsDir);
        await LoadMetaAsync(stoppingToken);
        await RefreshCatalogIfStaleAsync(stoppingToken);
    }

    // ── Public API ──────────────────────────────────────────────────

    /// <summary>
    /// Returns installed + catalog top-10 per family, merged.
    /// </summary>
    public async Task<ModelListDto> GetModelsAsync(CancellationToken ct = default)
    {
        await RefreshCatalogIfStaleAsync(ct);
        var installed = GetInstalledEntries();
        var catalogOnly = _catalog
            .Where(c => installed.All(i => !(i.Family == c.Family && i.Version == c.Version)))
            .Select(c => new ModelEntryDto
            {
                Family = c.Family,
                DisplayName = c.DisplayName,
                Version = c.Version,
                FileName = c.FileName,
                FileSizeBytes = c.FileSizeBytes,
                Sha256 = c.Sha256,
                DownloadUrl = c.DownloadUrl,
                ReleaseDate = c.ReleaseDate,
                Status = "catalog",
                IsLatest = c.IsLatest,
            });

        return new ModelListDto
        {
            Models = installed.Concat(catalogOnly).ToList(),
            CatalogFetchedAt = _catalogFetchedAt == DateTime.MinValue
                ? null
                : _catalogFetchedAt.ToString("O"),
            CatalogStale = DateTime.UtcNow - _catalogFetchedAt > TimeSpan.FromHours(CatalogTtlHours),
        };
    }

    /// <summary>
    /// Returns the absolute local path for an installed model, or null.
    /// Used by <see cref="FrameExportService"/> to pass the model path to the daemon.
    /// </summary>
    public string? GetInstalledModelPath(string family, string version)
    {
        var fileName = _meta.Models
            .Where(m => m.Family == family && (version == "latest" ? m.IsLatest : m.Version == version))
            .OrderByDescending(m => m.InstalledAt)
            .FirstOrDefault()?.FileName;
        if (fileName is null)
            return null;
        var path = Path.Combine(_modelsDir, fileName);
        return File.Exists(path) ? path : null;
    }

    public Task RecordUsageAsync(string family, string version, CancellationToken ct = default)
    {
        var entry = _meta.Models.FirstOrDefault(m => m.Family == family && m.Version == version);
        if (entry is not null)
        {
            entry.LastUsedAt = DateTime.UtcNow;
            return SaveMetaAsync(ct);
        }
        return Task.CompletedTask;
    }

    public Task<ModelDownloadStartResult> StartDownloadAsync(string family, string version, CancellationToken ct = default)
    {
        // Full implementation in T028/T029.
        _logger.LogWarning("[ModelCatalogService] StartDownloadAsync not yet implemented (T028)");
        return Task.FromResult(ModelDownloadStartResult.NotFound);
    }

    public async IAsyncEnumerable<ModelDownloadProgressDto> GetDownloadProgressAsync(
        string family,
        string version,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        // Full implementation in T028/T029.
        await Task.Delay(100, ct);
        yield return new ModelDownloadProgressDto { Family = family, Version = version, Percent = 0, Status = "error", Error = "Not implemented" };
    }

    public Task<ModelDeleteResult> DeleteModelAsync(string family, string version, CancellationToken ct = default)
    {
        var entry = _meta.Models.FirstOrDefault(m => m.Family == family && m.Version == version);
        if (entry is null)
            return Task.FromResult(ModelDeleteResult.Fail("Not installed"));

        var installedInFamily = _meta.Models.Count(m => m.Family == family);
        if (installedInFamily <= 1)
            return Task.FromResult(ModelDeleteResult.Fail("Cannot delete the only installed version"));

        _meta.Models.Remove(entry);
        var path = Path.Combine(_modelsDir, entry.FileName);
        try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }

        return SaveMetaAsync(ct).ContinueWith(_ => ModelDeleteResult.Ok(), ct);
    }

    // ── Private helpers ─────────────────────────────────────────────

    private List<ModelEntryDto> GetInstalledEntries()
    {
        return _meta.Models
            .Where(m => File.Exists(Path.Combine(_modelsDir, m.FileName)))
            .Select(m => new ModelEntryDto
            {
                Family = m.Family,
                DisplayName = m.DisplayName,
                Version = m.Version,
                FileName = m.FileName,
                Status = "installed",
                LocalPath = Path.Combine(_modelsDir, m.FileName),
                LastUsedAt = m.LastUsedAt?.ToString("O"),
                IsLatest = m.IsLatest,
            })
            .ToList();
    }

    private Task RefreshCatalogIfStaleAsync(CancellationToken ct)
    {
        if (DateTime.UtcNow - _catalogFetchedAt < TimeSpan.FromHours(CatalogTtlHours))
            return Task.CompletedTask;
        // Full catalog fetch from remote CDN implemented in T021.
        _catalogFetchedAt = DateTime.UtcNow;
        return Task.CompletedTask;
    }

    private async Task LoadMetaAsync(CancellationToken ct)
    {
        if (!File.Exists(_metaPath)) return;
        try
        {
            var json = await File.ReadAllTextAsync(_metaPath, ct);
            _meta = JsonSerializer.Deserialize<ModelMetadata>(json) ?? new ModelMetadata();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ModelCatalogService] Failed to load metadata.json");
        }
    }

    private async Task SaveMetaAsync(CancellationToken ct = default)
    {
        await _metaLock.WaitAsync(ct);
        try
        {
            var json = JsonSerializer.Serialize(_meta, new JsonSerializerOptions { WriteIndented = true });
            var tmp = _metaPath + ".tmp";
            await File.WriteAllTextAsync(tmp, json, ct);
            File.Move(tmp, _metaPath, overwrite: true);
        }
        finally
        {
            _metaLock.Release();
        }
    }

    // ── Internal metadata model (not exposed via API) ────────────────

    private sealed class ModelMetadata
    {
        [JsonPropertyName("models")] public List<ModelMetaEntry> Models { get; set; } = new();
    }

    private sealed class ModelMetaEntry
    {
        [JsonPropertyName("family")]      public string   Family      { get; set; } = "";
        [JsonPropertyName("displayName")] public string   DisplayName { get; set; } = "";
        [JsonPropertyName("version")]     public string   Version     { get; set; } = "";
        [JsonPropertyName("fileName")]    public string   FileName    { get; set; } = "";
        [JsonPropertyName("isLatest")]    public bool     IsLatest    { get; set; }
        [JsonPropertyName("installedAt")] public DateTime InstalledAt { get; set; }
        [JsonPropertyName("lastUsedAt")]  public DateTime? LastUsedAt { get; set; }
    }
}
