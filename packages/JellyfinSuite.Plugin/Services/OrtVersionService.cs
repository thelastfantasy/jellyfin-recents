using System.Collections.Concurrent;
using System.Formats.Tar;
using System.IO.Compression;
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
/// Manages ORT runtime versions under /config/plugins/JellyfinSuite/ort/. Bootstraps on
/// startup by scanning for an active version, downloads new versions on demand (detecting
/// host OS + GPU vendor to pick the matching asset), and activates a version by writing
/// active.txt and killing the running frame-forge daemon so it relaunches with the new
/// ORT_DYLIB_PATH (see research.md §3).
///
/// Unlike <see cref="ModelCatalogService"/> (which reads a project-curated
/// model-catalog.json published to gh-pages), the ORT "catalog" here is derived live from
/// the GitHub Releases API for a single project-pinned version of microsoft/onnxruntime
/// (<see cref="PinnedOrtVersion"/>) — there is no separate file for the project to publish
/// or for the asset sha256/url/size to drift out of sync with upstream. Pinning the version
/// in code (rather than always tracking upstream's "latest") is deliberate: this project has
/// already hit ORT-version-specific GPU hangs (research.md §7a, the Blackwell/CUDA12 "gpu"
/// build), so adopting a new ORT release is a reviewed code change, not an automatic update.
/// </summary>
public sealed class OrtVersionService : BackgroundService
{
    private readonly DeviceEnumerationService _deviceEnum;
    private readonly ILogger<OrtVersionService> _logger;
    private FrameExportService? _frameExport;
    private string? _activeOrtLibPath;
    private string? _activeOrtAssetKey;
    private const int MaxRetainedVersions = 2;

    private readonly string _pluginDir;
    private readonly string _catalogPath;
    private readonly string _catalogTtlPath;

    private record OrtCatalogEntry(string Version, string? ReleaseDate, Dictionary<string, OrtAssetDto> Assets);

    // Catalog entries are assumed ordered newest-first in the source JSON (single source of
    // truth authored by the project, same convention as the `models` array) — there is no
    // semver-safe way to sort ORT's own version strings (e.g. "2.0.0-rc.12").
    private List<OrtCatalogEntry> _catalog = new();
    private DateTime _catalogFetchedAt = DateTime.MinValue;
    private DateTime _lastFetchAttemptAt = DateTime.MinValue;
    private const int CatalogTtlHours = 24;
    private static readonly TimeSpan FetchRetryBackoff = TimeSpan.FromMinutes(5);

    // The ORT version this project has verified works (no EP-init hangs, correct GPU kernels
    // for the hardware tested against — research.md §7a). Bump this only after manually
    // re-running tests/stitch-eval/run_demo_gpu.sh against the new version.
    private const string PinnedOrtVersion = "1.26.0";
    private const string OrtReleaseApiUrlEnvVar = "FRAME_FORGE_ORT_RELEASE_API_URL";
    private static string DefaultOrtReleaseApiUrl =>
        $"https://api.github.com/repos/microsoft/onnxruntime/releases/tags/v{PinnedOrtVersion}";

    // Active downloads, keyed by ORT version string. Same Channel-push/SSE-pull pattern as
    // ModelCatalogService._downloads.
    private readonly ConcurrentDictionary<string, Channel<OrtDownloadProgressDto>> _downloads = new();

    public OrtVersionService(IApplicationPaths appPaths, DeviceEnumerationService deviceEnum, ILogger<OrtVersionService> logger)
    {
        _deviceEnum = deviceEnum;
        _logger = logger;
        _pluginDir = Path.Combine(appPaths.PluginsPath, "JellyfinSuite");
        _catalogPath = Path.Combine(OrtRoot, "catalog.json");
        _catalogTtlPath = _catalogPath + ".ttl";
    }

    /// <summary>
    /// Wires in the frame-forge daemon manager after DI container build (avoids circular
    /// construction — FrameExportService already depends on this service for ActiveOrtLibPath).
    /// Called from <see cref="Jellyfin.Plugin.JellyfinSuite.FrameExportAuxServicesWirer"/>.
    /// </summary>
    public void SetFrameExportService(FrameExportService frameExport) => _frameExport = frameExport;

    /// <summary>Absolute path to the active ORT dylib, or null if none installed.</summary>
    public string? ActiveOrtLibPath => _activeOrtLibPath;

