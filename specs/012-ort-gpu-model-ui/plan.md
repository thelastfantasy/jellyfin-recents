# Implementation Plan: ORT GPU Acceleration & Model/Device Selection UI

**Branch**: `feature/012-ort-gpu-model-ui` | **Date**: 2026-06-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-ort-gpu-model-ui/spec.md`

## Summary

Add GPU-accelerated DL inference to frame-forge via ORT Execution Providers (CUDA on Linux,
DirectML on Windows), with a workshop modal Advanced panel for device selection, model
family/version selection, and ORT runtime management. A GenerationLog JSON is produced after
each stitch and downloadable from the result panel. All user selections persist in browser
localStorage; server provides VRAM-ranked defaults.

## Technical Context

**Language/Version**: Rust (frame-forge, crates/frame-forge/), C# (.NET 8, packages/JellyfinSuite.Plugin/), TypeScript/React (apps/frontend/)

**Primary Dependencies**:
- `ort` 2.0.0-rc.12 → switch from `download-binaries` to `load-dynamic` feature for runtime EP swapping
- ORT EP Cargo features to add: `cuda` (Linux NVIDIA), `directml` (Windows), `openvino` (Intel iGPU Linux), `rocm` (AMD Linux, lower priority)
- OpenCV already present via `opencv` Cargo feature
- ASP.NET Core (already in use): add `StitchController`
- React + existing Popover/combobox patterns in frontend

**Storage**:
- `/config/plugins/JellyfinSuite/models/` — ONNX model files (existing)
- `/config/plugins/JellyfinSuite/models/metadata.json` — model version metadata (new)
- `/config/plugins/JellyfinSuite/ort/<version>/` — ORT runtime directories (new)
- `/config/plugins/JellyfinSuite/ort/active.txt` — active ORT version pointer (new)
- `/config/plugins/JellyfinSuite/model-catalog.json` — 24h-cached remote catalog (new)
- Browser `localStorage` — user device/model/ORT selections (frontend)

**Testing**: `mise run test` (cargo test + dotnet test + bun test)

**Target Platform**: Linux x64 (primary, Docker container); Windows x64 (DirectML path, secondary)

**Performance Goals**:
- Device list loads ≤ 1s (SC-002)
- GPU inference ≥ 2× faster than CPU baseline on synthetic_landscape (SC-001)
- Model download progress updates ≤ every 2s (SC-003)

**Constraints**:
- `cargo check` must pass before any `mise run update` (Rust rule)
- No Jellyfin server restart required for ORT version activation (FR-011); frame-forge daemon restart on ORT version change is acceptable
- GenerationLog only for stitch jobs, never animate (FR-015)
- Retain ≤ 5 model versions per family (FR-007a), ≤ 2 ORT versions (default, FR-011)

**Scale/Scope**: Single-server Jellyfin plugin; no distributed concerns.

## Constitution Check

> Constitution applies to restructuring/migration work. This feature adds new code rather
> than restructuring. The following constitution principles still apply as best practice:

- **III. Test Gate**: `mise run test` must pass at end of each Stage. ✅ enforced.
- **IV. Build Gate**: `mise run update` must succeed before marking any Stage complete.
- **V. Incremental Verification**: each Stage verified independently before next begins.
- **Rust Modification Rule**: `mise run check-frame-forge` must pass before any build.

No constitution violations. No complexity table needed.

## Project Structure

### Documentation (this feature)

```text
specs/012-ort-gpu-model-ui/
├── plan.md              ← this file
├── research.md          ← Phase 0 (complete)
├── data-model.md        ← Phase 1 (complete)
├── quickstart.md        ← Phase 1 (complete)
├── contracts/
│   └── api.md           ← Phase 1 (complete)
└── tasks.md             ← Phase 2 (/speckit-tasks)
```

### Source Code Layout

```text
crates/frame-forge/
├── Cargo.toml                     ← add EP features, load-dynamic
└── src/
    ├── cli.rs                     ← add --device, --log-output flags
    ├── dl_match.rs                ← add EP session builder, device ID parsing
    └── generation_log.rs          ← new: GenerationLog struct + JSON serialisation

