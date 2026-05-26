using System.Buffers.Binary;
using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

public sealed class FrameExportService : IDisposable
{
    private const string BinaryName = "frame-forge-linux-x64";
    private const byte MsgSingleFrame = 0x10;

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
        if (!IsAvailable) return;

        await _startLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_process is { HasExited: false })
                return;

            _logger.LogInformation("[FrameExport] Starting frame-forge: {Path}", _binaryPath);
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
                _logger.LogWarning("[FrameExport] frame-forge exited unexpectedly");
                _ = Task.Run(async () =>
                {
                    await Task.Delay(3000);
                    await EnsureStartedAsync(CancellationToken.None);
                });
            };
            _process.Start();

            // Wait briefly for socket to appear
            for (int i = 0; i < 20 && !File.Exists(_socketPath); i++)
                await Task.Delay(100, ct).ConfigureAwait(false);
        }
        finally
        {
            _startLock.Release();
        }
    }

    private async Task<Socket> GetSocketAsync(CancellationToken ct)
    {
        await _socketLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_socket?.Connected == true)
                return _socket;

            _socket?.Dispose();
            _socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            await _socket.ConnectAsync(new UnixDomainSocketEndPoint(_socketPath), ct).ConfigureAwait(false);
            return _socket;
        }
        finally
        {
            _socketLock.Release();
        }
    }

    public async Task<(byte[]? JpegData, ushort QualityFlags)> GetFrameAsync(
        string filePath,
        long posMs,
        int width,
        Guid itemId,
        CancellationToken ct = default)
    {
        if (!IsAvailable) return (null, 0);

        await EnsureStartedAsync(ct).ConfigureAwait(false);
        var sock = await GetSocketAsync(ct).ConfigureAwait(false);

        var requestId = Interlocked.Increment(ref _nextRequestId);
        var pathBytes = Encoding.UTF8.GetBytes(filePath);

        // Build request frame:
        // [1] msg_type (0x10)
        // [4] request_id (u32 LE)
        // [8] pos_ms (i64 LE)
        // [4] width (u32 LE)
        // [4] path_len (u32 LE)
        // [N] file path (UTF-8)
        var buf = new byte[1 + 4 + 8 + 4 + 4 + pathBytes.Length];
        buf[0] = MsgSingleFrame;
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(1, 4), requestId);
        BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(5, 8), posMs);
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(13, 4), (uint)width);
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(17, 4), (uint)pathBytes.Length);
        pathBytes.CopyTo(buf.AsSpan(21));

        await sock.SendAsync(buf, SocketFlags.None, ct).ConfigureAwait(false);

        // Read response:
        // [4] request_id (u32 LE)
        // [4] jpeg_len (u32 LE)
        // [N] JPEG bytes
        // [2] quality_flags (u16 LE)
        var header = new byte[8];
        await ReceiveExactAsync(sock, header, 8, ct).ConfigureAwait(false);
        var respId = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(0, 4));
        var jpegLen = (int)BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(4, 8));

        if (jpegLen == 0)
            return (null, 0);

        var jpegData = new byte[jpegLen];
        await ReceiveExactAsync(sock, jpegData, jpegLen, ct).ConfigureAwait(false);

        var flagBuf = new byte[2];
        await ReceiveExactAsync(sock, flagBuf, 2, ct).ConfigureAwait(false);
        var flags = BinaryPrimitives.ReadUInt16LittleEndian(flagBuf);

        _logger.LogInformation(
            "[FrameExport] {Path} @{PosMs}ms → {Size}B flags=0x{Flags:X4}",
            Path.GetFileName(filePath), posMs, jpegLen, flags);

        return (jpegData, flags);
    }

    private static async Task ReceiveExactAsync(Socket sock, byte[] buffer, int count, CancellationToken ct)
    {
        int received = 0;
        while (received < count)
        {
            var n = await sock.ReceiveAsync(buffer.AsMemory(received, count - received), SocketFlags.None, ct).ConfigureAwait(false);
            if (n == 0)
                throw new IOException("Socket closed before receiving expected data");
            received += n;
        }
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
