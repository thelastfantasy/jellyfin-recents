# API Contracts: ORT GPU Acceleration & Model/Device Selection UI

Base prefix: `/JellyfinSuite/Stitch`

All responses are JSON (camelCase). All endpoints are `[AllowAnonymous]` consistent with
the existing `FrameExportController` pattern.

---

## Device Enumeration

### GET /Stitch/Devices

Returns all available compute devices on the server.

**Response 200**:
```json
{
  "devices": [
    {
      "id": "cuda:0",
      "displayName": "NVIDIA RTX 4070",
      "deviceType": "GPU",
      "vendor": "NVIDIA",
      "vramMb": 12288,
      "isIntegrated": false,
      "isDefault": true
    },
    {
      "id": "cpu:0",
      "displayName": "CPU",
      "deviceType": "CPU",
      "vendor": "CPU",
      "vramMb": null,
      "isIntegrated": false,
      "isDefault": false
    }
  ]
}
```

---

## Model Management

### GET /Stitch/Models

Returns all model entries: installed + catalog top-10 per family.

**Response 200**:
```json
{
  "models": [
    {
      "family": "lightglue",
      "displayName": "LightGlue v2",
      "version": "2.0",
      "fileName": "superpoint_lightglue_pipeline.onnx",
      "fileSizeBytes": 123456789,
      "sha256": "abc123...",
      "downloadUrl": "https://...",
      "releaseDate": "2024-11-01",
      "status": "installed",
      "localPath": "/config/plugins/JellyfinSuite/models/superpoint_lightglue_pipeline.onnx",
      "lastUsedAt": "2026-06-17T10:00:00Z",
      "isLatest": true
    }
  ],
  "catalogFetchedAt": "2026-06-17T08:00:00Z",
  "catalogStale": false
}
```

### POST /Stitch/Models/Download

Trigger download of a specific model version.

**Request**:
```json
{ "family": "lightglue", "version": "2.0" }
```

**Response 202**: Download started (monitor via SSE).

**Response 404**: Version not found in catalog.

**Response 409**: Already installed or download in progress.

### GET /Stitch/Models/DownloadProgress?family=&version=

SSE stream of download progress for a specific model.

**Event data** (repeated):
```json
{ "family": "lightglue", "version": "2.0", "percent": 42, "status": "downloading" }
```
Final event: `status` is `"installed"`, `"error"`, or `"cancelled"`.

### DELETE /Stitch/Models/{family}/{version}

Delete a locally installed model version (only if not the active "latest").

**Response 200**: `{ "deleted": true }`

**Response 409**: Cannot delete — this is the only installed version for the family.

---

## ORT Version Management

### GET /Stitch/OrtVersions

Returns all ORT versions: installed + catalog list.

**Response 200**:
```json
{
  "activeVersion": "2.0.0-rc.12",
  "versions": [
    {
      "version": "2.0.0-rc.12",
      "releaseDate": "2024-10-01",
      "isActive": true,
      "localDir": "/config/plugins/JellyfinSuite/ort/v2.0.0-rc.12",
      "installedAt": "2026-06-17T07:00:00Z",
      "assets": {
        "linux-x64-cuda": { "url": "https://...", "sha256": "...", "sizeBytes": 456789 }
      }
    }
  ],
  "maxRetainedVersions": 2
}
```

### POST /Stitch/OrtVersions/Download

Download and activate a specific ORT version.

**Request**:
```json
{ "version": "2.1.0" }
```

**Response 202**: Download started.

**Response 404**: Version not found in catalog.

### POST /Stitch/OrtVersions/Activate

Switch the active ORT version to an already-installed one (no download needed).

**Request**:
```json
{ "version": "2.0.0-rc.12" }
```

**Response 200**: `{ "activeVersion": "2.0.0-rc.12" }`

**Response 404**: Version not installed.

### GET /Stitch/OrtVersions/DownloadProgress?version=

SSE stream for ORT download progress (same shape as model download progress).

---

## Stitch Job Extensions

### POST /FrameExport/Generate (extended)

The existing endpoint accepts additional optional fields in `params`:

```json
{
  "type": "stitch",
  "itemId": "...",
  "frames": [...],
  "params": {
    "format": "png",
    "quality": 95,
    "deviceId": "cuda:0",
    "modelFamily": "lightglue",
    "modelVersion": "latest",
    "ortVersion": null
  }
}
```

All new fields are optional. When absent, server defaults apply (VRAM-ranked device,
latest installed model, active ORT version).

### GET /FrameExport/Result/{taskId}/generation-log.json

Returns the GenerationLog for a completed stitch task.

**Response 200** (stitch tasks only):
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
  "totalDurationMs": 1820,
  "fallbacks": []
}
```

**Response 404**: Task not found, not yet complete, or task is an animate (not stitch) job.

---

## frame-forge Socket Protocol Extension (MSG_STITCH)

MSG_STITCH (0x12) is extended with two trailing fields appended after the existing wire format:

```
[device_id_len (4 LE)] [device_id (UTF-8)]   -- e.g. "cuda:0"; empty = use default EP chain
[log_path_len  (4 LE)] [log_path  (UTF-8)]   -- absolute path for GenerationLog JSON; empty = skip
```

The Rust daemon reads `device_id` to select the ORT Execution Provider for this request.
`log_path` is written atomically on stitch completion; C# reads it after the task is done.

`ORT_DYLIB_PATH` is set in the daemon process environment at startup (not per-request).
ORT version changes trigger a daemon restart via `OrtVersionService.ActivateVersion()`.
