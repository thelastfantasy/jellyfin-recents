# Feature Specification: ORT GPU Acceleration & Model/Device Selection UI

**Feature Branch**: `feature/012-ort-gpu-model-ui`

**Created**: 2026-06-17

**Status**: Draft

## Clarifications

### Session 2026-06-17

- Q: デフォルトデバイスの自動選択基準は何か → A: VRAM 容量（大きい順）を一次基準とし、同容量の場合は離散 GPU を統合 GPU より優先する
- Q: デバイス/モデル/ORT 選択の永続化スコープは何か → A: フロントエンドの localStorage に保存（ブラウザごとに記憶）。サーバーは VRAM 優先ルールに基づくデフォルト値の提供のみ担当し、ユーザー設定はサーバーに保存しない
- Q: モデルカタログの配信方式は何か → A: プラグイン起動時にリモート URL から最新カタログ JSON を取得する。取得失敗時はキャッシュ済みカタログにフォールバックし、カタログが一切ない場合は空リストを表示する
- Q: GPU 初期化失敗時の通知タイミングは何か → A: stitch 実行時に失敗を検知し、結果エリアにインライン通知する（CPU フォールバック済みである旨を明示）
- Q: ORT の初回セットアップ方式は何か → A: プラグイン初回起動時にバックグラウンドで自動ダウンロード。ダウンロード中でも UI は操作可能で、完了前に stitch を実行した場合は CPU モードで動作する

### Session 2026-06-17 (continued)

- Q: Advanced 設定の変更権限は誰か → A: 全ユーザーが個別に変更可。各自の選択は localStorage に保存され、サーバー側に認証・認可は不要。モデルのダウンロードは管理者権限不要
- Q: 新 ORT バージョン適用後の旧バージョン保持ポリシーは何か → A: 保持するバージョン数を設定可能（デフォルト: 最新2世代保持）。上限を超えた最古バージョンは自動削除され、Advanced パネルから保持中の任意バージョンに切り替え可能
- Q: ORT ダウンロード失敗時のリトライポリシーは何か → A: HTTP 4xx は即時断念（クライアントエラー、リトライ不要）。HTTP 5xx およびネットワークエラーはインターバルを挟んで最大3回自動リトライ。3回失敗後は ORT 管理パネルにエラーを表示し手動リトライを促す
- Q: ORT のダウンロード元はどこか → A: microsoft/onnxruntime の GitHub Releases から直接ダウンロード
- Q: モデルカタログのキャッシュ TTL は何か → A: 24 時間。TTL 超過後の次回アクセス時に再フェッチし、失敗時はキャッシュ継続利用

**Input**: User description: "GPU/ORT 加速 + 设备选择 + 模型管理 UI，作为工坊 modal 的高级选项"

## User Scenarios & Testing *(mandatory)*

### User Story 1 — GPU-accelerated stitch via workshop (Priority: P1)

A user with a mid-range GPU opens the workshop modal for a panoramic clip and triggers a stitch.
They can see that inference is running on their discrete GPU rather than the CPU, and the
stitch completes in noticeably less time.

**Why this priority**: Without GPU support, DL-based matching is too slow on large frames for
interactive use. This is the core value of the whole feature.

**Independent Test**: Enable GPU backend for the default device, trigger a stitch on a
landscape scene, and confirm the stitch result image is produced faster than the CPU baseline.
Standalone even without model/device selection UI in place.

**Acceptance Scenarios**:

1. **Given** a system with at least one GPU, **When** the user opens the workshop and runs a
   stitch with default settings, **Then** the DL inference backend uses the GPU and the
   operation completes without error.
2. **Given** no compatible GPU is present, **When** the user triggers a stitch, **Then** the
   system automatically falls back to CPU without requiring any user action, and a notice is
   shown in the result.
3. **Given** the GPU runs out of memory mid-inference, **When** the failure is detected,
   **Then** the system retries the operation on CPU and reports the fallback to the user.

---

### User Story 2 — Device selection in workshop modal (Priority: P2)