packages/JellyfinSuite.Plugin/
├── Controllers/
│   ├── FrameExportController.cs   ← extend Generate + add Result/{id}/generation-log.json
│   └── StitchController.cs        ← new: /Stitch/Devices, /Stitch/Models, /Stitch/OrtVersions
├── Services/
│   ├── ModelCatalogService.cs     ← replaces ModelAcquisitionService (catalog + LRU retention)
│   ├── OrtVersionService.cs       ← new: download/manage ORT runtime versions
│   └── DeviceEnumerationService.cs ← new: list compute devices
├── Models/
│   ├── StitchDto.cs               ← ComputeDeviceDto, ModelEntryDto, OrtVersionDto, GenerationLogDto
│   └── FrameExportDto.cs          ← extend GenerateParams with deviceId/modelFamily/modelVersion
└── PluginServiceRegistrator.cs    ← register new services

apps/player-enhancer/src/
├── api/
│   ├── routes.ts                  ← extend: suite.stitch.devices()/models()/ortVersions()/upscale*()
│   └── frameExportApi.ts          ← extend: fetchDevices()/fetchModels()/fetchOrtVersions(), getGenerationLog (done)
├── components/
│   ├── AdvancedPanel.tsx          ← new: device + model + ORT advanced options
│   ├── ParamsPanel.tsx            ← extend: render <AdvancedPanel> below existing controls
│   ├── ResultPage.tsx             ← extend: Download log button (done), Upscale trigger button
│   └── UpscalePage.tsx            ← new: US7 upscale flow (options → processing → comparison → error)
└── core/
    └── state.ts                   ← extend: ExportSettings gets deviceId/modelFamily/modelVersion/ortVersion
```

**Note**: the Advanced device/model/ORT panel and the Download-log/Upscale buttons all belong to
the workshop modal, i.e. `apps/player-enhancer`, not `apps/frontend`. `apps/frontend`'s
`FrameExportQueueWidget.tsx` is a separate persistent task-queue page with no log-download or
upscale interaction by design. `FrameExportJobRunner.tsx` (also in `apps/player-enhancer`) is a
headless SSE progress listener with no rendered UI — it does not own any result/download UI.

## Implementation Stages

---

### Stage 1: frame-forge GPU backend (Rust)

**Goal**: frame-forge can use a GPU EP and write a GenerationLog JSON.

**Files changed**:
- `crates/frame-forge/Cargo.toml` — switch `ort` to `load-dynamic`, add `cuda`/`directml` features
- `crates/frame-forge/src/dl_match.rs` — EP-aware session builder, parse device ID from MSG_STITCH
- `crates/frame-forge/src/generation_log.rs` — new file: `GenerationLog` struct, JSON write
- Rust daemon MSG_STITCH handler — extend to read `device_id` and `log_path` trailing fields

**Key decisions**:
- Session builder selects EP based on `device_id` field received in MSG_STITCH: `cuda:N`, `directml:N`, `cpu:N`.
- `ORT_DYLIB_PATH` is set once in the daemon process environment at startup; ORT version changes require daemon restart.
- On EP init failure, fall back to CPU and record event in `GenerationLog.fallbacks`.
- Log written atomically to `log_path` field from MSG_STITCH at end of stitch; C# reads after task completes.

**Verification**:
```bash
mise run check-frame-forge   # must be 0 errors
# manual smoke test (CPU path, no GPU required):
./target/debug/frame-forge stitch --input a.png b.png --output out.png \
  --device cpu:0 --log-output /tmp/log.json && cat /tmp/log.json
