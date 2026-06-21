using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

/// <summary>
/// Downloads + caches the CUDA 13 runtime shared libraries (cudart, cuBLAS, cuRAND, cuFFT, cuDNN)
/// that ORT's gpu_cuda13 EP build needs but the base jellyfin/jellyfin image does not ship — that
/// image only carries what ffmpeg's NVENC/NVDEC hwaccel needs (the driver's libcuda.so), not the
/// full CUDA Runtime stack ONNX Runtime's CUDA EP dlopens.
///
/// LESSON LEARNED (root-caused a "stuck at 20%, CPU 100%, GPU 0%, zero errors anywhere" bug that
/// took an entire investigation to track down — see git history around this file for the full
/// trail): a MISSING dependency of <c>libonnxruntime_providers_cuda.so</c> does not surface as an
/// error anywhere. ORT dlopens that provider .so lazily inside <c>commit_from_file</c>; if even one
/// of its own <c>NEEDED</c> entries (checked via <c>ldd libonnxruntime_providers_cuda.so</c>) can't
/// resolve, ORT silently treats the CUDA EP as unavailable — <c>with_execution_providers</c> still
/// "succeeds", <c>commit_from_file</c> still "succeeds", <c>GetCapability()</c> just quietly claims
/// zero nodes for every op, and 100% of the model runs on CPU. No exception, no log line, no
/// FallbackEvent — the daemon looks completely healthy. The only way this was actually proven (not
/// guessed) was ONNX Runtime's own chrome-trace profiler (<c>SessionBuilder::with_profiling</c> +
/// <c>Session::end_profiling()</c>), which records the literal EP each node executed on; log
/// severity (<c>ORT_LOG</c>/<c>with_log_level</c>) produced no output at all in this prebuilt
/// release binary, even at Verbose.
///
/// Concretely: shipping only cudart + cuBLAS + cuDNN (this service's original set) was NOT enough —
/// <c>libonnxruntime_providers_cuda.so</c> also directly links <c>libcurand.so.10</c> and
/// <c>libcufft.so.12</c>, which nothing else in the container provides and no cuDNN-based model
/// (Real-ESRGAN included) ever calls into directly, so the gap was easy to miss by reasoning about
/// "what the model needs" instead of "what the provider .so's full NEEDED list is". Takeaway: when
/// bundling a runtime for a prebuilt third-party shared library, verify completeness with
/// <c>ldd &lt;the .so&gt; | grep "not found"</c> against the exact target environment — don't infer
/// the dependency list from the library's own documented purpose.
///
/// Lazily triggered on startup only when an NVIDIA GPU is actually detected
/// (<see cref="DeviceEnumerationService"/>), since the combined download is ~1.5GB and CPU-only/
/// AMD/Intel-only hosts have no use for it — same one-time-bootstrap-if-needed shape as
/// <see cref="OrtVersionService"/>, just for the layer below it.
///
/// Source: NVIDIA's own redistributable manifests (the same feed pip/conda's nvidia-* packages
/// pull from), not a project-hosted mirror — these archives are gigabytes apiece, identical
/// reasoning to why <see cref="OrtVersionService"/> queries the GitHub Releases API directly
/// instead of maintaining its own catalog.
/// </summary>
public sealed class CudaRuntimeAcquisitionService : BackgroundService
{
    private readonly DeviceEnumerationService _deviceEnum;
    private readonly ILogger<CudaRuntimeAcquisitionService> _logger;
    private readonly string _pluginDir;
    private readonly string _frameForgeBinaryPath;
    private FrameExportService? _frameExport;
    private string? _activeLibDir;

    // Pinned so a new CUDA/cuDNN release doesn't silently change runtime behaviour — same
    // discipline as OrtVersionService.PinnedOrtVersion. cuDNN only gained a "cuda13" variant
    // starting at 9.12.0 (verified directly against NVIDIA's redist manifest); bump together
    // with PinnedCudaVersion and re-verify both still expose linux-x86_64/cuda13 entries.
    private const string PinnedCudaVersion = "13.0.2";
    private const string PinnedCudnnVersion = "9.13.0";

    private const string CudaRedistBaseUrl = "https://developer.download.nvidia.com/compute/cuda/redist/";
    private const string CudnnRedistBaseUrl = "https://developer.download.nvidia.com/compute/cudnn/redist/";

    private static string CudaManifestUrl(string version) => $"{CudaRedistBaseUrl}redistrib_{version}.json";
    private static string CudnnManifestUrl(string version) => $"{CudnnRedistBaseUrl}redistrib_{version}.json";

