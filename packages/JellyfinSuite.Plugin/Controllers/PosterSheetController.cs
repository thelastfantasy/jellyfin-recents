using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinSuite.Models;
using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Controllers;

[ApiController]
[Route("JellyfinSuite/PosterSheet")]
[Authorize]
public class PosterSheetController : ControllerBase
{
    private readonly PosterSheetJobService _jobService;
    private readonly FontAcquisitionService _fontService;
    private readonly ILibraryManager _libraryManager;
    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<PosterSheetController> _logger;

    private string FontsDir => Path.Combine(_appPaths.DataPath, "fonts");

    public PosterSheetController(
        PosterSheetJobService jobService,
        FontAcquisitionService fontService,
        ILibraryManager libraryManager,
        IApplicationPaths appPaths,
        ILogger<PosterSheetController> logger)
    {
        _jobService = jobService;
        _fontService = fontService;
        _libraryManager = libraryManager;
        _appPaths = appPaths;
        _logger = logger;
    }

    /// <summary>
    /// Start (or return existing) poster sheet generation job for an item.
    /// </summary>
    [HttpPost("{itemId}")]
    [ProducesResponseType(typeof(StartJobResponseDto), StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status422UnprocessableEntity)]
    public IActionResult StartJob(string itemId, [FromBody] PosterSheetRequestDto req)
    {
        if (!Guid.TryParse(itemId, out var itemGuid))
            return BadRequest("Invalid itemId format.");

        var item = _libraryManager.GetItemById(itemGuid);
        if (item is null)
            return NotFound($"Item {itemId} not found.");

        // Must be a video with valid runtime
        if (item.MediaType != MediaType.Video)
            return UnprocessableEntity("Item is not a video.");

        if (!item.RunTimeTicks.HasValue || item.RunTimeTicks.Value <= 0)
            return UnprocessableEntity("Item has no valid duration.");

        var durationSeconds = item.RunTimeTicks.Value / 10_000_000.0;
        var requiredFrames = req.Rows * req.Cols;
        var maxFrames = (int)Math.Floor(durationSeconds / 1.0);

        // Require at least 1 second per frame (min spacing)
        if (requiredFrames > maxFrames)
            return BadRequest(
                $"Grid too large for video duration. Maximum {maxFrames} frames (1s spacing). Requested: {requiredFrames}.");

        var inputPath = item.Path;
        if (string.IsNullOrEmpty(inputPath))
            return UnprocessableEntity("Item has no file path.");

        var job = _jobService.GetOrCreateJob(itemId, item.Name, req, inputPath);

        return Accepted(new StartJobResponseDto { JobId = job.Id });
    }

    /// <summary>
    /// List all known poster sheet jobs (for UI restore after navigation).
    /// </summary>
    [HttpGet("jobs")]
    [ProducesResponseType(typeof(IEnumerable<PosterSheetStatusDto>), StatusCodes.Status200OK)]
    public IActionResult ListJobs()
    {
        var dtos = _jobService.GetAllJobs().Select(job => new PosterSheetStatusDto
        {
            JobId = job.Id,
            ItemId = job.ItemId,
            ItemTitle = job.ItemTitle,
            Status = job.Status.ToString().ToLowerInvariant(),
            Progress = job.Progress,
            Total = job.Total,
            Error = job.Error,
            MediaInfo = job.MediaInfo,
            CreatedAt = new DateTimeOffset(job.CreatedAt, TimeSpan.Zero).ToUnixTimeMilliseconds(),
        });
        return Ok(dtos);
    }

