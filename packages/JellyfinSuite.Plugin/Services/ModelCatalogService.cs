using System.Collections.Concurrent;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Jellyfin.Plugin.JellyfinSuite.Models;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

/// <summary>
/// Manages ONNX model catalog, downloads, LRU eviction, and lastUsedAt tracking.
/// Replaces the old <see cref="ModelAcquisitionService"/> with a versioned, multi-family
/// catalog (lightglue / efficient-loftr today; realesrgan / gfpgan added in US7).
/// </summary>
public sealed class ModelCatalogService : BackgroundService
{
    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<ModelCatalogService> _logger;
    private readonly string _pluginDir;
    private readonly string _modelsDir;
    private readonly string _metaPath;
    private readonly string _catalogPath;
    private readonly string _catalogTtlPath;

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
    private DateTime _lastFetchAttemptAt = DateTime.MinValue;
    private const int CatalogTtlHours = 24;
    private const int MaxVersionsPerFamily = 5;
    private static readonly TimeSpan FetchRetryBackoff = TimeSpan.FromMinutes(5);

    // Remote catalog URL, published to the project's gh-pages branch (see T067 / research.md
    // for the model sourcing + update process). Model binaries are hosted as assets on the
    // "models-v1" GitHub Release; fetches fail gracefully and fall back to the on-disk cache
    // (or an installed-only listing when no cache exists yet either).
    private const string CatalogUrlEnvVar = "FRAME_FORGE_MODEL_CATALOG_URL";
    private const string DefaultCatalogUrl =
        "https://thelastfantasy.github.io/jellyfin-suite/model-catalog.json";

    // Active downloads, keyed by "{family}::{version}". Populated by StartDownloadAsync,
    // drained (and removed) by the GetDownloadProgressAsync forwarder once its SSE consumer
    // finishes reading — same Channel-push pattern as FrameExportTaskManager.ProgressChannel.
    private readonly ConcurrentDictionary<string, Channel<ModelDownloadProgressDto>> _downloads = new();

