using System.IO.Compression;
using System.Net.Http;
using System.Security.Cryptography;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

public class FontAcquisitionService : IHostedService
{
    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<FontAcquisitionService> _logger;

    /// <summary>
    /// Represents a download source: either a direct font file URL,
    /// or a ZIP archive URL with the entry path to extract.
    /// </summary>
    private record FontSource(string Url, string? ZipEntry = null);

    // Primary: GitHub raw content (global).
    // Fallback: Alibaba Cloud mirror (mirrors.aliyun.com) — reliable inside China.
    //           The mirror hosts GitHub Release ZIPs; we extract the Regular weight OTF.
    // Users may also place a custom file at the "custom-font-*.otf" path to bypass all downloads.

    // System font paths are probed before downloading.
    // Jellyfin's official Docker image (Debian bookworm) installs Noto CJK via fonts-noto-cjk
    // to /usr/share/fonts/opentype/noto/. OTF is preferred over TTC because ab_glyph only
    // reads index 0 from a TTC collection, which may not be the intended variant.
    private static readonly string[] NotoSansSystemPaths =
    [
        "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
        "/usr/share/fonts/noto-cjk/NotoSansCJKjp-Regular.otf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    ];

    private static readonly string[] NotoSerifSystemPaths =
    [
        "/usr/share/fonts/opentype/noto/NotoSerifCJKjp-Regular.otf",
        "/usr/share/fonts/noto-cjk/NotoSerifCJKjp-Regular.otf",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSerifCJK-Regular.ttc",
    ];


    // Roboto is available via fonts-roboto-hinted / fonts-roboto-unhinted on Debian/Ubuntu.
    private static readonly string[] RobotoSystemPaths =
    [
        "/usr/share/fonts/truetype/roboto/hinted/Roboto-Regular.ttf",
        "/usr/share/fonts/truetype/roboto/unhinted/Roboto-Regular.ttf",
        "/usr/share/fonts/truetype/roboto/Roboto-Regular.ttf",
        "/usr/share/fonts/roboto/Roboto-Regular.ttf",
    ];

    private static readonly string[] RobotoMonoSystemPaths =
    [
        "/usr/share/fonts/truetype/roboto/hinted/RobotoMono-Regular.ttf",
        "/usr/share/fonts/truetype/roboto/RobotoMono-Regular.ttf",
        "/usr/share/fonts/roboto/RobotoMono-Regular.ttf",
    ];

    // Oswald, Playfair Display, and Cinzel are not in standard Linux package repos,
    // but probe anyway in case the user has manually installed them.
    private static readonly string[] OswaldSystemPaths =
    [
        "/usr/share/fonts/truetype/oswald/Oswald-Regular.ttf",
        "/usr/share/fonts/oswald/Oswald-Regular.ttf",
    ];

    private static readonly string[] PlayfairSystemPaths =
    [
        "/usr/share/fonts/truetype/playfair/PlayfairDisplay-Regular.ttf",
        "/usr/share/fonts/playfair-display/PlayfairDisplay-Regular.ttf",
    ];

    private static readonly string[] CinzelSystemPaths =
    [
        "/usr/share/fonts/truetype/cinzel/Cinzel-Regular.ttf",
        "/usr/share/fonts/cinzel/Cinzel-Regular.ttf",
    ];

    private static readonly string[] VollkornSystemPaths = [];

    private static readonly FontSource[] NotoSansSources =
    [
        new("https://github.com/googlefonts/noto-cjk/raw/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf"),
        new("https://mirrors.aliyun.com/github/releases/googlefonts/noto-cjk/Sans2.004/16_NotoSansJP.zip",
            "NotoSansJP-Regular.otf"),
    ];

    private static readonly FontSource[] NotoSerifSources =
    [
        new("https://github.com/googlefonts/noto-cjk/raw/main/Serif/OTF/Japanese/NotoSerifCJKjp-Regular.otf"),
        new("https://mirrors.aliyun.com/github/releases/googlefonts/noto-cjk/Serif2.003/12_NotoSerifJP.zip",
            "NotoSerifJP-Regular.otf"),
    ];

    private static readonly FontSource[] RobotoMonoSources =
    [
        // fontsource npm → jsDelivr CDN (backed by npm registry, extremely stable)
        new("https://cdn.jsdelivr.net/npm/@fontsource/roboto-mono@5/files/roboto-mono-latin-400-normal.woff2"),
        new("https://unpkg.com/@fontsource/roboto-mono@5/files/roboto-mono-latin-400-normal.woff2"),
    ];

    private static readonly FontSource[] RobotoSources =
    [
        new("https://cdn.jsdelivr.net/npm/@fontsource/roboto@5/files/roboto-latin-400-normal.woff2"),
        new("https://unpkg.com/@fontsource/roboto@5/files/roboto-latin-400-normal.woff2"),
    ];

    private static readonly FontSource[] OswaldSources =
    [
        new("https://cdn.jsdelivr.net/npm/@fontsource/oswald@5/files/oswald-latin-400-normal.woff2"),
        new("https://unpkg.com/@fontsource/oswald@5/files/oswald-latin-400-normal.woff2"),
    ];

    private static readonly FontSource[] PlayfairSources =
    [
        new("https://cdn.jsdelivr.net/npm/@fontsource/playfair-display@5/files/playfair-display-latin-400-normal.woff2"),
        new("https://unpkg.com/@fontsource/playfair-display@5/files/playfair-display-latin-400-normal.woff2"),
    ];

    private static readonly FontSource[] CinzelSources =
    [
        new("https://cdn.jsdelivr.net/npm/@fontsource/cinzel@5/files/cinzel-latin-400-normal.woff2"),
        new("https://unpkg.com/@fontsource/cinzel@5/files/cinzel-latin-400-normal.woff2"),
    ];

    private static readonly FontSource[] VollkornSources =
    [
        new("https://cdn.jsdelivr.net/npm/@fontsource/vollkorn@5/files/vollkorn-latin-400-normal.woff2"),
        new("https://unpkg.com/@fontsource/vollkorn@5/files/vollkorn-latin-400-normal.woff2"),
    ];

    public string? NotoSansPath { get; private set; }
    public string? NotoSerifPath { get; private set; }
    public string? RobotoMonoPath { get; private set; }
    public string? RobotoPath { get; private set; }
    public string? OswaldPath { get; private set; }
    public string? PlayfairPath { get; private set; }
    public string? CinzelPath { get; private set; }
    public string? VollkornPath { get; private set; }

    public FontAcquisitionService(
        IApplicationPaths appPaths,
        ILogger<FontAcquisitionService> logger)
    {
        _appPaths = appPaths;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _ = Task.Run(() => AcquireFontsAsync(cancellationToken), cancellationToken);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task AcquireFontsAsync(CancellationToken ct)
    {
        var fontsDir = Path.Combine(_appPaths.DataPath, "fonts");
        Directory.CreateDirectory(fontsDir);

        NotoSansPath = await AcquireFontAsync(
            fontsDir, "NotoSansJP.otf", "custom-font-sans.otf", NotoSansSources, ct, NotoSansSystemPaths);
        NotoSerifPath = await AcquireFontAsync(
            fontsDir, "NotoSerifJP.otf", "custom-font-serif.otf", NotoSerifSources, ct, NotoSerifSystemPaths);
        RobotoMonoPath = await AcquireFontAsync(
            fontsDir, "RobotoMono-Regular.woff2", "custom-font-mono.ttf", RobotoMonoSources, ct, RobotoMonoSystemPaths);
        RobotoPath = await AcquireFontAsync(
            fontsDir, "Roboto-Regular.woff2", "custom-font-roboto.ttf", RobotoSources, ct, RobotoSystemPaths);
        OswaldPath = await AcquireFontAsync(
            fontsDir, "Oswald-Regular.woff2", "custom-font-oswald.ttf", OswaldSources, ct, OswaldSystemPaths);
        PlayfairPath = await AcquireFontAsync(
            fontsDir, "PlayfairDisplay-Regular.woff2", "custom-font-playfair.ttf", PlayfairSources, ct, PlayfairSystemPaths);
        CinzelPath = await AcquireFontAsync(
            fontsDir, "Cinzel-Regular.woff2", "custom-font-cinzel.ttf", CinzelSources, ct, CinzelSystemPaths);
        VollkornPath = await AcquireFontAsync(
            fontsDir, "Vollkorn-Regular.woff2", "custom-font-vollkorn.ttf", VollkornSources, ct, VollkornSystemPaths);
    }

    private async Task<string?> AcquireFontAsync(
        string fontsDir, string cacheFileName, string customFileName,
        IReadOnlyList<FontSource> sources, CancellationToken ct,
        IReadOnlyList<string>? systemPaths = null)
    {
        // 1. User-placed custom file takes top priority — no download needed
        var customPath = Path.Combine(fontsDir, customFileName);
        if (File.Exists(customPath)) return customPath;

        // 2. Bundled font — ships inside the "Jellyfin Recents + Fonts" release zip alongside the DLL.
        //    The zip extracts fonts/ next to JellyfinSuite.Plugin.dll, so probing the assembly
        //    directory requires no data-path write and works immediately after install.
        var assemblyDir = Path.GetDirectoryName(typeof(FontAcquisitionService).Assembly.Location);
        if (assemblyDir is not null)
        {
            var bundledPath = Path.Combine(assemblyDir, "fonts", cacheFileName);
            if (File.Exists(bundledPath))
            {
                _logger.LogInformation("Using bundled font: {Path}", bundledPath);
                return bundledPath;
            }
        }

        // 3. System font probe — use OS-installed font if available (no download needed).
        //    OTF is listed before TTC so ab_glyph gets a single-font file; TTC index 0
        //    may not be the intended variant when multiple languages are packed together.
        if (systemPaths is not null)
        {
            foreach (var sysPath in systemPaths)
            {
                if (File.Exists(sysPath))
                {
                    _logger.LogInformation("Using system font: {Path}", sysPath);
                    return sysPath;
                }
            }
        }

        // 4. Already cached and checksum valid
        var cachedPath = Path.Combine(fontsDir, cacheFileName);
        var checksumPath = cachedPath + ".sha256";
        if (File.Exists(cachedPath) && File.Exists(checksumPath))
        {
            try
            {
                var expectedHash = await File.ReadAllTextAsync(checksumPath, ct);
                var actualHash = await ComputeFileHashAsync(cachedPath, ct);
                if (string.Equals(expectedHash.Trim(), actualHash, StringComparison.OrdinalIgnoreCase))
                    return cachedPath;
            }
            catch { /* checksum mismatch — fall through to re-download */ }
        }

        // 5. Alternate-extension fallback: e.g., Roboto-Regular.ttf exists but we now look for .woff2.
        //    Avoids re-downloading when the only change is the target extension.
        var baseNoExt = Path.GetFileNameWithoutExtension(cacheFileName);
        foreach (var altExt in new[] { ".woff2", ".ttf", ".otf", ".woff" })
        {
            if (string.Equals(altExt, Path.GetExtension(cacheFileName), StringComparison.OrdinalIgnoreCase))
                continue;
            var altPath = Path.Combine(fontsDir, baseNoExt + altExt);
            if (File.Exists(altPath))
            {
                _logger.LogInformation("Using cached font (alternate format {Ext}): {Path}", altExt, altPath);
                return altPath;
            }
        }

        // 6. Try each source in order; return on first success
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        foreach (var source in sources)
        {
            try
            {
                _logger.LogInformation("Downloading font from {Url}", source.Url);
                var raw = await http.GetByteArrayAsync(source.Url, ct);

                var fontBytes = source.ZipEntry is not null
                    ? ExtractFromZip(raw, source.ZipEntry)
                    : raw;

                await File.WriteAllBytesAsync(cachedPath, fontBytes, ct);
                var hash = ComputeHash(fontBytes);
                await File.WriteAllTextAsync(checksumPath, hash, ct);
                _logger.LogInformation("Font saved to {Path}", cachedPath);
                return cachedPath;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("Font download failed from {Url}: {Message}", source.Url, ex.Message);
            }
        }

        _logger.LogError(
            "All font sources failed for {File}. " +
            "To install manually, place the font file at {Path}",
            cacheFileName, customPath);
        return null;
    }

    private static byte[] ExtractFromZip(byte[] zipBytes, string entryName)
    {
        using var ms = new MemoryStream(zipBytes);
        using var zip = new ZipArchive(ms, ZipArchiveMode.Read);

        // Match by filename only — ignore subdirectory prefix if present
        var entry = zip.Entries.FirstOrDefault(e =>
            string.Equals(Path.GetFileName(e.FullName), entryName, StringComparison.OrdinalIgnoreCase))
            ?? throw new FileNotFoundException($"Entry '{entryName}' not found in ZIP.");

        using var stream = entry.Open();
        using var result = new MemoryStream();
        stream.CopyTo(result);
        return result.ToArray();
    }

    private static async Task<string> ComputeFileHashAsync(string path, CancellationToken ct)
    {
        await using var fs = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(fs, ct);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static string ComputeHash(byte[] data)
    {
        var hash = SHA256.HashData(data);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