A user with both an integrated GPU and a discrete GPU wants to dedicate the discrete card to
stitch processing. They expand the "Advanced" section of the workshop modal and choose their
discrete GPU from a labeled dropdown.

**Why this priority**: Multi-GPU systems are common (laptop + eGPU, dual-GPU workstations).
Without device selection, the system may pick the weaker integrated GPU.

**Independent Test**: With two or more GPU adapters present, open the workshop advanced panel,
confirm both appear in the device list with distinguishable labels, pick the secondary device,
run a stitch, and confirm it completes successfully.

**Acceptance Scenarios**:

1. **Given** a multi-GPU system, **When** the user opens the Advanced section, **Then** all
   available compute devices (CPUs and GPUs) are listed with unique, human-readable labels
   (name + slot identifier where needed to disambiguate).
2. **Given** the user selects a specific GPU, **When** a stitch job is triggered, **Then**
   inference runs on the selected device.
3. **Given** the user has not changed the device setting, **When** a stitch is triggered,
   **Then** the most capable discrete GPU is selected automatically; CPU is the fallback when
   no GPU is detected.
4. **Given** the selected device becomes unavailable (driver crash, hot-unplug), **When** the
   stitch is triggered, **Then** the system falls back to CPU and informs the user.

---

### User Story 3 — Model selection in workshop modal (Priority: P2)

A user who has downloaded both LightGlue v2 and EfficientLoFTR wants to compare results.
They switch the active model from the same Advanced panel without restarting the server.

**Why this priority**: Equal importance to device selection — both are part of the same
"Advanced" panel experience and both require the model/device management backend.

**Independent Test**: Download two models via the model catalog, pick one from the dropdown,
run a stitch, pick the other, run again, confirm both produce outputs with the correct model
reported in the result metadata.

**Acceptance Scenarios**:

1. **Given** at least one model file is present locally, **When** the user opens the Advanced
   section, **Then** a model name selector and a version combobox are shown. The version
   combobox contains a pinned "Latest" entry, up to 10 catalog versions, and all locally
   downloaded versions; downloaded versions appear in a distinct colour.
2. **Given** a model is selected and a stitch is triggered, **When** the job completes,
   **Then** the result metadata reports which model was used.
3. **Given** the user selects "Disabled" (traditional algorithm only), **When** a stitch is
   triggered, **Then** no DL model is loaded and the traditional AKAZE path is used.
4. **Given** the user selects a model that is not downloaded, **Then** the control is disabled
   or a "Download first" prompt is shown; the model cannot be selected until it is present
   locally.

---

### User Story 4 — Download generation log for debugging (Priority: P3)

After a stitch completes, a user (or developer filing a bug report) wants to know exactly what
happened: which algorithm was chosen, which model and version ran, which hardware device was
used, and whether any fallbacks occurred. They click "Download log" next to the existing
"Download image" button and receive a JSON file with the full generation record.

**Why this priority**: Equal to model catalog — the generation log is essential for meaningful
bug reports and power-user debugging, especially once GPU paths and multiple models are in play.

**Independent Test**: Trigger a stitch, confirm the result panel shows both a "Download image"
and a "Download log" button, download the JSON, verify it contains algorithm name, model file
name, model version, ORT version, device name, and any fallback events.

**Acceptance Scenarios**:

1. **Given** a panoramic stitch completes successfully, **When** the result is displayed,
   **Then** a "Download log" button appears alongside the existing image download button.
   **Given** the output is an animated GIF, **When** the result is displayed, **Then** no
   "Download log" button is shown.
2. **Given** the user clicks "Download log", **When** the download occurs, **Then** a JSON
   file is saved containing: algorithm used, model file name and version, ORT version, device
   name, device type (CPU/GPU), number of DL keypoint matches, whether a fallback occurred
   and why, and total inference duration.
3. **Given** GPU inference failed and fell back to CPU, **When** the log is downloaded,
   **Then** the JSON includes a `fallbacks` array describing each fallback event with its
   reason.
4. **Given** the traditional AKAZE path was used (no DL model), **When** the log is
   downloaded, **Then** the model fields are present but marked as `null` or `"disabled"`.

