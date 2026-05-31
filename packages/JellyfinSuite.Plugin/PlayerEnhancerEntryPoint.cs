using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite;

/// <summary>
/// Hosted service that patches Jellyfin's index.html on startup to auto-load the player enhancer ESM bundle.
/// </summary>
public class PlayerEnhancerEntryPoint : IHostedService
{
    internal const string EnhancerUrl = "/JellyfinSuite/PlayerEnhancer/Launcher";

    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<PlayerEnhancerEntryPoint> _logger;
    private readonly IHostApplicationLifetime _lifetime;

    public PlayerEnhancerEntryPoint(
        IApplicationPaths appPaths,
        ILogger<PlayerEnhancerEntryPoint> logger,
        IHostApplicationLifetime lifetime)
    {
        _appPaths = appPaths;
        _logger = logger;
        _lifetime = lifetime;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Migrate legacy config.json entry early (safe to do before full startup)
        try { RemoveFromConfigJson(_appPaths.WebPath, EnhancerUrl); } catch { }

        // Delay index.html injection until ApplicationStarted so that Jellyfin's own
        // web-file initialization (which may overwrite index.html) has already run.
        _lifetime.ApplicationStarted.Register(InjectEnhancer);

        return Task.CompletedTask;
    }

    private void InjectEnhancer()
    {
        if (Plugin.Instance?.Configuration.AutoInjectEnabled == false)
        {
            _logger.LogDebug("PlayerEnhancer auto-inject skipped: disabled by user");
            return;
        }

        try
        {
            RemoveEnhancerTagsFromIndexHtml(_appPaths.WebPath);
            var url = GetVersionedUrl();
            var changed = PatchIndexHtml(_appPaths.WebPath, url);
            if (changed)
                _logger.LogInformation("PlayerEnhancer: injected script tag into index.html ({Url})", url);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PlayerEnhancer: failed to patch index.html");
        }
    }

    private static string GetVersionedUrl() => EnhancerUrl;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    /// <summary>
    /// Idempotently injects a module script tag for <paramref name="url"/> before &lt;/body&gt; in index.html.
    /// Returns true if the file was modified.
    /// </summary>
    internal static bool PatchIndexHtml(string webPath, string url)
    {
        var indexPath = Path.Combine(webPath, "index.html");
        if (!File.Exists(indexPath)) return false;

        var html = File.ReadAllText(indexPath);
        var tag = MakeScriptTag(url);
        if (html.Contains(tag)) return false;
        if (!html.Contains("</body>")) return false;

        File.WriteAllText(indexPath, html.Replace("</body>", tag + "</body>"));
        return true;
    }

    /// <summary>
    /// Removes the module script tag for <paramref name="url"/> from index.html.
    /// Returns true if the file was modified.
    /// </summary>
    internal static bool RemoveFromIndexHtml(string webPath, string url)
    {
        var indexPath = Path.Combine(webPath, "index.html");
        if (!File.Exists(indexPath)) return false;

        var html = File.ReadAllText(indexPath);
        var tag = MakeScriptTag(url);
        if (!html.Contains(tag)) return false;

        File.WriteAllText(indexPath, html.Replace(tag, ""));
        return true;
    }

    /// <summary>
    /// Removes all enhancer script tags (any version suffix) from index.html.
    /// Returns true if the file was modified.
    /// </summary>
    internal static bool RemoveEnhancerTagsFromIndexHtml(string webPath)
    {
        var indexPath = Path.Combine(webPath, "index.html");
        if (!File.Exists(indexPath)) return false;

        var html = File.ReadAllText(indexPath);
        var cleaned = Regex.Replace(
            html,
            @"<script type=""module"" src=""(?:/web/configurationpage\?name=JellyfinSuitePlayerEnhancer|/JellyfinSuite/PlayerEnhancer/Launcher)[^""]*""></script>",
            string.Empty);
        if (cleaned == html) return false;

        File.WriteAllText(indexPath, cleaned);
        return true;
    }

    private static string MakeScriptTag(string url) =>
        $"<script type=\"module\" src=\"{url}\"></script>";

    // Legacy helpers kept for migration cleanup and unit tests.

    internal static bool PatchConfigJson(string webPath, string url)
    {
        var configPath = Path.Combine(webPath, "config.json");
        if (!File.Exists(configPath)) return false;

        var json = File.ReadAllText(configPath);
        var node = JsonNode.Parse(json);
        if (node is not JsonObject obj) return false;

        var plugins = obj["plugins"]?.AsArray();
        if (plugins is null)
        {
            plugins = new JsonArray();
            obj["plugins"] = plugins;
        }

        foreach (var item in plugins)
        {
            if (item is JsonValue val && val.TryGetValue<string>(out var s) && s == url)
                return false;
        }

        plugins.Add(url);
        WriteIndented(configPath, obj);
        return true;
    }

    internal static bool RemoveFromConfigJson(string webPath, string url)
    {
        var configPath = Path.Combine(webPath, "config.json");
        if (!File.Exists(configPath)) return false;

        var json = File.ReadAllText(configPath);
        var node = JsonNode.Parse(json);
        if (node is not JsonObject obj) return false;

        var plugins = obj["plugins"]?.AsArray();
        if (plugins is null) return false;

        for (var i = plugins.Count - 1; i >= 0; i--)
        {
            if (plugins[i] is JsonValue val && val.TryGetValue<string>(out var s) && s == url)
            {
                plugins.RemoveAt(i);
                WriteIndented(configPath, obj);
                return true;
            }
        }

        return false;
    }

    private static void WriteIndented(string path, JsonNode node)
    {
        using var ms = new System.IO.MemoryStream();
        using var writer = new Utf8JsonWriter(ms, new JsonWriterOptions { Indented = true });
        node.WriteTo(writer);
        writer.Flush();
        File.WriteAllBytes(path, ms.ToArray());
    }
}
