# Tasks: ORT GPU Acceleration & Model/Device Selection UI

**Input**: Design documents from `specs/012-ort-gpu-model-ui/`

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependencies on each other)
- **[Story]**: Which user story this task belongs to
- Tests are NOT included (not requested in spec)

---

## Phase 1: Setup

**Purpose**: Cargo feature switch and new file skeletons before any implementation begins.

- [X] T001 Switch `ort` dependency from `download-binaries` to `load-dynamic`; add `cuda`, `directml`, `openvino` optional Cargo features in `crates/frame-forge/Cargo.toml`; note that `rocm` is deferred to a post-v1 PR due to complexity (see research.md)
- [X] T002 [P] Create empty `crates/frame-forge/src/generation_log.rs` with module stub; add `mod generation_log;` to `crates/frame-forge/src/cli.rs`
- [X] T003 [P] Create empty `packages/JellyfinSuite.Plugin/Controllers/StitchController.cs` with namespace, `[ApiController]`, and `[Route("JellyfinSuite/Stitch")]` skeleton

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core Rust and C# infrastructure that all user stories depend on. No user story work can begin until this phase is complete.

**⚠️ CRITICAL**: Run `mise run check-frame-forge` after each Rust task. All must pass before proceeding.

- [X] T004 Implement EP-aware ORT session builder in `crates/frame-forge/src/dl_match.rs`: parse `--device` prefix (`cuda:N`, `directml:N`, `openvino:N`, `cpu:N`), build EP chain via `Session::builder().with_execution_providers([...])`, fall through to CPU on EP init failure
- [X] T005 Implement `GenerationLog` struct and `write_log(path, log)` in `crates/frame-forge/src/generation_log.rs`: fields per data-model.md (algorithm, modelFileName, modelVersion, ortVersion, deviceName, deviceType, deviceId, keypointMatchCount, inferenceDurationMs, totalDurationMs, fallbacks[]); serialize to JSON via serde
- [X] T006 Extend MSG_STITCH handler in the Rust daemon to read two trailing fields after the existing wire format: `device_id` (length-prefixed UTF-8, empty = default EP chain) and `log_path` (length-prefixed UTF-8, empty = skip log); pass `device_id` to EP session builder in `dl_match.rs`; populate `GenerationLog` throughout stitch execution; write JSON atomically to `log_path` on completion; capture fallback events when EP init fails and when DL → AKAZE fallback occurs
- [X] T007 Run `mise run check-frame-forge` — fix any errors before proceeding to T008
- [X] T008 [P] Create all new C# DTOs in `packages/JellyfinSuite.Plugin/Models/StitchDto.cs`: `ComputeDeviceDto`, `ModelEntryDto`, `ModelDownloadRequestDto`, `OrtVersionDto`, `OrtVersionActivateRequestDto`, `GenerationLogDto`, `FallbackEventDto` — all properties with `[JsonPropertyName("camelCase")]`
- [X] T009 [P] Extend `packages/JellyfinSuite.Plugin/Models/FrameExportDto.cs` `GenerateParams` with nullable fields: `deviceId`, `modelFamily`, `modelVersion`, `ortVersion` — each with `[JsonPropertyName]`
- [X] T010 Register `DeviceEnumerationService`, `OrtVersionService`, `ModelCatalogService` as singletons in `packages/JellyfinSuite.Plugin/PluginServiceRegistrator.cs`; inject into `StitchController` constructor
- [ ] T011 Run `mise run gen-types` (initial pass — after first DTO additions) to regenerate `packages/api-types/src/jellyfin-api.ts`; verify no TypeScript compile errors

**Checkpoint**: `mise run check-frame-forge` passes, `dotnet build` passes, gen-types succeeds.

---

## Phase 3: User Story 1 — GPU-accelerated stitch (Priority: P1) 🎯 MVP

**Goal**: Stitch jobs automatically use the best available GPU; CPU fallback is transparent.

**Independent Test**: Run a stitch job without any UI change; confirm `generation-log.json` shows `deviceType: "GPU"` on a GPU host, or `deviceType: "CPU"` with fallback note on CPU-only host.