    public CudaRuntimeAcquisitionService(
        IApplicationPaths appPaths,
        DeviceEnumerationService deviceEnum,
        ILogger<CudaRuntimeAcquisitionService> logger)
    {
        _deviceEnum = deviceEnum;
        _logger = logger;
        _pluginDir = Path.Combine(appPaths.PluginsPath, "JellyfinSuite");
        _frameForgeBinaryPath = Path.Combine(_pluginDir, "frame-forge-linux-x64");
    }

    /// <summary>
    /// Wires in the frame-forge daemon manager after DI container build, mirroring
    /// <see cref="OrtVersionService.SetFrameExportService"/>. Called from
    /// <see cref="Jellyfin.Plugin.JellyfinSuite.FrameExportAuxServicesWirer"/>.
    /// </summary>
    public void SetFrameExportService(FrameExportService frameExport) => _frameExport = frameExport;

    /// <summary>Absolute path to the extracted lib/ dir (cudart+cublas+cudnn .so's), or null
    /// until the background bootstrap completes (or never starts, e.g. no NVIDIA GPU).</summary>
    public string? ActiveLibDir => _activeLibDir;

    private string CudaRuntimeRoot => Path.Combine(_pluginDir, "cuda-runtime");
    private string VersionDirName => $"cuda{PinnedCudaVersion}_cudnn{PinnedCudnnVersion}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // frame-forge only ships a Linux binary today (FrameExportService.IsAvailable) — same
        // gate OrtVersionService uses before spending bandwidth on a runtime nothing can load.
        if (OperatingSystem.IsWindows()) return;

        Directory.CreateDirectory(CudaRuntimeRoot);
        var libDir = Path.Combine(CudaRuntimeRoot, VersionDirName, "lib");
        if (Directory.Exists(libDir) && Directory.EnumerateFiles(libDir, "*.so*").Any())
        {
            _activeLibDir = libDir;
            _logger.LogInformation("[CudaRuntimeAcquisition] Found cached CUDA runtime at {Dir}", libDir);
            return;
        }

        var devices = await _deviceEnum.EnumerateAsync(stoppingToken).ConfigureAwait(false);
        var gpu = devices.FirstOrDefault(d => d.DeviceType == "GPU" && d.IsDefault);
        if (gpu?.Vendor != "NVIDIA")
        {
            _logger.LogInformation(
                "[CudaRuntimeAcquisition] No NVIDIA GPU detected — skipping CUDA runtime bootstrap " +
                "(~1.5GB, only needed for cuBLAS/cuDNN-based GPU inference).");
            return;
        }

