using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

/// <summary>
/// Manages the frame-forge Rust daemon and provides frame decode / animation / stitch requests.
/// </summary>
public sealed class FrameExportService : IDisposable
{
    private const string BinaryName = "frame-forge-linux-x64";

    private readonly ILogger<FrameExportService> _logger;
    private readonly string _socketPath;
    private readonly string _binaryPath;

    private Process? _process;
    private readonly SemaphoreSlim _startLock = new(1, 1);

    private Socket? _socket;
    private readonly SemaphoreSlim _socketLock = new(1, 1);

    private uint _nextRequestId;
    private bool _disposed;

    public bool IsAvailable =>
        !RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
        && File.Exists(_binaryPath);

    public FrameExportService(
        IApplicationPaths appPaths,
        ILogger<FrameExportService> logger)
    {
        _logger = logger;
        _socketPath = Path.Combine(appPaths.DataPath, "jfs-frame-forge.sock");
        _binaryPath = Path.Combine(appPaths.PluginsPath, "JellyfinSuite", BinaryName);
    }

    public async Task EnsureStartedAsync(CancellationToken ct = default)
    {
        if (!IsAvailable)
        {
            _logger.LogInformation("[FrameExport] frame-forge not available on this platform");
            return;
        }

        await _startLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_process is { HasExited: false })
                return;

            _logger.LogInformation("[FrameExport] Starting frame-forge daemon: {Path}", _binaryPath);
            _process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = _binaryPath,
                    Arguments = _socketPath,
                    UseShellExecute = false,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                },
                EnableRaisingEvents = true,
            };
            _process.Exited += (_, _) =>
            {
                _logger.LogWarning("[FrameExport] frame-forge daemon exited unexpectedly");
                Task.Run(async () =>
                {
                    await Task.Delay(3000);
                    await EnsureStartedAsync(CancellationToken.None);
                });
            };
            _process.Start();
        }
        finally
        {
            _startLock.Release();
        }
    }

    public async Task<byte[]?> GetFrameAsync(
        string filePath,
        long posMs,
        int width,
        Guid itemId,
        CancellationToken ct = default)
    {
        if (!IsAvailable)
            return null;

        await EnsureStartedAsync(ct).ConfigureAwait(false);
        // TODO: Phase 2 T018-T019 — binary protocol frame send/receive
        return null;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _socket?.Dispose();
        _startLock.Dispose();
        _socketLock.Dispose();

        if (_process is { HasExited: false })
        {
            _process.Kill();
            _process.WaitForExit(3000);
            _process.Dispose();
        }
    }
}