- [X] T012 Implement `packages/JellyfinSuite.Plugin/Services/OrtVersionService.cs` bootstrap path only: `StartAsync` checks if any ORT version is present under `/config/plugins/JellyfinSuite/ort/`; if none, triggers background download of the platform-appropriate ORT asset (same OS detection logic as T033: Linux → `linux-x64-cuda`, Windows → `win-x64-directml`) from `microsoft/onnxruntime` GitHub Releases; writes `active.txt` on completion; exposes `ActiveOrtLibPath` property
- [X] T013 Implement `packages/JellyfinSuite.Plugin/Services/DeviceEnumerationService.cs`: on Linux parse `/sys/class/drm/card*/device/` sysfs entries (vendor, VRAM via `mem_info_vram_total`); on Windows use DXGI adapter enumeration via P/Invoke; return ordered `ComputeDeviceDto[]`; mark `isDefault=true` for highest-VRAM discrete GPU (or CPU if none)
- [X] T014 Extend `packages/JellyfinSuite.Plugin/Services/FrameExportService.cs` `SubmitStitchTaskAsync`: resolve default device from `DeviceEnumerationService` when `StitchJobConfig.deviceId` is null; pass resolved `device_id` and a temp `log_path` in the MSG_STITCH socket message; after task completes, read log JSON from `log_path` and store in task record's new `GenerationLog?` field; also extend `EnsureStartedAsync` to inject `ORT_DYLIB_PATH` (from `OrtVersionService.ActiveOrtLibPath`) into the daemon process environment
- [X] T015 Add `GenerationLog?` field to task record in `packages/JellyfinSuite.Plugin/Services/FrameExportTaskManager.cs`

**Checkpoint**: `mise run update` succeeds. Submit a stitch job. `FrameExport/Tasks` shows task complete. GPU used on GPU host.

---

## Phase 4: User Story 2 — Device selection in workshop modal (Priority: P2)

**Goal**: All compute devices listed in the Advanced panel; user can pick one; selection persists in localStorage.

**Independent Test**: Open workshop modal → Advanced section → device combobox shows at least CPU; picking a device and reloading the page restores the selection.

- [ ] T016 [US2] Add `GET /Stitch/Devices` endpoint to `packages/JellyfinSuite.Plugin/Controllers/StitchController.cs`: call `DeviceEnumerationService.EnumerateAsync()`, return `{ devices: ComputeDeviceDto[] }`
- [ ] T017 [P] [US2] Create `apps/frontend/src/api/stitchApi.ts`: typed fetch functions `fetchDevices()`, `fetchModels()`, `fetchOrtVersions()` — typed against generated `jellyfin-api.ts` types
- [ ] T018 [P] [US2] Create `apps/frontend/src/state/stitchSettings.ts`: `getStitchSettings()` / `setStitchSettings()` reading and writing `jfs_stitch_device_id`, `jfs_stitch_model_family`, `jfs_stitch_model_version`, `jfs_stitch_ort_version` from `localStorage`; return server-provided defaults when no localStorage value exists
- [ ] T019 [US2] Create `apps/frontend/src/components/StitchAdvancedPanel.tsx`: collapsible "Advanced" section with warning message; device combobox populated from `fetchDevices()`; selection wired to `setStitchSettings()`; restored from `getStitchSettings()` on mount; disable combobox while loading
- [ ] T020 [US2] Wire `StitchAdvancedPanel` into `apps/frontend/src/components/FrameExportJobRunner.tsx`: render panel below existing stitch controls; pass selected `deviceId` into `GenerateRequest.params` on submit; when user has never opened the Advanced section (localStorage keys absent), omit `deviceId`/`modelFamily` from params entirely so the server default applies (FR-013)

**Checkpoint**: `mise run deploy-enhancer`. Device list visible in browser. localStorage key `jfs_stitch_device_id` set after selection. Survives page reload.

---

## Phase 5: User Story 3 — Model selection in workshop modal (Priority: P2)

