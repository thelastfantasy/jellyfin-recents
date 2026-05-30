using System.Buffers.Binary;
using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

/// <summary>
/// Manages the seek-preview Rust daemon and provides FETCH/PREFETCH frame requests.
/// Maintains two separate Unix socket connections so PREFETCH never blocks FETCH.
/// </summary>
public sealed class SeekPreviewService : IDisposable
{
    private const string BinaryName = "seek-preview-linux-x64";

    /// <summary>Disk cache root written by the Rust daemon. C# polls this for SSE readiness.</summary>
    public static string CacheDirectory => Path.Combine(Path.GetTempPath(), "seek-preview");

    private readonly ILogger<SeekPreviewService> _logger;

    private readonly string _socketPath;
    private readonly string _binaryPath;

    private Process? _process;

    // Guards EnsureStartedAsync against concurrent daemon launches
    private readonly SemaphoreSlim _startLock = new(1, 1);

    // FETCH connection: one request at a time, protected by semaphore
    private Socket? _fetchSocket;
    private readonly SemaphoreSlim _fetchLock = new(1, 1);

    // PREFETCH connection: fire-and-forget, no synchronization needed
    private Socket? _prefetchSocket;
    private readonly SemaphoreSlim _prefetchConnLock = new(1, 1);

    private uint _nextRequestId;
    private bool _disposed;

    public SeekPreviewService(IApplicationPaths appPaths, ILogger<SeekPreviewService> logger)
    {
        _logger = logger;
        _socketPath = Path.Combine(appPaths.DataPath, "jfs-seek-preview.sock");
        var dir = Path.GetDirectoryName(typeof(SeekPreviewService).Assembly.Location)!;
        _binaryPath = Path.Combine(dir, BinaryName);
    }

    public bool IsAvailable => RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
                               && File.Exists(_binaryPath);