```

**Gate**: `mise run check-frame-forge` passes. `mise run test` passes.

---

### Stage 2: C# device enumeration & ORT version service

**Goal**: `/Stitch/Devices` and `/Stitch/OrtVersions` endpoints functional.

**Files changed**:
- `Services/DeviceEnumerationService.cs` — new: sysfs (Linux) / WMI (Windows) device listing
- `Services/OrtVersionService.cs` — new: catalog fetch, download, retention, activation
- `Controllers/StitchController.cs` — new: GET /Devices, GET/POST /OrtVersions, SSE progress
- `Models/StitchDto.cs` — new: `ComputeDeviceDto`, `OrtVersionDto`, `OrtAssetDto`
- `PluginServiceRegistrator.cs` — register new services as singletons

**Key decisions**:
- `DeviceEnumerationService` is stateless (re-enumerates on each request); no caching needed.
- `OrtVersionService.StartAsync` triggers background ORT download on first startup if no
  ORT is present. Downloads from `microsoft/onnxruntime` GitHub Releases.
- Retry policy: 4xx → fail immediately; 5xx/network → exponential back-off (1s, 4s, 16s),
  max 3 retries.
- Active version pointer: plain text file `ort/active.txt`. `ORT_DYLIB_PATH` is computed
  from this file and injected into frame-forge process environment at invocation time.

**Verification**:
```bash
dotnet build packages/JellyfinSuite.Plugin/
mise run update-quick
curl http://localhost:8600/JellyfinSuite/Stitch/Devices | jq .
curl http://localhost:8600/JellyfinSuite/Stitch/OrtVersions | jq .
```

**Gate**: `mise run test` passes. Both endpoints return 200.

---

### Stage 3: C# model catalog service

**Goal**: `/Stitch/Models` and `/Stitch/Models/Download` endpoints functional. Replaces
`ModelAcquisitionService`.

**Files changed**:
- `Services/ModelCatalogService.cs` — new: replaces `ModelAcquisitionService`
  - Fetches catalog JSON from remote URL at startup (24h TTL cache)
  - Reads/writes `metadata.json` for `lastUsedAt` and LRU eviction
  - Exposes installed model paths for `FrameExportService` (same interface as before)
- `Models/StitchDto.cs` — add `ModelEntryDto`, `DownloadRequestDto`
- `Controllers/StitchController.cs` — add GET /Models, POST /Models/Download,
  GET /Models/DownloadProgress (SSE), DELETE /Models/{family}/{version}
- `PluginServiceRegistrator.cs` — swap `ModelAcquisitionService` for `ModelCatalogService`

**LRU eviction logic**:
```
on download complete:
  installed = versions where status == "installed" for family
  if installed.count > 5:
    candidates = installed where !isLatest, sorted by lastUsedAt asc
    delete candidates[0] from disk + metadata
