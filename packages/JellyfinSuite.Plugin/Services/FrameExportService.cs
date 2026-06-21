using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Linq;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using Jellyfin.Plugin.JellyfinSuite.Models;
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
    private const byte MsgPrefetchStream = 0x18;
    private const byte MsgPrefetchRangeStream = 0x19;
    private const byte MsgDebugDump          = 0x1A;
    private const byte MsgUpscale             = 0x1B;
    private const byte MsgCancelUpscale      = 0x1C;

    private readonly ILogger<FrameExportService> _logger;
    private readonly string _socketPath;
    private readonly string _binaryPath;
    private OrtVersionService? _ortVersion;
    private DeviceEnumerationService? _deviceEnum;
    private ModelCatalogService? _modelCatalog;
    private CudaRuntimeAcquisitionService? _cudaRuntime;

    private Process? _process;
    private readonly SemaphoreSlim _startLock = new(1, 1);

    private Socket? _socket;
    private readonly SemaphoreSlim _socketLock = new(1, 1);
    // Serialises per-request send+receive so concurrent HTTP requests don't interleave on the socket.
    private readonly SemaphoreSlim _requestLock = new(1, 1);

    private uint _nextRequestId;
    private bool _disposed;

    // Frame path index: populated by PrefetchRangeStreamAsync when Rust reports cached file paths.
    // Key: (itemId, fi_idx) → (thumbPath, origPath) — avoids glob matching in TryGetCachedWebP.
    private static readonly ConcurrentDictionary<(Guid, long), (string ThumbPath, string OrigPath)> _framePathIndex = new();

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

    /// <summary>
    /// Wire in optional services after construction (avoids circular DI).
    /// Called from <see cref="PluginServiceRegistrator"/> after both services are registered.
    /// </summary>
    public void SetAuxServices(
        OrtVersionService ortVersion,
        DeviceEnumerationService deviceEnum,
        ModelCatalogService modelCatalog,
        CudaRuntimeAcquisitionService cudaRuntime)
    {
        _ortVersion = ortVersion;
        _deviceEnum = deviceEnum;
        _modelCatalog = modelCatalog;
        _cudaRuntime = cudaRuntime;
    }

    public async Task EnsureStartedAsync(CancellationToken ct = default)
    {
        if (!IsAvailable) return;

        await _startLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _process?.Refresh();
            if (_process is { HasExited: false })
                return;

            InvalidateSocket();
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
            // CudaRuntimeAcquisitionService's lib dir may not exist yet (still downloading, or no
            // NVIDIA GPU) — appending a non-existent path is harmless, the dynamic linker just
            // skips it; it becomes load-bearing the moment the background bootstrap finishes,
            // with no restart needed beyond the one EnsureStartedAsync already does after it.
            var ldLibraryPath = "/usr/lib/jellyfin-ffmpeg/lib";
            if (_cudaRuntime?.ActiveLibDir is { Length: > 0 } cudaLibDir)
                ldLibraryPath = $"{cudaLibDir}:{ldLibraryPath}";
            psi.Environment["LD_LIBRARY_PATH"] = ldLibraryPath;
            psi.Environment["RUST_LOG"] = Environment.GetEnvironmentVariable("RUST_LOG") ?? "frame_forge=debug";
            // ORT_DYLIB_PATH tells the `load-dynamic` ort build which ORT shared library to load.
            // OrtVersionService sets this after scanning/downloading the active ORT version.
            var ortLibPath = _ortVersion?.ActiveOrtLibPath;
            if (!string.IsNullOrEmpty(ortLibPath))
                psi.Environment["ORT_DYLIB_PATH"] = ortLibPath;
            // FRAME_FORGE_ORT_ASSET_KEY lets the daemon check the gpu-compat denylist
            // (T040-T041) against the asset variant actually active — the ORT_DYLIB_PATH
            // string alone carries no such signal (research.md §7a).
            var ortAssetKey = _ortVersion?.ActiveOrtAssetKey;
            if (!string.IsNullOrEmpty(ortAssetKey))
                psi.Environment["FRAME_FORGE_ORT_ASSET_KEY"] = ortAssetKey;

            _process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            _process.Start();

            // Pipe daemon stderr to Jellyfin log for the lifetime of the daemon process — must NOT
            // be tied to `ct` (the caller's request-scoped token that happened to trigger this lazy
            // startup): once that original HTTP request's connection closes, its token cancels,
            // which would silently kill this loop forever while the daemon keeps running for the
            // rest of the session — every subsequent stitch/upscale/prefetch becomes invisible to
            // `docker logs` with no error anywhere (observed in production: log coverage stopped
            // ~68 minutes into a session with no trace of why). The natural lifetime bound here is
            // the process itself: ReadLineAsync returns null on EOF once the process exits.
            var process = _process;
            _ = Task.Run(async () =>
            {
                string? line;
                while ((line = await process.StandardError.ReadLineAsync(CancellationToken.None)) != null)
                    _logger.LogInformation("[frame-forge] {Line}", line);
            });

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

    // Fast path: serve from the frame path index populated during PrefetchReady SSE.
    // Bypasses _requestLock entirely — no glob, no socket, no lock contention.
    public static byte[]? TryGetCachedWebP(Guid itemId, long frameIdx, int width)
    {
        if (frameIdx < 0) return null;
        if (!_framePathIndex.TryGetValue((itemId, frameIdx), out var paths)) return null;
        var path = width == 0 ? paths.OrigPath : paths.ThumbPath;
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return null;
        try { return File.ReadAllBytes(path); }
        catch { return null; }
    }

    // Parses an SSE chunk from PrefetchRangeStream: if it carries thumbPath/origPath,
    // stores them in _framePathIndex and returns a stripped chunk (paths not forwarded to browser).
    private static byte[] StripAndStorePaths(byte[] chunk, Guid itemId)
    {
        const string prefix = "data: ";
        var text = Encoding.UTF8.GetString(chunk);
        if (!text.StartsWith(prefix, StringComparison.Ordinal)) return chunk;

        var jsonStr = text[prefix.Length..].TrimEnd('\n', '\r');
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(jsonStr);
            var root = doc.RootElement;
            if (!root.TryGetProperty("frameReady", out var frProp)) return chunk;
            var fiIdx = frProp.GetInt64();

            if (root.TryGetProperty("thumbPath", out var tpProp) &&
                root.TryGetProperty("origPath",  out var opProp))
            {
                var thumbPath = tpProp.GetString() ?? "";
                var origPath  = opProp.GetString() ?? "";
                if (!string.IsNullOrEmpty(thumbPath))
                    _framePathIndex[(itemId, fiIdx)] = (thumbPath, origPath);
                return Encoding.UTF8.GetBytes($"data: {{\"frameReady\":{fiIdx}}}\n\n");
            }
        }
        catch { /* ignore parse errors, forward as-is */ }
        return chunk;
    }

    public async Task<(byte[]? JpegData, ushort QualityFlags, long ActualPtsMs)> GetFrameAsync(
        string filePath,
        long frameIdx,
        int width,
        Guid itemId,
        CancellationToken ct = default)
    {
        if (!IsAvailable) return (null, 0, 0);

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
            // [8] frame_idx (i64 LE, frame-forge resolves to posMs internally)
            // [4] width (u32 LE)
            // [4] path_len (u32 LE)
            // [N] file path (UTF-8)
            // [32] item_id (ASCII hex, no dashes)
            var buf = new byte[1 + 4 + 8 + 4 + 4 + pathBytes.Length + 32];
            buf[0] = MsgSingleFrame;
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(1, 4), requestId);
            BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(5, 8), frameIdx);
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
                    return (null, 0, 0);

                var jpegData = new byte[jpegLen];
                await ReceiveExactAsync(sock, jpegData, (int)jpegLen, ct).ConfigureAwait(false);

                var flagBuf = new byte[2];
                await ReceiveExactAsync(sock, flagBuf, 2, ct).ConfigureAwait(false);
                var flags = BinaryPrimitives.ReadUInt16LittleEndian(flagBuf);

                var ptsBuf = new byte[8];
                await ReceiveExactAsync(sock, ptsBuf, 8, ct).ConfigureAwait(false);
                var actualPtsMs = BinaryPrimitives.ReadInt64LittleEndian(ptsBuf);
                if (actualPtsMs < 0) actualPtsMs = 0; // cache hit sentinel

                return (jpegData, flags, actualPtsMs);
            }
            catch (OperationCanceledException)
            {
                InvalidateSocket();
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("[FrameExport] socket error — resetting: {Ex}", ex.Message);
                InvalidateSocket();
                return (null, 0, 0);
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

    /// <summary>Recovers a stitch task's diagnostics (model/EP used, GPU fallback events) when
    /// the task ends in error — the daemon writes <paramref name="logPath"/> incrementally as it
    /// runs, so a graceful daemon-reported failure (or even a crash after partial progress) can
    /// still leave a useful file behind even though the success-only read further below never
    /// runs. Mirrors <see cref="UpscaleService"/>'s identically-named orphan-log recovery for the
    /// same reason: failures are exactly when this diagnostic is most wanted (FR — "下载日志"
    /// button on generation failure, stitch only since animate never writes this log).</summary>
    public static GenerationLogDto? TryReadOrphanGenerationLog(string? logPath)
    {
        if (string.IsNullOrEmpty(logPath) || !File.Exists(logPath)) return null;
        try
        {
            var json = File.ReadAllText(logPath);
            return System.Text.Json.JsonSerializer.Deserialize<GenerationLogDto>(json);
        }
        catch { return null; }
        finally { try { File.Delete(logPath); } catch { } }
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
        long frameIdx,
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
            BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(5, 8), frameIdx);
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(13, 4), (uint)width);
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(17, 4), (uint)pathBytes.Length);
            pathBytes.CopyTo(buf.AsSpan(21));
            itemIdBytes.CopyTo(buf.AsSpan(21 + pathBytes.Length));

            await sock.SendAsync(buf, SocketFlags.None, ct).ConfigureAwait(false);

            // ACK: [4 request_id][4 jpeg_len=0]
            var ack = new byte[8];
            await ReceiveExactAsync(sock, ack, 8, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            InvalidateSocket();
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[FrameExport] prefetch socket error: {Ex}", ex.Message);
            InvalidateSocket();
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
        catch (OperationCanceledException)
        {
            InvalidateSocket();
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[FrameExport] prefetch_range socket error: {Ex}", ex.Message);
            InvalidateSocket();
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

            // Response: [4 request_id][4 count][count × (8 frame_idx + 8 pos_ms)]
            var header = new byte[8];
            await ReceiveExactAsync(sock, header, 8, ct).ConfigureAwait(false);
            var count = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(4));
            if (count == 0) return Array.Empty<long>();

            var body = new byte[count * 16];
            await ReceiveExactAsync(sock, body, (int)(count * 16), ct).ConfigureAwait(false);

            var result = new List<long>((int)count);
            for (var i = 0; i < (int)count; i++)
                result.Add(BinaryPrimitives.ReadInt64LittleEndian(body.AsSpan(i * 16))); // frame_idx
            return result;
        }
        catch (OperationCanceledException)
        {
            InvalidateSocket();
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[FrameExport] list_cached socket error: {Ex}", ex.Message);
            InvalidateSocket();
            return Array.Empty<long>();
        }
        finally
        {
            _requestLock.Release();
        }
    }

    /// <summary>
    /// Sends MSG_INDEX_FRAMES (0x15) to frame-forge and returns the complete frame index.
    /// Result is cached in the Rust daemon per video path.
    /// </summary>
    public async Task<FrameIndexDto?> FrameIndexAsync(
        string filePath, Guid itemId, CancellationToken ct = default)
    {
        if (!IsAvailable) return null;
        await EnsureStartedAsync(ct).ConfigureAwait(false);

        await _requestLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var sock = await GetSocketAsync(ct).ConfigureAwait(false);
            var pathBytes = Encoding.UTF8.GetBytes(filePath);

            // Wire: [msg_type(1)] [path_len(4)][path(N)]
            var buf = new byte[1 + 4 + pathBytes.Length];
            buf[0] = 0x15; // MSG_INDEX_FRAMES
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(1, 4), (uint)pathBytes.Length);
            pathBytes.CopyTo(buf.AsSpan(5));

            await sock.SendAsync(buf, SocketFlags.None, ct).ConfigureAwait(false);

            // Response: [frame_count(4)][fps_num(8)][fps_den(8)] × frame_count: [pts_ms(8)][is_key(1)]
            var header = new byte[20];
            await ReceiveExactAsync(sock, header, 20, ct).ConfigureAwait(false);
            var frameCount = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(0));
            var fpsNum = BinaryPrimitives.ReadInt64LittleEndian(header.AsSpan(4));
            var fpsDen = BinaryPrimitives.ReadInt64LittleEndian(header.AsSpan(12));

            if (frameCount == 0)
                return new FrameIndexDto { Frames = Array.Empty<FrameIndexEntryDto>(), Fps = new FpsFracDto { Num = fpsNum, Den = fpsDen } };

            var body = new byte[frameCount * 9];
            await ReceiveExactAsync(sock, body, (int)(frameCount * 9), ct).ConfigureAwait(false);

            var frames = new FrameIndexEntryDto[frameCount];
            for (var i = 0; i < (int)frameCount; i++)
            {
                var offset = i * 9;
                frames[i] = new FrameIndexEntryDto
                {
                    Ms = BinaryPrimitives.ReadInt64LittleEndian(body.AsSpan(offset)),
                    IsKey = body[offset + 8] != 0,
                    FrameIndex = i,
                };
            }

            return new FrameIndexDto { Frames = frames, Fps = new FpsFracDto { Num = fpsNum, Den = fpsDen } };
        }
        catch (OperationCanceledException)
        {
            InvalidateSocket();
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[FrameExport] FrameIndexAsync error: {Ex}", ex.Message);
            InvalidateSocket();
            return null;
        }
        finally
        {
            _requestLock.Release();
        }
    }

    public async Task<byte[]?> SubmitAnimateTaskAsync(
        TaskState task,
        Guid itemId,
        List<string> filePaths,
        List<long> frameIndices,
        string format,   // "gif" or "webp"
        string resizeMode, int targetPx, float speed, int loopCount,
        float cropX = 0f, float cropY = 0f, float cropW = 0f, float cropH = 0f,
        float quality = 0.75f, string resolutionPreset = "original",
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
        // item_id: fixed 32 ASCII bytes (UUID N format, no hyphens)
        ms.Write(Encoding.ASCII.GetBytes(itemId.ToString("N")), 0, 32);
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
        var presetBytes = Encoding.UTF8.GetBytes(resolutionPreset);
        ms.Write(BitConverter.GetBytes((uint)presetBytes.Length), 0, 4);
        ms.Write(presetBytes, 0, presetBytes.Length);

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
        Guid itemId,
        List<string> filePaths,
        List<long> positionsMs,
        string format,   // "png" or "webp"
        float quality = 0.75f,
        string? deviceId = null,
        string? logPath = null,
        bool modelDisabled = false,
        string? modelFamily = null,
        string? modelVersion = null,
        string? modelPath = null,
        CancellationToken ct = default)
    {
        if (!IsAvailable) return null;
        await EnsureStartedAsync(ct).ConfigureAwait(false);
        var sock = await GetSocketAsync(ct).ConfigureAwait(false);

        // T014: an empty device_id is interpreted by the Rust daemon as "cpu:0" (see
        // dl_match::parse_device_id), not "best available GPU" — so the US1 MVP goal
        // (GPU used automatically with zero UI interaction) requires resolving the
        // highest-VRAM default device here whenever the caller didn't pick one explicitly.
        if (string.IsNullOrEmpty(deviceId) && _deviceEnum != null)
        {
            try
            {
                var devices = await _deviceEnum.EnumerateAsync(ct).ConfigureAwait(false);
                deviceId = devices.FirstOrDefault(d => d.IsDefault)?.Id;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("[FrameExport] Device default resolution failed, falling back to CPU: {Ex}", ex.Message);
            }
        }

        var taskIdBytes = Encoding.UTF8.GetBytes(task.TaskId);
        var frameCount = filePaths.Count;

        using var ms = new MemoryStream();
        ms.WriteByte(0x12); // MSG_STITCH
        // item_id: fixed 32 ASCII bytes (UUID N format, no hyphens)
        ms.Write(Encoding.ASCII.GetBytes(itemId.ToString("N")), 0, 32);
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
        ms.Write(BitConverter.GetBytes((uint)0), 0, 4);         // preset_len = 0 (stitch always uses original resolution)

        // MSG_STITCH trailing extension fields (spec 012):
        // [device_id_len(4 LE)][device_id(UTF-8)]  -- empty string = use default EP chain
        // [log_path_len (4 LE)][log_path (UTF-8)]  -- empty string = skip generation log
        var deviceIdBytes = Encoding.UTF8.GetBytes(deviceId ?? "");
        ms.Write(BitConverter.GetBytes((uint)deviceIdBytes.Length), 0, 4);
        if (deviceIdBytes.Length > 0) ms.Write(deviceIdBytes, 0, deviceIdBytes.Length);

        var logPathBytes = Encoding.UTF8.GetBytes(logPath ?? "");
        ms.Write(BitConverter.GetBytes((uint)logPathBytes.Length), 0, 4);
        if (logPathBytes.Length > 0) ms.Write(logPathBytes, 0, logPathBytes.Length);

        // MSG_STITCH model-selection trailing fields (spec 012 US3):
        // [model_disabled(1)]                          -- 1 = AKAZE-only, skip DL matching entirely
        // [model_family_len(4)][model_family(UTF-8)]    -- "lightglue" | "efficient-loftr" | "" (auto)
        // [model_version_len(4)][model_version(UTF-8)]  -- echoed verbatim into GenerationLog.model_version
        // [model_path_len(4)][model_path(UTF-8)]        -- explicit absolute model file path resolved by
        //                                                  ModelCatalogService.GetInstalledModelPath; empty
        //                                                  lets the daemon auto-detect by canonical filename
        ms.WriteByte(modelDisabled ? (byte)1 : (byte)0);

        var modelFamilyBytes = Encoding.UTF8.GetBytes(modelFamily ?? "");
        ms.Write(BitConverter.GetBytes((uint)modelFamilyBytes.Length), 0, 4);
        if (modelFamilyBytes.Length > 0) ms.Write(modelFamilyBytes, 0, modelFamilyBytes.Length);

        var modelVersionBytes = Encoding.UTF8.GetBytes(modelVersion ?? "");
        ms.Write(BitConverter.GetBytes((uint)modelVersionBytes.Length), 0, 4);
        if (modelVersionBytes.Length > 0) ms.Write(modelVersionBytes, 0, modelVersionBytes.Length);

        var modelPathBytes = Encoding.UTF8.GetBytes(modelPath ?? "");
        ms.Write(BitConverter.GetBytes((uint)modelPathBytes.Length), 0, 4);
        if (modelPathBytes.Length > 0) ms.Write(modelPathBytes, 0, modelPathBytes.Length);

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
                                task.GenerationLog = TryReadOrphanGenerationLog(logPath);
                                task.ProgressChannel.Writer.TryComplete();
                                return null;
                            }
                        }
                    }
                    catch { }
                    if (statusCode == 1)
                    {
                        task.Status = TaskStatus.Error;
                        task.GenerationLog = TryReadOrphanGenerationLog(logPath);
                        task.ProgressChannel.Writer.TryComplete();
                        return null;
                    }
                }
                else
                {
                    await ReceiveExactAsync(sock, header, 4, ct).ConfigureAwait(false);
                    var dataLen = (int)BitConverter.ToUInt32(header, 0);
                    var dataBuf = new byte[dataLen];
                    await ReceiveExactAsync(sock, dataBuf, dataLen, ct).ConfigureAwait(false);
                    done = true;

                    // Read GenerationLog JSON from logPath written atomically by the daemon
                    if (!string.IsNullOrEmpty(logPath) && File.Exists(logPath))
                    {
                        try
                        {
                            var logJson = await File.ReadAllTextAsync(logPath, ct).ConfigureAwait(false);
                            task.GenerationLog = System.Text.Json.JsonSerializer.Deserialize<
                                Jellyfin.Plugin.JellyfinSuite.Models.GenerationLogDto>(logJson);

                            // T025: bump lastUsedAt for the DL model that was actually used, so
                            // LRU eviction (T028) ranks it correctly. Algorithm/ModelVersion are
                            // echoed verbatim by the daemon (dl_match::algorithm_name), so this
                            // also covers the "Latest" sentinel resolving to a concrete version.
                            var log = task.GenerationLog;
                            if (_modelCatalog != null && log != null
                                && (log.Algorithm == "lightglue" || log.Algorithm == "efficient-loftr")
                                && !string.IsNullOrEmpty(log.ModelVersion))
                            {
                                await _modelCatalog.RecordUsageAsync(log.Algorithm, log.ModelVersion, ct).ConfigureAwait(false);
                            }
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning("[FrameExport] Failed to read generation log: {Ex}", ex.Message);
                        }
                        finally
                        {
                            try { File.Delete(logPath); } catch { }
                        }
                    }

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

    /// <summary>
    /// Sends MSG_UPSCALE (0x1B) to frame-forge: Real-ESRGAN super-resolution with an optional
    /// GFPGAN face-restore pass. Mirrors <see cref="SubmitStitchTaskAsync"/>'s send/receive loop,
    /// but reports progress via <paramref name="onProgress"/> instead of a <c>TaskState</c> —
    /// upscale jobs are tracked by <c>UpscaleService</c>'s own in-memory job dictionary, not
    /// <c>FrameExportTaskManager</c> (T057 deliberately puts the Upscale endpoints on
    /// <c>StitchController</c>, not <c>FrameExportController</c>).
    /// </summary>
    public async Task<UpscaleSubmitResult?> SubmitUpscaleTaskAsync(
        Guid itemId,
        string inputPath,
        string outputPath,
        string modelPath,
        bool isAnimation,
        string? faceRestoreModelPath,
        string? deviceId,
        string? logPath,
        float postDownscaleFactor,
        string jobId,
        Action<TaskProgress> onProgress,
        CancellationToken ct = default)
    {
        if (!IsAvailable) return null;
        await EnsureStartedAsync(ct).ConfigureAwait(false);
        var sock = await GetSocketAsync(ct).ConfigureAwait(false);

        if (string.IsNullOrEmpty(deviceId) && _deviceEnum != null)
        {
            try
            {
                var devices = await _deviceEnum.EnumerateAsync(ct).ConfigureAwait(false);
                deviceId = devices.FirstOrDefault(d => d.IsDefault)?.Id;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("[FrameExport] Device default resolution failed, falling back to CPU: {Ex}", ex.Message);
            }
        }

        using var ms = new MemoryStream();
        ms.WriteByte(MsgUpscale);
        ms.Write(Encoding.ASCII.GetBytes(itemId.ToString("N")), 0, 32);

        void WriteLenPrefixed(string? s)
        {
            var bytes = Encoding.UTF8.GetBytes(s ?? "");
            ms.Write(BitConverter.GetBytes((uint)bytes.Length), 0, 4);
            if (bytes.Length > 0) ms.Write(bytes, 0, bytes.Length);
        }

        WriteLenPrefixed(inputPath);
        WriteLenPrefixed(outputPath);
        WriteLenPrefixed(modelPath);
        WriteLenPrefixed(deviceId);
        ms.WriteByte(isAnimation ? (byte)1 : (byte)0);
        WriteLenPrefixed(faceRestoreModelPath);
        WriteLenPrefixed(logPath);
        ms.Write(BitConverter.GetBytes(postDownscaleFactor), 0, 4);
        WriteLenPrefixed(jobId);

        var reqBuf = ms.ToArray();
        try
        {
            await sock.SendAsync(reqBuf, SocketFlags.None, ct).ConfigureAwait(false);

            var header = new byte[8];
            while (!ct.IsCancellationRequested)
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
                            onProgress(prog);
                            if (prog.Status == "error" || statusCode == 1) return null;
                        }
                    }
                    catch { }
                }
                else
                {
                    await ReceiveExactAsync(sock, header, 4, ct).ConfigureAwait(false);
                    var dataLen = (int)BitConverter.ToUInt32(header, 0);
                    var dataBuf = new byte[dataLen];
                    await ReceiveExactAsync(sock, dataBuf, dataLen, ct).ConfigureAwait(false);

                    UpscaleLogDto? log = null;
                    if (!string.IsNullOrEmpty(logPath) && File.Exists(logPath))
                    {
                        try
                        {
                            var logJson = await File.ReadAllTextAsync(logPath, ct).ConfigureAwait(false);
                            log = System.Text.Json.JsonSerializer.Deserialize<UpscaleLogDto>(logJson);
                            if (log != null && log.Fallbacks.Count > 0)
                            {
                                _logger.LogWarning("[FrameExport] Upscale job fell back to CPU: {Fallbacks}",
                                    string.Join("; ", log.Fallbacks.Select(f => f.Reason)));
                            }
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning("[FrameExport] Failed to read upscale log: {Ex}", ex.Message);
                        }
                        finally
                        {
                            try { File.Delete(logPath); } catch { }
                        }
                    }

                    return new UpscaleSubmitResult { OutputBytes = dataBuf, Log = log };
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

    /// <summary>Tells frame-forge to cooperatively abandon a still-running upscale job (checked
    /// between tiles/faces — see server.rs CancelFlagGuard). Fire-and-forget on a brand-new
    /// connection: the connection actually running the job is busy inside SubmitUpscaleTaskAsync
    /// and won't read another message until that call returns, so this can't reuse <see cref="_socket"/>.
    /// Best-effort only — UpscaleService.Cancel already marks the job Cancelled independently of
    /// whether this succeeds; this just lets the daemon reclaim CPU/GPU sooner instead of running
    /// to completion or waiting for the EnsureStartedAsync timeout watchdog.</summary>
    public async Task CancelUpscaleTaskAsync(string jobId, CancellationToken ct = default)
    {
        if (!IsAvailable || !File.Exists(_socketPath)) return;

        try
        {
            using var sock = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            await sock.ConnectAsync(new UnixDomainSocketEndPoint(_socketPath), ct).ConfigureAwait(false);

            var jobIdBytes = Encoding.UTF8.GetBytes(jobId);
            using var ms = new MemoryStream();
            ms.WriteByte(MsgCancelUpscale);
            ms.Write(BitConverter.GetBytes((uint)jobIdBytes.Length), 0, 4);
            ms.Write(jobIdBytes, 0, jobIdBytes.Length);

            await sock.SendAsync(ms.ToArray(), SocketFlags.None, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug("[FrameExport] CancelUpscaleTaskAsync best-effort send failed: {Ex}", ex.Message);
        }
    }

    /// <summary>
    /// Sends MSG_INDEX_FRAMES_STREAM (0x17) to frame-forge and streams the response
    /// directly to <paramref name="output"/> without deserializing. The daemon sends
    /// SSE-formatted chunks prefixed with 4-byte length; C# just copies bytes.
    /// Priority frames near <paramref name="currentTimeMs"/> arrive first.
    /// </summary>
    public async Task FrameIndexStreamAsync(
        string filePath, Guid itemId, long currentTimeMs, Stream output, CancellationToken ct = default)
    {
        if (!IsAvailable) return;
        await EnsureStartedAsync(ct).ConfigureAwait(false);

        await _requestLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var sock = await GetSocketAsync(ct).ConfigureAwait(false);
            var requestId = Interlocked.Increment(ref _nextRequestId);
            var pathBytes = Encoding.UTF8.GetBytes(filePath);
            var itemIdBytes = Encoding.ASCII.GetBytes(itemId.ToString("N")); // 32 bytes

            // Wire: [msg_type(1)] [request_id(4)] [item_id(32)] [path_len(4)][path(N)] [current_time_ms(8)]
            var buf = new byte[1 + 4 + 32 + 4 + pathBytes.Length + 8];
            var pos = 0;
            buf[pos++] = 0x17; // MSG_INDEX_FRAMES_STREAM
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(pos, 4), requestId); pos += 4;
            itemIdBytes.CopyTo(buf.AsSpan(pos, 32)); pos += 32;
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(pos, 4), (uint)pathBytes.Length); pos += 4;
            pathBytes.CopyTo(buf.AsSpan(pos)); pos += pathBytes.Length;
            BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(pos, 8), currentTimeMs);

            await sock.SendAsync(buf, SocketFlags.None, ct).ConfigureAwait(false);

            // Response header: request_id(4)
            var header = new byte[4];
            await ReceiveExactAsync(sock, header, 4, ct).ConfigureAwait(false);
            var responseId = BinaryPrimitives.ReadUInt32LittleEndian(header);
            if (responseId != requestId)
                throw new IOException($"[FrameExport] FrameIndexStream socket desync: expected {requestId}, got {responseId}");

            // Read chunks and forward directly to output
            var lenBuf = new byte[4];
            while (true)
            {
                await ReceiveExactAsync(sock, lenBuf, 4, ct).ConfigureAwait(false);
                var chunkLen = (int)BinaryPrimitives.ReadUInt32LittleEndian(lenBuf);
                if (chunkLen == 0) break;

                var chunk = new byte[chunkLen];
                await ReceiveExactAsync(sock, chunk, chunkLen, ct).ConfigureAwait(false);
                await output.WriteAsync(chunk, ct).ConfigureAwait(false);
                await output.FlushAsync(ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            InvalidateSocket();
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[FrameExport] FrameIndexStreamAsync error: {Ex}", ex.Message);
            InvalidateSocket();
        }
        finally
        {
            _requestLock.Release();
        }
    }

    /// <summary>
    /// Sends MSG_PREFETCH_RANGE_STREAM (0x19) to frame-forge with a time range.
    /// Rust resolves frames from in-memory frameinfo, decodes each, SSEs per frame + done signal.
    /// Response uses length-prefixed chunks (same as FrameIndexStreamAsync).
    /// </summary>
    public async Task PrefetchRangeStreamAsync(
        string filePath, Guid itemId, long currentTimeMs, long currentFrameIdx,
        double beforeSeconds, double afterSeconds, bool includeCurrentFrame, int width,
        string prefetchSessionId, Stream output, CancellationToken ct = default)
    {
        if (!IsAvailable) return;
        await EnsureStartedAsync(ct).ConfigureAwait(false);

        await _requestLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var sock = await GetSocketAsync(ct).ConfigureAwait(false);
            var pathBytes = Encoding.UTF8.GetBytes(filePath);
            var itemIdBytes = Encoding.ASCII.GetBytes(itemId.ToString("N")); // 32 bytes
            var beforeMs = (long)Math.Round(beforeSeconds * 1000);
            var afterMs  = (long)Math.Round(afterSeconds  * 1000);
            var sessionIdBytes = Encoding.UTF8.GetBytes(prefetchSessionId ?? "");

            // Wire: [msg(1)] [item_id(32)] [path_len(4)][path(N)] [current_time_ms(8)] [current_frame_idx(8)] [before_ms(8)] [after_ms(8)] [include_current(1)] [width(4)] [session_id_len(4)][session_id(N)]
            var buf = new byte[1 + 32 + 4 + pathBytes.Length + 8 + 8 + 8 + 8 + 1 + 4 + 4 + sessionIdBytes.Length];
            var pos = 0;
            buf[pos++] = MsgPrefetchRangeStream;
            itemIdBytes.CopyTo(buf.AsSpan(pos, 32)); pos += 32;
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(pos, 4), (uint)pathBytes.Length); pos += 4;
            pathBytes.CopyTo(buf.AsSpan(pos)); pos += pathBytes.Length;
            BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(pos, 8), currentTimeMs); pos += 8;
            BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(pos, 8), currentFrameIdx); pos += 8;
            BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(pos, 8), beforeMs); pos += 8;
            BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(pos, 8), afterMs); pos += 8;
            buf[pos++] = (byte)(includeCurrentFrame ? 1 : 0);
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(pos, 4), (uint)width); pos += 4;
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(pos, 4), (uint)sessionIdBytes.Length); pos += 4;
            sessionIdBytes.CopyTo(buf.AsSpan(pos));

            await sock.SendAsync(buf, SocketFlags.None, ct).ConfigureAwait(false);

            // Read length-prefixed chunks; intercept paths before forwarding to browser
            var lenBuf = new byte[4];
            while (true)
            {
                await ReceiveExactAsync(sock, lenBuf, 4, ct).ConfigureAwait(false);
                var chunkLen = (int)BinaryPrimitives.ReadUInt32LittleEndian(lenBuf);
                if (chunkLen == 0) break;

                var chunk = new byte[chunkLen];
                await ReceiveExactAsync(sock, chunk, chunkLen, ct).ConfigureAwait(false);
                var forwarded = StripAndStorePaths(chunk, itemId);
                await output.WriteAsync(forwarded, ct).ConfigureAwait(false);
                await output.FlushAsync(ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            InvalidateSocket();
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[FrameExport] PrefetchRangeStreamAsync error: {Ex}", ex.Message);
            InvalidateSocket();
        }
        finally
        {
            _requestLock.Release();
        }
    }

    /// <summary>
    /// Sends MSG_PREFETCH_STREAM (0x18) to frame-forge with specific frame indices.
    /// Rust decodes each frame (skipping cached) and sends SSE per frame.
    /// </summary>
    public async Task PrefetchStreamAsync(
        string filePath, Guid itemId, int width, long[] fiIndices,
        Stream output, CancellationToken ct = default)
    {
        if (!IsAvailable) return;
        await EnsureStartedAsync(ct).ConfigureAwait(false);

        await _requestLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var sock = await GetSocketAsync(ct).ConfigureAwait(false);
            var pathBytes = Encoding.UTF8.GetBytes(filePath);
            var itemIdBytes = Encoding.ASCII.GetBytes(itemId.ToString("N")); // 32 bytes

            // Wire: [msg(1)] [path_len(4)][path(N)] [item_id(32)] [width(4)] [count(4)] [count × fi_idx(8)]
            var count = fiIndices.Length;
            var buf = new byte[1 + 4 + pathBytes.Length + 32 + 4 + 4 + count * 8];
            var pos = 0;
            buf[pos++] = MsgPrefetchStream; // 0x18
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(pos, 4), (uint)pathBytes.Length); pos += 4;
            pathBytes.CopyTo(buf.AsSpan(pos)); pos += pathBytes.Length;
            itemIdBytes.CopyTo(buf.AsSpan(pos, 32)); pos += 32;
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(pos, 4), (uint)width); pos += 4;
            BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(pos, 4), (uint)count); pos += 4;
            foreach (var fi in fiIndices)
            {
                BinaryPrimitives.WriteInt64LittleEndian(buf.AsSpan(pos, 8), fi);
                pos += 8;
            }

            await sock.SendAsync(buf, SocketFlags.None, ct).ConfigureAwait(false);

            // Read SSE lines and forward
            var readBuf = new byte[4096];
            while (true)
            {
                var n = await sock.ReceiveAsync(readBuf, SocketFlags.None, ct).ConfigureAwait(false);
                if (n == 0) break;
                await output.WriteAsync(readBuf.AsMemory(0, n), ct).ConfigureAwait(false);
                await output.FlushAsync(ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            InvalidateSocket();
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[FrameExport] PrefetchStreamAsync error: {Ex}", ex.Message);
            InvalidateSocket();
        }
        finally
        {
            _requestLock.Release();
        }
    }

    /// <summary>
    /// Sends MSG_DEBUG_DUMP (0x1A) to frame-forge and returns the JSON state snapshot.
    /// Fields: ramEntries, ramCap, fiCached[], fiCap, fiInProgress[], prefetchQueued.
    /// </summary>
    public async Task<string> GetDebugDumpAsync(CancellationToken ct = default)
    {
        if (!IsAvailable) return "{}";
        await EnsureStartedAsync(ct).ConfigureAwait(false);

        await _requestLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var sock = await GetSocketAsync(ct).ConfigureAwait(false);
            try
            {
                await sock.SendAsync(new byte[] { MsgDebugDump }, SocketFlags.None, ct).ConfigureAwait(false);

                var lenBuf = new byte[4];
                await ReceiveExactAsync(sock, lenBuf, 4, ct).ConfigureAwait(false);
                var len = (int)BinaryPrimitives.ReadUInt32LittleEndian(lenBuf);

                var jsonBuf = new byte[len];
                await ReceiveExactAsync(sock, jsonBuf, len, ct).ConfigureAwait(false);
                return Encoding.UTF8.GetString(jsonBuf);
            }
            catch (OperationCanceledException)
            {
                InvalidateSocket();
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("[FrameExport] debug dump socket error: {Ex}", ex.Message);
                InvalidateSocket();
                return "{}";
            }
        }
        finally
        {
            _requestLock.Release();
        }
    }

    /// <summary>
    /// Forcibly stops the running frame-forge daemon so the next <see cref="EnsureStartedAsync"/>
    /// call relaunches it with an updated environment (e.g. after <see cref="OrtVersionService.ActivateVersionAsync"/>
    /// changes which ORT_DYLIB_PATH gets passed in). No-op if the daemon isn't running.
    /// </summary>
    public void KillDaemon()
    {
        if (_process is { HasExited: false })
        {
            _logger.LogInformation("[FrameExport] Killing daemon to pick up new ORT_DYLIB_PATH");
            _process.Kill();
            _process.WaitForExit(3000);
        }
        InvalidateSocket();
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
