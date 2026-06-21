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

**Published URL (T067)**: `https://thelastfantasy.github.io/jellyfin-suite/model-catalog.json`,
served from the project's `gh-pages` branch (same hosting pattern as the existing plugin
`manifest.json`). Model binaries themselves are NOT committed to git — they are uploaded as
assets on the `models-v1` GitHub Release (tag deliberately not matching `v*.*.*` so it does
not trigger `.github/workflows/release.yml`), and `downloadUrl` in the catalog points at
`https://github.com/thelastfantasy/jellyfin-suite/releases/download/models-v1/<fileName>`.

Initial v1 catalog contents (Real-ESRGAN / GFPGAN for the "提升画质" upscale feature, US7):

| family | version | source repo | license |
|---|---|---|---|
| realesrgan | photo-x2 | wide-video/real-esrgan-v1.0.0 (HF) | BSD-3-Clause |
| realesrgan | photo-x4 | universonic/RealESRGAN (HF) | BSD-3-Clause |
| realesrgan | anime-x4 | universonic/RealESRGAN (HF) | BSD-3-Clause |
| gfpgan | v1.4 | HowToSD/GFPGAN-ONNX (HF) | Apache-2.0 |

`realesrgan/anime-x2` has no entry: the upstream xinntao Real-ESRGAN project never released
that variant, and no credible community ONNX conversion was found either. Real-ESRGAN inputs
must have dynamic H/W dimensions (frame-forge tiles at varying sizes); several candidate
anime-x2 conversions found on Hugging Face had fixed input shapes (e.g. 64×64, 240×240) and
were rejected for that reason rather than included to fill the slot.

**anime-x2 fallback**: rather than leave the combination unavailable, `UpscaleService.cs`
maps an `anime`+`x2` request onto the `anime-x4` model and asks frame-forge to downscale the
x4 output by 0.5 afterward (`post_downscale_factor` on `MSG_UPSCALE`, applied in
`server.rs::handle_upscale` after face-restore, via `upscale::upscale_image` → optional
`DynamicImage::resize_exact` with `Lanczos3`). This stays within FR-021 (resolution/sharpness
only) since downscaling discards detail rather than hallucinating it, and avoids depending on
an unverified extra ONNX file. Usage/LRU is recorded against `anime-x4` (the model actually
run), not a synthetic `anime-x2` catalog entry.

**Updating the catalog** (adding/replacing a model variant):
1. Source or convert the ONNX file; verify with `onnx.load(path, load_external_data=False)`
   that `graph.input`/`graph.output` shapes match what the consuming Rust code expects
   (dynamic H/W for Real-ESRGAN tiles; fixed 512×512 for GFPGAN — see `crates/frame-forge/src/upscale.rs`
   and `crates/frame-forge/src/face_restore.rs`).