```

**Verification**:
```bash
mise run update-quick
curl http://localhost:8600/JellyfinSuite/Stitch/Models | jq '{count: (.models|length), stale: .catalogStale}'
# POST download, check SSE stream, verify file appears on disk
```

**Gate**: `mise run test` passes. Existing stitch jobs still work (no regression in model
path resolution).

---

### Stage 4: Stitch job config + GenerationLog plumbing (C#)

**Goal**: stitch jobs accept `deviceId`/`modelFamily`/`modelVersion`, pass them to
frame-forge, and expose the resulting log via `GET /FrameExport/Result/{id}/generation-log.json`.

**Files changed**:
- `Models/FrameExportDto.cs` — add `deviceId`, `modelFamily`, `modelVersion`, `ortVersion`
  to `GenerateParams`
- `Models/StitchDto.cs` — add `GenerationLogDto`, `FallbackEventDto`
- `Services/FrameExportService.cs` — extend `SubmitStitchTaskAsync` to:
  - Resolve model file path from `ModelCatalogService` based on family+version
  - Resolve device ID (use default from `DeviceEnumerationService` if null)
  - Pass `device_id` and a temp `log_path` in the MSG_STITCH socket message
  - After task completes, read log JSON from `log_path` and attach to task
  - Extend `EnsureStartedAsync` to set `ORT_DYLIB_PATH` from `OrtVersionService.ActiveOrtLibPath`
  - `OrtVersionService.ActivateVersion()` kills daemon; next request auto-restarts with new env
- `Services/FrameExportTaskManager.cs` (or task record) — add `GenerationLog?` field
- `Controllers/FrameExportController.cs` — add `GET Result/{taskId}/generation-log.json`

**Verification**:
```bash
mise run update-quick
# Submit stitch with explicit deviceId, fetch log
curl -s "http://localhost:8600/JellyfinSuite/FrameExport/Result/$TASK/generation-log.json" | jq .
```

**Gate**: `mise run test` passes. Log endpoint returns 200 for stitch tasks, 404 for animate tasks.

---

### Stage 5: Frontend Advanced panel

**Goal**: Workshop modal shows Advanced section with device, model, and ORT controls.
Download log button appears on stitch results.

**Files changed**:
- `apps/player-enhancer/src/api/routes.ts` / `frameExportApi.ts` — extend: typed fetch for
  `/Stitch/Devices`, `/Stitch/Models`, `/Stitch/OrtVersions`
- `apps/player-enhancer/src/core/state.ts` — extend: `ExportSettings` gets optional
  `deviceId`/`modelFamily`/`modelVersion`/`ortVersion` fields, persisted automatically via the
  existing `loadSettingsOnce()`/`saveSettings()`/`updateSettings()` localStorage mechanism (no new
  storage key)
- `apps/player-enhancer/src/components/AdvancedPanel.tsx` — new, rendered from `ParamsPanel.tsx`:
  - Device combobox (populated from `/Stitch/Devices`)
  - Model name selector + version combobox (populated from `/Stitch/Models`)
    - "Latest" pinned at top
    - Union of catalog top-10 + installed; installed shown in accent colour
    - Selecting uninstalled version triggers download prompt
  - ORT version display + "Update" / version switcher
  - "Advanced" collapsible section with "don't change unless you know what you're doing" warning
- `apps/player-enhancer/src/components/FrameExportModal.tsx` — extend: read `AdvancedPanel`
  selections from `settingsAtom` and pass to `GenerateRequest.params` at the
  `generateExportMutation()` call site
- `apps/player-enhancer/src/components/ResultPage.tsx` — extend (not `apps/frontend`'s
  `FrameExportQueueWidget.tsx`, a separate persistent task-queue page; not `FrameExportJobRunner.tsx`,
  a headless SSE progress listener with no rendered UI):
  - For completed stitch tasks: show "Download log" button alongside "Download image" — **done**
  - "Download log" fetches `GET /FrameExport/Result/{taskId}/generation-log.json` via
    `frameExportApi.ts`'s `getGenerationLog` — **done**

**Verification**:
```bash
mise run deploy-enhancer  # if only frontend changes
# Browser: open workshop modal → expand Advanced → device list appears
# Change model family → version combobox updates
# Run stitch → result shows Download + Download log buttons
# Reload page → selections restored from localStorage
```

**Gate**: `mise run test` passes. `mise run update-quick` succeeds. Manual verification
against Quickstart scenarios 6, 9, 10.

---

### Stage 6: Integration validation & GPU smoke test

**Goal**: End-to-end validation on a GPU host; confirm all Quickstart scenarios pass.

**Actions**:
1. Run all Quickstart scenarios (see [quickstart.md](quickstart.md)).
2. Confirm SC-001: GPU stitch ≥ 2× faster than CPU on `synthetic_landscape` fixture.
3. Confirm SC-007: baseline stitch (no Advanced interaction) unchanged.
4. Run `mise run test` — must pass.
5. Run `mise run update` — full build + deploy.

**Gate**: All Quickstart scenarios pass. `mise run test` clean. No regressions in
animate or non-stitch frame export flows.

---

## Design Artifacts Index

| Artifact | Path | Status |
|---|---|---|
| Specification | [spec.md](spec.md) | Complete |
| Research | [research.md](research.md) | Complete |
| Data Model | [data-model.md](data-model.md) | Complete |
| API Contracts | [contracts/api.md](contracts/api.md) | Complete |
| Quickstart | [quickstart.md](quickstart.md) | Complete |
| Tasks | tasks.md | Pending (`/speckit-tasks`) |
