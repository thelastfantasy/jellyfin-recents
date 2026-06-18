# Research: ORT GPU Acceleration & Model/Device Selection UI

## 1. ORT Execution Provider Configuration (ort crate v2.x)

**Decision**: Use `ort` crate v2.0.0-rc.12 with `load-dynamic` feature instead of
`download-binaries` to enable runtime ORT library swapping.

**Rationale**: `download-binaries` bakes a specific ORT build into the binary at compile
time and cannot be swapped at runtime. `load-dynamic` loads `libonnxruntime.so` /
`onnxruntime.dll` from a path specified by `ORT_DYLIB_PATH` env var at process startup,
enabling the C# host to point frame-forge at a user-managed ORT build that includes the
desired EP (CUDA, DirectML, OpenVINO, etc.).

**EP activation**:
```rust
// Session builder with EP selection (ort v2.x API):
Session::builder()?
    .with_execution_providers([
        CUDAExecutionProvider::default().build(),  // falls through if unavailable
        CPUExecutionProvider::default().build(),
    ])?
    .commit_from_file(path)?
```
Each EP is attempted in order; ORT falls through to the next if unavailable.
Cargo features required per EP: `cuda`, `directml`, `rocm`, `openvino` (all optional).

**Alternatives considered**:
- Keep `download-binaries`: ruled out — cannot swap runtime, fixed CPU-only ORT.
- Vendor ORT binaries inside the plugin: ruled out — 100s MB per platform/EP variant.

---

## 2. GPU Device Enumeration

**Decision**: Implement platform-specific enumeration in a new C# `DeviceEnumerationService`,
returning a list of `ComputeDevice` objects. frame-forge itself does not enumerate — it
accepts a device index or EP name via `--device` CLI argument.

**Windows (DirectML)**:
Use `WMI` (Win32_VideoController) or DXGI adapter enumeration via P/Invoke to
`CreateDXGIFactory1`. DXGI is preferred: returns adapter description, VRAM
(DedicatedVideoMemory), and PCI-bus slot information. Integrated graphics is identified by
`AdapterFlag.Software` == 0 and DedicatedVideoMemory == 0.

**Linux**:
Parse `/sys/class/drm/card*/device/` sysfs entries. For each card:
- `vendor`: PCI vendor ID (0x10de = NVIDIA, 0x1002 = AMD, 0x8086 = Intel)
- `mem_info_vram_total`: AMD GPU VRAM (via amdgpu driver)
- `subsystem_device`: device ID for display name lookup
For NVIDIA: also check `/proc/driver/nvidia/gpus/` or run `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader`.

**Device ID format**: `{platform}:{index}` e.g., `directml:0`, `cuda:0`, `cpu:0`.
This opaque ID is passed in the `device_id` field of the MSG_STITCH socket message.

**Alternatives considered**:
- wgpu for cross-platform enumeration: adds 10+ MB to plugin, overkill for just listing adapters.

---

## 3. ORT Runtime Swapping Mechanism

**Decision**: The C# plugin manages versioned ORT runtime directories under
`/config/plugins/JellyfinSuite/ort/`. Each version lives in its own subdirectory
(`v2.0.0-rc.12/`, `v2.1.0/`, etc.). The active version is tracked by `active.txt`.
`ORT_DYLIB_PATH` is set in the frame-forge daemon's process environment at startup
(in `EnsureStartedAsync`). Since `load-dynamic` loads the ORT dylib once at first session
creation and fixes it for the process lifetime, ORT version changes require a daemon restart.
`OrtVersionService.ActivateVersion()` writes `active.txt` and signals daemon restart;
`EnsureStartedAsync` on the next request detects the dead process and relaunches it with
the updated `ORT_DYLIB_PATH`.

**Version retention**: Default 2 most recent versions; configurable via plugin settings.
Eviction: when a new version is activated and count exceeds the limit, oldest version
directory is deleted.

