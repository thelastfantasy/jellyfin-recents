using Jellyfin.Plugin.JellyfinSuite.Models;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

/// <summary>
/// Manages ORT runtime versions under /config/plugins/JellyfinSuite/ort/.
/// Bootstraps on startup by scanning for an active version.
/// Full download/bootstrap implementation in T033.
/// </summary>
public sealed class OrtVersionService : BackgroundService
{
    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<OrtVersionService> _logger;
    private string? _activeOrtLibPath;
    private const int MaxRetainedVersions = 2;

    public OrtVersionService(IApplicationPaths appPaths, ILogger<OrtVersionService> logger)
    {
        _appPaths = appPaths;
        _logger = logger;
    }

    /// <summary>Absolute path to the active ORT dylib, or null if none installed.</summary>
    public string? ActiveOrtLibPath => _activeOrtLibPath;

    private string OrtRoot => Path.Combine(_appPaths.PluginsPath, "JellyfinSuite", "ort");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Directory.CreateDirectory(OrtRoot);

        var activeTxt = Path.Combine(OrtRoot, "active.txt");
        if (File.Exists(activeTxt))
        {
            var version = (await File.ReadAllTextAsync(activeTxt, stoppingToken)).Trim();
            _activeOrtLibPath = FindLibInVersion(version);
            if (_activeOrtLibPath is not null)
            {
                _logger.LogInformation("[OrtVersionService] Active ORT: {version} → {path}", version, _activeOrtLibPath);
                return;
            }
        }

        _logger.LogInformation("[OrtVersionService] No ORT version installed. GPU-accelerated stitch will fall back to CPU.");
    }

    public async Task<OrtVersionListDto> GetVersionListAsync(CancellationToken ct = default)
    {
        var activeTxt = Path.Combine(OrtRoot, "active.txt");
        string? active = File.Exists(activeTxt) ? (await File.ReadAllTextAsync(activeTxt, ct)).Trim() : null;

        var versions = new List<OrtVersionDto>();
        if (Directory.Exists(OrtRoot))
        {
            foreach (var dir in Directory.GetDirectories(OrtRoot).OrderByDescending(d => d))
            {
                var ver = Path.GetFileName(dir);
                var installedAtFile = Path.Combine(dir, "installed-at.txt");
                string? installedAt = File.Exists(installedAtFile)
                    ? (await File.ReadAllTextAsync(installedAtFile, ct)).Trim()
                    : null;
                versions.Add(new OrtVersionDto
                {
                    Version = ver,
                    IsActive = ver == active,
                    LocalDir = dir,
                    InstalledAt = installedAt,
                });
            }
        }

        return new OrtVersionListDto
        {
            ActiveVersion = active,
            Versions = versions,
            MaxRetainedVersions = MaxRetainedVersions,
        };
    }

    public Task<OrtDownloadStartResult> StartDownloadAsync(string version, CancellationToken ct = default)
    {
        _logger.LogWarning("[OrtVersionService] StartDownloadAsync not yet implemented (T033)");
        return Task.FromResult(OrtDownloadStartResult.NotFound);
    }

    public async IAsyncEnumerable<OrtDownloadProgressDto> GetDownloadProgressAsync(
        string version,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        await Task.Delay(100, ct);
        yield return new OrtDownloadProgressDto { Version = version, Percent = 0, Status = "error", Error = "Not implemented" };
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
        _logger.LogInformation("[OrtVersionService] Activated ORT version {version}", version);
        return true;
    }

    private string? FindLibInVersion(string version)
    {
        var dir = Path.Combine(OrtRoot, version);
        if (!Directory.Exists(dir))
            return null;
        var candidates = new[] { "libonnxruntime.so", "onnxruntime.dll", "libonnxruntime.dylib" };
        return candidates.Select(n => Path.Combine(dir, n)).FirstOrDefault(File.Exists);
    }
}
