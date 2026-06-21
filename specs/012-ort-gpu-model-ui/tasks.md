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

- [X] T012 Implement `packages/JellyfinSuite.Plugin/Services/OrtVersionService.cs` bootstrap path only: `StartAsync` checks if any ORT version is present under `/config/plugins/JellyfinSuite/ort/`; if none, triggers background download of the platform-appropriate ORT asset (same OS detection logic as T033: Linux → `linux-x64-cuda`, Windows → `win-x64-directml`) from `microsoft/onnxruntime` GitHub Releases; writes `active.txt` on completion; exposes `ActiveOrtLibPath` property — 已在 T033 的完整实现中补上：`ExecuteAsync` 扫描 `active.txt` 设置 `_activeOrtLibPath`，若未找到任何已安装版本且非 Windows，则 `Task.Run` 触发新增的 `BootstrapDownloadAsync`（拉取 catalog 最新版本、下载、解压、写 `installed-at.txt` 并自动 `ActivateVersionAsync`），真正满足"首次启动自动下载并激活"的原始需求
- [ ] T013 Implement `packages/JellyfinSuite.Plugin/Services/DeviceEnumerationService.cs`: on Linux parse `/sys/class/drm/card*/device/` sysfs entries (vendor, VRAM via `mem_info_vram_total`); on Windows use DXGI adapter enumeration via P/Invoke; return ordered `ComputeDeviceDto[]`; mark `isDefault=true` for highest-VRAM discrete GPU (or CPU if none) — **重新核查发现误标**：Linux 分支（sysfs）确实完整实现；但 `EnumerateWindows()` 目前是显式 stub（`yield break`，注释写"Stub: full DXGI P/Invoke enumeration is implemented in T013"——循环引用自身，实际从未实现），Windows 主机上会直接落到纯 CPU fallback。之前被误标为 `[X]`，现改回未完成；DXGI P/Invoke 枚举需要真实 Windows 环境验证（这台开发机是 Linux），留待有 Windows 测试条件时补上
- [X] T014 Extend `packages/JellyfinSuite.Plugin/Services/FrameExportService.cs` `SubmitStitchTaskAsync`: resolve default device from `DeviceEnumerationService` when `StitchJobConfig.deviceId` is null; pass resolved `device_id` and a temp `log_path` in the MSG_STITCH socket message; after task completes, read log JSON from `log_path` and store in task record's new `GenerationLog?` field; also extend `EnsureStartedAsync` to inject `ORT_DYLIB_PATH` (from `OrtVersionService.ActiveOrtLibPath`) into the daemon process environment
- [X] T015 Add `GenerationLog?` field to task record in `packages/JellyfinSuite.Plugin/Services/FrameExportTaskManager.cs`

**Checkpoint**: `mise run update` succeeds. Submit a stitch job. `FrameExport/Tasks` shows task complete. GPU used on GPU host.

---

## Phase 4: User Story 2 — Device selection in workshop modal (Priority: P2)

**Goal**: All compute devices listed in the Advanced panel; user can pick one; selection persists in localStorage.

**Independent Test**: Open workshop modal → Advanced section → device combobox shows at least CPU; picking a device and reloading the page restores the selection.

- [X] T016 [US2] Add `GET /Stitch/Devices` endpoint to `packages/JellyfinSuite.Plugin/Controllers/StitchController.cs`: call `DeviceEnumerationService.EnumerateAsync()`, return `{ devices: ComputeDeviceDto[] }`
- [X] T017 [P] [US2] Add `suite.stitch.devices()`/`models()`/`ortVersions()` routes to `apps/player-enhancer/src/api/routes.ts` and typed fetch functions `fetchDevices()`, `fetchModels()`, `fetchOrtVersions()` to `apps/player-enhancer/src/api/frameExportApi.ts` — typed against generated `jellyfin-api.ts` types (not a new `apps/frontend/src/api/stitchApi.ts`: this Advanced panel lives in the workshop modal, i.e. `apps/player-enhancer`, not the `apps/frontend` queue widget — see ResultPage download-log precedent)
- [X] T018 [P] [US2] Extend the `ExportSettings` interface and `DEFAULT_SETTINGS` in `apps/player-enhancer/src/core/state.ts` with optional `deviceId?`, `modelFamily?`, `modelVersion?`, `ortVersion?` fields (all `undefined` by default = "use server default"); no new file or separate localStorage key is needed — persistence already flows through the existing `loadSettingsOnce()`/`saveSettings()`/`updateSettings()` mechanism (FR-004a)
- [X] T019 [US2] Create `apps/player-enhancer/src/components/AdvancedPanel.tsx`: collapsible "Advanced" section with usage warning (FR-012); device combobox populated from `fetchDevices()`; selection calls `updateSettings({ deviceId })`; initial value read from `settingsAtom`; disable combobox while loading; render `<AdvancedPanel>` from within `apps/player-enhancer/src/components/ParamsPanel.tsx` below the existing quality/dimensions/crop controls. Add `advanced.title`, `advanced.warning`, `advanced.device` i18n keys to all three locale blocks (en/zh/ja) in `apps/player-enhancer/src/lib/i18n.ts`
- [X] T020 [US2] Wire the Advanced panel's selections into the generate request: in `apps/player-enhancer/src/components/FrameExportModal.tsx`, read `deviceId` from `settingsAtom`'s current value at the `generateExportMutation()` call site and include it in the request params; when `deviceId` is `undefined` (Advanced section never opened), omit it entirely so the server default applies (FR-013)

**Checkpoint**: `mise run deploy-enhancer`. Device list visible in browser. localStorage key `jfs_stitch_device_id` set after selection. Survives page reload.

---

## Phase 5: User Story 3 — Model selection in workshop modal (Priority: P2)

**Goal**: Model name + version combobox in Advanced panel; installed versions shown in accent colour; "Latest" pinned at top; "Disabled" removes DL entirely.

**Independent Test**: With two models installed, open Advanced section; both appear in version combobox; selecting one and running stitch produces log showing that model; selecting "Disabled" produces log with null model fields.

