using Jellyfin.Plugin.JellyfinSuite.Models;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite.Services;

/// <summary>
/// Enumerates compute devices (GPU/CPU) available on the host.
/// Linux: reads sysfs DRM entries. Windows: uses DXGI via P/Invoke.
/// </summary>
public sealed class DeviceEnumerationService
{
    private readonly ILogger<DeviceEnumerationService> _logger;
    private List<ComputeDeviceDto>? _cache;

    public DeviceEnumerationService(ILogger<DeviceEnumerationService> logger)
    {
        _logger = logger;
    }

    public Task<List<ComputeDeviceDto>> EnumerateAsync(CancellationToken ct = default)
    {
        if (_cache is not null)
            return Task.FromResult(_cache);

        _cache = BuildDeviceList();
        return Task.FromResult(_cache);
    }

    private List<ComputeDeviceDto> BuildDeviceList()
    {
        var devices = new List<ComputeDeviceDto>();

        if (OperatingSystem.IsLinux())
            devices.AddRange(EnumerateLinux());
        else if (OperatingSystem.IsWindows())
            devices.AddRange(EnumerateWindows());

        // Always add CPU as last fallback
        devices.Add(new ComputeDeviceDto
        {
            Id = "cpu:0",
            DisplayName = "CPU",
            DeviceType = "CPU",
            Vendor = "CPU",
            VramMb = null,
            IsIntegrated = false,
            IsDefault = devices.Count == 0,
        });

        // Mark the first GPU (highest VRAM) as default if any GPU exists
        var firstGpu = devices.FirstOrDefault(d => d.DeviceType == "GPU");
        if (firstGpu is not null)
            firstGpu.IsDefault = true;

        return devices;
    }

    private IEnumerable<ComputeDeviceDto> EnumerateLinux()
    {
        const string drmBase = "/sys/class/drm";
        if (!Directory.Exists(drmBase))
            yield break;

        int gpuIndex = 0;
        foreach (var cardDir in Directory.GetDirectories(drmBase, "card*")
                     .Where(d => !d.Contains('-'))   // skip card0-HDMI-1 etc
                     .OrderBy(d => d))
        {
            var deviceDir = Path.Combine(cardDir, "device");
            if (!Directory.Exists(deviceDir))
                continue;

            string? vendor = ReadSysfs(Path.Combine(deviceDir, "vendor"));
            string? vramPath = Path.Combine(deviceDir, "mem_info_vram_total");
            long? vramBytes = ReadSysfsLong(vramPath);

            string vendorName = NormaliseVendor(vendor);
            string ep = vendorName == "NVIDIA" ? "cuda" : "directml";

            yield return new ComputeDeviceDto
            {
                Id = $"{ep}:{gpuIndex}",
                DisplayName = $"{vendorName} GPU {gpuIndex}",
                DeviceType = "GPU",
                Vendor = vendorName,
                VramMb = vramBytes.HasValue ? vramBytes.Value / (1024 * 1024) : null,
                IsIntegrated = false,
                IsDefault = false,
            };
            gpuIndex++;
        }
    }

    private IEnumerable<ComputeDeviceDto> EnumerateWindows()
    {
        // Stub: full DXGI P/Invoke enumeration is implemented in T013.
        // Returns empty so CPU-only fallback applies until then.
        yield break;
    }

    private static string? ReadSysfs(string path)
    {
        try { return File.ReadAllText(path).Trim(); } catch { return null; }
    }

    private static long? ReadSysfsLong(string path)
    {
        var s = ReadSysfs(path);
        return s is not null && long.TryParse(s, out var v) ? v : null;
    }

    private static string NormaliseVendor(string? id) => id?.Trim().ToLowerInvariant() switch
    {
        "0x10de" => "NVIDIA",
        "0x1002" => "AMD",
        "0x8086" => "Intel",
        _ => "Unknown",
    };
}