---

### User Story 5 — Model download catalog (Priority: P4)

A user who has just installed the plugin sees "No models downloaded" in the Advanced panel.
They open the model catalog section, see available models with their file sizes, and download
one directly from the UI.

**Why this priority**: Discovery and acquisition flow; P3 because the plugin ships with a
working CPU+AKAZE path that requires no downloads.

**Independent Test**: Starting from a clean state (no .onnx files), open the model catalog,
trigger a download, wait for completion progress indication, confirm the model appears in the
model selector.

**Acceptance Scenarios**:

1. **Given** the user opens the model catalog, **When** models are available for download,
   **Then** each entry shows model name, version tag, file size, and a download button.
2. **Given** a download is in progress, **When** the user is watching, **Then** a progress
   indicator is visible and the UI remains interactive.
3. **Given** a download completes successfully, **When** the catalog refreshes, **Then** the
   downloaded model appears in the model selector dropdown immediately.
4. **Given** a download fails (network error, checksum mismatch), **When** the error occurs,
   **Then** the partial file is removed and an error message is displayed with a retry option.
5. **Given** 5 versions of a model family are already stored and a 6th is downloaded,
   **When** the download completes, **Then** the latest version and the 4 most recently used
   versions are retained; the least recently used non-latest version is automatically deleted.

---

### User Story 6 — ORT runtime management (Priority: P5)

A power user wants to update their ONNX Runtime to a newer version to gain performance
improvements. They open the ORT section of the Advanced panel, see the currently installed
version, and trigger a download of the latest available version.

**Why this priority**: P5 — the system ships with a bundled or pre-downloaded ORT, and most
users never need to manage it manually. This is a safety hatch for advanced users.

**Independent Test**: With a prior ORT version installed, trigger an update via the UI, confirm
the new version string is reflected in the panel, and confirm stitch still succeeds afterward.

**Acceptance Scenarios**:

1. **Given** the user opens the ORT management section, **When** it loads, **Then** the
   currently active ORT version is displayed.
2. **Given** a newer ORT version is available, **When** the user clicks "Update", **Then** the
   new runtime is downloaded and activated without requiring a server restart.
3. **Given** an ORT update fails, **When** the error occurs, **Then** the previously working
   version is preserved and the user is informed.
4. **Given** the user selects a specific ORT version from a version list, **When** confirmed,
   **Then** that version is used for subsequent stitch jobs.

---

### Edge Cases

- What happens when a GPU is present but its driver is outdated (EP initialisation fails)?
  → Fall back to CPU; complete the stitch; display an inline fallback notice in the result area (see FR-004).
- How does the system handle two GPUs with identical device names?
  → Append a disambiguating slot/index label (e.g., "NVIDIA RTX 4070 [PCIe slot 1]").
- What happens when a model file on disk is corrupted (truncated ONNX)?
  → Show it as "invalid" in the selector with a repair/re-download option; do not attempt to load it.
- What if the user's network is offline during a model download?
  → Show a clear error; clean up partial file; provide a retry button.
- What if inference fails on the selected GPU mid-stitch (OOM, driver crash)?
  → Retry on CPU, complete the stitch, and notify the user of the fallback.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST enumerate all available compute devices (CPU + all GPU adapters)
  and expose this list via a server-side API before each stitch job.
- **FR-002**: The system MUST allow the user to select a compute device from the enumerated
  list. Persistence of this selection is governed by FR-004a.
- **FR-003**: The system MUST automatically select the default device by VRAM capacity
  (largest first); when VRAM is equal, discrete GPUs take priority over integrated graphics;
  CPU is the fallback when no GPU is detected.
- **FR-004**: When the selected GPU device fails during inference, the system MUST fall back to
  CPU, complete the stitch, and display an inline notification in the result area indicating
  that GPU initialisation failed and CPU was used instead.
- **FR-004a**: Device, model, and ORT version selections made in the Advanced panel MUST be
  stored in browser localStorage and restored on the next visit; when no localStorage value
  exists, the server-provided default (VRAM-ranked best device, first installed model) is used.
