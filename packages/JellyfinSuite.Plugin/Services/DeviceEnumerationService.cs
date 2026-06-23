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

        // /sys/class/drm is commonly visible inside a container even when the GPU itself
        // wasn't passed through (sysfs metadata leaks across the mount namespace while
        // /dev/dri does not), which previously caused cuda:N to be reported as available and
        // selected as default even though ORT's CUDA EP has no device to actually attach to —
        // it then hangs until run_with_ep_timeout's timeout aborts the frame-forge process.
        // Gate on /dev/dri actually existing so we only report GPUs that are truly reachable.
        if (!Directory.Exists("/dev/dri") || !Directory.EnumerateFileSystemEntries("/dev/dri").Any())
        {
            _logger.LogDebug("[DeviceEnumeration] /dev/dri not accessible — skipping GPU enumeration, CPU will be default");
            yield break;
        }

        var cardDirs = Directory.GetDirectories(drmBase, "card*")
            .Where(d => !d.Contains('-'))   // skip card0-HDMI-1 etc
            .OrderBy(d => d)
            .ToList();

        // Only shell out to nvidia-smi if at least one NVIDIA GPU is present, to avoid the
        // process-spawn overhead/exception path on AMD/Intel/CPU-only hosts.
        Dictionary<string, NvidiaGpuInfo>? nvInfo = null;

        int gpuIndex = 0;
        foreach (var cardDir in cardDirs)
        {
            var deviceDir = Path.Combine(cardDir, "device");
            if (!Directory.Exists(deviceDir))
                continue;

            string? vendor = ReadSysfs(Path.Combine(deviceDir, "vendor"));
            string? deviceIdRaw = ReadSysfs(Path.Combine(deviceDir, "device"));
            string? vramPath = Path.Combine(deviceDir, "mem_info_vram_total");
            long? vramBytes = ReadSysfsLong(vramPath);

            string vendorName = NormaliseVendor(vendor);
            // "directml" was wrong here for every non-NVIDIA vendor: DirectML is a Windows-only
            // (DirectX 12) API with no Linux runtime at all, and this method only ever runs on
            // Linux (OperatingSystem.IsLinux() gate in BuildDeviceList). A device tagged
            // "directml:N" would reach dl_match.rs::build_ep_session's "directml" branch, try to
            // load an EP that can't exist on this OS, and silently fall back to CPU — the same
            // "looks fine, runs 100% CPU, no error anywhere" failure mode root-caused for CUDA
            // earlier (see CudaRuntimeAcquisitionService's class doc for that story).
            // Intel maps to "openvino", which build_ep_session already has a real branch for
            // (OpenVINOExecutionProvider, GPU device type) — untested on real Arc hardware but at
            // least it's the correct EP family instead of one that can't run on this OS at all.
            // AMD maps to "rocm": there's no ROCm branch in build_ep_session yet, so this falls
            // through to the default CPU branch exactly like today — but it's now an honest label
            // instead of a falsely-Windows-only one, and if ROCm EP support is ever added later,
            // no enumeration change is needed. (ROCm's hardware support for integrated/APU GPUs is
            // poor enough that wiring a real ROCm EP is a separate, larger, lower-confidence effort
            // — not bundled into this fix.)
            string ep = vendorName switch
            {
                "NVIDIA" => "cuda",
                "Intel"  => "openvino",
                "AMD"    => "rocm",
                _        => "cpu",
            };

            // PCI bus address — only used internally to join against nvidia-smi's own
            // pci.bus_id column below, not surfaced to the frontend (the /dev/dri/cardN path
            // is the form users actually recognise on their own host).
            var pciSlot = ReadPciSlotName(deviceDir);
            var devicePath = $"/dev/dri/{Path.GetFileName(cardDir)}";

            string? computeCapability = null;
            string? modelName = null;
            if (vendorName == "NVIDIA")
            {
                nvInfo ??= GetNvidiaGpuInfo();
                if (pciSlot is not null && NormalisePciBusId(pciSlot) is { } busId &&
                    nvInfo.TryGetValue(busId, out var info))
                {
                    computeCapability = info.ComputeCap;
                    modelName = info.Name;
                }
            }

            yield return new ComputeDeviceDto
            {
                Id = $"{ep}:{gpuIndex}",
                DisplayName = $"{vendorName} GPU {gpuIndex}",
                DeviceType = "GPU",
                Vendor = vendorName,
                VramMb = vramBytes.HasValue ? vramBytes.Value / (1024 * 1024) : null,
                IsIntegrated = IsIntegratedGpu(vendorName, deviceIdRaw),
                IsDefault = false,
                ComputeCapability = computeCapability,
                ModelName = modelName,
                DevicePath = devicePath,
            };
            gpuIndex++;
        }
    }

    private readonly record struct NvidiaGpuInfo(string ComputeCap, string Name);

    /// <summary>Runs `nvidia-smi --query-gpu=pci.bus_id,compute_cap,name` and maps normalised PCI
    /// bus id → (compute capability, model name e.g. "NVIDIA GeForce RTX 4090"). Returns an empty
    /// dict if nvidia-smi is missing or fails (NVML-based, independent of the ORT/CUDA init path
    /// so this detection itself cannot hang).</summary>
    private Dictionary<string, NvidiaGpuInfo> GetNvidiaGpuInfo()
    {
        var result = new Dictionary<string, NvidiaGpuInfo>();
        try
        {
            using var proc = new System.Diagnostics.Process
            {
                StartInfo = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "nvidia-smi",
                    Arguments = "--query-gpu=pci.bus_id,compute_cap,name --format=csv,noheader",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                },
            };
            proc.Start();
            string output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(5000);
            if (proc.ExitCode != 0)
            {
                _logger.LogWarning("[DeviceEnumeration] nvidia-smi exited with code {Code}", proc.ExitCode);
                return result;
            }

            foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var cols = line.Split(',', StringSplitOptions.TrimEntries);
                if (cols.Length < 3)
                    continue;
                if (NormalisePciBusId(cols[0]) is { } busId)
                    result[busId] = new NvidiaGpuInfo(cols[1], cols[2]);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "[DeviceEnumeration] nvidia-smi unavailable, computeCapability/modelName will stay null");
        }

        return result;
    }

    /// <summary>Reads PCI_SLOT_NAME (e.g. "0000:01:00.0") from a DRM device's uevent file.</summary>
    private static string? ReadPciSlotName(string deviceDir)
    {
        try
        {
            foreach (var line in File.ReadAllLines(Path.Combine(deviceDir, "uevent")))
            {
                if (line.StartsWith("PCI_SLOT_NAME=", StringComparison.Ordinal))
                    return line["PCI_SLOT_NAME=".Length..];
            }
        }
        catch { /* ignore */ }

        return null;
    }

    /// <summary>Normalises PCI bus ids to "bus:device.function" so sysfs's 4-digit-domain form
    /// ("0000:01:00.0") and nvidia-smi's 8-digit-domain form ("00000000:01:00.0") compare equal.</summary>
    private static string? NormalisePciBusId(string raw)
    {
        var parts = raw.Trim().Split(':');
        return parts.Length >= 2 ? $"{parts[^2]}:{parts[^1]}".ToLowerInvariant() : null;
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

    /// <summary>Known integrated-GPU PCI device IDs for AMD APU graphics (Raphael/Phoenix/Rembrandt/
    /// Cezanne/Renoir/Picasso/Raven generations) — GPU drivers don't expose an "integrated vs
    /// discrete" flag directly, so this is the same PCI-device-ID-table approach industry tools like
    /// switcheroo-control use (research.md §5). Treated as an allowlist (not a denylist) because
    /// AMD's *discrete* Radeon lineup spans far more device IDs across generations than its much
    /// smaller set of APU iGPU chips — enumerating the small side is more maintainable.</summary>
    private static readonly HashSet<string> KnownAmdIntegratedDeviceIds = new(StringComparer.OrdinalIgnoreCase)
    {
        "0x15d8", // Picasso (Ryzen 3000 APU)
        "0x15dd", // Raven/Raven2 (Ryzen 2000/3000 APU)
        "0x1636", // Renoir (Ryzen 4000 APU)
        "0x1638", // Cezanne/Barcelo (Ryzen 5000 APU)
        "0x1681", // Rembrandt (Ryzen 6000 mobile APU)
        "0x15bf", // Phoenix (Ryzen 7040/8040 mobile APU)
        "0x164e", // Raphael (Ryzen 7000 desktop APU iGPU — this project's own dev hardware)
        "0x13c0", "0x13c1", // Phoenix2/Hawk Point variants
    };

    /// <summary>Intel discrete (Arc) GPU PCI device IDs fall in known generation-specific ranges;
    /// every other Intel GPU device ID is an integrated GPU (Intel ships one on nearly every CPU
    /// generation, so the integrated side is the far larger, less enumerable set here — the inverse
    /// of the AMD case above).</summary>
    private static bool IsIntelDiscrete(string? deviceId)
    {
        if (deviceId is null) return false;
        var id = deviceId.Trim().ToLowerInvariant();
        // DG2/Alchemist (Arc A-series, e.g. A380/A580/A770): 0x56xx.
        // DG1: 0x4905/0x4906. Battlemage (Arc B-series): 0xe2xx.
        return id.StartsWith("0x56", StringComparison.Ordinal)
            || id is "0x4905" or "0x4906"
            || id.StartsWith("0xe2", StringComparison.Ordinal);
    }

    private static bool IsIntegratedGpu(string vendorName, string? deviceIdRaw) => vendorName switch
    {
        // NVIDIA has no desktop/workstation integrated GPU product line — always discrete.
        "NVIDIA" => false,
        "AMD" => KnownAmdIntegratedDeviceIds.Contains(deviceIdRaw?.Trim() ?? ""),
        "Intel" => !IsIntelDiscrete(deviceIdRaw),
        _ => false,
    };
}