    /// <summary>
    /// Get status of a poster sheet job.
    /// </summary>
    [HttpGet("{jobId}/status")]
    [ProducesResponseType(typeof(PosterSheetStatusDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult GetStatus(string jobId)
    {
        var job = _jobService.GetJob(jobId);
        if (job is null)
            return NotFound($"Job {jobId} not found.");

        return Ok(new PosterSheetStatusDto
        {
            JobId = job.Id,
            ItemId = job.ItemId,
            Status = job.Status.ToString().ToLowerInvariant(),
            Progress = job.Progress,
            Total = job.Total,
            Error = job.Error,
            MediaInfo = job.MediaInfo,
        });
    }

    /// <summary>
    /// Download the completed poster sheet image.
    /// </summary>
    [HttpGet("{jobId}/image")]
    [ProducesResponseType(typeof(FileContentResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public IActionResult GetImage(string jobId)
    {
        var job = _jobService.GetJob(jobId);
        if (job is null)
            return NotFound($"Job {jobId} not found.");

        if (job.Status != JobStatus.Done)
            return Conflict($"Job is not complete (status: {job.Status}).");

        if (string.IsNullOrEmpty(job.OutputPath) || !System.IO.File.Exists(job.OutputPath))
            return NotFound("Output file not found.");

        var bytes = System.IO.File.ReadAllBytes(job.OutputPath);
            return File(bytes, "image/webp");
    }

    /// <summary>
    /// Server-Sent Events stream for real-time job progress.
    /// Authenticate via ?api_key= query param (EventSource cannot set custom headers).
    /// </summary>
    [HttpGet("{jobId}/stream")]
    public async Task StreamStatus(string jobId, CancellationToken cancellationToken)
    {
        var job = _jobService.GetJob(jobId);
        if (job is null)
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        Response.Headers["Content-Type"] = "text/event-stream; charset=utf-8";
        Response.Headers["Cache-Control"] = "no-cache, no-store";
        Response.Headers["X-Accel-Buffering"] = "no";

        var serializerOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        };

        while (!cancellationToken.IsCancellationRequested)
        {
            var dto = new PosterSheetStatusDto
            {
                JobId = job.Id,
                ItemId = job.ItemId,
                Status = job.Status.ToString().ToLowerInvariant(),
                Progress = job.Progress,
                Total = job.Total,
                Error = job.Error,
                MediaInfo = job.MediaInfo,
            };

            var json = JsonSerializer.Serialize(dto, serializerOptions);
            var payload = Encoding.UTF8.GetBytes($"data: {json}\n\n");

            try
            {
                await Response.Body.WriteAsync(payload, cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            if (job.Status is JobStatus.Done or JobStatus.Error or JobStatus.Cancelled)
                break;

            try
            {
                await Task.Delay(500, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    /// <summary>
    /// Cancel (if running), delete the output file, and remove the job from memory.
    /// </summary>
    [HttpDelete("{jobId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult DeleteJob(string jobId)
    {
        var job = _jobService.GetJob(jobId);
        if (job is null)
            return NotFound($"Job {jobId} not found.");

        _jobService.DeleteJob(jobId);
        return NoContent();
    }

    /// <summary>
    /// Generate a preview image for overlay settings (synchronous, short-lived).
    /// AllowAnonymous: stateless sample image, no user data involved (FR-031).
    /// </summary>
    [HttpPost("preview")]
    [AllowAnonymous]
    [ProducesResponseType(typeof(FileContentResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> Preview([FromBody] PreviewRequestDto req)
    {
        var binaryPath = PosterSheetJobService.GetBinaryPath();
        if (!System.IO.File.Exists(binaryPath))
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                "poster-gen binary not available.");

        // Require at least one font to be ready
        if (_fontService.NotoSansPath is null && _fontService.NotoSerifPath is null)
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                "Fonts are not yet available. Please retry shortly.");

        var tempOutput = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(),
            $"postersheet-preview-{Guid.NewGuid():N}.webp");

        try
        {
            var args = _jobService.BuildPreviewArgs(req, tempOutput);
            _logger.LogInformation("Preview args: {Binary} {Args}", binaryPath, args);

            var psi = new System.Diagnostics.ProcessStartInfo(binaryPath, args)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            using var process = System.Diagnostics.Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start poster-gen");

            cts.Token.Register(() => { try { process.Kill(); } catch { } });

            string? errorLine = null;
            bool done = false;

            // Read stderr in parallel to prevent pipe-buffer deadlock
            var stderrTask = process.StandardError.ReadToEndAsync();

            string? line;
            while ((line = await process.StandardOutput.ReadLineAsync()) != null)
            {
                if (line.StartsWith("DONE", StringComparison.Ordinal)) done = true;
                else if (line.StartsWith("ERROR ", StringComparison.Ordinal)) errorLine = line[6..];
            }

            var stderrOutput = await stderrTask;
            await process.WaitForExitAsync(cts.Token);

            if (!string.IsNullOrWhiteSpace(stderrOutput))
                _logger.LogWarning("Preview stderr: {Stderr}", stderrOutput);

            if (!done || !System.IO.File.Exists(tempOutput))
            {
                var err = errorLine
                    ?? (string.IsNullOrWhiteSpace(stderrOutput) ? null : stderrOutput.Trim())
                    ?? $"poster-gen exited with code {process.ExitCode}";
                _logger.LogError("Preview failed: {Error}", err);
                return BadRequest($"Preview generation failed: {err}");
            }

            var bytes = await System.IO.File.ReadAllBytesAsync(tempOutput);
        return File(bytes, "image/webp");
        }
        finally
        {
            if (System.IO.File.Exists(tempOutput))
                try { System.IO.File.Delete(tempOutput); } catch { }
        }
    }

    /// <summary>
    /// Check whether a poster sheet is already cached for given parameters.
    /// </summary>
    [HttpGet("cache/{itemId}")]
    [ProducesResponseType(typeof(CacheCheckResponseDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public IActionResult CheckCache(
        string itemId,
        [FromQuery] int rows,
        [FromQuery] int cols,
        [FromQuery] int thumbWidth,
        [FromQuery] string seed,
        [FromQuery] string overlayHash)
    {
        if (_jobService.TryGetCachedPath(itemId, rows, cols, thumbWidth, seed, overlayHash, out _))
        {
            var activeJobId = _jobService.GetActiveJobIdForItem(itemId);
            return Ok(new CacheCheckResponseDto { Cached = true, JobId = activeJobId });
        }

        return NoContent();
    }

    [HttpGet("fonts")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult ListUserFonts()
    {
        Directory.CreateDirectory(FontsDir);
        var cache = ReadFontMetaCache();

        var result = Directory.GetFiles(FontsDir)
            .Select(path => new { path, name = Path.GetFileName(path) })
            .Where(x => x.name != null && x.name.StartsWith("custom-", StringComparison.Ordinal) &&
                (x.name.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase) ||
                 x.name.EndsWith(".otf", StringComparison.OrdinalIgnoreCase) ||
                 x.name.EndsWith(".woff", StringComparison.OrdinalIgnoreCase) ||
                 x.name.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase)))
            .Select(x =>
            {
                var key = Path.GetFileNameWithoutExtension(x.name)!;
                if (cache.TryGetValue(key, out var cached)) return cached;

                // Cache miss — parse and persist (e.g. fonts uploaded before this feature)
                var ext = Path.GetExtension(x.name).ToLowerInvariant();
                try
                {
                    var bytes = System.IO.File.ReadAllBytes(x.path);
                    var displayName = ext is ".woff" or ".woff2"
                        ? key["custom-".Length..]
                        : (ReadFontFamilyName(bytes) ?? key);
                    var record = AnalyzeFontMeta(key, displayName, bytes, ext);
                    SaveToFontMetaCache(record);
                    return record;
                }
                catch { return new FontMetaRecord { Key = key, DisplayName = key, Script = "latin", Format = ext.TrimStart('.') }; }
            })
            .OrderBy(x => x.Key)
            .ToArray();
        return Ok(result);
    }

    private const long FontMaxBytes = 30L * 1024 * 1024;

    // Valid font magic bytes — TTC excluded: ab_glyph reads only index 0 of a collection.
    private static readonly byte[][] FontMagics =
    [
        [0x00, 0x01, 0x00, 0x00], // TrueType 1.0
        [0x74, 0x72, 0x75, 0x65], // 'true'  Mac TrueType
        [0x4F, 0x54, 0x54, 0x4F], // 'OTTO'  OpenType / CFF
        [0x77, 0x4F, 0x46, 0x46], // 'wOFF'  WOFF1 — ttf-parser handles natively
        [0x77, 0x4F, 0x46, 0x32], // 'wOF2'  WOFF2 — decoded by poster-gen at render time
    ];

    [HttpPost("fonts")]
    [RequestSizeLimit(FontMaxBytes)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> UploadFont(IFormFile file)
    {
        // 1. Extension whitelist
        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (ext != ".ttf" && ext != ".otf" && ext != ".woff" && ext != ".woff2")
            return BadRequest("Only .ttf, .otf, .woff, and .woff2 font files are accepted.");

        // 2. Declared size limit (guards against unbuffered streams)
        if (file.Length > FontMaxBytes)
            return BadRequest("Font file exceeds 30 MB limit.");

        // 3. Read into memory (size already bounded above)
        byte[] fontBytes;
        using (var ms = new MemoryStream((int)Math.Min(file.Length, FontMaxBytes)))
        {
            await file.CopyToAsync(ms);
            fontBytes = ms.ToArray();
        }

        // 4. Magic-byte validation — rejects renamed zips, executables, PDFs, etc.
        if (!HasValidFontMagic(fontBytes))
            return BadRequest("File header is not a valid TTF, OTF, WOFF, or WOFF2 font.");

        // 5. Read font family name. WOFF/WOFF2 tables are compressed so the sfnt parser
        //    cannot read them directly — fall back to the uploaded filename in that case.
        string internalName;
        bool isWoff = ext == ".woff" || ext == ".woff2";
        if (isWoff)
        {
            internalName = Path.GetFileNameWithoutExtension(file.FileName);
        }
        else
        {
            var parsedName = ReadFontFamilyName(fontBytes);
            if (string.IsNullOrWhiteSpace(parsedName))
                return BadRequest("Could not read font family name from file.");
            internalName = parsedName;
        }

        var sanitized = SanitizeFontName(internalName);
        if (string.IsNullOrEmpty(sanitized))
            return BadRequest("Font family name contains no usable characters.");

        Directory.CreateDirectory(FontsDir);

        // Remove any same-name file with a different extension to prevent duplicate keys.
        foreach (var altExt in new[] { ".ttf", ".otf", ".woff", ".woff2" })
        {
            if (string.Equals(altExt, ext, StringComparison.OrdinalIgnoreCase)) continue;
            var altPath = Path.Combine(FontsDir, $"custom-{sanitized}{altExt}");
            if (System.IO.File.Exists(altPath)) System.IO.File.Delete(altPath);
        }

        var dest = Path.Combine(FontsDir, $"custom-{sanitized}{ext}");
        await System.IO.File.WriteAllBytesAsync(dest, fontBytes);

        // Analyze and cache font metadata
        var meta = AnalyzeFontMeta($"custom-{sanitized}", internalName, fontBytes, ext);
        SaveToFontMetaCache(meta);

        return Ok(meta);
    }

    internal static bool HasValidFontMagic(byte[] data)
    {
        if (data.Length < 4) return false;
        foreach (var magic in FontMagics)
        {
            if (data[0] == magic[0] && data[1] == magic[1] &&
                data[2] == magic[2] && data[3] == magic[3])
                return true;
        }
        return false;
    }

    internal static string? ReadFontFamilyName(byte[] data)
    {
        try
        {
            using var ms = new MemoryStream(data);
            using var br = new BinaryReader(ms);

            R32(br); // sfVersion
            var numTables = R16(br);
            br.ReadBytes(6); // searchRange + entrySelector + rangeShift

            long nameTableOffset = -1;
            for (int i = 0; i < numTables; i++)
            {
                var tag = new string(br.ReadChars(4));
                br.ReadBytes(4); // checksum
                var offset = R32(br);
                br.ReadBytes(4); // length
                if (tag == "name") nameTableOffset = offset;
            }

            if (nameTableOffset < 0) return null;

            ms.Seek(nameTableOffset, SeekOrigin.Begin);
            R16(br); // format
            var count = R16(br);
            var strOffset = R16(br);

            string? preferred = null, family = null, full = null;

            for (int i = 0; i < count; i++)
            {
                var platformId = R16(br);
                var encodingId = R16(br);
                R16(br); // languageId
                var nameId = R16(br);
                var length = R16(br);
                var strOff = R16(br);

                // Windows platform (3) + Unicode BMP encoding (1) only
                if (platformId != 3 || encodingId != 1) continue;
                if (nameId is not (1 or 4 or 16)) continue;

                var savedPos = ms.Position;
                ms.Seek(nameTableOffset + strOffset + strOff, SeekOrigin.Begin);
                var nameBytes = br.ReadBytes(length);
                var str = Encoding.BigEndianUnicode.GetString(nameBytes);
                ms.Seek(savedPos, SeekOrigin.Begin);

                if (nameId == 16 && preferred == null) preferred = str;
                else if (nameId == 1 && family == null) family = str;
                else if (nameId == 4 && full == null) full = str;
            }

            // Preferred Family > Family > Full Name
            return preferred ?? family ?? full;
        }
        catch { return null; }
    }

    internal static string SanitizeFontName(string name)
    {
        var sb = new StringBuilder();
        foreach (var ch in name)
        {
            if (char.IsLetterOrDigit(ch))
                sb.Append(ch);
            else if (sb.Length > 0 && sb[sb.Length - 1] != '-')
                sb.Append('-');
        }
        var result = sb.ToString().Trim('-');
        return result.Length > 64 ? result[..64] : result;
    }

    /// Returns true if the font's cmap format-4 subtable covers any segment in the CJK
    /// Unified Ideographs range (U+4E00–U+9FFF), indicating a CJK-capable font.
    internal static bool FontCoversCjk(byte[] data)
    {
        try
        {
            using var ms = new MemoryStream(data);
            using var br = new BinaryReader(ms);

            R32(br); // sfVersion
            var numTables = R16(br);
            br.ReadBytes(6); // searchRange + entrySelector + rangeShift

            long cmapTableOffset = -1;
            for (int i = 0; i < numTables; i++)
            {
                var tag = new string(br.ReadChars(4));
                br.ReadBytes(4); // checksum
                var offset = R32(br);
                br.ReadBytes(4); // length
                if (tag == "cmap") cmapTableOffset = (long)offset;
            }
            if (cmapTableOffset < 0) return false;

            ms.Seek(cmapTableOffset, SeekOrigin.Begin);
            R16(br); // cmap version
            var numSubtables = R16(br);

            long format4Offset = -1;
            for (int i = 0; i < numSubtables; i++)
            {
                var platformId = R16(br);
                var encodingId = R16(br);
                var subtableOff = R32(br);
                // Platform 3 (Windows), Encoding 1 (Unicode BMP) — standard cmap subtable
                if (platformId == 3 && encodingId == 1 && format4Offset < 0)
                    format4Offset = cmapTableOffset + (long)subtableOff;
            }
            if (format4Offset < 0) return false;

            ms.Seek(format4Offset, SeekOrigin.Begin);
            var format = R16(br);
            if (format != 4) return false;
            R16(br); // length
            R16(br); // language
            var segCountX2 = R16(br);
            var segCount = segCountX2 / 2;
            br.ReadBytes(6); // searchRange + entrySelector + rangeShift

            var endCounts   = new int[segCount];
            var startCounts = new int[segCount];
            for (int i = 0; i < segCount; i++) endCounts[i] = R16(br);
            R16(br); // reservedPad
            for (int i = 0; i < segCount; i++) startCounts[i] = R16(br);

            // Check if any segment overlaps the CJK Unified Ideographs block (U+4E00–U+9FFF)
            const int cjkStart = 0x4E00;
            const int cjkEnd   = 0x9FFF;
            for (int i = 0; i < segCount; i++)
            {
                if (startCounts[i] <= cjkEnd && endCounts[i] >= cjkStart)
                    return true;
            }
            return false;
        }
        catch { return false; }
    }

    private static ushort R16(BinaryReader br)
    {
        var b = br.ReadBytes(2);
        return (ushort)((b[0] << 8) | b[1]);
    }

    private static uint R32(BinaryReader br)
    {
        var b = br.ReadBytes(4);
        return ((uint)b[0] << 24) | ((uint)b[1] << 16) | ((uint)b[2] << 8) | b[3];
    }

    // ── Font metadata cache ────────────────────────────────────────────────

    private sealed class FontMetaRecord
    {
        public string Key { get; set; } = string.Empty;
        public string DisplayName { get; set; } = string.Empty;
        public string Script { get; set; } = "latin";
        public string Format { get; set; } = "ttf";
        public bool? IsSerif { get; set; }
        public bool? IsMonospace { get; set; }
        public bool? IsBold { get; set; }
        public bool? IsItalic { get; set; }
        public bool? HasLigatures { get; set; }
    }

    private string FontMetaCachePath => Path.Combine(FontsDir, "meta.json");

    private static readonly JsonSerializerOptions _cacheJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private Dictionary<string, FontMetaRecord> ReadFontMetaCache()
    {
        try
        {
            if (!System.IO.File.Exists(FontMetaCachePath)) return new();
            var json = System.IO.File.ReadAllText(FontMetaCachePath);
            return JsonSerializer.Deserialize<Dictionary<string, FontMetaRecord>>(json, _cacheJsonOptions) ?? new();
        }
        catch { return new(); }
    }

    private void WriteFontMetaCache(Dictionary<string, FontMetaRecord> cache)
    {
        try
        {
            Directory.CreateDirectory(FontsDir);
            System.IO.File.WriteAllText(FontMetaCachePath, JsonSerializer.Serialize(cache, _cacheJsonOptions));
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Failed to write font meta cache: {Message}", ex.Message);
        }
    }

    private void SaveToFontMetaCache(FontMetaRecord record)
    {
        var cache = ReadFontMetaCache();
        cache[record.Key] = record;
        WriteFontMetaCache(cache);
    }

    private void RemoveFromFontMetaCache(string key)
    {
        var cache = ReadFontMetaCache();
        if (cache.Remove(key))
            WriteFontMetaCache(cache);
    }

    // ── Font metadata analysis ─────────────────────────────────────────────

    private static (short familyClass, byte[] panose, ushort fsSelection)? ReadOs2Table(byte[] data)
    {
        try
        {
            using var ms = new MemoryStream(data);
            using var br = new BinaryReader(ms);
            R32(br); var numTables = R16(br); br.ReadBytes(6);
            long os2Offset = -1;
            for (int i = 0; i < numTables; i++)
            {
                var tag = new string(br.ReadChars(4)); br.ReadBytes(4);
                var off = R32(br); br.ReadBytes(4);
                if (tag == "OS/2") os2Offset = off;
            }
            if (os2Offset < 0) return null;
            ms.Seek(os2Offset, SeekOrigin.Begin);
            br.ReadBytes(30);                  // skip 15 × uint16 fields
            var familyClass = (short)R16(br);  // offset 30
            var panose = br.ReadBytes(10);      // offset 32
            br.ReadBytes(20);                   // ulUnicodeRange1-4 + achVendID
            var fsSelection = R16(br);          // offset 62
            return (familyClass, panose, fsSelection);
        }
        catch { return null; }
    }

    private static bool ReadGsubHasLigatures(byte[] data)
    {
        try
        {
            using var ms = new MemoryStream(data);
            using var br = new BinaryReader(ms);
            R32(br); var numTables = R16(br); br.ReadBytes(6);
            long gsubOffset = -1;
            for (int i = 0; i < numTables; i++)
            {
                var tag = new string(br.ReadChars(4)); br.ReadBytes(4);
                var off = R32(br); br.ReadBytes(4);
                if (tag == "GSUB") gsubOffset = off;
            }
            if (gsubOffset < 0) return false;
            ms.Seek(gsubOffset, SeekOrigin.Begin);
            R16(br); R16(br); R16(br);               // MajorVersion + MinorVersion + ScriptListOffset
            var featureListOff = R16(br);
            ms.Seek(gsubOffset + featureListOff, SeekOrigin.Begin);
            var featureCount = R16(br);
            for (int i = 0; i < featureCount; i++)
            {
                var tag = new string(br.ReadChars(4));
                R16(br); // FeatureOffset
                if (tag is "liga" or "calt") return true;
            }
            return false;
        }
        catch { return false; }
    }

    private static bool FontIsMonospace(byte[] data)
    {
        try
        {
            using var ms = new MemoryStream(data);
            using var br = new BinaryReader(ms);
            R32(br); var numTables = R16(br); br.ReadBytes(6);
            long hheaOffset = -1, hmtxOffset = -1; uint hmtxLength = 0;
            for (int i = 0; i < numTables; i++)
            {
                var tag = new string(br.ReadChars(4)); br.ReadBytes(4);
                var off = R32(br); var len = R32(br);
                if (tag == "hhea") hheaOffset = off;
                else if (tag == "hmtx") { hmtxOffset = off; hmtxLength = len; }
            }
            if (hheaOffset < 0 || hmtxOffset < 0) return false;

            // numberOfHMetrics is at offset 34 within hhea
            ms.Seek(hheaOffset + 34, SeekOrigin.Begin);
            var numHMetrics = R16(br);
            if (numHMetrics == 0) return false;
            if (numHMetrics == 1) return true; // all glyphs share one advance width

            ms.Seek(hmtxOffset, SeekOrigin.Begin);
            var firstWidth = R16(br); R16(br); // first lsb
            for (int i = 1; i < numHMetrics && ms.Position + 4 <= hmtxOffset + hmtxLength; i++)
            {
                if (R16(br) != firstWidth) return false;
                R16(br); // lsb
            }
            return true;
        }
        catch { return false; }
    }

    private static bool FontCoversEmoji(byte[] data)
    {
        try
        {
            using var ms = new MemoryStream(data);
            using var br = new BinaryReader(ms);
            R32(br); var numTables = R16(br); br.ReadBytes(6);
            for (int i = 0; i < numTables; i++)
            {
                var tag = new string(br.ReadChars(4));
                br.ReadBytes(12); // checksum + offset + length
                if (tag is "CBDT" or "CBLC" or "COLR" or "CPAL" or "sbix") return true;
            }
            return false;
        }
        catch { return false; }
    }

    private static FontMetaRecord AnalyzeFontMeta(string key, string displayName, byte[] fontBytes, string ext)
    {
        var format = ext.TrimStart('.');
        bool isWoff = ext is ".woff" or ".woff2";

        if (isWoff)
            return new FontMetaRecord { Key = key, DisplayName = displayName, Script = "latin", Format = format };

        var script = "latin";
        bool? isSerif = null, isBold = null, isItalic = null;

        if (FontCoversEmoji(fontBytes))
            return new FontMetaRecord { Key = key, DisplayName = displayName, Script = "emoji", Format = format };

        if (FontCoversCjk(fontBytes)) script = "cjk";

        var os2 = ReadOs2Table(fontBytes);
        if (os2 != null)
        {
            var (familyClass, _, fsSelection) = os2.Value;
            var classId = (familyClass >> 8) & 0xFF;
            if (classId == 12) script = "symbol";
            isSerif = classId switch { 1 or 2 or 3 or 4 or 5 or 7 => true, 8 => false, _ => null };
            isBold   = (fsSelection & 0x0020) != 0;
            isItalic = (fsSelection & 0x0001) != 0;
        }

        return new FontMetaRecord
        {
            Key = key, DisplayName = displayName, Script = script, Format = format,
            IsSerif = isSerif, IsMonospace = FontIsMonospace(fontBytes),
            IsBold = isBold, IsItalic = isItalic, HasLigatures = ReadGsubHasLigatures(fontBytes),
        };
    }

    [HttpDelete("fonts/{key}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult DeleteUserFont(string key)
    {
        if (!key.StartsWith("custom-", StringComparison.Ordinal))
            return BadRequest("Only user-uploaded fonts (prefixed with 'custom-') can be deleted.");

        Directory.CreateDirectory(FontsDir);
        var ttf   = Path.Combine(FontsDir, key + ".ttf");
        var otf   = Path.Combine(FontsDir, key + ".otf");
        var woff  = Path.Combine(FontsDir, key + ".woff");
        var woff2 = Path.Combine(FontsDir, key + ".woff2");

        bool deleted = false;
        if (System.IO.File.Exists(ttf))   { System.IO.File.Delete(ttf);   deleted = true; }
        if (System.IO.File.Exists(otf))   { System.IO.File.Delete(otf);   deleted = true; }
        if (System.IO.File.Exists(woff))  { System.IO.File.Delete(woff);  deleted = true; }
        if (System.IO.File.Exists(woff2)) { System.IO.File.Delete(woff2); deleted = true; }

        if (!deleted) return NotFound($"Font '{key}' not found.");

        RemoveFromFontMetaCache(key);
        return NoContent();
    }
}