        _logger.LogInformation(
            "[CudaRuntimeAcquisition] NVIDIA GPU detected — bootstrapping CUDA {Cuda} + cuDNN {Cudnn} runtime in background",
            PinnedCudaVersion, PinnedCudnnVersion);
        _ = Task.Run(() => BootstrapDownloadAsync(stoppingToken), CancellationToken.None);
    }

    private async Task BootstrapDownloadAsync(CancellationToken ct)
    {
        var versionDir = Path.Combine(CudaRuntimeRoot, VersionDirName);
        var tmpDir = versionDir + ".download.tmp";
        try
        {
            if (!File.Exists(_frameForgeBinaryPath))
            {
                _logger.LogWarning("[CudaRuntimeAcquisition] frame-forge binary not found at {Path} — aborting bootstrap", _frameForgeBinaryPath);
                return;
            }

            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
            http.DefaultRequestHeaders.Add("User-Agent", "JellyfinSuite/1.0");

            using var cudaManifest = await FetchManifestAsync(http, CudaManifestUrl(PinnedCudaVersion), ct).ConfigureAwait(false);
            using var cudnnManifest = await FetchManifestAsync(http, CudnnManifestUrl(PinnedCudnnVersion), ct).ConfigureAwait(false);

            var cudart = ExtractCudaEntry(cudaManifest, "cuda_cudart");
            var cublas = ExtractCudaEntry(cudaManifest, "libcublas");
            // libcurand/libcufft: NEEDED by libonnxruntime_providers_cuda.so (verified via ldd —
            // it links libcurand.so.10 and libcufft.so.12 directly, not just transitively through
            // cublas/cudnn) but easy to miss since cuDNN-based models like Real-ESRGAN never call
            // curand/cufft APIs themselves. Without these two, the provider .so fails to fully
            // resolve at dlopen time; ORT swallows that failure and silently runs 100% on CPU
            // instead of erroring, which is what made this so hard to diagnose (no error anywhere,
            // CUDA EP "registers" fine, GetCapability just claims zero nodes).
            var curand = ExtractCudaEntry(cudaManifest, "libcurand");
            var cufft = ExtractCudaEntry(cudaManifest, "libcufft");
            var cudnn = ExtractCudnnEntry(cudnnManifest, "cuda13");

            if (cudart is null || cublas is null || curand is null || cufft is null || cudnn is null)
            {
                _logger.LogWarning(
                    "[CudaRuntimeAcquisition] Redist manifest missing an expected component " +
                    "(cudart={HasCudart} cublas={HasCublas} curand={HasCurand} cufft={HasCufft} cudnn/cuda13={HasCudnn}) — aborting bootstrap",
                    cudart is not null, cublas is not null, curand is not null, cufft is not null, cudnn is not null);
                return;
            }

            if (Directory.Exists(tmpDir)) Directory.Delete(tmpDir, recursive: true);
            Directory.CreateDirectory(tmpDir);

            await DownloadAndExtractAsync(http, CudaRedistBaseUrl + cudart.Value.RelativePath, cudart.Value.Sha256, tmpDir, ct).ConfigureAwait(false);
            await DownloadAndExtractAsync(http, CudaRedistBaseUrl + cublas.Value.RelativePath, cublas.Value.Sha256, tmpDir, ct).ConfigureAwait(false);
            await DownloadAndExtractAsync(http, CudaRedistBaseUrl + curand.Value.RelativePath, curand.Value.Sha256, tmpDir, ct).ConfigureAwait(false);
            await DownloadAndExtractAsync(http, CudaRedistBaseUrl + cufft.Value.RelativePath, cufft.Value.Sha256, tmpDir, ct).ConfigureAwait(false);
            await DownloadAndExtractAsync(http, CudnnRedistBaseUrl + cudnn.Value.RelativePath, cudnn.Value.Sha256, tmpDir, ct).ConfigureAwait(false);

            // Flatten every extracted archive's lib/*.so* into one directory so frame-forge only
            // needs a single extra LD_LIBRARY_PATH entry — each redist archive nests its libs
            // under its own "<pkg>-linux-x86_64-<ver>-archive/lib/" subdirectory.
            var libDir = Path.Combine(versionDir, "lib");
            Directory.CreateDirectory(libDir);
            foreach (var so in Directory.EnumerateFiles(tmpDir, "*.so*", SearchOption.AllDirectories))
            {
                var dest = Path.Combine(libDir, Path.GetFileName(so));
                if (!File.Exists(dest)) File.Copy(so, dest);
            }
            Directory.Delete(tmpDir, recursive: true);

            _activeLibDir = libDir;
            _logger.LogInformation(
                "[CudaRuntimeAcquisition] CUDA runtime ready at {Dir} ({Count} libs)",
                libDir, Directory.GetFiles(libDir).Length);

            // frame-forge reads LD_LIBRARY_PATH once at process start (FrameExportService.
            // EnsureStartedAsync) — the user has no reason to know they need to restart anything
            // for GPU accel to kick in, so do it for them on the next stitch/upscale request.
            _frameExport?.KillDaemon();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "[CudaRuntimeAcquisition] Bootstrap failed — GPU acceleration keeps falling back to CPU until next retry");
            try { if (Directory.Exists(tmpDir)) Directory.Delete(tmpDir, recursive: true); } catch { /* best effort */ }
        }
    }

    // ── Download + extract ────────────────────────────────────────────

    private async Task DownloadAndExtractAsync(HttpClient http, string url, string expectedSha256, string destDir, CancellationToken ct)
    {
        var tmpFile = Path.Combine(Path.GetTempPath(), $"jfs-cuda-{Guid.NewGuid():N}.tar.xz");
        const int maxAttempts = 4; // 1 initial attempt + 3 retries
        var backoff = new[] { TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(4), TimeSpan.FromSeconds(16) };
        Exception? lastError = null;

        try
        {
            for (var attempt = 1; attempt <= maxAttempts; attempt++)
            {
                try
                {
                    using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
                    response.EnsureSuccessStatusCode();
                    await using (var src = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
                    await using (var dst = File.Create(tmpFile))
                    {
                        await src.CopyToAsync(dst, ct).ConfigureAwait(false);
                    }

                    if (expectedSha256.Length > 0)
                    {
                        var actual = await ComputeSha256Async(tmpFile).ConfigureAwait(false);
                        if (!string.Equals(actual, expectedSha256, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidDataException($"SHA-256 mismatch for {url} (expected {expectedSha256}, got {actual})");
                    }

                    await ExtractTarXzAsync(tmpFile, destDir, ct).ConfigureAwait(false);
                    _logger.LogInformation("[CudaRuntimeAcquisition] Downloaded + extracted {Url}", url);
                    return;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    _logger.LogWarning(
                        "[CudaRuntimeAcquisition] Download attempt {Attempt}/{Max} failed for {Url}: {Msg}",
                        attempt, maxAttempts, url, ex.Message);
                    if (attempt == maxAttempts) throw lastError;
                    await Task.Delay(backoff[attempt - 1], ct).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            try { if (File.Exists(tmpFile)) File.Delete(tmpFile); } catch { /* best effort */ }
        }
    }

    private static async Task<string> ComputeSha256Async(string path)
    {
        await using var stream = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(stream, CancellationToken.None).ConfigureAwait(false);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>
    /// .NET's BCL has no LZMA/XZ decompressor (only Brotli/GZip/Deflate), and a managed-library
    /// route (e.g. Joveler.Compression.XZ pinvoking liblzma) turned out to be a dead end:
    /// Jellyfin's plugin loader doesn't go through hostfxr's deps.json native-asset probing, so
    /// neither the package's own bundled native binary nor its managed DLL dependencies (which
    /// nothing here ever copies into the plugin folder — Microsoft.Data.Sqlite only "works"
    /// today because Jellyfin server itself already ships that one) reliably resolve at runtime.
    /// frame-forge already proves out a real, statically-linked liblzma binding via Cargo
    /// (xz2/lzma-sys) for its `extract-tar-xz` subcommand, so extraction shells out to the
    /// binary already deployed alongside this plugin instead.
    /// </summary>
    private async Task ExtractTarXzAsync(string archivePath, string destDir, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(_frameForgeBinaryPath, $"extract-tar-xz \"{archivePath}\" \"{destDir}\"")
        {
            UseShellExecute = false,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        using var proc = Process.Start(psi) ?? throw new InvalidOperationException($"failed to start {_frameForgeBinaryPath}");
        var stderr = await proc.StandardError.ReadToEndAsync(ct).ConfigureAwait(false);
        await proc.WaitForExitAsync(ct).ConfigureAwait(false);
        if (proc.ExitCode != 0)
            throw new InvalidOperationException($"extract-tar-xz failed (exit {proc.ExitCode}) for {archivePath}: {stderr}");
    }

    private static async Task<JsonDocument> FetchManifestAsync(HttpClient http, string url, CancellationToken ct)
    {
        var json = await http.GetStringAsync(url, ct).ConfigureAwait(false);
        return JsonDocument.Parse(json);
    }

    // ── NVIDIA redist manifest shape (https://developer.download.nvidia.com/compute/{cuda,cudnn}/redist/) ──
    // Top-level keys are component names (e.g. "cuda_cudart", "libcublas", "cudnn") whose value
    // carries a "linux-x86_64" platform entry. cuDNN additionally nests a CUDA-major-version
    // variant ("cuda11"/"cuda12"/"cuda13") under that platform entry; the CUDA toolkit's own
    // components (cudart, cublas) don't need that extra level since the manifest itself is
    // already scoped to one CUDA version via PinnedCudaVersion.

    private static (string RelativePath, string Sha256)? ExtractCudaEntry(JsonDocument manifest, string componentKey)
    {
        if (!manifest.RootElement.TryGetProperty(componentKey, out var comp)) return null;
        if (!comp.TryGetProperty("linux-x86_64", out var plat)) return null;
        return ReadRelativePathAndSha(plat);
    }

    private static (string RelativePath, string Sha256)? ExtractCudnnEntry(JsonDocument manifest, string cudaVariant)
    {
        if (!manifest.RootElement.TryGetProperty("cudnn", out var cudnn)) return null;
        if (!cudnn.TryGetProperty("linux-x86_64", out var plat)) return null;
        if (!plat.TryGetProperty(cudaVariant, out var variant)) return null;
        return ReadRelativePathAndSha(variant);
    }

    private static (string RelativePath, string Sha256)? ReadRelativePathAndSha(JsonElement entry)
    {
        if (!entry.TryGetProperty("relative_path", out var rpEl)) return null;
        var sha256 = entry.TryGetProperty("sha256", out var shaEl) ? shaEl.GetString() ?? "" : "";
        return (rpEl.GetString() ?? "", sha256);
    }
}