2. `sha256sum <file>` and note the byte size.
3. `gh release upload models-v1 <file>` (or `gh release create models-v1 <files...>` if the
   release doesn't exist yet).
4. Edit `model-catalog.json`, add/update the entry (`family`, `displayName`, `version` —
   must match the `{modelStyle}-x{scale}` / `"latest"` convention `UpscaleService.cs` queries
   by —, `fileName`, `downloadUrl`, `sha256`, `fileSizeBytes`, `releaseDate`).
5. Push the updated `model-catalog.json` to the `gh-pages` branch root (e.g. via a throwaway
   `git worktree add /tmp/gh-pages-worktree gh-pages`, copy the file in, commit, push, then
   `git worktree remove`). `ModelCatalogService`'s 24h TTL means installs already in progress
   may briefly see the old catalog; this is expected and harmless.

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

**Decision**: Implement as a custom React combobox (not native `<select>`) to support
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

---

## 7. GPU Hang Findings — Blackwell CUDA EP + GPU-flavored ORT CPU Path

Found and fixed while manually verifying GPU acceleration on an RTX 5060 (Blackwell,
compute capability `sm_120`, driver 595.71, max supported CUDA 13.2) ahead of Phase 9.

### 7a. ORT 1.26.0 standard `gpu` (CUDA 12) build hangs/silently-CPU-falls-back on Blackwell

The standard Linux GPU asset (`onnxruntime-linux-x64-gpu-1.26.0.tgz`, built against CUDA 12)
either hung indefinitely or silently executed on CPU while reporting the CUDA EP as
registered, when running `build_ep_session("cuda", ...)` against a Blackwell GPU. Root
cause: CUDA 12's nvcc does not emit SASS/PTX for `sm_120`; the CUDA 12 ORT build has no
working Blackwell kernels.

**Fix**: use the `gpu_cuda13` asset variant instead
(`onnxruntime-linux-x64-gpu_cuda13-1.26.0.tgz`, built against CUDA 13). Verified: session
build ~0.5-0.9s, real inference ~0.3-0.5s, 40/40 consecutive runs with zero hangs and zero
`FallbackEvent`s, `nvidia-smi` showing real GPU utilization (up to 23%) and memory spikes
(up to ~3.3GB) correlated with the test loop. Confirmed across both LightGlue v2 and
EfficientLoFTR models, and across a full 7-scene `forge stitch --device cuda:0` run (see
`tests/stitch-eval/run_demo_gpu.sh`, `mise run demo-stitch-gpu-linux`) — every scene
reported `ep=cuda:0` with `fallback_events=[]`.

Driver 595.71 (max CUDA 13.2) is forward-compatible with the CUDA 13.1 runtime bundled in
the `gpu_cuda13` asset, so no separate CUDA toolkit install is needed on the host — only
the matching userspace driver via `nvidia-container-toolkit` (CDI) for container GPU
passthrough. **Implication for `OrtVersionService` (T033)**: the Linux asset-selection
logic must distinguish `gpu` (CUDA 12) vs `gpu_cuda13` based on detected GPU compute
capability — generic `"linux-x64-cuda"` is not specific enough once both variants exist
upstream. ORT 1.27.0+ drops the CUDA 12 variant entirely per the 1.26.0 release notes, which
simplifies this back down to one asset once the active ORT version is pinned ≥1.27.

### 7b. GPU-flavored ORT build hangs on plain CPU session creation (separate bug)

Independently of 7a: using the `gpu_cuda13` build's `libonnxruntime.so` to build a session
with **no explicit execution provider** (`Session::builder().commit_from_file(path)`, the
bare-default pattern previously used for `device_id == "cpu"` in `build_ep_session`'s
`make_cpu` closure, and unconditionally in `LGlueV2::load`/`LGlue::load`/`ELoFTR::load`)
hangs indefinitely — confirmed via `/proc/<pid>/stat` showing 0 utime/stime and
`/proc/<pid>/task/*/wchan` showing `futex_do_wait` immediately after the call, i.e. it never
even starts computing. This reproduced 100% (4/4) across both bundled models.

**Fix**: explicitly register `CPUExecutionProvider` before `commit_from_file`, e.g.:
```rust
Session::builder()?
    .with_execution_providers([ort::execution_providers::CPUExecutionProvider::default().build()])?
    .commit_from_file(p)
```
This takes a different internal ORT code path and avoids the hang entirely (verified 4/4,
session build ~0.2-0.5s). Applied in `crates/frame-forge/src/dl_match.rs`'s `make_cpu`
closure inside `build_ep_session`.

**Production relevance**: `server.rs` always calls the EP-aware `load_matcher_for_request` →
`build_ep_session`, so this fix covers the production daemon path, including its own
internal CUDA-EP-failed → CPU fallback (which reuses `make_cpu` and would otherwise have
hung on the very environment where GPU init is least reliable). The CLI's `forge stitch`
command previously used the *separate*, non-EP-aware singleton path (`load_matcher` via
`loftr_guard()`), which has the same bare-default bug independent of `build_ep_session` —
fixed by switching the CLI to also call `load_matcher_for_request` (now takes a `--device`
flag; defaults to `cpu:0`), so there is exactly one session-construction code path for both
the daemon and the CLI/demo.

**Outstanding**: timeout protection (T036) is still warranted as defense-in-depth — this
fix addresses the one reproduced cause, but does not prove no other GPU/driver/model
combination can hang ORT's CPU EP for a different reason. T036 should wrap **all three**
EP branches in `build_ep_session` (cuda, directml, and the cpu fallback), not just the GPU
branches, given 7b shows the "safe" CPU path is not unconditionally safe. Because the
abandoned worker thread in the diagnostic tool's timeout wrapper held an ORT-internal
mutex during the 7b hang, and the *main* thread's PID kept existing (visible in `ps`) even
after printing the "TIMED OUT" message and returning `Ok(())` from `main` — normal process
exit runs shared-library static destructors (`atexit`/`__cxa_finalize` for `libonnxruntime.so`),
which can block on the same mutex the abandoned thread holds. T036's production
implementation should therefore call `std::process::exit()` (or equivalent immediate
termination) rather than relying on a normal return from `main`/the request handler to
guarantee the daemon doesn't hang on its own shutdown path after a timeout fires.

### 7c. OpenVINO EP match arm added — untested on real Intel GPU hardware

`build_ep_session` previously had no `"openvino"` match arm at all: a request for
`device_id="openvino:0"` (e.g. Intel Arc A-series GPUs, common in NAS/iGPU hardware) fell
through to the default `_ =>` branch — silently ran on CPU **with an empty
`fallback_events: []`**, i.e. no warning and no record, which is strictly worse than the
cuda/directml branches' explicit-failure logging. Added a symmetric `"openvino"` branch
using `OpenVINOExecutionProvider::default().with_device_type("GPU").build()`, following the
same try-GPU-then-CPU-fallback-with-FallbackEvent pattern.

**This branch is unverified against real Intel GPU hardware** — this dev machine only has
an NVIDIA GPU, so there was no way to confirm `OpenVINOExecutionProvider` actually engages
the Intel GPU rather than its own internal CPU fallback (OpenVINO EP can itself silently
choose CPU via `device_type=CPU` if GPU plugin init fails, which `.ok()` here cannot
distinguish from "no device" — same blind spot as 7a/7b before they were empirically
checked). Also, per the standard ORT release asset layout, OpenVINO EP is **not** bundled in
the `gpu`/`gpu_cuda13` tarballs — Linux OpenVINO support ships as
`onnxruntime-linux-x64-X.Y.Z.tgz` (the plain CPU build) plus a separate OpenVINO EP plugin/
runtime install, which `OrtVersionService`'s asset selection (T033) does not yet account for.
Needs real Arc/iGPU hardware to validate before this can be trusted the way 7a/7b are.