    /// <summary>
    /// Asset key the active version was downloaded under (e.g. "linux-x64-gpu_cuda13"), or
    /// null if none installed. Passed to the frame-forge daemon as `FRAME_FORGE_ORT_ASSET_KEY`
    /// so it can check the gpu-compat denylist (T040-T041) without re-deriving the asset
    /// variant from the dylib path itself, which carries no such information.
    /// </summary>
    public string? ActiveOrtAssetKey => _activeOrtAssetKey;

    private string OrtRoot => Path.Combine(_pluginDir, "ort");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Directory.CreateDirectory(OrtRoot);
        await LoadCatalogFromDiskAsync(stoppingToken).ConfigureAwait(false);

        var activeTxt = Path.Combine(OrtRoot, "active.txt");
        if (File.Exists(activeTxt))
        {
            var version = (await File.ReadAllTextAsync(activeTxt, stoppingToken)).Trim();
            _activeOrtLibPath = FindLibInVersion(version);
            if (_activeOrtLibPath is not null)
            {
                _activeOrtAssetKey = ReadAssetKey(version);
                _logger.LogInformation("[OrtVersionService] Active ORT: {version} → {path}", version, _activeOrtLibPath);
                return;
            }
        }

        _logger.LogInformation("[OrtVersionService] No ORT version installed. GPU-accelerated stitch will fall back to CPU.");