    public async Task EnsureStartedAsync(CancellationToken ct = default)
    {
        if (!IsAvailable) return;
        // Fast path: daemon running AND both sockets healthy.
        if (_process is { HasExited: false } && _fetchSocket != null && _prefetchSocket != null) return;

        await _startLock.WaitAsync(ct);
        try
        {
            if (_process is { HasExited: false })
            {
                // Daemon is still running but one or both sockets were reset after an error.
                // Reconnect them without restarting the daemon.
                if (_fetchSocket == null)
                    _fetchSocket = await ConnectUnixSocketAsync(ct);
                if (_prefetchSocket == null)
                    _prefetchSocket = await ConnectUnixSocketAsync(ct);
                return;
            }
            if (File.Exists(_socketPath))
                File.Delete(_socketPath);

            try { File.SetUnixFileMode(_binaryPath, UnixFileMode.UserRead | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute); }
            catch { /* non-Unix or permission denied — proceed anyway */ }

            var psi = new System.Diagnostics.ProcessStartInfo("nice", $"-n 10 \"{_binaryPath}\" \"{_socketPath}\"")
            {
                UseShellExecute = false,
                RedirectStandardError = true,
            };

            psi.Environment["LD_LIBRARY_PATH"] = "/usr/lib/jellyfin-ffmpeg/lib";

            _process = System.Diagnostics.Process.Start(psi);
            if (_process == null)
            {
                _logger.LogWarning("[SeekPreview] Failed to start seek-preview daemon");
                return;
            }

            _ = Task.Run(async () =>
            {
                string? line;
                while ((line = await _process.StandardError.ReadLineAsync()) != null)
                    _logger.LogInformation("{Line}", line);
            }, ct);

            for (var i = 0; i < 50 && !File.Exists(_socketPath); i++)
                await Task.Delay(100, ct);

            if (!File.Exists(_socketPath))
            {
                _logger.LogWarning("[SeekPreview] Daemon started but socket not created");
                return;
            }

            _fetchSocket = await ConnectUnixSocketAsync(ct);
            _prefetchSocket = await ConnectUnixSocketAsync(ct);

            _logger.LogInformation("[SeekPreview] Daemon ready at {Path}", _socketPath);

            _ = Task.Run(async () =>
            {
                await _process.WaitForExitAsync(CancellationToken.None);
                _logger.LogWarning("[SeekPreview] Daemon exited — restarting in 3s");
                await Task.Delay(3000, CancellationToken.None);
                await EnsureStartedAsync(CancellationToken.None);
            }, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[SeekPreview] Failed to start daemon");
        }
        finally
        {
            _startLock.Release();
        }
    }

    private async Task<Socket> ConnectUnixSocketAsync(CancellationToken ct)
    {
        var sock = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        var ep = new UnixDomainSocketEndPoint(_socketPath);
        await sock.ConnectAsync(ep, ct);
        return sock;
    }

    /// <summary>Fetches a JPEG frame for the given item at pos_ms. Returns null on failure.</summary>
    public async Task<byte[]?> FetchAsync(
        string filePath, long posMs, int width, Guid itemId, CancellationToken ct = default)
    {
        if (_fetchSocket == null) return null;

        await _fetchLock.WaitAsync(ct);
        try
        {
            var id = Interlocked.Increment(ref _nextRequestId);
            await SendRequestAsync(_fetchSocket, 0x01, id, posMs, width, filePath, itemId, ct);
            return await ReceiveResponseAsync(_fetchSocket, id, ct);
        }
        catch (Exception ex)
        {
            // If the request was cancelled after the Rust daemon already processed it and sent a
            // response, that response is now stuck in the socket buffer. The next call would read
            // the wrong frame. Dispose and null the socket so EnsureStartedAsync reconnects fresh.
            try { _fetchSocket?.Dispose(); } catch { }
            _fetchSocket = null;

            if (ex is OperationCanceledException) throw;
            _logger.LogDebug(ex, "[SeekPreview] FetchAsync error — socket reset");
            return null;
        }
        finally
        {
            _fetchLock.Release();
        }
    }

    /// <summary>
    /// Sends a prefetch request and awaits ACK (which arrives after Rust finishes decoding and writing to disk).
    /// Returns true on success.
    /// </summary>
    public Task<bool> PrefetchAsync(string filePath, long posMs, int width, Guid itemId, CancellationToken ct = default)
    {
        if (_prefetchSocket == null) return Task.FromResult(false);

        return Task.Run(async () =>
        {
            await _prefetchConnLock.WaitAsync(ct);
            try
            {
                var id = Interlocked.Increment(ref _nextRequestId);
                // Longer timeout: Rust now decodes synchronously before ACKing
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(TimeSpan.FromSeconds(30));
                await SendRequestAsync(_prefetchSocket, 0x02, id, posMs, width, filePath, itemId, cts.Token);
                var buf = new byte[8];
                return await ReceiveBytesAsync(_prefetchSocket, buf, cts.Token);
            }
            catch
            {
                try { _prefetchSocket?.Dispose(); } catch { }
                _prefetchSocket = null;
                return false;
            }
            finally
            {
                _prefetchConnLock.Release();
            }
        }, ct);
    }

    /// <summary>
    /// Queries the Rust daemon for all cached pos_ms values for the given item and width.
    /// Uses the FETCH socket so it can be called even without a prefetch socket.
    /// </summary>
    public async Task<IReadOnlyList<long>> ListCachedAsync(
        Guid itemId, int width = 320, CancellationToken ct = default)
    {
        if (_fetchSocket == null) return Array.Empty<long>();

        await _fetchLock.WaitAsync(ct);
        try
        {
            var id = Interlocked.Increment(ref _nextRequestId);
            var itemIdBytes = System.Text.Encoding.ASCII.GetBytes(itemId.ToString("N")); // 32 bytes

            // priority(1) + request_id(4) + item_id(32) + width(4)
            var buf = new byte[41];
            buf[0] = 0x03; // PRIORITY_LIST
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(1), id);
            itemIdBytes.CopyTo(buf, 5);
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(37), (uint)width);

            await _fetchSocket.SendAsync(buf, System.Net.Sockets.SocketFlags.None, ct);

            // Response: [4 request_id][4 count][count × 8 pos_ms]
            var header = new byte[8];
            if (!await ReceiveBytesAsync(_fetchSocket, header, ct)) return Array.Empty<long>();

            var count = System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(4));
            if (count == 0) return Array.Empty<long>();

            var body = new byte[count * 8];
            if (!await ReceiveBytesAsync(_fetchSocket, body, ct)) return Array.Empty<long>();

