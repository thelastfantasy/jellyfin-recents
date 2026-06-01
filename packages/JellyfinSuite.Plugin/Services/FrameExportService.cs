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
    private const byte MsgPrefetchFrame = 0x13;
    private const byte MsgListCached = 0x14;
    private const byte MsgIndexFrames = 0x15;
    private const byte MsgPrefetchRange = 0x16;

    private readonly ILogger<FrameExportService> _logger;
    private readonly string _socketPath;
    private readonly string _binaryPath;

    private Process? _process;
    private readonly SemaphoreSlim _startLock = new(1, 1);

    private Socket? _socket;
    private readonly SemaphoreSlim _socketLock = new(1, 1);
    // Serialises per-request send+receive so concurrent HTTP requests don't interleave on the socket.
    private readonly SemaphoreSlim _requestLock = new(1, 1);

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

            if (File.Exists(_socketPath)) File.Delete(_socketPath);

            try { File.SetUnixFileMode(_binaryPath, UnixFileMode.UserRead | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute); }
            catch { /* non-Unix or permission denied — proceed anyway */ }

            _logger.LogInformation("[FrameExport] Starting frame-forge: {Path}", _binaryPath);

            var psi = new ProcessStartInfo("nice", $"-n 10 \"{_binaryPath}\" \"{_socketPath}\"")
            {
                UseShellExecute = false,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            psi.Environment["LD_LIBRARY_PATH"] = "/usr/lib/jellyfin-ffmpeg/lib";

            _process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            _process.Start();

            // Pipe daemon stderr to Jellyfin log
            _ = Task.Run(async () =>
            {
                string? line;
                while ((line = await _process.StandardError.ReadLineAsync(ct)) != null)
                    _logger.LogInformation("[frame-forge] {Line}", line);
            }, ct);

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

    public async Task<(byte[]? JpegData, ushort QualityFlags, long ActualPtsMs)> GetFrameAsync(
        string filePath,
        long posMs,
        int width,
        Guid itemId,
        CancellationToken ct = default)
    {
        if (!IsAvailable) return (null, 0, posMs);

        await EnsureStartedAsync(ct).ConfigureAwait(false);

        await _requestLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var sock = await GetSocketAsync(ct).ConfigureAwait(false);

            var requestId = Interlocked.Increment(ref _nextRequestId);
            var pathBytes = Encoding.UTF8.GetBytes(filePath);
            var itemIdBytes = Encoding.ASCII.GetBytes(itemId.ToString("N")); // 32 bytes

            // [1] msg_type (0x10)
            // [4] request_id (u32 LE)
            // [8] pos_ms (i64 LE)
            // [4] width (u32 LE)
            // [4] path_len (u32 LE)
            // [N] file path (UTF-8)
            // [32] item_id (ASCII hex, no dashes)
            var buf = new byte[1 + 4 + 8 + 4 + 4 + pathBytes.Length + 32];
            buf[0] = MsgSingleFrame;
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(1, 4), requestId);
            BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(5, 8), posMs);
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(13, 4), (uint)width);
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(17, 4), (uint)pathBytes.Length);
            pathBytes.CopyTo(buf.AsSpan(21));
            itemIdBytes.CopyTo(buf.AsSpan(21 + pathBytes.Length));

            try
            {
                await sock.SendAsync(buf, SocketFlags.None, ct).ConfigureAwait(false);

                // Response wire: [request_id(4)] [jpeg_len(4)] [jpeg_data(N)] [quality_flags(2)] [actual_pts_ms(8)]
                // actual_pts_ms == -1 means cache hit; fallback to posMs.
                var header = new byte[8];
                await ReceiveExactAsync(sock, header, 8, ct).ConfigureAwait(false);
                var jpegLen = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(4, 4));

                if (jpegLen == 0)
                    return (null, 0, posMs);

                var jpegData = new byte[jpegLen];
                await ReceiveExactAsync(sock, jpegData, (int)jpegLen, ct).ConfigureAwait(false);

                var flagBuf = new byte[2];
                await ReceiveExactAsync(sock, flagBuf, 2, ct).ConfigureAwait(false);
                var flags = BinaryPrimitives.ReadUInt16LittleEndian(flagBuf);

                var ptsBuf = new byte[8];
                await ReceiveExactAsync(sock, ptsBuf, 8, ct).ConfigureAwait(false);
                var actualPtsMs = BinaryPrimitives.ReadInt64LittleEndian(ptsBuf);
                if (actualPtsMs < 0) actualPtsMs = posMs; // cache hit sentinel

                return (jpegData, flags, actualPtsMs);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning("[FrameExport] socket error — resetting: {Ex}", ex.Message);
                try { _socket?.Dispose(); } catch { }
                _socket = null;
                return (null, 0, posMs);
            }
        }
        finally
        {
            _requestLock.Release();
        }
    }

    private void InvalidateSocket()
    {
        try { _socket?.Dispose(); } catch { }
        _socket = null;
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

    public async Task PrefetchFrameAsync(
        string filePath,
        long posMs,
        int width,
        Guid itemId,
        CancellationToken ct = default)
    {
        if (!IsAvailable) return;
        await EnsureStartedAsync(ct).ConfigureAwait(false);

        await _requestLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var sock = await GetSocketAsync(ct).ConfigureAwait(false);
            var requestId = Interlocked.Increment(ref _nextRequestId);
            var pathBytes = Encoding.UTF8.GetBytes(filePath);
            var itemIdBytes = Encoding.ASCII.GetBytes(itemId.ToString("N"));

            var buf = new byte[1 + 4 + 8 + 4 + 4 + pathBytes.Length + 32];
            buf[0] = MsgPrefetchFrame;
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(1, 4), requestId);
            BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(5, 8), posMs);
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(13, 4), (uint)width);
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(17, 4), (uint)pathBytes.Length);
            pathBytes.CopyTo(buf.AsSpan(21));
            itemIdBytes.CopyTo(buf.AsSpan(21 + pathBytes.Length));

            await sock.SendAsync(buf, SocketFlags.None, ct).ConfigureAwait(false);

            // ACK: [4 request_id][4 jpeg_len=0]
            var ack = new byte[8];
            await ReceiveExactAsync(sock, ack, 8, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning("[FrameExport] prefetch socket error: {Ex}", ex.Message);
            try { _socket?.Dispose(); } catch { }
            _socket = null;
        }
        finally
        {
            _requestLock.Release();
        }
    }

    public async Task PrefetchRangeAsync(
        string filePath,
        long startIdx,
        double beforeSeconds,
        double afterSeconds,
        bool includeStart,
        int width,
        Guid itemId,
        CancellationToken ct = default)
    {
        if (!IsAvailable) return;
        await EnsureStartedAsync(ct).ConfigureAwait(false);

        await _requestLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var sock = await GetSocketAsync(ct).ConfigureAwait(false);
            var pathBytes = Encoding.UTF8.GetBytes(filePath);
            var itemIdBytes = Encoding.ASCII.GetBytes(itemId.ToString("N"));

            // Wire: [msg(1)] [item_id(32)] [path_len(4)][path(N)] [start_idx(8)] [before(8)] [after(8)] [include(1)] [width(4)]
            var buf = new byte[1 + 32 + 4 + pathBytes.Length + 8 + 8 + 8 + 1 + 4];
            var pos = 0;
            buf[pos++] = MsgPrefetchRange;
            itemIdBytes.CopyTo(buf.AsSpan(pos, 32)); pos += 32;
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(pos, 4), (uint)pathBytes.Length); pos += 4;
            pathBytes.CopyTo(buf.AsSpan(pos)); pos += pathBytes.Length;
            BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(pos, 8), startIdx); pos += 8;
            BinaryPrimitives.WriteDoubleLittleEndian(buf.AsSpan(pos, 8), beforeSeconds); pos += 8;
            BinaryPrimitives.WriteDoubleLittleEndian(buf.AsSpan(pos, 8), afterSeconds); pos += 8;
            buf[pos++] = includeStart ? (byte)1 : (byte)0;
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(pos, 4), (uint)width);

            await sock.SendAsync(buf, SocketFlags.None, ct).ConfigureAwait(false);

            // ACK: [4 request_id][4 jpeg_len=0]
            var ack = new byte[8];
            await ReceiveExactAsync(sock, ack, 8, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning("[FrameExport] prefetch_range socket error: {Ex}", ex.Message);
            try { _socket?.Dispose(); } catch { }
            _socket = null;
        }
        finally
        {
            _requestLock.Release();
        }
    }

    public async Task<IReadOnlyList<long>> ListCachedAsync(
        Guid itemId,
        int width,
        CancellationToken ct = default)
    {
        if (!IsAvailable) return Array.Empty<long>();
        await EnsureStartedAsync(ct).ConfigureAwait(false);

        await _requestLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var sock = await GetSocketAsync(ct).ConfigureAwait(false);
            var requestId = Interlocked.Increment(ref _nextRequestId);
            var itemIdBytes = Encoding.ASCII.GetBytes(itemId.ToString("N")); // 32 bytes

            // [1] msg_type (0x14)
            // [4] request_id
            // [32] item_id
            // [4] width
            var buf = new byte[41];
            buf[0] = MsgListCached;
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(1), requestId);
            itemIdBytes.CopyTo(buf.AsSpan(5));
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(37), (uint)width);

            await sock.SendAsync(buf, SocketFlags.None, ct).ConfigureAwait(false);

            // Response: [4 request_id][4 count][count × 8 pos_ms]
            var header = new byte[8];
            await ReceiveExactAsync(sock, header, 8, ct).ConfigureAwait(false);
            var count = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(4));
            if (count == 0) return Array.Empty<long>();

            var body = new byte[count * 8];
            await ReceiveExactAsync(sock, body, (int)(count * 8), ct).ConfigureAwait(false);

            var result = new List<long>((int)count);
            for (var i = 0; i < (int)count; i++)
                result.Add(BinaryPrimitives.ReadInt64LittleEndian(body.AsSpan(i * 8)));
            return result;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning("[FrameExport] ListCached socket error: {Ex}", ex.Message);
            try { _socket?.Dispose(); } catch { }
            _socket = null;
            return Array.Empty<long>();
        }
        finally
        {
            _requestLock.Release();
        }
    }

    public async Task<byte[]?> SubmitAnimateTaskAsync(
        TaskState task,
        List<string> filePaths,
        List<long> frameIndices,
        string format,   // "gif" or "webp"
        string resizeMode, int targetPx, float speed, int loopCount,
        float cropX = 0f, float cropY = 0f, float cropW = 0f, float cropH = 0f,
        float quality = 0.75f,
        CancellationToken ct = default)
    {
        if (!IsAvailable) return null;
        await EnsureStartedAsync(ct).ConfigureAwait(false);
        var sock = await GetSocketAsync(ct).ConfigureAwait(false);

        var taskIdBytes = Encoding.UTF8.GetBytes(task.TaskId);
        var frameCount = filePaths.Count;

        // Build ANIMATE (0x11) request
        using var ms = new MemoryStream();
        ms.WriteByte(0x11); // msg_type
        ms.Write(BitConverter.GetBytes((uint)taskIdBytes.Length), 0, 4);
        ms.Write(taskIdBytes, 0, taskIdBytes.Length);
        ms.Write(BitConverter.GetBytes((uint)frameCount), 0, 4);

        for (int i = 0; i < frameCount; i++)
        {
            ms.Write(BitConverter.GetBytes(frameIndices[i]), 0, 8);
            var pathBytes = Encoding.UTF8.GetBytes(filePaths[i]);
            ms.Write(BitConverter.GetBytes((uint)pathBytes.Length), 0, 4);
            ms.Write(pathBytes, 0, pathBytes.Length);
        }

        ushort fmtVal = format == "webp" ? (ushort)0x02 : (ushort)0x01;
        ushort modeVal = resizeMode == "height" ? (ushort)0x02 : (ushort)0x01;
        ms.Write(BitConverter.GetBytes(fmtVal), 0, 2);
        ms.Write(BitConverter.GetBytes(modeVal), 0, 2);
        ms.Write(BitConverter.GetBytes((uint)targetPx), 0, 4);
        ms.Write(BitConverter.GetBytes(speed), 0, 4);
        ms.Write(BitConverter.GetBytes((ushort)loopCount), 0, 2);
        ms.Write(BitConverter.GetBytes(cropX), 0, 4);
        ms.Write(BitConverter.GetBytes(cropY), 0, 4);
        ms.Write(BitConverter.GetBytes(cropW), 0, 4);
        ms.Write(BitConverter.GetBytes(cropH), 0, 4);
        ms.Write(BitConverter.GetBytes(quality), 0, 4);

        var reqBuf = ms.ToArray();
        try
        {
            await sock.SendAsync(reqBuf, SocketFlags.None, ct).ConfigureAwait(false);

            // Read progress events + final output
            var header = new byte[8];
            bool done = false;

            while (!done && !ct.IsCancellationRequested)
            {
                await ReceiveExactAsync(sock, header, 4, ct).ConfigureAwait(false);
                var statusCode = BitConverter.ToUInt32(header, 0);
                if (statusCode != 2)
                {
                    // Progress event: read json length + json
                    await ReceiveExactAsync(sock, header, 4, ct).ConfigureAwait(false);
                    var jsonLen = (int)BitConverter.ToUInt32(header, 0);
                    var jsonBuf = new byte[jsonLen];
                    await ReceiveExactAsync(sock, jsonBuf, jsonLen, ct).ConfigureAwait(false);
                    var json = Encoding.UTF8.GetString(jsonBuf);

                    // Parse and forward to task progress channel
                    try
                    {
                        var prog = System.Text.Json.JsonSerializer.Deserialize<TaskProgress>(json);
                        if (prog != null)
                        {
                            prog.TaskId = task.TaskId;
                            task.ProgressChannel.Writer.TryWrite(prog);
                            if (prog.Status == "error")
                            {
                                task.Status = TaskStatus.Error;
                                task.Error = prog.Error;
                                task.ProgressChannel.Writer.TryComplete();
                                return null;
                            }
                        }
                    }
                    catch { /* skip malformed progress */ }

                    if (statusCode == 1) // error
                    {
                        task.Status = TaskStatus.Error;
                        task.Error = json;
                        task.ProgressChannel.Writer.TryComplete();
                        return null;
                    }
                }
                else
                {
                    // Final output: read data_len + data
                    await ReceiveExactAsync(sock, header, 4, ct).ConfigureAwait(false);
                    var dataLen = (int)BitConverter.ToUInt32(header, 0);
                    var dataBuf = new byte[dataLen];
                    await ReceiveExactAsync(sock, dataBuf, dataLen, ct).ConfigureAwait(false);
                    done = true;
                    return dataBuf;
                }
            }
        }
        catch (OperationCanceledException)
        {
            InvalidateSocket();
            throw;
        }
        return null;
    }

    public async Task<byte[]?> SubmitStitchTaskAsync(
        TaskState task,
        List<string> filePaths,
        List<long> positionsMs,
        string format,   // "png" or "webp"
        float quality = 0.75f,
        CancellationToken ct = default)
    {
        if (!IsAvailable) return null;
        await EnsureStartedAsync(ct).ConfigureAwait(false);
        var sock = await GetSocketAsync(ct).ConfigureAwait(false);

        var taskIdBytes = Encoding.UTF8.GetBytes(task.TaskId);
        var frameCount = filePaths.Count;

        using var ms = new MemoryStream();
        ms.WriteByte(0x12); // MSG_STITCH
        ms.Write(BitConverter.GetBytes((uint)taskIdBytes.Length), 0, 4);
        ms.Write(taskIdBytes, 0, taskIdBytes.Length);
        ms.Write(BitConverter.GetBytes((uint)frameCount), 0, 4);

        for (int i = 0; i < frameCount; i++)
        {
            ms.Write(BitConverter.GetBytes(positionsMs[i]), 0, 8);
            var pathBytes = Encoding.UTF8.GetBytes(filePaths[i]);
            ms.Write(BitConverter.GetBytes((uint)pathBytes.Length), 0, 4);
            ms.Write(pathBytes, 0, pathBytes.Length);
        }

        ushort fmtVal = format == "webp" ? (ushort)0x02 : (ushort)0x01;
        ms.Write(BitConverter.GetBytes(fmtVal), 0, 2);          // format
        ms.Write(BitConverter.GetBytes((ushort)0x01), 0, 2);    // resize_mode (unused for stitch)
        ms.Write(BitConverter.GetBytes((uint)0), 0, 4);         // target_px = 0
        ms.Write(BitConverter.GetBytes(1.0f), 0, 4);            // speed = 1.0 (f32, unused for stitch)
        ms.Write(BitConverter.GetBytes((ushort)0), 0, 2);       // loop_count = 0
        ms.Write(BitConverter.GetBytes(0f), 0, 4);              // crop_x = 0
        ms.Write(BitConverter.GetBytes(0f), 0, 4);              // crop_y = 0
        ms.Write(BitConverter.GetBytes(0f), 0, 4);              // crop_w = 0 (disabled)
        ms.Write(BitConverter.GetBytes(0f), 0, 4);              // crop_h = 0
        ms.Write(BitConverter.GetBytes(quality), 0, 4);         // quality

        var reqBuf = ms.ToArray();
        try
        {
            await sock.SendAsync(reqBuf, SocketFlags.None, ct).ConfigureAwait(false);

            // Read progress events + final output (same pattern as animate)
            var header = new byte[8];
            bool done = false;

            while (!done && !ct.IsCancellationRequested)
            {
                await ReceiveExactAsync(sock, header, 4, ct).ConfigureAwait(false);
                var statusCode = BitConverter.ToUInt32(header, 0);
                if (statusCode != 2)
                {
                    await ReceiveExactAsync(sock, header, 4, ct).ConfigureAwait(false);
                    var jsonLen = (int)BitConverter.ToUInt32(header, 0);
                    var jsonBuf = new byte[jsonLen];
                    await ReceiveExactAsync(sock, jsonBuf, jsonLen, ct).ConfigureAwait(false);
                    var json = Encoding.UTF8.GetString(jsonBuf);
                    try
                    {
                        var prog = System.Text.Json.JsonSerializer.Deserialize<TaskProgress>(json);
                        if (prog != null)
                        {
                            prog.TaskId = task.TaskId;
                            task.ProgressChannel.Writer.TryWrite(prog);
                            if (prog.Status == "error")
                            {
                                task.Status = TaskStatus.Error;
                                task.Error = prog.Error;
                                task.ProgressChannel.Writer.TryComplete();
                                return null;
                            }
                        }
                    }
                    catch { }
                    if (statusCode == 1) { task.Status = TaskStatus.Error; task.ProgressChannel.Writer.TryComplete(); return null; }
                }
                else
                {
                    await ReceiveExactAsync(sock, header, 4, ct).ConfigureAwait(false);
                    var dataLen = (int)BitConverter.ToUInt32(header, 0);
                    var dataBuf = new byte[dataLen];
                    await ReceiveExactAsync(sock, dataBuf, dataLen, ct).ConfigureAwait(false);
                    done = true;
                    return dataBuf;
                }
            }
        }
        catch (OperationCanceledException)
        {
            InvalidateSocket();
            throw;
        }
        return null;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _socket?.Dispose();
        _startLock.Dispose();
        _socketLock.Dispose();
        _requestLock.Dispose();

        if (_process is { HasExited: false })
        {
            _process.Kill();
            _process.WaitForExit(3000);
            _process.Dispose();
        }
    }
}