**Goal**: Model name + version combobox in Advanced panel; installed versions shown in accent colour; "Latest" pinned at top; "Disabled" removes DL entirely.

**Independent Test**: With two models installed, open Advanced section; both appear in version combobox; selecting one and running stitch produces log showing that model; selecting "Disabled" produces log with null model fields.

- [ ] T021 [US3] Implement `packages/JellyfinSuite.Plugin/Services/ModelCatalogService.cs`: `StartAsync` fetches catalog JSON from remote URL (replace `ModelAcquisitionService`); caches to `/config/plugins/JellyfinSuite/model-catalog.json` with 24h TTL (check `.ttl` file timestamp); reads/writes `models/metadata.json` for `lastUsedAt` per model file; exposes `GetInstalledModelPath(family, version)` for `FrameExportService` to consume (same contract as old `LightGluePath`/`EfficientLoFTRPath`)
- [ ] T022 [US3] Add `GET /Stitch/Models` to `packages/JellyfinSuite.Plugin/Controllers/StitchController.cs`: merge catalog top-10 per family with installed metadata; return `{ models: ModelEntryDto[], catalogFetchedAt, catalogStale }`
- [ ] T023 [US3] Add model name selector to `apps/frontend/src/components/StitchAdvancedPanel.tsx`: native `<select>` with options `lightglue | efficient-loftr | disabled`; when "disabled" is selected, hide version combobox
- [ ] T024 [US3] Add version combobox to `apps/frontend/src/components/StitchAdvancedPanel.tsx`: custom Preact combobox (not native select, to support colour coding); items = union of catalog top-10 + installed for selected family; "Latest" entry pinned at top; installed items rendered in accent colour (`--jf-accent` CSS var), catalog-only items in muted colour; sort: installed first, then catalog-only, each group descending by version
- [ ] T025 [US3] Wire model selection into `apps/frontend/src/components/FrameExportJobRunner.tsx`: pass `modelFamily` and `modelVersion` to `GenerateRequest.params`; update `ModelCatalogService.lastUsedAt` by calling `FrameExportService` which calls `ModelCatalogService.RecordUsage(family, version)` after each stitch

**Checkpoint**: `mise run deploy-enhancer`. Both model selectors visible. Select EfficientLoFTR + Latest → stitch → log shows `"family":"efficient-loftr"`.

---

## Phase 6: User Story 4 — Download generation log (Priority: P3)

**Goal**: After a stitch, "Download log" button appears alongside "Download image"; log JSON contains full generation details.

**Independent Test**: Complete a stitch job; result panel shows both buttons; downloaded JSON contains algorithm, modelFileName, deviceName, inferenceDurationMs.

- [ ] T026 [US4] Add `GET /FrameExport/Result/{taskId}/generation-log.json` to `packages/JellyfinSuite.Plugin/Controllers/FrameExportController.cs`: return `task.GenerationLog` serialised as JSON if task type is "stitch" and status is Complete; return 404 for animate tasks or missing log
- [ ] T027 [US4] Add "Download log" button and GPU fallback notice to `apps/frontend/src/components/FrameExportJobRunner.tsx`: (a) render "Download log" button only when `task.type === "stitch"` and task is complete; clicking fetches `GET /FrameExport/Result/{taskId}/generation-log.json` and triggers browser download as `<itemTitle>_<timestamp>_log.json`; (b) after fetching the log, if `fallbacks[]` is non-empty, display an inline notice in the result area (e.g. "GPU unavailable — completed on CPU") to satisfy FR-004 and US1 Scenarios 2 & 3

**Checkpoint**: `mise run deploy-enhancer`. Stitch result shows two download buttons. Animate result shows only one. Downloaded log JSON validates against schema in data-model.md.

---

## Phase 7: User Story 5 — Model download catalog (Priority: P4)

**Goal**: Model catalog section in Advanced panel; user can download a model, see progress, and LRU eviction keeps at most 5 versions per family.