**Download source**: `https://github.com/microsoft/onnxruntime/releases/download/vX.Y.Z/`
— platform-specific asset naming:
- Linux CPU+CUDA: `onnxruntime-linux-x64-gpu-X.Y.Z.tgz`
- Linux ROCm: `onnxruntime-linux-x64-rocm-X.Y.Z.tgz`
- Linux OpenVINO: `onnxruntime-linux-x64-X.Y.Z.tgz` + OpenVINO EP plugin
- Windows DirectML: `onnxruntime-win-x64-directml-X.Y.Z.zip`
- Windows CPU: `onnxruntime-win-x64-X.Y.Z.zip`

**Retry policy**: 4xx → no retry. 5xx/network error → up to 3 retries with exponential
back-off (1s, 4s, 16s). On failure after 3 retries: surface error in ORT management panel.

**Alternatives considered**:
- Bake EP into Cargo features: ruled out — requires rebuild per EP, no runtime switching.
- Use ORT's own auto-download: ruled out — no version pinning or user control.

---

## 4. Model Catalog Architecture

**Decision**: JSON catalog hosted at a stable project-controlled URL (e.g., a GitHub raw
file or CDN). Cached locally with 24-hour TTL. Schema:

```json
{
  "schemaVersion": 1,
  "models": [
    {
      "family": "lightglue",
      "displayName": "LightGlue v2",
      "version": "2.0",
      "fileName": "superpoint_lightglue_pipeline.onnx",
      "downloadUrl": "https://...",
      "sha256": "...",
      "fileSizeBytes": 123456789,
      "releaseDate": "2024-11-01"
    }
  ],
  "ortVersions": [
    {
      "version": "2.0.0-rc.12",
      "assets": {
        "linux-x64-cpu": { "url": "...", "sha256": "...", "sizeBytes": 0 },
        "linux-x64-cuda": { "url": "...", "sha256": "...", "sizeBytes": 0 },
        "win-x64-directml": { "url": "...", "sha256": "...", "sizeBytes": 0 }
      }
    }
  ]
}
```

**Model retention policy**:
- Per model family (lightglue, efficient-loftr), max 5 versions on disk.
- Slot 1: latest version (pinned, never evicted).
- Slots 2–5: LRU order by `last_used_at` timestamp (updated each stitch run).
- Eviction: when 6th version downloaded → delete version with oldest `last_used_at`
  that is not the latest.

**Alternatives considered**:
- Static JSON bundled in plugin DLL: ruled out — new models require plugin update.

---

## 5. GenerationLog Output

**Decision**: frame-forge writes `generation-log.json` to the path supplied in the
`log_path` field of the MSG_STITCH socket message. C# reads this file after the task
completes and attaches it to the task record.

**Log schema**:
```json
{
  "algorithm": "LightGlue v2 → warp_expand_blend",
  "modelFileName": "superpoint_lightglue_pipeline.onnx",
  "modelVersion": "2.0",
  "ortVersion": "2.0.0-rc.12",
  "deviceName": "NVIDIA RTX 4070",
  "deviceType": "GPU",
  "deviceId": "cuda:0",
  "keypointMatchCount": 472,
  "inferenceDurationMs": 340,
  "fallbacks": [
    { "type": "GPU→CPU", "reason": "CUDA EP init failed: driver mismatch", "timestamp": "..." }
  ]
}
```

The C# task record stores this as `GenerationLog?` and exposes it via a new endpoint
`GET /FrameExport/Result/{taskId}/generation-log.json`.

---

## 6. Frontend Model Version Combobox

**Decision**: Implement as a custom Preact combobox (not native `<select>`) to support
per-item color coding. Use existing Popover component pattern in the codebase.

**Version list composition**:
1. Pinned "Latest" entry at top
2. Union of: catalog top-10 versions for selected family + all locally installed versions
3. Sort: installed-then-catalog, within each group by version descending
4. Color: installed versions use accent color; catalog-only versions use muted color

**localStorage keys** (prefixed `jfs_stitch_`):
- `jfs_stitch_device_id`: selected device ID string
- `jfs_stitch_model_family`: "lightglue" | "efficient-loftr" | "disabled"
- `jfs_stitch_model_version`: version string or "latest"
- `jfs_stitch_ort_version`: ORT version string or "latest"
