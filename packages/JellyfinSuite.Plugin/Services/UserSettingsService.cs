using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

/// <summary>
/// Per-user player preferences stored at DataPath/JellyfinSuite.UserSettings.json.
/// DataPath is outside the plugin binary directory, so data survives plugin uninstallation.
/// </summary>
public sealed class UserSettingsService
{
    private static readonly JsonSerializerOptions _jsonOpts = new() { WriteIndented = true };
    private readonly string _filePath;
    private readonly object _lock = new();
    private Dictionary<string, UserPlayerSettings> _data = new();

    public UserSettingsService(IApplicationPaths appPaths)
    {
        _filePath = Path.Combine(appPaths.DataPath, "JellyfinSuite.UserSettings.json");
        Load();
    }

    public UserPlayerSettings Get(string userId)
    {
        lock (_lock)
        {
            return _data.TryGetValue(userId, out var s) ? s.Clone() : new UserPlayerSettings();
        }
    }

    public void Save(string userId, UserPlayerSettings settings)
    {
        lock (_lock)
        {
            _data[userId] = settings;
            Flush();
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            _data = JsonSerializer.Deserialize<Dictionary<string, UserPlayerSettings>>(
                File.ReadAllText(_filePath)) ?? new();
        }
        catch { _data = new(); }
    }

    private void Flush()
    {
        try { File.WriteAllText(_filePath, JsonSerializer.Serialize(_data, _jsonOpts)); }
        catch { }
    }
}

public sealed class UserPlayerSettings
{
    public bool TrickplayEnabled { get; set; } = true;
    public double SeekSeconds { get; set; } = 10.0;
    public double SpeedRate { get; set; } = 2.0;

    public UserPlayerSettings Clone() =>
        new() { TrickplayEnabled = TrickplayEnabled, SeekSeconds = SeekSeconds, SpeedRate = SpeedRate };
}