**Independent Test**: Starting from no models, open catalog, click download, wait for completion; model appears in version combobox. Download 6 versions of same family; only 5 remain (latest + 4 LRU).

- [ ] T028 [US5] Implement LRU eviction in `packages/JellyfinSuite.Plugin/Services/ModelCatalogService.cs`: after each successful download, count installed versions per family; if > 5, find least recently used version where `isLatest == false` and delete its file + metadata entry
- [ ] T029 [US5] Implement retry policy in `ModelCatalogService` download helper: HTTP 4xx → immediate failure (no retry); HTTP 5xx / network error → exponential back-off retries (1s, 4s, 16s), max 3 attempts; on permanent failure, remove partial `.tmp` file
- [ ] T030 [US5] Add `POST /Stitch/Models/Download` and `GET /Stitch/Models/DownloadProgress` (SSE) and `DELETE /Stitch/Models/{family}/{version}` to `packages/JellyfinSuite.Plugin/Controllers/StitchController.cs`
- [ ] T031 [US5] Add model catalog section to `apps/frontend/src/components/StitchAdvancedPanel.tsx`: list catalog-only entries with name, version, file size, and "Download" button; on click, open SSE to `/Stitch/Models/DownloadProgress`; show progress bar during download; on completion, refresh model list and enable the newly installed version in the combobox
- [ ] T032 [US5] Handle "selecting uninstalled version" case in version combobox: when user selects a catalog-only (not installed) entry, show an inline "Download first" prompt with a download button rather than allowing the stitch to proceed

**Checkpoint**: `mise run update-quick`. Full download flow works in browser. LRU verified via API: install 6 versions, `GET /Stitch/Models` shows 5 installed.

---

## Phase 8: User Story 6 — ORT runtime management (Priority: P5)

**Goal**: Advanced panel shows active ORT version; user can download a newer version or roll back; at most 2 versions retained.

**Independent Test**: Active ORT version shown in panel. Download a second version; both visible. Activate older version; stitch still completes. Add a third; first is auto-deleted.

- [ ] T033 [US6] Complete `packages/JellyfinSuite.Plugin/Services/OrtVersionService.cs` full implementation: scan `/config/plugins/JellyfinSuite/ort/` for installed versions; implement `DownloadVersionAsync(version)` detecting host OS and EP availability at runtime (Linux → `linux-x64-cuda`, Windows → `win-x64-directml`, etc.) and fetching the matching asset name from the GitHub Releases catalog JSON; implement `ActivateVersion(version)` writing `active.txt` then killing the running frame-forge daemon process (if any) so that `EnsureStartedAsync` on the next request restarts it with the updated `ORT_DYLIB_PATH`; enforce 2-version retention (delete oldest non-active when count exceeds limit); same retry policy as models (4xx → fail, 5xx/network → 3 retries with back-off)
- [ ] T034 [US6] Add `GET /Stitch/OrtVersions`, `POST /Stitch/OrtVersions/Download`, `POST /Stitch/OrtVersions/Activate`, `GET /Stitch/OrtVersions/DownloadProgress` (SSE) to `packages/JellyfinSuite.Plugin/Controllers/StitchController.cs`
- [ ] T035 [US6] Add ORT section to `apps/frontend/src/components/StitchAdvancedPanel.tsx`: show active version string; "Check for updates" / "Update to vX.Y.Z" button; version list of retained versions with "Activate" button for non-active ones; progress bar during download via SSE

**Checkpoint**: `mise run update-quick`. ORT panel visible. Download + activate flow works. Rollback restores previous version. Stitch succeeds after rollback.

---

## Phase 9: Polish & Integration Validation