    public ModelCatalogService(IApplicationPaths appPaths, ILogger<ModelCatalogService> logger)
    {
        _appPaths = appPaths;
        _logger = logger;
        _pluginDir = Path.GetDirectoryName(typeof(ModelCatalogService).Assembly.Location)!;
        _modelsDir = Path.Combine(_pluginDir, "models");
        _metaPath = Path.Combine(_modelsDir, "metadata.json");
        _catalogPath = Path.Combine(_pluginDir, "model-catalog.json");
        _catalogTtlPath = _catalogPath + ".ttl";
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

    public async Task<ModelDownloadStartResult> StartDownloadAsync(string family, string version, CancellationToken ct = default)
    {
        await RefreshCatalogIfStaleAsync(ct);

        var key = $"{family}::{version}";
        if (_downloads.ContainsKey(key))
            return ModelDownloadStartResult.InProgress;

        var alreadyInstalled = _meta.Models.Any(m =>
            m.Family == family
            && (version == "latest" ? m.IsLatest : m.Version == version)
            && File.Exists(Path.Combine(_modelsDir, m.FileName)));
        if (alreadyInstalled)
            return ModelDownloadStartResult.AlreadyInstalled;

        var entry = ResolveCatalogEntry(family, version);
        if (entry is null || entry.DownloadUrl is null)
            return ModelDownloadStartResult.NotFound;

        var channel = Channel.CreateUnbounded<ModelDownloadProgressDto>();
        if (!_downloads.TryAdd(key, channel))
            return ModelDownloadStartResult.InProgress;

        // Fire-and-forget: deliberately not tied to the POST request's CancellationToken,
        // so the download survives past the HTTP request that started it.
        _ = Task.Run(() => DownloadModelFileAsync(entry, family, channel));
        return ModelDownloadStartResult.Started;
    }

    public async IAsyncEnumerable<ModelDownloadProgressDto> GetDownloadProgressAsync(
        string family,
        string version,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var key = $"{family}::{version}";
        if (!_downloads.TryGetValue(key, out var channel))
        {
            yield return new ModelDownloadProgressDto
            {
                Family = family,
                Version = version,
                Percent = 0,
                Status = "error",
                Error = "No download in progress for this model",
            };
            yield break;
        }

        try
        {
            await foreach (var evt in channel.Reader.ReadAllAsync(ct))
            {
                yield return evt;
            }
        }
        finally
        {
            _downloads.TryRemove(key, out _);
        }
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

    // ── Download pipeline (T028/T029) ─────────────────────────────────

    private async Task DownloadModelFileAsync(CatalogEntry entry, string requestedFamily, Channel<ModelDownloadProgressDto> channel)
    {
        var dest = Path.Combine(_modelsDir, entry.FileName);
        var tmp = dest + ".tmp";
        const int maxAttempts = 4; // 1 initial attempt + 3 retries
        var backoff = new[] { TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(4), TimeSpan.FromSeconds(16) };
        Exception? lastError = null;

        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
        http.DefaultRequestHeaders.Add("User-Agent", "JellyfinSuite/1.0");

        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            try
            {
                // Caller (StartDownloadAsync) already verified DownloadUrl is non-null before scheduling this task.
                using var response = await http.GetAsync(entry.DownloadUrl!, HttpCompletionOption.ResponseHeadersRead, CancellationToken.None)
                    .ConfigureAwait(false);

                if (!response.IsSuccessStatusCode)
                {
                    var status = (int)response.StatusCode;
                    if (status is >= 400 and < 500)
                    {
                        // Client errors (bad URL, 404, etc.) will not resolve themselves on retry.
                        await FailDownloadAsync(channel, requestedFamily, entry.Version, tmp, $"HTTP {status}")
                            .ConfigureAwait(false);
                        return;
                    }
                    throw new HttpRequestException($"HTTP {status}");
                }

                var totalBytes = response.Content.Headers.ContentLength;
                await using (var src = await response.Content.ReadAsStreamAsync(CancellationToken.None).ConfigureAwait(false))
                await using (var dst = File.Create(tmp))
                {
                    await CopyWithProgressAsync(channel, requestedFamily, entry.Version, src, dst, totalBytes)
                        .ConfigureAwait(false);
                }

                if (entry.Sha256 is { Length: > 0 } expectedHash)
                {
                    var actualHash = await ComputeSha256Async(tmp).ConfigureAwait(false);
                    if (!string.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException($"SHA-256 mismatch (expected {expectedHash}, got {actualHash})");
                }

                File.Move(tmp, dest, overwrite: true);
                await RegisterInstalledAsync(entry).ConfigureAwait(false);
                await EvictLruIfNeededAsync(entry.Family).ConfigureAwait(false);

                await channel.Writer.WriteAsync(new ModelDownloadProgressDto
                {
                    Family = requestedFamily,
                    Version = entry.Version,
                    Percent = 100,
                    Status = "installed",
                }).ConfigureAwait(false);
                channel.Writer.TryComplete();

                _logger.LogInformation(
                    "[ModelCatalogService] Downloaded {Family}/{Version} -> {File}",
                    entry.Family, entry.Version, entry.FileName);
                return;
            }
            catch (Exception ex)
            {
                lastError = ex;
                _logger.LogWarning(
                    "[ModelCatalogService] Download attempt {Attempt}/{Max} failed for {Family}/{Version}: {Msg}",
                    attempt, maxAttempts, entry.Family, entry.Version, ex.Message);
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* best effort */ }

                if (attempt == maxAttempts) break;
                await Task.Delay(backoff[attempt - 1]).ConfigureAwait(false);
            }
        }

        await FailDownloadAsync(channel, requestedFamily, entry.Version, tmp, lastError?.Message ?? "Download failed")
            .ConfigureAwait(false);
    }

    private async Task FailDownloadAsync(
        Channel<ModelDownloadProgressDto> channel, string family, string version, string tmpPath, string error)
    {
        try { if (File.Exists(tmpPath)) File.Delete(tmpPath); } catch { /* best effort */ }
        await channel.Writer.WriteAsync(new ModelDownloadProgressDto
        {
            Family = family,
            Version = version,
            Percent = 0,
            Status = "error",
            Error = error,
        }).ConfigureAwait(false);
        channel.Writer.TryComplete();
        _logger.LogError(
            "[ModelCatalogService] Download failed permanently for {Family}/{Version}: {Error}", family, version, error);
    }

    private static async Task CopyWithProgressAsync(
        Channel<ModelDownloadProgressDto> channel, string family, string version,
        Stream src, Stream dst, long? totalBytes)
    {
        var buf = new byte[81920];
        long copied = 0;
        int n;
        var lastUpdate = DateTime.UtcNow;

        while ((n = await src.ReadAsync(buf, CancellationToken.None).ConfigureAwait(false)) > 0)
        {
            await dst.WriteAsync(buf.AsMemory(0, n), CancellationToken.None).ConfigureAwait(false);
            copied += n;

            if (DateTime.UtcNow - lastUpdate > TimeSpan.FromSeconds(1))
            {
                var percent = totalBytes is > 0 ? Math.Min(99.0, copied * 100.0 / totalBytes.Value) : 0;
                await channel.Writer.WriteAsync(new ModelDownloadProgressDto
                {
                    Family = family,
                    Version = version,
                    Percent = percent,
                    Status = "downloading",
                }).ConfigureAwait(false);
                lastUpdate = DateTime.UtcNow;
            }
        }
    }

    private static async Task<string> ComputeSha256Async(string path)
    {
        await using var stream = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(stream, CancellationToken.None).ConfigureAwait(false);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    // Multiple model families (lightglue, efficient-loftr, and — from US7 — realesrgan,
    // gfpgan) can download concurrently, so all in-memory mutations of `_meta.Models` plus
    // the resulting save are wrapped in `_metaLock` as one atomic unit, not just the save.
    private async Task RegisterInstalledAsync(CatalogEntry entry)
    {
        await _metaLock.WaitAsync().ConfigureAwait(false);
        try
        {
            _meta.Models.RemoveAll(m => m.Family == entry.Family && m.Version == entry.Version);

            if (entry.IsLatest)
            {
                foreach (var m in _meta.Models.Where(m => m.Family == entry.Family))
                    m.IsLatest = false;
            }

            _meta.Models.Add(new ModelMetaEntry
            {
                Family = entry.Family,
                DisplayName = entry.DisplayName,
                Version = entry.Version,
                FileName = entry.FileName,
                IsLatest = entry.IsLatest,
                InstalledAt = DateTime.UtcNow,
                LastUsedAt = null,
            });

            await SaveMetaLockedAsync().ConfigureAwait(false);
        }
        finally
        {
            _metaLock.Release();
        }
    }

    /// <summary>
    /// Keeps at most <see cref="MaxVersionsPerFamily"/> installed versions per family.
    /// The latest version is pinned; among the rest, the least-recently-used (by
    /// <c>LastUsedAt</c>, falling back to <c>InstalledAt</c> for never-used versions) is
    /// evicted first.
    /// </summary>
    private async Task EvictLruIfNeededAsync(string family)
    {
        await _metaLock.WaitAsync().ConfigureAwait(false);
        try
        {
            var familyModels = _meta.Models.Where(m => m.Family == family).ToList();
            var excess = familyModels.Count - MaxVersionsPerFamily;
            if (excess <= 0) return;

            var evictionCandidates = familyModels
                .Where(m => !m.IsLatest)
                .OrderBy(m => m.LastUsedAt ?? m.InstalledAt)
                .Take(excess)
                .ToList();

            foreach (var victim in evictionCandidates)
            {
                _meta.Models.Remove(victim);
                var path = Path.Combine(_modelsDir, victim.FileName);
                try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
                _logger.LogInformation(
                    "[ModelCatalogService] Evicted LRU model {Family}/{Version}", family, victim.Version);
            }

            await SaveMetaLockedAsync().ConfigureAwait(false);
        }
        finally
        {
            _metaLock.Release();
        }
    }

    private CatalogEntry? ResolveCatalogEntry(string family, string version) =>
        version == "latest"
            ? _catalog.FirstOrDefault(c => c.Family == family && c.IsLatest)
            : _catalog.FirstOrDefault(c => c.Family == family && c.Version == version);

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

    /// <summary>
    /// Refreshes the in-memory catalog from the remote URL when the 24h TTL has expired.
    /// On first call (cold start), loads whatever is cached on disk first. Network failures
    /// are logged and swallowed — the service falls back to the disk cache (or an
    /// installed-only listing if no cache exists), and retries are throttled to once every
    /// <see cref="FetchRetryBackoff"/> so an unreachable catalog URL does not spam requests.
    /// </summary>
    private async Task RefreshCatalogIfStaleAsync(CancellationToken ct)
    {
        if (_catalog.Count == 0 && _catalogFetchedAt == DateTime.MinValue)
        {
            await LoadCatalogFromDiskAsync(ct).ConfigureAwait(false);
        }

        var stale = DateTime.UtcNow - _catalogFetchedAt > TimeSpan.FromHours(CatalogTtlHours);
        if (!stale) return;
        if (DateTime.UtcNow - _lastFetchAttemptAt < FetchRetryBackoff) return;

        _lastFetchAttemptAt = DateTime.UtcNow;
        var url = Environment.GetEnvironmentVariable(CatalogUrlEnvVar)?.Trim() is { Length: > 0 } envUrl
            ? envUrl
            : DefaultCatalogUrl;

        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            http.DefaultRequestHeaders.Add("User-Agent", "JellyfinSuite/1.0");
            var json = await http.GetStringAsync(url, ct).ConfigureAwait(false);

            ApplyCatalogJson(json);

            Directory.CreateDirectory(_pluginDir);
            var tmp = _catalogPath + ".tmp";
            await File.WriteAllTextAsync(tmp, json, ct).ConfigureAwait(false);
            File.Move(tmp, _catalogPath, overwrite: true);
            await File.WriteAllTextAsync(
                _catalogTtlPath, DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), ct).ConfigureAwait(false);

            _catalogFetchedAt = DateTime.UtcNow;
            _logger.LogInformation(
                "[ModelCatalogService] Catalog refreshed from {Url} ({Count} models)", url, _catalog.Count);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                "[ModelCatalogService] Catalog fetch from {Url} failed ({Msg}) — using cached/installed-only listing",
                url, ex.Message);
        }
    }

    private async Task LoadCatalogFromDiskAsync(CancellationToken ct)
    {
        if (!File.Exists(_catalogPath)) return;
        try
        {
            var json = await File.ReadAllTextAsync(_catalogPath, ct).ConfigureAwait(false);
            ApplyCatalogJson(json);

            if (File.Exists(_catalogTtlPath))
            {
                var raw = (await File.ReadAllTextAsync(_catalogTtlPath, ct).ConfigureAwait(false)).Trim();
                if (long.TryParse(raw, out var epochSeconds))
                    _catalogFetchedAt = DateTimeOffset.FromUnixTimeSeconds(epochSeconds).UtcDateTime;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ModelCatalogService] Failed to load cached model-catalog.json");
        }
    }

    private void ApplyCatalogJson(string json)
    {
        var parsed = JsonSerializer.Deserialize<CatalogFileDto>(json) ?? new CatalogFileDto();

        var latestPerFamily = parsed.Models
            .GroupBy(m => m.Family)
            .ToDictionary(
                g => g.Key,
                g => g.OrderByDescending(m => DateTime.TryParse(m.ReleaseDate, out var d) ? d : DateTime.MinValue).First());

        _catalog = parsed.Models
            .Select(m => new CatalogEntry(
                m.Family,
                m.DisplayName,
                m.Version,
                m.FileName,
                m.FileSizeBytes,
                m.Sha256,
                m.DownloadUrl,
                m.ReleaseDate,
                IsLatest: ReferenceEquals(latestPerFamily.GetValueOrDefault(m.Family), m)))
            .ToList();
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
            await SaveMetaLockedAsync(ct);
        }
        finally
        {
            _metaLock.Release();
        }
    }

    /// <summary>Writes <see cref="_meta"/> to disk. Caller must already hold <see cref="_metaLock"/>.</summary>
    private async Task SaveMetaLockedAsync(CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(_meta, new JsonSerializerOptions { WriteIndented = true });
        var tmp = _metaPath + ".tmp";
        await File.WriteAllTextAsync(tmp, json, ct);
        File.Move(tmp, _metaPath, overwrite: true);
    }

    // ── Remote catalog DTOs (deserialization-only, not exposed via API) ─────

    private sealed class CatalogFileDto
    {
        [JsonPropertyName("schemaVersion")] public int SchemaVersion { get; set; }
        [JsonPropertyName("models")] public List<CatalogModelDto> Models { get; set; } = new();
    }

    private sealed class CatalogModelDto
    {
        [JsonPropertyName("family")] public string Family { get; set; } = "";
        [JsonPropertyName("displayName")] public string DisplayName { get; set; } = "";
        [JsonPropertyName("version")] public string Version { get; set; } = "";
        [JsonPropertyName("fileName")] public string FileName { get; set; } = "";
        [JsonPropertyName("downloadUrl")] public string? DownloadUrl { get; set; }
        [JsonPropertyName("sha256")] public string? Sha256 { get; set; }
        [JsonPropertyName("fileSizeBytes")] public long? FileSizeBytes { get; set; }
        [JsonPropertyName("releaseDate")] public string? ReleaseDate { get; set; }
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