- **FR-005**: The model selection UI in the Advanced panel MUST consist of two separate
  controls:
  a. **Model name selector** — lists available model families (e.g., LightGlue,
     EfficientLoFTR) plus a "Disabled" option that reverts to the traditional AKAZE path.
  b. **Version combobox** — populated based on the selected model family, containing:
     - A pinned **"Latest"** entry at the top (always resolves to the newest available
       version at stitch time, downloading it if not already present).
     - The union of: the 10 most recent versions from the catalog and all locally
       downloaded versions of that family.
     - Downloaded versions MUST be visually distinguished (e.g., different text colour or
       a badge) from catalog-only versions that have not yet been downloaded.
     - Selecting a catalog-only version triggers a download prompt before the stitch runs.
- **FR-006**: The system MUST allow the user to disable DL model usage entirely by selecting
  "Disabled" in the model name selector, reverting to the traditional AKAZE algorithm. When
  "Disabled" is selected the version combobox is hidden or disabled.
- **FR-007**: The system MUST provide a model catalog that lists downloadable models with name,
  version, file size, and download status.
- **FR-007a**: The system MUST automatically manage locally stored model versions per model
  family (e.g., LightGlue, EfficientLoFTR) according to the following retention policy
  (maximum 5 versions per family):
  1. The latest available version of the family is always retained regardless of usage.
  2. The remaining 4 slots are filled by the most recently used versions (LRU order).
  When a newly downloaded version causes the count to exceed 5, the least recently used
  version that is not the latest is evicted and its file deleted.
- **FR-008**: The system MUST support downloading individual model files from the catalog, with
  real-time progress indication.
- **FR-009**: When a model download fails, the system MUST apply the standard retry policy
  (HTTP 4xx: no retry; HTTP 5xx / network error: up to 3 retries with back-off). After all
  retries are exhausted, or on checksum mismatch, the partial file MUST be removed and an
  actionable error message displayed with a manual retry option.
- **FR-010**: The system MUST display the currently active ONNX Runtime version in the Advanced
  panel.
- **FR-011**: The system MUST support downloading and activating a newer ORT version without
  requiring a Jellyfin server restart. (Implementation note: activating a new ORT version
  restarts the frame-forge daemon process — not the Jellyfin server — to load the updated
  ORT shared library. The daemon restart is transparent to the user and takes effect on the
  next stitch request.) Previously downloaded ORT versions are retained on disk up to a
  configurable limit (default: 2 most recent versions); the oldest version beyond the limit is
  automatically deleted. The Advanced panel MUST allow switching between any retained version.
- **FR-012**: All device/model/ORT selections MUST be exposed as advanced options in the
  workshop modal under a clearly labelled "Advanced" section with a usage warning. Any
  authenticated Jellyfin user may change these settings; no administrator role is required.
  Model downloads are likewise open to all authenticated users.
- **FR-013**: The workshop modal MUST show sensible defaults and remain fully functional when
  the user never interacts with the Advanced section.
- **FR-014**: After each stitch, the server MUST produce a structured generation log containing:
  algorithm name, model file name, model version, ORT version, device name, device type
  (CPU/GPU), keypoint match count, fallback events (each with reason), and total inference
  duration in milliseconds. The log MUST be returned to the frontend alongside the result image.
- **FR-015**: When the workshop output is a panoramic stitch (not an animated GIF), the result
  panel MUST display a "Download log" button alongside the image download button. Clicking it
  downloads the generation log as a JSON file. The button MUST NOT appear for animated GIF
  outputs.
- **FR-016**: When a fallback occurred (GPU → CPU, DL → AKAZE, etc.), the JSON log MUST
  include a `fallbacks` array where each entry describes the fallback type and reason. When
  no model was used, model fields MUST be present with a value of `null` or `"disabled"`.

### Key Entities

- **ComputeDevice**: Represents an enumerated compute device — attributes: unique ID, display
  name, device type (CPU / GPU), vendor, slot or index for disambiguation, availability status.