        // frame-forge only ships a Linux binary today (FrameExportService.IsAvailable), so
        // don't spend bandwidth bootstrapping an ORT runtime that nothing on this host can use.
        if (!OperatingSystem.IsWindows())
            _ = Task.Run(() => BootstrapDownloadAsync(stoppingToken), CancellationToken.None);
    }

    /// <summary>
    /// One-time auto-download of the newest catalog ORT version on first run, so GPU
    /// acceleration works out of the box without the user visiting the Advanced panel.
    /// Fire-and-forget from <see cref="ExecuteAsync"/>; failures are logged and otherwise
    /// harmless — CPU fallback continues to work, and the user can retry via the UI (T035).
    /// </summary>
    private async Task BootstrapDownloadAsync(CancellationToken ct)
    {
        await RefreshCatalogIfStaleAsync(ct).ConfigureAwait(false);
        var entry = _catalog.FirstOrDefault();
        if (entry is null)
        {
            _logger.LogInformation("[OrtVersionService] No ORT catalog available yet for auto-bootstrap; will retry on next request.");
            return;
        }

        var assetKey = ResolveAssetKey(await _deviceEnum.EnumerateAsync(ct).ConfigureAwait(false));
        if (!entry.Assets.TryGetValue(assetKey, out var asset))
        {
            _logger.LogInformation(
                "[OrtVersionService] Catalog has no {Key} asset for {Version}; GPU-accelerated stitch will fall back to CPU until a compatible version is published.",
                assetKey, entry.Version);
            return;
        }

        _logger.LogInformation("[OrtVersionService] Auto-bootstrapping ORT {Version} ({Key}) in background", entry.Version, assetKey);
        var channel = Channel.CreateUnbounded<OrtDownloadProgressDto>();
        if (!_downloads.TryAdd(entry.Version, channel))
            return; // a UI-triggered download for the same version is already racing this — let it win

        try
        {
            await DownloadOrtAssetAsync(entry.Version, assetKey, asset, channel).ConfigureAwait(false);
            if (FindLibInVersion(entry.Version) is not null)
                await ActivateVersionAsync(entry.Version, ct).ConfigureAwait(false);
        }
        finally
        {
            _downloads.TryRemove(entry.Version, out _);
        }
    }

    public async Task<OrtVersionListDto> GetVersionListAsync(CancellationToken ct = default)
    {
        await RefreshCatalogIfStaleAsync(ct).ConfigureAwait(false);

        var activeTxt = Path.Combine(OrtRoot, "active.txt");
        string? active = File.Exists(activeTxt) ? (await File.ReadAllTextAsync(activeTxt, ct)).Trim() : null;

        var versions = new List<OrtVersionDto>();
        var installedVersions = new HashSet<string>();
        if (Directory.Exists(OrtRoot))
        {
            foreach (var dir in Directory.GetDirectories(OrtRoot).OrderByDescending(d => d))
            {
                var ver = Path.GetFileName(dir);
                installedVersions.Add(ver);
                var installedAtFile = Path.Combine(dir, "installed-at.txt");
                string? installedAt = File.Exists(installedAtFile)
                    ? (await File.ReadAllTextAsync(installedAtFile, ct)).Trim()
                    : null;
                versions.Add(new OrtVersionDto
                {
                    Version = ver,
                    ReleaseDate = _catalog.FirstOrDefault(c => c.Version == ver)?.ReleaseDate,
                    IsActive = ver == active,
                    LocalDir = dir,
                    InstalledAt = installedAt,
                    Status = "installed",
                });
            }
        }

        // Surface the newest catalog version as a download candidate when not already
        // installed, so the frontend can show an "Update to vX.Y.Z" prompt (T035).
        var latestCatalog = _catalog.FirstOrDefault();
        if (latestCatalog is not null && !installedVersions.Contains(latestCatalog.Version))
        {
            versions.Add(new OrtVersionDto
            {
                Version = latestCatalog.Version,
                ReleaseDate = latestCatalog.ReleaseDate,
                IsActive = false,
                Status = "catalog",
                Assets = latestCatalog.Assets,
            });
        }

        return new OrtVersionListDto
        {
            ActiveVersion = active,
            Versions = versions,
            MaxRetainedVersions = MaxRetainedVersions,
        };
    }

    public async Task<OrtDownloadStartResult> StartDownloadAsync(string version, CancellationToken ct = default)
    {
        await RefreshCatalogIfStaleAsync(ct).ConfigureAwait(false);

        if (_downloads.ContainsKey(version))
            return OrtDownloadStartResult.InProgress;

        var entry = version == "latest" ? _catalog.FirstOrDefault() : _catalog.FirstOrDefault(c => c.Version == version);
        if (entry is null)
            return OrtDownloadStartResult.NotFound;

        if (FindLibInVersion(entry.Version) is not null)
            return OrtDownloadStartResult.AlreadyInstalled;

        var assetKey = ResolveAssetKey(await _deviceEnum.EnumerateAsync(ct).ConfigureAwait(false));
        if (!entry.Assets.TryGetValue(assetKey, out var asset))
        {
            _logger.LogWarning(
                "[OrtVersionService] No asset for key {Key} in catalog entry {Version}", assetKey, entry.Version);
            return OrtDownloadStartResult.NotFound;
        }

        var channel = Channel.CreateUnbounded<OrtDownloadProgressDto>();
        if (!_downloads.TryAdd(entry.Version, channel))
            return OrtDownloadStartResult.InProgress;

        // Fire-and-forget: survives past the HTTP request that started it, same as
        // ModelCatalogService.DownloadModelFileAsync.
        _ = Task.Run(() => DownloadOrtAssetAsync(entry.Version, assetKey, asset, channel));
        return OrtDownloadStartResult.Started;
    }

    public async IAsyncEnumerable<OrtDownloadProgressDto> GetDownloadProgressAsync(
        string version,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        if (!_downloads.TryGetValue(version, out var channel))
        {
            yield return new OrtDownloadProgressDto
            {
                Version = version,
                Percent = 0,
                Status = "error",
                Error = "No download in progress for this version",
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
            _downloads.TryRemove(version, out _);
        }
    }

    public async Task<bool> ActivateVersionAsync(string version, CancellationToken ct = default)
    {
        if (!Directory.Exists(Path.Combine(OrtRoot, version)))
            return false;

        var libPath = FindLibInVersion(version);
        if (libPath is null)
            return false;

        await File.WriteAllTextAsync(Path.Combine(OrtRoot, "active.txt"), version, ct);
        _activeOrtLibPath = libPath;
        _activeOrtAssetKey = ReadAssetKey(version);
        _logger.LogInformation("[OrtVersionService] Activated ORT version {version}", version);

        // load-dynamic fixes the ORT dylib for the daemon process's lifetime, so switching
        // versions requires a restart; EnsureStartedAsync relaunches with the new
        // ORT_DYLIB_PATH on the next stitch request.
        _frameExport?.KillDaemon();

        await EvictOldVersionsAsync(version, ct).ConfigureAwait(false);
        return true;
    }

    // ── Retention (research.md §3: keep MaxRetainedVersions, oldest non-active evicted) ──

    private Task EvictOldVersionsAsync(string activeVersion, CancellationToken ct)
    {
        if (!Directory.Exists(OrtRoot)) return Task.CompletedTask;

        var dirs = Directory.GetDirectories(OrtRoot)
            .Where(d => Path.GetFileName(d) != activeVersion)
            .Select(d => new
            {
                Dir = d,
                Version = Path.GetFileName(d),
                InstalledAt = ReadInstalledAt(d),
            })
            .OrderBy(x => x.InstalledAt)
            .ToList();

        var totalCount = dirs.Count + 1; // +1 for the active version itself
        var excess = totalCount - MaxRetainedVersions;
        if (excess <= 0) return Task.CompletedTask;

        foreach (var victim in dirs.Take(excess))
        {
            try
            {
                Directory.Delete(victim.Dir, recursive: true);
                _logger.LogInformation("[OrtVersionService] Evicted retained ORT version {Version}", victim.Version);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[OrtVersionService] Failed to evict ORT version {Version}", victim.Version);
            }
        }

        return Task.CompletedTask;
    }

    private static DateTime ReadInstalledAt(string dir)
    {
        var file = Path.Combine(dir, "installed-at.txt");
        if (File.Exists(file) && DateTime.TryParse(File.ReadAllText(file).Trim(), out var dt))
            return dt;
        return Directory.GetCreationTimeUtc(dir);
    }

    // ── Download pipeline ──────────────────────────────────────────────

    private async Task DownloadOrtAssetAsync(string version, string assetKey, OrtAssetDto asset, Channel<OrtDownloadProgressDto> channel)
    {
        var versionDir = Path.Combine(OrtRoot, version);
        var tmpArchive = Path.Combine(OrtRoot, $".{version}.download.tmp");
        const int maxAttempts = 4; // 1 initial attempt + 3 retries
        var backoff = new[] { TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(4), TimeSpan.FromSeconds(16) };
        Exception? lastError = null;

        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
        http.DefaultRequestHeaders.Add("User-Agent", "JellyfinSuite/1.0");

        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            try
            {
                using var response = await http.GetAsync(asset.Url, HttpCompletionOption.ResponseHeadersRead, CancellationToken.None)
                    .ConfigureAwait(false);

                if (!response.IsSuccessStatusCode)
                {
                    var status = (int)response.StatusCode;
                    if (status is >= 400 and < 500)
                    {
                        await FailDownloadAsync(channel, version, tmpArchive, $"HTTP {status}").ConfigureAwait(false);
                        return;
                    }
                    throw new HttpRequestException($"HTTP {status}");
                }

                var totalBytes = response.Content.Headers.ContentLength;
                await using (var src = await response.Content.ReadAsStreamAsync(CancellationToken.None).ConfigureAwait(false))
                await using (var dst = File.Create(tmpArchive))
                {
                    await CopyWithProgressAsync(channel, version, src, dst, totalBytes).ConfigureAwait(false);
                }

                if (asset.Sha256 is { Length: > 0 } expectedHash)
                {
                    var actualHash = await ComputeSha256Async(tmpArchive).ConfigureAwait(false);
                    if (!string.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException($"SHA-256 mismatch (expected {expectedHash}, got {actualHash})");
                }

                Directory.CreateDirectory(versionDir);
                await ExtractArchiveAsync(tmpArchive, asset.Url, versionDir).ConfigureAwait(false);
                await File.WriteAllTextAsync(Path.Combine(versionDir, "installed-at.txt"), DateTime.UtcNow.ToString("O"))
                    .ConfigureAwait(false);
                // Sidecar so a later ActivateVersionAsync/ExecuteAsync can recover the asset
                // variant without re-deriving it from the dylib path (T040-T041 denylist input).
                await File.WriteAllTextAsync(Path.Combine(versionDir, "asset-key.txt"), assetKey)
                    .ConfigureAwait(false);

                await channel.Writer.WriteAsync(new OrtDownloadProgressDto
                {
                    Version = version,
                    Percent = 100,
                    Status = "installed",
                }).ConfigureAwait(false);
                channel.Writer.TryComplete();

                _logger.LogInformation("[OrtVersionService] Downloaded + extracted ORT {Version}", version);
                return;
            }
            catch (Exception ex)
            {
                lastError = ex;
                _logger.LogWarning(
                    "[OrtVersionService] Download attempt {Attempt}/{Max} failed for ORT {Version}: {Msg}",
                    attempt, maxAttempts, version, ex.Message);
                try { Directory.Delete(versionDir, recursive: true); } catch { /* best effort, may not exist yet */ }

                if (attempt == maxAttempts) break;
                await Task.Delay(backoff[attempt - 1]).ConfigureAwait(false);
            }
        }

        await FailDownloadAsync(channel, version, tmpArchive, lastError?.Message ?? "Download failed").ConfigureAwait(false);
    }

    private static async Task ExtractArchiveAsync(string archivePath, string sourceUrl, string destDir)
    {
        if (sourceUrl.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            ZipFile.ExtractToDirectory(archivePath, destDir, overwriteFiles: true);
            return;
        }

        // .tgz / .tar.gz
        await using var fileStream = File.OpenRead(archivePath);
        await using var gzip = new GZipStream(fileStream, CompressionMode.Decompress);
        await TarFile.ExtractToDirectoryAsync(gzip, destDir, overwriteFiles: true).ConfigureAwait(false);
    }

    private async Task FailDownloadAsync(Channel<OrtDownloadProgressDto> channel, string version, string tmpArchive, string error)
    {
        try { if (File.Exists(tmpArchive)) File.Delete(tmpArchive); } catch { /* best effort */ }
        await channel.Writer.WriteAsync(new OrtDownloadProgressDto
        {
            Version = version,
            Percent = 0,
            Status = "error",
            Error = error,
        }).ConfigureAwait(false);
        channel.Writer.TryComplete();
        _logger.LogError("[OrtVersionService] Download failed permanently for ORT {Version}: {Error}", version, error);
    }

    private static async Task CopyWithProgressAsync(
        Channel<OrtDownloadProgressDto> channel, string version, Stream src, Stream dst, long? totalBytes)
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
                await channel.Writer.WriteAsync(new OrtDownloadProgressDto
                {
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

    // ── Asset-key resolution (T042: distinguish `gpu` (CUDA12) vs `gpu_cuda13` (CUDA13)
    //    on Linux using the compute-capability detection added in T039 — research.md §7a:
    //    CUDA12's nvcc emits no SASS/PTX for sm_120 (Blackwell, compute capability >= 12.0),
    //    so the standard `gpu` asset hangs/silently-CPU-falls-back there) ──────────────

    private static string ResolveAssetKey(List<ComputeDeviceDto> devices)
    {
        var gpu = devices.FirstOrDefault(d => d.DeviceType == "GPU" && d.IsDefault);
        if (OperatingSystem.IsLinux())
        {
            if (gpu?.Vendor != "NVIDIA")
                return "linux-x64-cpu";
            return IsBlackwellOrNewer(gpu.ComputeCapability) ? "linux-x64-gpu_cuda13" : "linux-x64-gpu";
        }
        if (OperatingSystem.IsWindows())
            return gpu is not null ? "win-x64-directml" : "win-x64-cpu";
        return "linux-x64-cpu";
    }

    /// <summary>True when compute capability is 12.0+ (Blackwell, e.g. sm_120) — see research.md §7a.</summary>
    private static bool IsBlackwellOrNewer(string? computeCapability) =>
        computeCapability is not null
        && double.TryParse(computeCapability, System.Globalization.CultureInfo.InvariantCulture, out var cc)
        && cc >= 12.0;

    private string? FindLibInVersion(string version)
    {
        var dir = Path.Combine(OrtRoot, version);
        if (!Directory.Exists(dir))
            return null;
        var candidates = new[] { "libonnxruntime.so", "onnxruntime.dll", "libonnxruntime.dylib" };
        // GitHub release tarballs nest the dylib under lib/, not the tarball root.
        return Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
            .FirstOrDefault(f => candidates.Contains(Path.GetFileName(f)));
    }

    /// <summary>Reads the `asset-key.txt` sidecar written by <see cref="DownloadOrtAssetAsync"/>
    /// at download time (e.g. "linux-x64-gpu_cuda13"). Null for versions installed before this
    /// sidecar existed — the Rust-side `gpu_compat::check` denylist treats an absent key as
    /// "no protection" rather than a false match.</summary>
    private string? ReadAssetKey(string version)
    {
        var file = Path.Combine(OrtRoot, version, "asset-key.txt");
        return File.Exists(file) ? File.ReadAllText(file).Trim() : null;
    }

    // ── Catalog fetch/cache (GitHub Releases API for PinnedOrtVersion — no project-hosted
    //    file to keep in sync; see class doc-comment) ──────────────────────────────────

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
        var url = Environment.GetEnvironmentVariable(OrtReleaseApiUrlEnvVar)?.Trim() is { Length: > 0 } envUrl
            ? envUrl
            : DefaultOrtReleaseApiUrl;

        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            http.DefaultRequestHeaders.Add("User-Agent", "JellyfinSuite/1.0");
            http.DefaultRequestHeaders.Add("Accept", "application/vnd.github+json");
            var json = await http.GetStringAsync(url, ct).ConfigureAwait(false);

            ApplyCatalogJson(json);

            Directory.CreateDirectory(OrtRoot);
            var tmp = _catalogPath + ".tmp";
            await File.WriteAllTextAsync(tmp, json, ct).ConfigureAwait(false);
            File.Move(tmp, _catalogPath, overwrite: true);
            await File.WriteAllTextAsync(
                _catalogTtlPath, DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), ct).ConfigureAwait(false);

            _catalogFetchedAt = DateTime.UtcNow;
            _logger.LogInformation(
                "[OrtVersionService] Catalog refreshed from {Url} ({Count} ORT versions)", url, _catalog.Count);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                "[OrtVersionService] Catalog fetch from {Url} failed ({Msg}) — using cached/installed-only listing",
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
            _logger.LogWarning(ex, "[OrtVersionService] Failed to load cached ORT catalog.json");
        }
    }

    // Maps a GitHub release asset's file-name stem (with the version + extension removed) to
    // the internal asset key ResolveAssetKey() produces. Only platform/EP combinations
    // frame-forge actually ships are mapped — others (win-*, osx-*, *-aarch64) fall through to
    // null and are silently dropped, same as an absent key in the old hand-authored catalog.
    private static readonly Dictionary<string, string> AssetStemToKey = new()
    {
        ["onnxruntime-linux-x64"] = "linux-x64-cpu",
        ["onnxruntime-linux-x64-gpu"] = "linux-x64-gpu",
        ["onnxruntime-linux-x64-gpu_cuda13"] = "linux-x64-gpu_cuda13",
    };

    private static string? MapAssetNameToKey(string fileName, string version) =>
        AssetStemToKey.GetValueOrDefault(
            fileName.Replace($"-{version}.tgz", "", StringComparison.Ordinal)
                .Replace($"-{version}.zip", "", StringComparison.Ordinal));

    private void ApplyCatalogJson(string json)
    {
        var release = JsonSerializer.Deserialize<GitHubReleaseDto>(json) ?? new GitHubReleaseDto();
        var version = release.TagName.TrimStart('v');
        if (version.Length == 0)
        {
            _catalog = new();
            return;
        }

        var assets = new Dictionary<string, OrtAssetDto>();
        foreach (var asset in release.Assets)
        {
            var key = MapAssetNameToKey(asset.Name, version);
            if (key is null) continue;

            var sha256 = asset.Digest is { Length: > 0 } digest && digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase)
                ? digest["sha256:".Length..]
                : asset.Digest ?? "";
            assets[key] = new OrtAssetDto { Url = asset.BrowserDownloadUrl, Sha256 = sha256, SizeBytes = asset.Size };
        }

        _catalog = new List<OrtCatalogEntry> { new(version, release.PublishedAt, assets) };
    }

    // ── GitHub Releases API DTOs (deserialization-only, not exposed via our own API) ────
    // https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name

    private sealed class GitHubReleaseDto
    {
        [JsonPropertyName("tag_name")]     public string TagName { get; set; } = "";
        [JsonPropertyName("published_at")] public string? PublishedAt { get; set; }
        [JsonPropertyName("assets")]       public List<GitHubReleaseAssetDto> Assets { get; set; } = new();
    }

    private sealed class GitHubReleaseAssetDto
    {
        [JsonPropertyName("name")]                 public string Name { get; set; } = "";
        [JsonPropertyName("browser_download_url")] public string BrowserDownloadUrl { get; set; } = "";
        [JsonPropertyName("size")]                 public long Size { get; set; }

        // GitHub computes/exposes this directly so we don't have to download multi-hundred-MB
        // archives ourselves just to verify a checksum we could otherwise just ask for.
        [JsonPropertyName("digest")]               public string? Digest { get; set; }
    }
}