            var result = new List<long>((int)count);
            for (var i = 0; i < (int)count; i++)
                result.Add(System.Buffers.Binary.BinaryPrimitives.ReadInt64LittleEndian(body.AsSpan(i * 8)));
            return result;
        }
        catch (Exception ex)
        {
            try { _fetchSocket?.Dispose(); } catch { }
            _fetchSocket = null;
            if (ex is OperationCanceledException) throw;
            return Array.Empty<long>();
        }
        finally
        {
            _fetchLock.Release();
        }
    }

    private static async Task SendRequestAsync(
        Socket sock,
        byte priority, uint requestId, long posMs, int width,
        string filePath, Guid itemId, CancellationToken ct)
    {
        var pathBytes = System.Text.Encoding.UTF8.GetBytes(filePath);
        var itemIdBytes = System.Text.Encoding.ASCII.GetBytes(itemId.ToString("N")); // always 32 bytes
        // 1 + 4 + 8 + 4 + 4 + N + 32
        var buf = new byte[21 + pathBytes.Length + 32];
        buf[0] = priority;
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(1), requestId);
        BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(5), posMs);
        BinaryPrimitives.WriteInt32LittleEndian(buf.AsSpan(13), width);
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(17), (uint)pathBytes.Length);
        pathBytes.CopyTo(buf, 21);
        itemIdBytes.CopyTo(buf, 21 + pathBytes.Length);
        await sock.SendAsync(buf, SocketFlags.None, ct);
    }

    private static async Task<byte[]?> ReceiveResponseAsync(Socket sock, uint expectedId, CancellationToken ct)
    {
        var header = new byte[8];
        if (!await ReceiveBytesAsync(sock, header, ct)) return null;

        var responseId = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (responseId != expectedId)
            throw new InvalidOperationException(
                $"[SeekPreview] socket desync: expected request_id={expectedId}, got={responseId} — socket reset");

        var jpegLen = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(4));
        if (jpegLen == 0) return null;

        var jpeg = new byte[jpegLen];
        if (!await ReceiveBytesAsync(sock, jpeg, ct)) return null;
        return jpeg;
    }

    private static async Task<bool> ReceiveBytesAsync(Socket sock, byte[] buf, CancellationToken ct)
    {
        var offset = 0;
        while (offset < buf.Length)
        {
            var read = await sock.ReceiveAsync(buf.AsMemory(offset), SocketFlags.None, ct);
            if (read == 0) return false;
            offset += read;
        }
        return true;
    }

    /// <summary>
    /// Sends FRAME_INFO (0x04) to the Rust daemon: decodes the frame at posMs and returns
    /// the accurate frame index and frame-start timestamp computed from actual decoded pts + fps.
    /// Returns null if the daemon is unavailable or decode fails.
    /// </summary>
    public async Task<(long FrameIdx, long FrameStartMs)?> FrameInfoAsync(
        string filePath, long posMs, Guid itemId, CancellationToken ct = default)
    {
        if (_fetchSocket == null) return null;

        await _fetchLock.WaitAsync(ct);
        try
        {
            var id = Interlocked.Increment(ref _nextRequestId);
            // Use the same width as seek-preview batch cache (320) so Rust can serve from RAM cache.
            await SendRequestAsync(_fetchSocket, 0x04, id, posMs, 320, filePath, itemId, ct);

            // Response: [request_id(4)][actual_pts_ms(8)][fps_num(8)][fps_den(8)]
            var buf = new byte[28];
            if (!await ReceiveBytesAsync(_fetchSocket, buf, ct)) return null;

            var responseId = BinaryPrimitives.ReadUInt32LittleEndian(buf);
            if (responseId != id)
                throw new InvalidOperationException(
                    $"[SeekPreview] FrameInfo socket desync: expected {id}, got {responseId}");

            var actualPtsMs = BinaryPrimitives.ReadInt64LittleEndian(buf.AsSpan(4));
            var fpsNum      = BinaryPrimitives.ReadInt64LittleEndian(buf.AsSpan(12));
            var fpsDen      = BinaryPrimitives.ReadInt64LittleEndian(buf.AsSpan(20));

            if (actualPtsMs < 0 || fpsNum <= 0 || fpsDen <= 0) return null;

            var frameIdx    = (actualPtsMs * fpsNum + fpsDen * 500) / (fpsDen * 1000);
            var frameStartMs = frameIdx * fpsDen * 1000 / fpsNum;
            return (frameIdx, frameStartMs);
        }
        catch (Exception ex)
        {
            try { _fetchSocket?.Dispose(); } catch { }
            _fetchSocket = null;
            if (ex is OperationCanceledException) throw;
            _logger.LogDebug(ex, "[SeekPreview] FrameInfoAsync error — socket reset");
            return null;
        }
        finally
        {
            _fetchLock.Release();
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        try { _fetchSocket?.Dispose(); } catch { }
        try { _prefetchSocket?.Dispose(); } catch { }
        _startLock.Dispose();
        _fetchLock.Dispose();
        _prefetchConnLock.Dispose();

        try
        {
            if (_process is { HasExited: false })
            {
                _process.Kill();
                _process.Dispose();
            }
        }
        catch { }
    }
}