- [X] T021 [US3] Implement `packages/JellyfinSuite.Plugin/Services/ModelCatalogService.cs`: `StartAsync` fetches catalog JSON from remote URL (replace `ModelAcquisitionService`); caches to `/config/plugins/JellyfinSuite/model-catalog.json` with 24h TTL (check `.ttl` file timestamp); reads/writes `models/metadata.json` for `lastUsedAt` per model file; exposes `GetInstalledModelPath(family, version)` for `FrameExportService` to consume (same contract as old `LightGluePath`/`EfficientLoFTRPath`) — `RefreshCatalogIfStaleAsync` now does a real `HttpClient` GET against `FRAME_FORGE_MODEL_CATALOG_URL` (env override) / a default placeholder URL, parses the research.md §4 schema, atomically writes `model-catalog.json` + `.ttl` (unix epoch seconds), and gracefully falls back to the on-disk cache or an installed-only listing on any network/parse failure (retry throttled to once per 5 min so an unreachable URL doesn't spam requests). **Note**: the default URL is a placeholder — T067 is what actually publishes real catalog content there; until then every fetch 404s and the service correctly falls back, which is expected and by design, not a defect
- [X] T022 [US3] Add `GET /Stitch/Models` to `packages/JellyfinSuite.Plugin/Controllers/StitchController.cs`: merge catalog top-10 per family with installed metadata; return `{ models: ModelEntryDto[], catalogFetchedAt, catalogStale }` — endpoint is wired and returns the correct shape; now that T021 lands, the catalog-only portion will populate once T067 publishes real catalog content (currently empty only because the placeholder CDN URL has nothing hosted yet, not because of a code defect)
- [X] T023 [US3] Add model name selector to `apps/player-enhancer/src/components/AdvancedPanel.tsx`: native `<select>` with options `lightglue | efficient-loftr | disabled`, calling `updateSettings({ modelFamily })`; when "disabled" is selected, hide version combobox. Add `advanced.model`, `advanced.modelDisabled` i18n keys (en/zh/ja) in `apps/player-enhancer/src/lib/i18n.ts` — i18n keys were already present from an earlier session; selector implemented with `effectiveFamily = st.modelFamily ?? 'lightglue'` for display only (actual `settings.modelFamily` stays `undefined` until touched, so it's correctly omitted from the request per FR-013); selecting a real family resets `modelVersion` to `undefined` ("Latest")
- [X] T024 [US3] Add version combobox to `apps/player-enhancer/src/components/AdvancedPanel.tsx`: custom React combobox (not native select, to support colour coding), calling `updateSettings({ modelVersion })`; items = union of catalog top-10 + installed for selected family; "Latest" entry pinned at top; installed items rendered in accent colour, catalog-only items in muted colour; sort: installed first, then catalog-only, each group descending by version. Add `advanced.modelVersion`, `advanced.latest` i18n keys (en/zh/ja) — implemented as a button+`<ul>` popover (`.jfs-fe-combobox-*` in `player.css`) with outside-click-to-close; used the existing `#00a4dc` accent colour already used elsewhere in this stylesheet for "installed" rather than introducing a new unused `--jf-accent` CSS variable, since no other component in this file uses custom properties
- [X] T025 [US3] Wire model selection into the generate request: in `apps/player-enhancer/src/components/FrameExportModal.tsx`, read `modelFamily`/`modelVersion` from `settingsAtom` at the same `generateExportMutation()` call site as T020 and include them in the request params; update `ModelCatalogService.lastUsedAt` by calling `FrameExportService` which calls `ModelCatalogService.RecordUsage(family, version)` after each stitch — request-body wiring done (both fields omitted when unset, matching FR-013); `RecordUsageAsync` call added in `FrameExportService.SubmitStitchTaskAsync` right after `GenerationLogDto` is parsed (uses `log.Algorithm`/`log.ModelVersion`, which the Rust daemon echoes verbatim per `dl_match::algorithm_name`, so this correctly records the *resolved* version even when "Latest" was requested); `ModelCatalogService` is now wired into `FrameExportService` via the existing `SetAuxServices`/`FrameExportAuxServicesWirer` pattern (extended, not duplicated) to avoid a constructor-time circular dependency

**Checkpoint**: `mise run deploy-enhancer`. Both model selectors visible. Select EfficientLoFTR + Latest → stitch → log shows `"family":"efficient-loftr"`.

---

## Phase 6: User Story 4 — Download generation log (Priority: P3)

**Goal**: After a stitch, "Download log" button appears alongside "Download image"; log JSON contains full generation details.

**Independent Test**: Complete a stitch job; result panel shows both buttons; downloaded JSON contains algorithm, modelFileName, deviceName, inferenceDurationMs.

- [X] T026 [US4] Add `GET /FrameExport/Result/{taskId}/generation-log.json` to `packages/JellyfinSuite.Plugin/Controllers/FrameExportController.cs`: return `task.GenerationLog` serialised as JSON if task type is "stitch" and status is Complete; return 404 for animate tasks or missing log
- [X] T027 [US4] Add "Download log" button and GPU fallback notice to `apps/player-enhancer/src/components/ResultPage.tsx` (the workshop modal's result view — not `FrameExportQueueWidget.tsx` in `apps/frontend`, which is a separate persistent task-queue page with no log-download interaction by design; not `FrameExportJobRunner.tsx` either, a headless SSE progress listener with no rendered UI): (a) render "Download log" button only when `sExportType.value === "stitch"` and the result is complete; clicking fetches `GET /FrameExport/Result/{taskId}/generation-log.json` (via `frameExportApi.ts`'s `getGenerationLog`) and triggers a blob download as `<itemTitle>_<taskId6>_log.json`; (b) after fetching the log, if `fallbacks[]` is non-empty, display an inline notice in the result area to satisfy FR-004 and US1 Scenarios 2 & 3 — **done**, see `handleDownloadLog`/`gpuFallback` in that file

**Checkpoint**: `mise run deploy-enhancer`. Stitch result shows two download buttons. Animate result shows only one. Downloaded log JSON validates against schema in data-model.md.

---

## Phase 7: User Story 5 — Model download catalog (Priority: P4)

**Goal**: Model catalog section in Advanced panel; user can download a model, see progress, and LRU eviction keeps at most 5 versions per family.

**Independent Test**: Starting from no models, open catalog, click download, wait for completion; model appears in version combobox. Download 6 versions of same family; only 5 remain (latest + 4 LRU).

- [X] T028 [US5] Implement LRU eviction in `packages/JellyfinSuite.Plugin/Services/ModelCatalogService.cs`: after each successful download, count installed versions per family; if > 5, find least recently used version where `isLatest == false` and delete its file + metadata entry — implemented in `EvictLruIfNeededAsync`, called from `DownloadModelFileAsync` after each successful install; whole mutate-then-persist sequence (including `RegisterInstalledAsync`) runs under `_metaLock` to stay correct under concurrent downloads of different families
- [X] T029 [US5] Implement retry policy in `ModelCatalogService` download helper: HTTP 4xx → immediate failure (no retry); HTTP 5xx / network error → exponential back-off retries (1s, 4s, 16s), max 3 attempts; on permanent failure, remove partial `.tmp` file — implemented in `DownloadModelFileAsync`: 4 total attempts (1 initial + 3 retries), 4xx short-circuits via `FailDownloadAsync` with no retry, 5xx/network errors retry with the specified backoff array, `.tmp` deleted on every failed attempt and on final permanent failure
- [X] T030 [US5] Add `POST /Stitch/Models/Download` and `GET /Stitch/Models/DownloadProgress` (SSE) and `DELETE /Stitch/Models/{family}/{version}` to `packages/JellyfinSuite.Plugin/Controllers/StitchController.cs` — routes are wired; now that T028/T029 have landed, `DownloadModel`/`GetModelDownloadProgress` are backed by the real `ModelCatalogService.StartDownloadAsync` (Channel-per-download, registered in a `ConcurrentDictionary`) and `GetDownloadProgressAsync` (thin `IAsyncEnumerable` forwarder draining that channel) rather than stubs; `DeleteModel` remains fully functional
- [X] T031 [US5] Add model catalog section to `apps/player-enhancer/src/components/AdvancedPanel.tsx`: list catalog-only entries with name, version, file size, and "Download" button; on click, open SSE to `/Stitch/Models/DownloadProgress`; show progress bar during download; on completion, refresh model list and enable the newly installed version in the combobox. Add `advanced.download`, `advanced.downloading` i18n keys (en/zh/ja) in `apps/player-enhancer/src/lib/i18n.ts` — i18n keys were already present from an earlier session; implemented as a single inline `.jfs-fe-download-prompt` panel (file size via new `formatBytes` helper in `lib/utils.ts`) rather than a separate always-visible catalog browser, since the version combobox (T024) already scopes catalog-only entries to the selected family — clicking "Download" calls `downloadModelMutation().mutationFn` then opens `openModelDownloadProgressStream`; on `status:"installed"` it invalidates the `stitchModels` query key and commits `modelFamily`/`modelVersion` into settings
- [X] T032 [US5] Handle "selecting uninstalled version" case in `AdvancedPanel.tsx`'s version combobox: when user selects a catalog-only (not installed) entry, show an inline "Download first" prompt with a download button rather than allowing the stitch to proceed. Add `advanced.downloadFirst` i18n key (en/zh/ja) — implemented via `selectCatalogVersion`: clicking a catalog-only combobox item does NOT call `updateSettings`/close as "selected"; it instead populates `pending` state, which renders the same `.jfs-fe-download-prompt` panel built for T031 (shared implementation, not duplicated)

**Checkpoint**: `mise run update-quick`. Full download flow works in browser. LRU verified via API: install 6 versions, `GET /Stitch/Models` shows 5 installed.

---

## Phase 8: User Story 6 — ORT runtime management (Priority: P5)

**Goal**: Advanced panel shows active ORT version; user can download a newer version or roll back; at most 2 versions retained.

**Independent Test**: Active ORT version shown in panel. Download a second version; both visible. Activate older version; stitch still completes. Add a third; first is auto-deleted.

- [X] T033 [US6] Complete `packages/JellyfinSuite.Plugin/Services/OrtVersionService.cs` full implementation: scan `/config/plugins/JellyfinSuite/ort/` for installed versions; implement `DownloadVersionAsync(version)` detecting host OS and EP availability at runtime (Linux → `linux-x64-cuda`, Windows → `win-x64-directml`, etc.) and fetching the matching asset name from the GitHub Releases catalog JSON; implement `ActivateVersion(version)` writing `active.txt` then killing the running frame-forge daemon process (if any) so that `EnsureStartedAsync` on the next request restarts it with the updated `ORT_DYLIB_PATH`; enforce 2-version retention (delete oldest non-active when count exceeds limit); same retry policy as models (4xx → fail, 5xx/network → 3 retries with back-off) — 已重写完整实现（589 行）：`RefreshCatalogIfStaleAsync`/`LoadCatalogFromDiskAsync`/`ApplyCatalogJson` 独立抓取+缓存 `ortVersions` 数组（24h TTL，与 `ModelCatalogService` 各自独立缓存避免文件写竞争）；`GetVersionListAsync` 扫描已安装目录（Status="installed"）并追加一条最新未安装版本（Status="catalog"）；`StartDownloadAsync` 支持 `"latest"` 哨兵值，经 `ResolveAssetKey` 按 OS+GPU 厂商选资产（Linux+NVIDIA→`linux-x64-cuda`，Windows+GPU→`win-x64-directml`，否则对应 CPU 变体；显式注释标注 gpu/gpu_cuda13 区分延后至 T042）；`DownloadOrtAssetAsync` 实现 4 次重试退避（1s/4s/16s,4xx 不重试）+ SHA256 校验+ `ExtractArchiveAsync`（.zip 用 `ZipFile`，.tgz/.tar.gz 用 `GZipStream`+`TarFile.ExtractToDirectoryAsync`）；`ActivateVersionAsync` 写 `active.txt` 后调用新增的 `FrameExportService.KillDaemon()`（杀掉 daemon 让下次请求用新 `ORT_DYLIB_PATH` 重启）并触发 `EvictOldVersionsAsync`（按 `installed-at.txt` 时间戳保留最新 2 个版本）；新增 `BootstrapDownloadAsync` 满足 T012 的首次启动自动下载诉求
  - **订正（T039 期间发现）**：`EvictOldVersionsAsync` 在 compaction 之后磁盘上的实际内容里仍残留两处编译错误——早退分支是裸 `return;`（方法签名是非 `async Task`，必须 `return Task.CompletedTask;`）、结尾是裸 `await Task.CompletedTask;`（非 `async` 方法不能 `await`）。说明此前会话声称的修复未完整落盘。本次已重新修正为全程同步返回 `Task.CompletedTask`，不含 `await`。本机仍无 dotnet，无法编译验证，仅代码审查确认语法正确；提醒：T033 的"已验证"结论需要打折扣，后续如有 Windows/dotnet 环境应优先跑一次 `dotnet build` 确认本文件及整个 plugin 项目无残留编译错误。
- [X] T034 [US6] Add `GET /Stitch/OrtVersions`, `POST /Stitch/OrtVersions/Download`, `POST /Stitch/OrtVersions/Activate`, `GET /Stitch/OrtVersions/DownloadProgress` (SSE) to `packages/JellyfinSuite.Plugin/Controllers/StitchController.cs` — 路由已接好，且全部 4 个 action 现已真正可用：`GetOrtVersions`/`ActivateOrtVersion` 一直是真实实现；`DownloadOrtVersion`/`GetOrtDownloadProgress` 随 T033 补全后不再是 "not implemented" 占位——`StartDownloadAsync` 真正触发下载并通过 `Channel<OrtDownloadProgressDto>` 推送进度，`GetDownloadProgressAsync` 是真实的 SSE 转发实现（与 `ModelCatalogService` 的下载进度模式一致）
- [X] T035 [US6] Add ORT section to `apps/player-enhancer/src/components/AdvancedPanel.tsx`: show active version string; "Check for updates" / "Update to vX.Y.Z" button; version list of retained versions with "Activate" button for non-active ones; progress bar during download via SSE. Add `advanced.ortVersion`, `advanced.checkUpdates`, `advanced.activate` i18n keys (en/zh/ja) in `apps/player-enhancer/src/lib/i18n.ts` — 已实现：新增 `ortVersionsQuery`/`status` 字段到 `frameExportApi.ts`（与 C# `OrtVersionDto.Status` 保持手动同步）；`AdvancedPanel.tsx` 新增 ORT 区块，展示 `activeVersion`，按 `versions` 中是否存在 `status==='catalog'` 的条目切换"检查更新"/"更新到 vX.Y.Z"按钮（点击后走 `downloadOrtVersionMutation`+SSE 进度条，复用模型下载同款 UI 模式），并列出已安装的非激活版本各配一个"激活"按钮（`activateOrtVersionMutation`）；新增 `advanced.updateTo` i18n key（en/zh/ja，含 `{version}` 占位符，沿用 `t(key).replace('{version}', ...)` 既有模式）。`mise run lint` 通过（0 errors，仅有与本次改动无关的既存 warning）；`pnpm exec tsc --noEmit` 无类型错误

**Checkpoint**: `mise run update-quick`. ORT panel visible. Download + activate flow works. Rollback restores previous version. Stitch succeeds after rollback.

---

## Phase 9: GPU Compatibility & Safety Net (Priority: P1 — closes production hang risk)

**Goal**: The hang observed during manual CUDA EP testing (Blackwell/RTX 50-series + ORT 1.26.0, see research.md) cannot occur in production: `build_ep_session` is timeout-protected, GPU/ORT combinations known to be broken are denylisted before the EP is even attempted, and the missing OpenVINO branch no longer silently falls through to CPU.

**Independent Test**: Force a `cuda` device on a denylisted GPU — stitch falls back to CPU automatically with a logged reason, no hang. Simulate an EP init that never returns — stitch fails over to CPU within the configured timeout instead of hanging the daemon. Request `openvino:0` — `build_ep_session` actually attempts the OpenVINO EP instead of silently using CPU.

- [X] T036 [P] Fix GPU-flavored ORT build hanging on plain CPU session creation: register `CPUExecutionProvider` explicitly in `build_ep_session`'s `make_cpu` closure in `crates/frame-forge/src/dl_match.rs` instead of relying on ORT's implicit default EP — verified the bare-default pattern hangs indefinitely (0% CPU, `futex_do_wait`) when `ORT_DYLIB_PATH` points at a `gpu`/`gpu_cuda13` build, while explicit registration completes in ~0.2-0.5s (4/4 reproductions fixed); also switched `forge stitch` CLI (`crates/frame-forge/src/cli.rs`) from the non-EP-aware `loftr_guard()` singleton to the EP-aware `load_matcher_for_request` (new `--device` flag, default `cpu:0`) so the CLI/demo path and the production `server.rs` path share one session-construction code path — see research.md §7b
- [X] T037 [P] Add EP construction timeout to `build_ep_session` in `crates/frame-forge/src/dl_match.rs`: run `Session::builder()...with_execution_providers(...)...commit_from_file(path)` on a worker thread with a bounded wait (default 15s, configurable via `FRAME_FORGE_EP_INIT_TIMEOUT_SECS` env var); apply to **all three** branches (`"cuda"`, `"directml"`, and the `make_cpu` default) since T036 fixed one reproduced CPU-path hang but does not prove no other combination can hang ORT's CPU EP; on timeout, call `std::process::exit()` rather than returning normally — research.md §7b found the abandoned worker thread can hold an ORT-internal mutex that a normal `main`-return's shared-library static destructors (`atexit`/`__cxa_finalize` for `libonnxruntime.so`) then block on, so "let the process exit naturally" is not actually safe — 已实现新增的 `run_with_ep_timeout<T, F>` 泛型helper（`std::sync::mpsc::channel` + `recv_timeout`，超时分支 `std::process::exit(1)`，与既有 `cli.rs::cmd_gpu_test` 诊断用的同款 thread+channel 模式一致，但生产路径用 `process::exit` 而非诊断工具的"打印后跳出循环"）；实际包到了全部 4 个分支（`cuda`/`directml`/`openvino`/默认 cpu），包括 CUDA/DirectML/OpenVINO 失败后走的 CPU 兜底分支（之前裸 `make_cpu(path)?` 现在也套了超时）；`make_cpu` 闭包提升为顶层 fn `make_cpu_session`（消除闭包跨线程 move 的所有权问题）；超时秒数读取 `FRAME_FORGE_EP_INIT_TIMEOUT_SECS`（默认 15s，沿用 `ep_init_timeout_secs()`）。`mise run check-frame-forge-opencv-linux` 编译通过（0 errors，仅有与本次改动无关的既存 dead-code warning）
- [X] T038 Add missing `"openvino"` match arm to `build_ep_session` in `crates/frame-forge/src/dl_match.rs`: same try-GPU-then-CPU-fallback pattern as `"cuda"`/`"directml"` using `ort::execution_providers::OpenVINOExecutionProvider`, `with_device_type("GPU")`. Compiles clean (`mise run check-frame-forge-opencv-linux`), but **not yet verified against real Intel GPU hardware** (this dev machine only has an NVIDIA GPU) — written symmetrically to the proven cuda/directml branches but unconfirmed whether it actually engages an Intel iGPU/Arc dGPU rather than OpenVINO's own internal CPU path. T037 落地后已用 `run_with_ep_timeout` 包住该分支（含其 CPU 兜底），不再是裸调用。
- [X] T039 [P] Add GPU compute-capability / vendor detection to `packages/JellyfinSuite.Plugin/Services/DeviceEnumerationService.cs`: on Linux, shell out to `nvidia-smi --query-gpu=compute_cap --format=csv,noheader` (NVML-based, independent of the ORT/CUDA init path so detection itself cannot hang) and populate a new `computeCapability` field on `ComputeDeviceDto`; leave null when unavailable (non-NVIDIA GPU, `nvidia-smi` missing)
  - 验证说明（代码审查，本机无 dotnet）：`StitchDto.cs` 的 `ComputeDeviceDto` 新增 `ComputeCapability`（`[JsonPropertyName("computeCapability")]`，可空）。`DeviceEnumerationService.EnumerateLinux()` 仅在已发现至少一块 NVIDIA GPU 时才惰性调用新增的 `GetNvidiaComputeCapabilities()`（避免在纯 AMD/Intel/CPU 主机上无谓 spawn `nvidia-smi` 进程触发异常路径）；该方法跑 `nvidia-smi --query-gpu=pci.bus_id,compute_cap --format=csv,noheader`（5s 超时，`nvidia-smi` 缺失/失败时走 catch 分支返回空字典，不抛给调用方），按 PCI bus id 建立 map。为了正确把 nvidia-smi 报告的 GPU 与 sysfs 遍历到的 DRM card 一一对应（而非假设顺序一致——多 GPU 主机上这个假设会错），新增 `ReadPciSlotName()` 读取每个 DRM device 的 `uevent` 文件中的 `PCI_SLOT_NAME=` 行，再用 `NormalisePciBusId()` 把 sysfs 的 4 位 domain 形式（`0000:01:00.0`）和 nvidia-smi 的 8 位 domain 形式（`00000000:01:00.0`）都归一化成 `bus:device.function`（`01:00.0`）后比较。已同步手写 TS 接口 `frameExportApi.ts` 的 `ComputeDeviceDto.computeCapability: string | null`（遵循既有手动同步惯例，非 `mise run gen-types` codegen 范围）。
- [X] T040 Create `crates/frame-forge/gpu-compat.json` (or an embedded Rust const) listing known-incompatible {vendor, computeCapability, ortVersionRange} combinations, seeded with NVIDIA Blackwell (`sm_120`) + ORT 1.26.0 standard `gpu` (CUDA 12) build → force CPU or require `gpu_cuda13` instead (research.md §7a — fixed for this project by switching to the `gpu_cuda13` asset, but the denylist still protects any future ORT version pin that regresses); load this list once at daemon startup
  - 验证说明：新建 `crates/frame-forge/gpu-compat.json`，seed 一条记录 `{vendor: "NVIDIA", computeCapability: "12.0", ortAssetKey: "linux-x64-gpu", reason: ...}`。新建 `crates/frame-forge/src/gpu_compat.rs`（`#[cfg(feature = "opencv")]`，在 `main.rs`/`cli.rs` 两个 bin 入口都注册了 `mod gpu_compat;`，因为本 crate 有 `frame-forge`/`forge` 两个 bin target 各自独立的 mod 树）：`include_str!("../gpu-compat.json")` 编译期内嵌（避免容器部署时需要单独拷贝配置文件），`OnceLock` 缓存一次性 `serde_json` 解析结果；`check(vendor, compute_capability, ort_asset_key)` 返回 `Option<String>`（命中原因）。`mise run check-frame-forge-opencv-linux` 编译通过（0 errors）。
- [X] T041 Wire the denylist from T040 into the device resolution path (`build_ep_session` or its caller in `server.rs`): before attempting a GPU EP, check the requested device's `computeCapability` (passed through from C#, see T039) against the active ORT version's denylist; if matched, skip the GPU attempt entirely and go straight to CPU with a `FallbackEvent` reason citing the denylist entry — this avoids paying even the bounded T037 timeout for hardware known in advance to hang
  - 验证说明：在 `dl_match.rs::build_ep_session` 的 `"cuda"` 分支最前面（GPU EP 尝试之前）插入检查——`gpu_compat::detect_compute_capability(dev_idx)` 独立 shell 出 `nvidia-smi --query-gpu=compute_cap --format=csv,noheader -i <index>`（不依赖 C# 侧已发生过的检测，daemon 自身具备完整安全检查能力）拿到 compute capability，再用 `gpu_compat::active_ort_asset_key()` 读取新增的 `FRAME_FORGE_ORT_ASSET_KEY` 环境变量，命中 denylist 则直接走 `make_cpu_session`（仍套 `run_with_ep_timeout`）并记录 `FallbackEvent{reason: "denylisted: ..."}`，完全跳过 CUDA EP 尝试本身（不仅是跳过超时等待）。`FRAME_FORGE_ORT_ASSET_KEY` 缺失（旧版插件/非 Linux）时 `check()` 直接返回 `None`，即"无法判断时不拦截"而非误拦截。`mise run check-frame-forge-opencv-linux` 编译通过。
- [X] T042 Extend `OrtVersionService` (T033) Linux asset-selection logic to distinguish the `gpu` (CUDA 12) vs `gpu_cuda13` (CUDA 13) asset variants based on detected GPU compute capability (T039), per research.md §7a; document the Blackwell/ORT-1.26.0 finding (§7a), the CPU-EP-hang finding and fix (§7b, T036), the denylist mechanism (T040-T041), and the EP-init timeout design (T037) — all already written into `specs/012-ort-gpu-model-ui/research.md`, this task is to keep it in sync as the above tasks land
  - 验证说明（代码审查，本机无 dotnet）：`ResolveAssetKey` 改为 Linux+NVIDIA 时按 `IsBlackwellOrNewer(computeCapability)`（compute capability ≥ 12.0）二选一返回 `"linux-x64-gpu_cuda13"` 或 `"linux-x64-gpu"`（原先笼统的 `"linux-x64-cuda"` key 废弃——目前没有任何已发布的 catalog 依赖旧 key，T067 仍未完成，废弃安全）。为了让 Rust daemon 在不重新解析 `ORT_DYLIB_PATH` 路径字符串的情况下知道当前激活的资产变体，新增 `asset-key.txt` sidecar：`DownloadOrtAssetAsync` 下载完成后写入该文件（内容即 `assetKey`），`ActivateVersionAsync`/`ExecuteAsync`（启动时已激活版本）通过新增的 `ReadAssetKey()`/`ActiveOrtAssetKey` 属性读回；`FrameExportService.cs` 启动 daemon 时把它设进新增的 `FRAME_FORGE_ORT_ASSET_KEY` 环境变量（与既有 `ORT_DYLIB_PATH` 同一处赋值逻辑）。**额外订正**：发现并修复了 `EvictOldVersionsAsync` 残留的两处编译错误（见 T033 订正记录）。research.md §7a/§7b/§7c 已在此前会话写好，本次未改动 research.md 正文（denylist 机制已通过 T040/T041 落地，与文档描述一致）。

**Checkpoint**: `mise run check-frame-forge`. Re-run `mise run demo-stitch-gpu-linux` (already passing as of T036 — see `tests/stitch-eval/demo-output-gpu/gpu_verification_manifest.json`, 7/7 scenes `ep=cuda:0` with zero `fallback_events`) and `forge gpu-test --device cuda:0 --model models/eloftr_640x480.onnx --timeout-secs 15` — confirm both still pass after T037-T042 land, including the denylist/timeout paths under simulated failure.

---

## Phase 10: User Story 7 — AI 一键提升画质 (Priority: P6)

**Goal**: 工坊弹窗的结果页（`ResultPage.tsx`，不是 `apps/frontend` 的队列页面）上有"提升画质"按钮；点击后
跳转到新的 `UpscalePage`，先让用户选择缩放倍数（×2/×4）、模型风格（写实/风景 vs. 动画）与人脸修复开关
（FR-024/FR-025），确认后用 Real-ESRGAN ONNX 模型跑超分辨率推理（复用 US1 的 EP 选择/回退基建与 US3/US5
的模型目录/下载/LRU 管理；人脸修复额外复用项目已有的 OpenCV 依赖做人脸检测），完成后展示原图/提升后对比
预览（含分辨率/文件大小变化），用户确认后替换或另存为新文件（另存为重复执行时按 FR-020a 自动避免文件名
冲突）；处理失败或取消时原文件不受影响。

**Independent Test**: 对一张已知偏低分辨率的全景图结果点击"提升画质"，选择默认选项（×2、写实/风景、人脸
修复关闭）确认，验证 modal 显示进度、完成后显示对比预览，确认保存后产出文件分辨率提升且内容与原图一致；
在预览阶段取消，确认原文件字节级不变；再对同一结果选择×4 另存为，确认产出文件名与第一次不冲突。

- [X] T049 [P] [US7] Implement `crates/frame-forge/src/upscale.rs` (behind `#[cfg(feature = "opencv")]`, same gate as `dl_match.rs`): `pub fn upscale_image(session: &mut ort::session::Session, img: &image::DynamicImage, tile: u32, overlap: u32) -> anyhow::Result<image::DynamicImage>` — splits the input into overlapping tiles sized to the model's fixed input shape, runs each tile through the session, blends overlaps, reassembles the upscaled output; add `mod upscale;` to `crates/frame-forge/src/main.rs`. Scale (×2/×4) and style (photo/anime) are not parameters of this function — they are expressed entirely by which model file the caller loads into `session` (FR-024), resolved upstream by `ModelCatalogService`/`UpscaleService`
- [X] T049a [P] [US7] Implement `crates/frame-forge/src/face_restore.rs` (same `#[cfg(feature = "opencv")]` gate): `pub fn restore_faces(session: &mut ort::session::Session, img: &image::DynamicImage) -> anyhow::Result<image::DynamicImage>` — uses OpenCV's bundled `cv::FaceDetectorYN` (YuNet) to find face bounding boxes (no new ONNX catalog entry needed for detection, per spec.md Assumptions), crops+aligns each detected face, runs the GFPGAN ONNX `session` per face, blends the restored face back into the original image with a feathered mask; returns `img` unchanged (no error) when zero faces are detected (FR-025, Edge Cases); add `mod face_restore;` to `crates/frame-forge/src/main.rs`
- [X] T050 [US7] Add `MSG_UPSCALE` request/response to `crates/frame-forge/src/protocol.rs` following the existing `MSG_STITCH (0x12)` wire-format pattern: `[item_id(32)] [input_path_len(4)][input_path] [output_path_len(4)][output_path] [model_path_len(4)][model_path] [device_id_len(4)][device_id] [is_animation(1)] [face_restore_model_path_len(4)][face_restore_model_path]` — empty `face_restore_model_path` means face restoration is disabled for this job (FR-025). **Deviation**: tasks.md specifies `0x1A`, but `server.rs` already defines `MSG_DEBUG_DUMP = 0x1A` for an existing handler; used `MSG_UPSCALE = 0x1B` instead, documented inline in both `protocol.rs` and `server.rs`.
- [X] T051 [US7] Implement the `MSG_UPSCALE` handler in the Rust daemon dispatch (`server.rs`): build the upscale ORT session via `dl_match::build_ep_session(model_path, device_id)` (the same function US1/US2 already use — reuse, not reimplementation, per FR-022); for a single image, decode/upscale/encode (PNG); for an animation, decode all frames, call `upscale::upscale_image` per frame with identical session/parameters (FR-023), re-encode via the existing GIF/WebP encoder already used by `animate.rs`; when `face_restore_model_path` is non-empty, build a second ORT session for it via `build_ep_session` and call `face_restore::restore_faces` (T049a) per image/frame after the upscale step; propagate `FallbackEvent`s from both `build_ep_session` calls into the response. **后续补全**：初版实现遗留了一个 TODO（`FallbackEvent` 被收集后直接丢弃，`UpscaleReq` 当时没有 `log_path` 字段可写入）。已补齐：`protocol.rs` 的 `UpscaleReq` 新增 `log_path` 字段（位于 wire format 末尾,`face_restore_model_path` 之后）；`generation_log.rs` 新增 `UpscaleLog` 结构（`deviceName`/`deviceType`/`deviceId`/`faceRestoreRequested`/`faceRestoreSkippedNoFace`/`fallbacks`），与 `GenerationLog` 共享同一个原子写 JSON 辅助函数；`face_restore::restore_faces` 签名改为返回 `(DynamicImage, usize)`（人脸检测数量），供 `handle_upscale` 汇总后计算 `faceRestoreSkippedNoFace`（FR-025 边界情况需要明确告知前端"已请求人脸修复但未检测到人脸"，而非静默忽略）；`device_type`/`device_name` 推断逻辑从 `handle_stitch` 中提取为 `dl_match::infer_device_label`，避免 stitch/upscale 两处重复同一段逻辑。`cli.rs` 的 `cmd_upscale`（T052）同步适配新签名。
- [X] T052 [P] [US7] Add a `forge upscale --input <path> --output <path> --model <path> --device <id> [--face-restore-model <path>]` CLI subcommand to `crates/frame-forge/src/cli.rs`, mirroring `forge stitch`'s `--device` flag, for manual testing without the full daemon/C# stack
- [X] T053 Run `mise run check-frame-forge-opencv-linux` — fix any errors before proceeding. **附带发现并修复的基建 bug**：`Makefile` 的 `build-frame-forge`/`build-frame-forge-linux` 目标（被 `mise run update`/`update-linux` 调用）此前从未传 `--features opencv` 也未安装 `libopencv-dev`，导致实际部署的二进制从未包含 DL stitch matching、GPU EP 选择（Phase 9）以及本阶段的 upscale/face-restore 代码——由于 `#[cfg(feature = "opencv")]` 优雅降级，编译不会报错，问题完全隐蔽。已修复两个 Makefile 目标，使其与已正确配置的 `check-frame-forge-opencv-linux` 目标一致。
- [X] T054 [P] [US7] Add `UpscaleJobDto`, `UpscaleStartRequestDto` (with `scale: 2 | 4`, `modelStyle: "photo" | "anime"`, `faceRestore: bool` properties), `UpscaleConfirmRequestDto` to `packages/JellyfinSuite.Plugin/Models/StitchDto.cs` — all properties with `[JsonPropertyName("camelCase")]`. 同时新增 `UpscaleConfirmResultDto`（`{outputPath}`，匹配前端 `confirmUpscaleMutation` 的返回值约定）和 `UpscaleLogDto`（镜像 frame-forge 的 `UpscaleLog`，内部使用，不直接对外暴露，供 T056 读取 fallbacks/faceRestoreSkippedNoFace）。
- [X] T055 [US7] Register the Real-ESRGAN model as a new family (e.g. `"realesrgan"`) in `ModelCatalogService` (T021/T028) with four versions covering each {style × scale} combination (e.g. `photo-x2`, `photo-x4`, `anime-x2`, `anime-x4`), and register the GFPGAN face-restoration model as a second new family (e.g. `"gfpgan"`); both are downloaded, version-managed, and LRU-evicted through the same mechanism as `lightglue`/`efficient-loftr` (FR-022, FR-024, FR-025). **说明（无代码改动）**：`ModelCatalogService` 完全 family-agnostic（已通读全文确认，`Family`/`Version` 字段无任何硬编码分支），新模型家族注册纯粹是远程 `model-catalog.json` 的内容问题，不需要改 C# 代码——与 T021/T022 处理 lightglue/efficient-loftr 时的结论完全一致。`realesrgan`/`gfpgan` 的目录条目发布属于 T067（"Publish initial model-catalog.json"）范畴，T067 完成前这两个 family 在 `GET /Stitch/Models` 中不会出现 catalog 条目，但本地已安装的模型仍可通过 `GetInstalledModelPath` 正常解析。
- [X] T056 [US7] Implement `UpscaleService` in `packages/JellyfinSuite.Plugin/Services/`: `SubmitUpscaleJobAsync(resultPath, scale, modelStyle, faceRestore, deviceId?)` resolves the `realesrgan` model path via `ModelCatalogService.GetInstalledModelPath("realesrgan", $"{modelStyle}-x{scale}")`, resolves the `gfpgan` model path the same way when `faceRestore` is true, resolves device via `DeviceEnumerationService` default when `deviceId` is null, sends `MSG_UPSCALE` to the frame-forge daemon socket, tracks job status (pending/running/succeeded/failed/cancelled) analogous to `FrameExportTaskManager`; `ConfirmAsync(jobId, mode, newFileName?)` performs the replace/save-as file operation only on explicit confirmation (FR-020) — when `mode` is save-as and `newFileName` is omitted, generate one by probing the filesystem for the next unused name in the sequence `{base}_high.{ext}`, `{base}_high_01.{ext}`, `{base}_high_02.{ext}`, ... (FR-020a); `CancelAsync(jobId)` leaves the original file untouched (FR-023)
  - 验证说明：经独立重新通读 `Services/UpscaleService.cs` 全文确认本任务在更早（已被压缩的）会话片段中已完成，逐项核对方法签名/行为与任务描述一致（含设备解析委托给 `FrameExportService.SubmitUpscaleTaskAsync` 这一层、`{base}_high_NN` 命名探测逻辑）。本次仅补登记 `[X]`，未做改动。
- [X] T057 [US7] Add `POST /Stitch/Upscale` (body: `resultPath`, `scale`, `modelStyle`, `faceRestore`, `deviceId?`), `GET /Stitch/Upscale/{jobId}` (status/progress), `POST /Stitch/Upscale/{jobId}/Confirm`, `POST /Stitch/Upscale/{jobId}/Cancel` to `packages/JellyfinSuite.Plugin/Controllers/StitchController.cs`
  - 验证说明：经独立重新通读 `Controllers/StitchController.cs` 确认四个端点均已实现并完成 DI 注册。**额外发现（超出本任务字面范围）**：实现中还多加了一个 `GET /Stitch/Upscale/{jobId}/Result` 预览端点（供 `UpscalePage.tsx` 成功态对比预览取图），属于合理补充，未在此单独立项。本次仅补登记 `[X]`，未做改动。
- [X] T058 [P] [US7] Add `suite.stitch.upscale*` routes to `apps/player-enhancer/src/api/routes.ts` (`POST /Stitch/Upscale`, `GET /Stitch/Upscale/{jobId}`, `POST /Stitch/Upscale/{jobId}/Confirm`, `POST /Stitch/Upscale/{jobId}/Cancel`); add `startUpscaleMutation({ scale, modelStyle, faceRestore })`, `fetchUpscaleStatus()`, `confirmUpscaleMutation()`, `cancelUpscaleMutation()` to `apps/player-enhancer/src/api/frameExportApi.ts`, following the existing `generateExportMutation`/`deleteResultMutation` pattern (not `apps/frontend` — this feature lives in the workshop modal, not the queue widget; see ResultPage download-log fix)
  - 验证说明：经独立重新读取确认本任务在更早（已被压缩的）会话片段中已完成 —— `routes.ts` 第56-59行已含 `upscale`/`upscaleStatus`/`upscaleConfirm`/`upscaleCancel` 四个路由；`frameExportApi.ts` 第245-298行已含 `UpscaleJobDto` 接口与 `startUpscaleMutation`/`fetchUpscaleStatus`/`confirmUpscaleMutation`/`cancelUpscaleMutation`，写法与既有 `generateExportMutation`/`deleteResultMutation` 一致。本次仅补登记 `[X]`，未做改动。
- [X] T059 [US7] Extend the `_pageAtom` union in `apps/player-enhancer/src/core/state.ts` from `'grid' | 'progress' | 'result'` to add `'upscale'`; create `apps/player-enhancer/src/components/UpscalePage.tsx` following the same page-component pattern as `ResultPage.tsx`, with four internal states: **options** (scale ×2/×4 toggle defaulting to ×2, style 写实/风景 vs. 动画 defaulting to 写实/风景, face-restoration checkbox defaulting to off — kept as local component state, not persisted to `settingsAtom`, since the user may deliberately want different options per attempt on the same result per FR-020a's scenario; a "开始处理" button calls `startUpscaleMutation()` with the chosen options); **processing** (progress indicator + cancel button, calls `cancelUpscaleMutation()`); **success** (toggle/slide-to-compare original vs. upscaled image, resolution + file-size delta text, inline warning text for the "already high-res" / "already upscaled once" / "no face detected, skipped" edge cases per spec.md, "替换原文件" / "另存为新文件" buttons calling `confirmUpscale()`); **error** (failure message, original file untouched)
  - 实现说明：轮询而非 SSE（后端 Upscale 状态接口是 poll-based，不像主生成流程那样有 SSE）；对比预览用前后切换按钮（非拖拽滑块）满足 FR-019 的"toggle/slide-to-compare"；"已是高分辨率"判定取 `job.originalWidth/Height` 任一边 ≥3840（对应 spec.md 边界情况"如已是 4K 全景图"的示例阈值），"已提升过一次"判定靠前端会话内 `_upscaledTaskIds` 集合（在 `state.ts` 新增，confirm 成功后写入,仅会话级软提示，刷新后重置，符合该提示非强制阻断的性质）；"无人脸跳过"读取后端 `faceRestoreSkippedNoFace` 字段。`i18n.ts` 在 T061 已有 17 个 key 基础上补充了 10 个（`upscale.processing`/`back`/`confirm`/`confirmFailed`/`done`/`before`/`after`/`dimensions`/`savedAs`,其中 `confirm` 目前未被实际使用，留作后续清理）。已通过 `eslint --fix` 与 `vite build` 验证 0 错误。
- [X] T060 [US7] Add a "提升画质" trigger button to `apps/player-enhancer/src/components/ResultPage.tsx` (next to the "Download log" button added for US4); clicking it sets `sPage.value = 'upscale'` to navigate straight to `UpscalePage`'s **options** state (T059) — it does NOT call `startUpscaleMutation()` directly, since options must be chosen first; wire the `'upscale'` case into `FrameExportModal.tsx`'s page switch to render `<UpscalePage>`
  - 说明：按钮对动图/全景图结果均显示（不像仅全景图才有的"Download log"按钮），因 FR-023 明确支持对动图结果也执行提升画质。
- [X] T061 [P] [US7] Add `result.upscale`, `upscale.title`, `upscale.optionsTitle`, `upscale.scale`, `upscale.scaleX2`, `upscale.scaleX4`, `upscale.style`, `upscale.stylePhoto`, `upscale.styleAnime`, `upscale.faceRestore`, `upscale.start`, `upscale.replace`, `upscale.saveAsNew`, `upscale.cancel`, `upscale.alreadyHighRes`, `upscale.alreadyUpscaled`, `upscale.noFaceDetected`, `upscale.failed` i18n keys to all three locale blocks (en/zh/ja) in `apps/player-enhancer/src/lib/i18n.ts`
  - 验证说明：经独立 grep 重新核查确认本任务在更早（已被压缩的）会话片段中已完成 —— en/zh/ja 三个 locale 区块均已包含 `result.upscale` 及全部 17 个 `upscale.*` key，翻译内容准确。本次仅补登记 `[X]`，未做改动。

**Checkpoint**: `mise run check-frame-forge-opencv-linux` passes. `mise run update` / `mise run update-linux` succeeds (first pass touches Rust). In the workshop modal, click "提升画质" on a completed panorama result → `UpscalePage` shows the options step (scale/style/face-restore, defaults ×2 + 写实/风景 + off) → confirming starts processing and shows progress → comparison preview appears with resolution/size delta → confirming "替换" overwrites the result file; cancelling at any stage leaves it byte-for-byte unchanged. Re-run with ×4 + "另存为" twice on the same result → second save-as produces a `_high_01` suffixed file, not a collision. Enable face restoration on a result with no faces → succeeds with the "no face detected, skipped" notice, output otherwise identical to the non-face-restore run.

---

## Phase 11: Polish & Integration Validation

- [X] T062 [P] Run `mise run gen-types` (final pass after all DTOs complete, including US7's `UpscaleJobDto`) — ensure `packages/api-types/src/jellyfin-api.ts` reflects all new DTOs; fix any TypeScript type errors in frontend
  - 验证说明：本机已装 dotnet 9.0.315（见 feedback memory），`mise run gen-types` 成功跑通（`gen-spec` → `gen-client` → `gen-plugin-types.mjs`）。产生的 diff 仅涉及 `ExportParams`（新增 `deviceId`/`modelFamily`/`modelVersion`/`ortVersion`，spec 012 US2/US3/US6 早前落地但一直没重新生成类型）与 `PrefetchRangeStreamRequest`（`currentTimeMs`/`beforeSeconds`/`afterSeconds` 改为可选 + 新增 `currentFrameIndex`/`prefetchSessionId`，对应已有前端 `PrefetchRangeParams` 联合类型）——均为对既有代码的类型同步，非本次新增 bug。**Upscale 相关 DTO 未出现在 diff 中**：核实后确认 `JfsSpecGen`（`packages/JfsSpecGen/JfsSpec.cs`）是手工维护的 DTO/路径白名单（不是反射扫描 controller），Upscale 端点从未被纳入该清单；而 `apps/player-enhancer`（消费 Upscale API 的唯一前端）本身也不导入 `@jfs/api-types`，全部手写 fetch 封装 + 手写 `UpscaleJobDto` interface（`frameExportApi.ts:247-261`）。逐字段核对该手写 interface 与 C# `UpscaleJobDto`（`StitchDto.cs:203-218`）：12 个字段完全一致，无漂移。结论：T059 描述的"确保 jellyfin-api.ts 反映新 DTO"对 Upscale 不适用（架构上从未走这条路径），任务本身已完整完成。副产物：跑 `mise run lint` 时发现 `apps/frontend/eslint.config.mjs`/`apps/player-enhancer/eslint.config.mjs` 缺少全局 `ignores: ['dist/**']`，导致已构建的 `dist/*.js` 被当成源码用 `js.configs.recommended`（无 browser globals）校验，报出 178 个虚假 `no-undef` 错误（`window`/`document` 等）；已在两个 config 文件顶部加 `{ ignores: ['dist/**'] }` 修复，复跑 `mise run lint` → 0 error，仅 27 个既有 warning（与本次改动无关）。
- [X] T063 [P] Run `mise run check-frame-forge` — confirm Rust crate compiles clean with `load-dynamic` and all EP features enabled
  - 说明：本机为 Linux，`mise run check-frame-forge`（Windows 专用，依赖 `cygpath`）报错；改跑等价的 Linux 目标 `mise run check-frame-forge-opencv-linux`（含 `--features opencv`，覆盖 DL stitch matching/GPU EP/本 Upscale 功能的全部代码路径）。结果：0 error，仅有与本次改动无关的既有 warning（未使用函数/字段等）。
- [ ] T064 Run all Quickstart scenarios from `specs/012-ort-gpu-model-ui/quickstart.md` (Scenarios 1–10) against the running `jellyfin-dev` container; for SC-001 specifically: submit the same stitch twice — once with `deviceId: "cuda:0"` and once with `deviceId: "cpu:0"` — and compare `inferenceDurationMs` in the two generation logs to confirm GPU is ≥ 2× faster; document any failures
- [X] T065 Run `mise run test` — full suite (Rust + TypeScript + C#) must pass with 0 failures
  - 验证结果：Rust 7 passed / 1 ignored（GPU-only 测试需 `FRAME_FORGE_TEST_GPU=1`，按约定跳过）；frontend(bun) 17 pass / 0 fail；C#(`dotnet test tests/JellyfinSuite.Tests`) 76 passed / 0 failed。三项 0 failure，满足任务要求。
- [X] T066 Run `mise run update` (Windows) or `mise run update-linux` (Linux) — full build + deploy; confirm container restarts cleanly and frame export health endpoint returns `available: true`
  - 验证结果：`mise run update-linux` 全量构建（Rust release + 前端 + C#）成功，6 项 `podman cp` 全部完成，`podman restart jellyfin-dev` 后健康检查返回 200；进一步 `curl http://localhost:8096/JellyfinSuite/FrameExport/Health` → `{"available":true,"activeTasks":0}`，满足任务的具体验收点。
- [X] T067 Publish initial `model-catalog.json` to the project-controlled CDN URL; hardcode or configure that URL in `packages/JellyfinSuite.Plugin/Services/ModelCatalogService.cs` (e.g., as a plugin configuration constant); document the URL and update process in `specs/012-ort-gpu-model-ui/research.md`
  - 验证结果：4 个模型文件（realesrgan-photo-x2/photo-x4/anime-x4 + gfpgan-v1.4，均来自 Hugging Face 上声明 BSD-3-Clause/Apache-2.0 的社区 ONNX 转换，经 `onnx.load` 校验 input/output shape 符合 frame-forge 假设——Real-ESRGAN 动态 H/W、GFPGAN 固定 512×512）已上传至 GitHub Release `models-v1`；`model-catalog.json`（4 条目，含真实 sha256/fileSizeBytes）已推送到 `gh-pages` 分支根目录，可通过 `https://thelastfantasy.github.io/jellyfin-suite/model-catalog.json` 访问；`ModelCatalogService.cs` 的 `DefaultCatalogUrl` 已指向该 URL；来源/许可证/更新流程已记录在 research.md §4。**已知缺口**：`realesrgan/anime-x2` 无可信来源（官方未发布，社区转换均为固定 shape 或文件损坏），目录中暂缺该条目，已在 Release notes 中说明。
- [X] T068 [US7] anime-x2 无可信 ONNX 源的补救：`UpscaleService.RunJobAsync` 检测到 `modelStyle=="anime" && scale==2` 时改用 `anime-x4` 模型并设置 `postDownscaleFactor=0.5f`；新增的 wire 字段 `post_downscale_factor`（`UpscaleReq`，`protocol.rs`/`FrameExportService.SubmitUpscaleTaskAsync`）让 `server.rs::handle_upscale` 在人脸修复之后对每帧做一次 `DynamicImage::resize_exact`（Lanczos3）把 x4 输出降回 x2，LRU 使用记录落在 `anime-x4` 而非虚构的 `anime-x2` 条目上。详见 research.md §4「anime-x2 fallback」。
  - 验证结果：`mise run check-frame-forge-opencv-linux` 0 errors；`mise run test` 全部通过（Rust 7 passed/1 ignored、frontend 17 pass、C# 76 passed）。未单独跑端到端的 anime-x2 真实推理（需要部署到 jellyfin-dev 才能验证 downscale 后的实际画质），留待部署后人工验证。

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
- **GPU Compatibility & Safety Net (Phase 9)**: Depends on US1 (T012-T015, `build_ep_session` must exist) and US2 (T016-T020, device enumeration must exist for T039); should land before Polish since T064's quickstart/SC-001 run and T066's full deploy should happen against the timeout/denylist-protected code path, not the unprotected one
- **US7 (Phase 10)**: Depends on US1 (`build_ep_session` reused as-is, T012-T015) and US3/US5 (`ModelCatalogService` catalog/download/LRU mechanism, T021/T028, extended with a new model family rather than reimplemented); benefits from Phase 9's timeout/denylist hardening but is not blocked by it — should still land before Polish so T064-T066 validate it too
- **Polish (Phase 11)**: Depends on all desired stories (including US7) and Phase 9 complete

### User Story Dependencies

| Story | Depends on | Independently testable? |
|---|---|---|
| US1 (GPU stitch) | Foundational | Yes — no UI needed |
| US2 (Device UI) | Foundational + US1 (device default logic) | Yes — mock GPU host works |
| US3 (Model UI) | Foundational + US1 (model path resolution) | Yes |
| US4 (Gen log) | US1 (log attached to task) | Yes |
| US5 (Model catalog) | US3 (ModelCatalogService) | Yes |
| US6 (ORT mgmt) | US1 (OrtVersionService bootstrap) | Yes |
| US7 (Upscale) | US1 (`build_ep_session`) + US3/US5 (`ModelCatalogService`) | Yes — independent button + modal flow |

### Parallel Opportunities

Within Phase 2:
- T008 and T009 are parallel (different C# files)

Within Phase 4 (US2):
- T017 and T018 are parallel (different areas of `apps/player-enhancer`: api/ vs core/state.ts)

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
  T017 [routes.ts/frameExportApi.ts]  ┐
  T018 [core/state.ts settings]       ┘ → T019 [AdvancedPanel.tsx] → T020 [FrameExportModal.tsx wire-up]
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
- Phase 9 → GPU hang/denylist hardening (closes the production risk found during manual Blackwell testing — should ship before declaring GPU acceleration production-ready, independent of UI phases)
- Phase 10 → "提升画质" button + modal on results (reuses Phase 3/5/7's EP selection and model catalog/download/LRU infrastructure as a new model family rather than new plumbing)

---

## Notes

- After every Rust change: `mise run check-frame-forge` (or `mise run check-frame-forge-opencv-linux` for US7) before build
- After every C# DTO change: `mise run gen-types` to keep TypeScript types in sync
- `mise run deploy-enhancer` for frontend-only changes (fastest loop)
- `mise run update-quick` for C# + frontend changes
- `mise run update` (Windows) / `mise run update-linux` (Linux — the plain `update`/`build` targets
  call `cygpath`, which does not exist on native Linux and fails outright) only when Rust changes
  are involved
- Never run `mise run update` / `mise run update-linux` without user confirmation (restarts container)
