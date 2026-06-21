# Data Model: ORT GPU Acceleration & Model/Device Selection UI

## Entities

### ComputeDevice

Enumerated at plugin startup and on each `/Stitch/Devices` request. Not persisted.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Opaque: `"cpu:0"`, `"cuda:0"`, `"directml:1"` |
| `displayName` | string | Human-readable: `"NVIDIA RTX 4070"`, `"Intel Iris Xe [slot 1]"` |
| `deviceType` | `"CPU"` \| `"GPU"` | |
| `vendor` | string | `"NVIDIA"`, `"AMD"`, `"Intel"`, `"CPU"` |
| `vramMb` | int? | null for CPU or when undetectable |
| `isIntegrated` | bool | true for iGPU (DedicatedVideoMemory == 0 on Windows) |
| `isDefault` | bool | true for the auto-selected best device |

**Default selection rule**: among GPUs, largest `vramMb` wins; ties broken by discrete > integrated. CPU is default when no GPU detected.

---

### ModelEntry

Represents one version of one model family, on-disk or in the remote catalog.

| Field | Type | Notes |
|---|---|---|
| `family` | `"lightglue"` \| `"efficient-loftr"` | Model family |
| `displayName` | string | `"LightGlue v2"`, `"EfficientLoFTR"` |
| `version` | string | Semver-like: `"2.0"`, `"1.0.0"` |
| `fileName` | string | Disk filename: `"superpoint_lightglue_pipeline.onnx"` |
| `fileSizeBytes` | long | |
| `sha256` | string | For integrity verification |
| `downloadUrl` | string | From catalog; null if catalog-only local entry |
| `releaseDate` | string | ISO-8601 date |
| `status` | `"catalog"` \| `"downloading"` \| `"installed"` \| `"invalid"` | |
| `localPath` | string? | Absolute path when installed |
| `lastUsedAt` | DateTime? | Updated each stitch invocation; null if never used |
| `isLatest` | bool | true if newest version in family per current catalog |

**Retention policy per family**: max 5 installed versions.
- `isLatest == true` → always retained, never evicted.
- Remaining 4 slots: LRU by `lastUsedAt`. Oldest evicted when 6th is added.

**Catalog refresh**: remote JSON fetched at plugin startup; cached 24 hours. Retry policy: 4xx → fail immediately; 5xx/network → up to 3 retries with exponential back-off (1s, 4s, 16s).

---

### OrtVersion

Represents one version of the ONNX Runtime library, managed on disk.

| Field | Type | Notes |
|---|---|---|
| `version` | string | `"2.0.0-rc.12"`, `"2.1.0"` |
| `releaseDate` | string | ISO-8601 |
| `assets` | dict | Key: platform+EP string, value: `OrtAsset` |
| `isActive` | bool | The version currently in use |
| `localDir` | string? | Path when installed: `/config/…/ort/v2.1.0/` |
| `installedAt` | DateTime? | When this version was downloaded |

**OrtAsset**:

| Field | Type | Notes |
|---|---|---|
| `url` | string | GitHub Releases download URL |
| `sha256` | string | |
| `sizeBytes` | long | |

**Retention policy**: max N versions on disk (default N=2, configurable). When a new version is activated and count > N, the oldest `installedAt` version that is not `isActive` is deleted. Rollback: any retained version can be activated without re-downloading.

---

### StitchJobConfig

Passed from frontend to the `/FrameExport/Generate` endpoint alongside frame selection. Extends the existing `GenerateRequest.Params`.

| Field | Type | Notes |
|---|---|---|
| `deviceId` | string? | `"cuda:0"`, `"directml:0"`, `"cpu:0"`. null = use server default |
| `modelFamily` | string? | `"lightglue"`, `"efficient-loftr"`, `"disabled"`. null = auto |
| `modelVersion` | string? | Specific version string or `"latest"`. null = latest |
| `ortVersion` | string? | Specific ORT version string. null = active version |

---

### GenerationLog

Produced by frame-forge after each stitch, returned to the frontend via a dedicated endpoint.

| Field | Type | Notes |
|---|---|---|
| `algorithm` | string | e.g., `"LightGlue v2 → warp_expand_blend"`, `"OpenCV Stitcher"` |
| `modelFileName` | string? | null when disabled or AKAZE-only |
| `modelVersion` | string? | null when no model used |
| `ortVersion` | string? | null when no model used |
| `deviceName` | string | e.g., `"NVIDIA RTX 4070"` or `"CPU"` |
| `deviceType` | `"CPU"` \| `"GPU"` | |
| `deviceId` | string | e.g., `"cuda:0"` |
| `keypointMatchCount` | int? | null for non-DL paths |
| `inferenceDurationMs` | long? | null for non-DL paths |
| `totalDurationMs` | long | Wall time for the full stitch |
| `fallbacks` | FallbackEvent[] | Empty array when no fallback occurred |

**FallbackEvent**:

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"GPU→CPU"`, `"DL→AKAZE"`, `"DL→OpenCVStitcher"` |
| `reason` | string | Human-readable: `"CUDA EP init failed: driver mismatch"` |
| `timestamp` | string | ISO-8601 |

---

## State Transitions

### ModelEntry.status

```
catalog  →  downloading  →  installed
                         ↘  catalog       (checksum mismatch: partial file deleted)
installed  →  invalid           (file corrupted on disk, detected at load time)
invalid    →  downloading       (user triggers re-download)
installed  →  [deleted]         (LRU eviction)
```

### OrtVersion lifecycle

```
[catalog only]  →  downloading  →  installed / active
installed       →  active           (user switches to this version)
active          →  installed        (another version activated)
installed       →  [deleted]        (retention limit exceeded, oldest removed)
```

## Persistence

| Data | Storage | Notes |
|---|---|---|
| Model files (.onnx) | `/config/plugins/JellyfinSuite/models/` | Managed by ModelCatalogService |
| Model metadata (version, lastUsedAt) | `/config/plugins/JellyfinSuite/models/metadata.json` | JSON file updated on each stitch |
| ORT runtime files | `/config/plugins/JellyfinSuite/ort/<version>/` | Managed by OrtVersionService |
| Active ORT version | `/config/plugins/JellyfinSuite/ort/active.txt` | Plain text version string |
| Catalog cache | `/config/plugins/JellyfinSuite/model-catalog.json` | Refreshed every 24h |
| Catalog cache timestamp | `/config/plugins/JellyfinSuite/model-catalog.json.ttl` | Unix epoch seconds |
| GenerationLog | In-memory on task, file in task temp dir | Served via dedicated endpoint |
| User selections (device, model, ORT) | Browser `localStorage` | Keys: `jfs_stitch_device_id`, `jfs_stitch_model_family`, `jfs_stitch_model_version`, `jfs_stitch_ort_version` |
