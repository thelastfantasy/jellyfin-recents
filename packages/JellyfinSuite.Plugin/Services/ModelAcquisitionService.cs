using System.Net.Http;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

/// <summary>
/// Downloads and caches DL model files (ONNX) used by frame-forge.
///
/// On every Jellyfin startup the service does a lightweight HEAD request,
/// compares the ETag with the cached value, and re-downloads only when the
/// remote file has changed.  If the network is unreachable the cached model
/// continues to be used.
///
/// Cache directory: {plugin install dir}/models/ — the actual on-disk plugin directory,
/// resolved via this assembly's own Assembly.Location rather than a hardcoded name (Jellyfin's
/// plugin loader names the install dir after meta.json's "name" + version, e.g.
/// "Jellyfin Suite_2.0.0.0", not a fixed "JellyfinSuite"). This is the second path searched by
/// frame-forge's find_model() (`<binary_dir>/models/<name>`, since frame-forge's own binary lives
/// in this same install dir), so the Rust binary picks it up automatically without any extra
/// configuration.
///
/// Model selection (FRAME_FORGE_MATCHER env var in frame-forge):
///   "lightglue"       → superpoint_lightglue.onnx  (SuperPoint + LightGlue fused)
///   "efficient-loftr" → eloftr_640x480.onnx           (EfficientLoFTR CVPR 2024, zahilaty export)
///   (default)         → auto: LightGlue first, then EfficientLoFTR
///
/// Override URLs:
///   FRAME_FORGE_LIGHTGLUE_URL   — mirror for LightGlue model
///   FRAME_FORGE_LOFTR_URL       — mirror for EfficientLoFTR model
/// </summary>
public class ModelAcquisitionService : IHostedService
{
    // LightGlue v2.0 pipeline model (fabio-sim/LightGlue-ONNX v2.0).
    // dl_match.rs prefers superpoint_lightglue_pipeline.onnx (v2) over the legacy fused name.
    private const string LightGlueUrl =
        "https://github.com/fabio-sim/LightGlue-ONNX/releases/download/v2.0/superpoint_lightglue_pipeline.onnx";
    private const string LightGlueFileName   = "superpoint_lightglue_pipeline.onnx";
    private const string LightGlueCustomFile = "custom-model-lightglue.onnx";

    // EfficientLoFTR: zahilaty/EfficientLoFTR-ONNX (public, no auth required).
    // Fixed 640×480 resolution export validated against the original PyTorch weights.
    // Outputs: mkpts0 (N,2), mkpts1 (N,2), mconf (N,) f32.
    private const string LoFTRUrl =
        "https://huggingface.co/zahilaty/EfficientLoFTR-ONNX/resolve/main/eloftr_640x480.onnx";
    private const string LoFTRFileName   = "eloftr_640x480.onnx";
    private const string LoFTRCustomFile = "custom-model-loftr.onnx";

    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<ModelAcquisitionService> _logger;

    /// <summary>Absolute path to the ready-to-use LightGlue model, or null if unavailable.</summary>
    public string? LightGluePath { get; private set; }

    /// <summary>Absolute path to the ready-to-use EfficientLoFTR model, or null if unavailable.</summary>
    public string? EfficientLoFTRPath { get; private set; }