- [ ] T036 [P] Run `mise run gen-types` (final pass after all DTOs complete) — ensure `packages/api-types/src/jellyfin-api.ts` reflects all new DTOs; fix any TypeScript type errors in frontend
- [ ] T037 [P] Run `mise run check-frame-forge` — confirm Rust crate compiles clean with `load-dynamic` and all EP features enabled
- [ ] T038 Run all Quickstart scenarios from `specs/012-ort-gpu-model-ui/quickstart.md` (Scenarios 1–10) against the running `jellyfin-dev` container; for SC-001 specifically: submit the same stitch twice — once with `deviceId: "cuda:0"` and once with `deviceId: "cpu:0"` — and compare `inferenceDurationMs` in the two generation logs to confirm GPU is ≥ 2× faster; document any failures
- [ ] T039 Run `mise run test` — full suite (Rust + TypeScript + C#) must pass with 0 failures
- [ ] T040 Run `mise run update` — full build + deploy; confirm container restarts cleanly and frame export health endpoint returns `available: true`
- [ ] T041 Publish initial `model-catalog.json` to the project-controlled CDN URL; hardcode or configure that URL in `packages/JellyfinSuite.Plugin/Services/ModelCatalogService.cs` (e.g., as a plugin configuration constant); document the URL and update process in `specs/012-ort-gpu-model-ui/research.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — **blocks all user stories**
- **US1 (Phase 3)**: Depends on Phase 2 — first story to implement (MVP gate)
- **US2 (Phase 4)**: Depends on Phase 2; integrates with US1 device resolution
- **US3 (Phase 5)**: Depends on Phase 2; integrates with US1 model path resolution
- **US4 (Phase 6)**: Depends on US1 (GenerationLog attached to task record in T014-T015)
- **US5 (Phase 7)**: Depends on US3 (ModelCatalogService must exist for download to extend)
- **US6 (Phase 8)**: Depends on US1 (OrtVersionService bootstrap in T012)
- **Polish (Phase 9)**: Depends on all desired stories complete

### User Story Dependencies

| Story | Depends on | Independently testable? |
|---|---|---|
| US1 (GPU stitch) | Foundational | Yes — no UI needed |
| US2 (Device UI) | Foundational + US1 (device default logic) | Yes — mock GPU host works |
| US3 (Model UI) | Foundational + US1 (model path resolution) | Yes |
| US4 (Gen log) | US1 (log attached to task) | Yes |
| US5 (Model catalog) | US3 (ModelCatalogService) | Yes |
| US6 (ORT mgmt) | US1 (OrtVersionService bootstrap) | Yes |

### Parallel Opportunities

Within Phase 2:
- T008 and T009 are parallel (different C# files)

Within Phase 4 (US2):
- T017 and T018 are parallel (different TS files)

Within Phase 3 (US1):
- T012 and T013 are parallel (different C# services)

---

## Parallel Execution Example: Phase 2 Foundational

```
Sequential: T004 → T005 → T006 → T007 (Rust chain, each depends on previous)

Parallel after T007:
  T008 [StitchDto.cs]          ┐
  T009 [FrameExportDto.cs]     ┘ → T010 → T011
```

## Parallel Execution Example: Phase 4 (US2)

```
T016 (StitchController GET /Devices) → available for frontend

Parallel:
  T017 [stitchApi.ts]          ┐
  T018 [stitchSettings.ts]     ┘ → T019 [StitchAdvancedPanel] → T020 [JobRunner wire-up]
```

---

## Implementation Strategy

### MVP (User Story 1 only — Stages 1-3 of plan)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: US1 (GPU stitch)
4. **STOP and VALIDATE**: stitch produces GenerationLog with GPU device
5. Deploy — already delivers GPU acceleration with zero UI change

### Incremental Delivery

- Phase 3 → GPU stitch works (no UI change needed)
- Phase 4 → Device selector in Advanced panel
- Phase 5 → Model selector in Advanced panel
- Phase 6 → Download log button appears on stitch result
- Phase 7 → Full model catalog download flow
- Phase 8 → ORT version management panel

---

## Notes

- After every Rust change: `mise run check-frame-forge` before build
- After every C# DTO change: `mise run gen-types` to keep TypeScript types in sync
- `mise run deploy-enhancer` for frontend-only changes (fastest loop)
- `mise run update-quick` for C# + frontend changes
- `mise run update` only when Rust changes are involved
- Never run `mise run update` without user confirmation (restarts container)