- **ModelEntry**: Represents a locally present or downloadable ONNX model — attributes: file
  name, logical name (LightGlue / EfficientLoFTR / etc.), version tag, file size, download
  status (available / downloading / installed / invalid), local path when installed,
  last_used_at timestamp (updated each time the model is selected for a stitch job),
  is_latest flag (true if this is the newest version in its family).
- **OrtVersion**: Represents a version of the ONNX Runtime library — attributes: version
  string, release date, download URL, currently-active flag, local path when installed.
  Multiple versions may be retained simultaneously up to the configured limit (default: 2).
- **StitchJobConfig**: Extended stitch configuration including selected device ID, selected
  model file name, ORT version in use; stored in the server and passed to the frame-forge
  daemon via the MSG_STITCH socket message.
- **GenerationLog**: Structured record produced after each stitch — attributes: algorithm
  name, model file name (nullable), model version (nullable), ORT version (nullable), device
  name, device type, keypoint match count, inference duration (ms), fallbacks array (each
  entry: type, reason, timestamp).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a system with a discrete GPU, stitch inference is at least 2× faster than the
  CPU-only baseline for the same scene and model (measured on synthetic_landscape fixture).
- **SC-002**: The device list in the Advanced panel loads within 1 second of opening the
  workshop modal.
- **SC-003**: A model download of ~100 MB completes without UI freezes; progress updates are
  visible at least every 2 seconds.
- **SC-004**: Switching between installed models requires no server restart and takes effect
  within the same stitch session.
- **SC-005**: When GPU inference fails, the CPU fallback completes the stitch without user
  intervention in 100% of tested scenarios.
- **SC-006**: All advanced settings (device, model, ORT) are accessible within 2 interactions
  from the main workshop modal (open modal → expand Advanced section).
- **SC-007**: Users who never open the Advanced section experience identical stitch quality and
  success rate to the current baseline (no regression).

## Assumptions

- Initial platform targets are Windows (DirectML / CPU) and Linux (CUDA / ROCm / OpenVINO /
  CPU); macOS CoreML is out of scope for v1.
- On Windows, DirectML covers all major GPU vendors via the DirectX 12 abstraction layer:
  NVIDIA, AMD, Intel discrete and integrated graphics. Chinese domestic GPUs that support
  DX12 (e.g., 砺算科技 7G100 series) may also benefit from DirectML but are not officially
  tested targets for v1.
- On Linux, CUDA covers NVIDIA; ROCm covers AMD discrete GPUs; OpenVINO covers Intel CPU,
  integrated graphics, and NPU. Other vendors on Linux are out of scope for v1.
- The workshop modal already exists and has an extensible settings layout; no redesign of
  the modal chrome is required.
- The model catalog is a JSON manifest fetched from a known remote URL. The cached copy is
  considered fresh for 24 hours; after TTL expiry the next access triggers a background
  re-fetch. If the re-fetch fails, the stale cache continues to be used. When no cache
  exists and the remote is unreachable, an empty downloadable list is shown.
- The ONNX Runtime library version used for inference is separate from the ORT used at compile
  time; runtime replacement is achieved by swapping a shared library file. ORT binaries are
  sourced exclusively from the official microsoft/onnxruntime GitHub Releases; download URLs
  are embedded in the model catalog JSON per platform and EP variant.
- Users are expected to have enough disk space for model files (~100–400 MB per model) before
  downloading; the UI should display required disk space but not enforce a quota.
- A single active model per stitch session is sufficient; simultaneous multi-model inference
  is out of scope.
- The ORT runtime is downloaded automatically in the background on the first plugin startup.
  The UI remains fully usable during the download; any stitch triggered before ORT is ready
  runs in CPU-only mode. The ORT management panel shows download progress during this phase.
- ORT and model download retry policy: HTTP 4xx responses are treated as permanent failures
  (no retry); HTTP 5xx responses and network-level errors trigger up to 3 automatic retries
  with a back-off interval between attempts. After 3 failed retries the error is surfaced in
  the management panel and the user must trigger a manual retry.