    public ModelAcquisitionService(
        IApplicationPaths appPaths,
        ILogger<ModelAcquisitionService> logger)
    {
        _appPaths = appPaths;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _ = Task.Run(() => AcquireModelsAsync(cancellationToken), cancellationToken);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task AcquireModelsAsync(CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(typeof(ModelAcquisitionService).Assembly.Location)!;
        var modelsDir = Path.Combine(dir, "models");
        Directory.CreateDirectory(modelsDir);

        // Download both models in parallel — they are independent.
        var lgTask    = AcquireModelAsync(modelsDir, "LightGlue",        LightGlueCustomFile, LightGlueFileName, "FRAME_FORGE_LIGHTGLUE_URL", LightGlueUrl, ct);
        var loftrTask = AcquireModelAsync(modelsDir, "EfficientLoFTR",   LoFTRCustomFile,     LoFTRFileName,     "FRAME_FORGE_LOFTR_URL",     LoFTRUrl,     ct);

        await Task.WhenAll(lgTask, loftrTask).ConfigureAwait(false);

        LightGluePath     = lgTask.Result;
        EfficientLoFTRPath = loftrTask.Result;

        if (LightGluePath is null && EfficientLoFTRPath is null)
            _logger.LogInformation(
                "[ModelAcquisition] No DL models available — frame-forge will use AKAZE fallback");
        else
            _logger.LogInformation(
                "[ModelAcquisition] Models ready — LightGlue: {LG}, EfficientLoFTR: {LFT}",
                LightGluePath ?? "unavailable", EfficientLoFTRPath ?? "unavailable");
    }

    private async Task<string?> AcquireModelAsync(
        string modelsDir,
        string modelName,
        string customFileName,
        string cacheFileName,
        string urlEnvVar,
        string defaultUrl,
        CancellationToken ct)
    {
        // 1. User-placed custom file — skips all auto-download logic
        var customPath = Path.Combine(modelsDir, customFileName);
        if (File.Exists(customPath))
        {
            _logger.LogInformation("[ModelAcquisition] {Model}: using custom model: {Path}", modelName, customPath);
            return customPath;
        }

        var url = Environment.GetEnvironmentVariable(urlEnvVar)?.Trim()
                  is { Length: > 0 } envUrl ? envUrl : defaultUrl;

        var cachedPath = Path.Combine(modelsDir, cacheFileName);
        var etagPath   = cachedPath + ".etag";

        // Timeout is fixed at construction — HttpClient forbids changing it after the
        // first request is sent (the HEAD check below), so it must already cover the
        // slower download path that follows.
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
        http.DefaultRequestHeaders.Add("User-Agent", "JellyfinSuite/1.0");

        // 2. HEAD request — check whether the remote file has changed
        string? remoteEtag = null;
        try
        {
            using var head = await http.SendAsync(
                new HttpRequestMessage(HttpMethod.Head, url), ct).ConfigureAwait(false);

            if (head.IsSuccessStatusCode)
                remoteEtag = head.Headers.ETag?.Tag
                    ?? head.Content.Headers.LastModified?.ToString("R");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                "[ModelAcquisition] {Model}: HEAD request failed ({Msg}) — using cached model if available",
                modelName, ex.Message);
        }

        // 3. Cached file present
        if (File.Exists(cachedPath))
        {
            var storedEtag = File.Exists(etagPath)
                ? (await File.ReadAllTextAsync(etagPath, ct).ConfigureAwait(false)).Trim()
                : null;

            if (remoteEtag is null || remoteEtag == storedEtag)
            {
                if (remoteEtag == storedEtag)
                    _logger.LogDebug("[ModelAcquisition] {Model}: up to date (ETag match)", modelName);
                return cachedPath;
            }

            _logger.LogInformation(
                "[ModelAcquisition] {Model}: remote updated (ETag {Old} → {New}) — re-downloading",
                modelName, storedEtag ?? "none", remoteEtag);
        }
        else if (remoteEtag is null)
        {
            _logger.LogWarning(
                "[ModelAcquisition] {Model}: no cached model and network unreachable. " +
                "Place {File} in {Dir} to enable DL stitching.",
                modelName, cacheFileName, modelsDir);
            return null;
        }

        // 4. Download (first time or ETag changed)
        return await DownloadModelAsync(http, modelName, url, cachedPath, etagPath, remoteEtag, ct)
            .ConfigureAwait(false);
    }

    private async Task<string?> DownloadModelAsync(
        HttpClient http,
        string modelName,
        string url,
        string cachedPath,
        string etagPath,
        string? expectedEtag,
        CancellationToken ct)
    {
        var tmpPath = cachedPath + ".tmp";
        try
        {
            _logger.LogInformation("[ModelAcquisition] {Model}: downloading from {Url}", modelName, url);

            using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct)
                .ConfigureAwait(false);
            response.EnsureSuccessStatusCode();

            var totalBytes = response.Content.Headers.ContentLength;
            var etag = response.Headers.ETag?.Tag
                       ?? response.Content.Headers.LastModified?.ToString("R")
                       ?? expectedEtag;

            await using (var src = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
            await using (var dst = File.Create(tmpPath))
            {
                await CopyWithProgressAsync(modelName, src, dst, totalBytes, ct).ConfigureAwait(false);
            }

            File.Move(tmpPath, cachedPath, overwrite: true);

            if (etag is not null)
                await File.WriteAllTextAsync(etagPath, etag, ct).ConfigureAwait(false);

            var sizeMb = new FileInfo(cachedPath).Length / 1_048_576.0;
            _logger.LogInformation(
                "[ModelAcquisition] {Model}: downloaded ({Mb:F0} MB) → {Path}",
                modelName, sizeMb, cachedPath);
            return cachedPath;
        }
        catch (Exception ex)
        {
            _logger.LogError("[ModelAcquisition] {Model}: download failed: {Msg}", modelName, ex.Message);
            try { File.Delete(tmpPath); } catch { }
            return File.Exists(cachedPath) ? cachedPath : null;
        }
    }

    private async Task CopyWithProgressAsync(
        string modelName,
        Stream src, Stream dst,
        long? totalBytes,
        CancellationToken ct)
    {
        var buf = new byte[81920];
        long copied = 0;
        int n;
        var lastLog = DateTime.UtcNow;

        while ((n = await src.ReadAsync(buf, ct).ConfigureAwait(false)) > 0)
        {
            await dst.WriteAsync(buf.AsMemory(0, n), ct).ConfigureAwait(false);
            copied += n;

            if (totalBytes > 0 && DateTime.UtcNow - lastLog > TimeSpan.FromSeconds(10))
            {
                _logger.LogInformation(
                    "[ModelAcquisition] {Model}: {Pct:F0}% ({Mb:F0}/{TotalMb:F0} MB)",
                    modelName,
                    copied * 100.0 / totalBytes.Value,
                    copied / 1_048_576.0,
                    totalBytes.Value / 1_048_576.0);
                lastLog = DateTime.UtcNow;
            }
        }
    }
}
