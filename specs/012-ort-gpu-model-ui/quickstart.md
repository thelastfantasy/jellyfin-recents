# Quickstart & Validation Guide: ORT GPU Acceleration & Model/Device Selection UI

## Prerequisites

- `jellyfin-dev` container running (`mise run update` completed)
- A CUDA-capable GPU present on the host (for GPU path validation); CPU-only host is
  sufficient for all non-GPU scenarios
- `curl` and `jq` available in shell

---

## Scenario 1: Device enumeration returns at least CPU

```bash
curl -s http://localhost:8600/JellyfinSuite/Stitch/Devices | jq '.devices[].id'
# Expected: at least "cpu:0"
# On GPU host: also "cuda:0" or "directml:0"
```

**Pass criterion**: response is 200, `devices` array is non-empty, CPU entry present.

---

## Scenario 2: Default device is the GPU with most VRAM

On a multi-GPU host:
```bash
curl -s http://localhost:8600/JellyfinSuite/Stitch/Devices | jq '.devices[] | select(.isDefault)'
# Expected: the GPU with highest vramMb has isDefault=true
```

**Pass criterion**: `isDefault=true` device has the largest `vramMb` among GPU entries.

---

## Scenario 3: Model catalog loads within 24h TTL

```bash
curl -s http://localhost:8600/JellyfinSuite/Stitch/Models | jq '{catalogStale, count: (.models | length)}'
# Expected: catalogStale=false, count >= 2 (at least LightGlue + EfficientLoFTR entries)
```

**Pass criterion**: response 200, at least 2 model entries visible, catalogStale=false.

---

## Scenario 4: Stitch with GPU device produces GenerationLog

Requires an installed model and an item with at least 2 frames.

```bash
# 1. Submit stitch job
TASK=$(curl -s -X POST http://localhost:8600/JellyfinSuite/FrameExport/Generate \
  -H 'Content-Type: application/json' \
  -d '{
    "type":"stitch","itemId":"<ITEM_ID>",
    "frames":[{"frameIdx":10},{"frameIdx":50}],
    "params":{"format":"png","quality":95,"deviceId":"cuda:0","modelFamily":"lightglue","modelVersion":"latest"}
  }' | jq -r '.taskId')

# 2. Poll until complete
curl -s "http://localhost:8600/JellyfinSuite/FrameExport/Tasks" | jq --arg t "$TASK" '.[] | select(.taskId==$t)'

# 3. Fetch log
curl -s "http://localhost:8600/JellyfinSuite/FrameExport/Result/$TASK/generation-log.json" | jq .
```

**Pass criterion**: log contains `deviceType: "GPU"`, `deviceId: "cuda:0"`, non-null
`modelFileName`, `inferenceDurationMs` > 0.

---

## Scenario 5: GPU failure falls back to CPU

Trigger fallback by passing an invalid device ID:
```bash
# params.deviceId set to a non-existent device
curl -s -X POST ... -d '{"params":{"deviceId":"cuda:99",...}}' ...
# Fetch log
curl -s "http://localhost:8600/JellyfinSuite/FrameExport/Result/$TASK/generation-log.json" | jq .fallbacks
```

**Pass criterion**: `fallbacks` array contains one entry with `type: "GPU→CPU"`,
stitch still completes successfully.

---

## Scenario 6: Download log button appears only for stitch (not animate)

In the browser:
1. Generate a **stitch** → result panel shows "Download image" AND "Download log" buttons.
2. Generate an **animate** → result panel shows only "Download image", no "Download log".

**Pass criterion**: button presence matches output type.

---

## Scenario 7: Model LRU eviction (5-version limit)

```bash
# Install 6 versions of the same family via /Stitch/Models/Download
# After 6th completes, verify only 5 remain installed
curl -s http://localhost:8600/JellyfinSuite/Stitch/Models | \
  jq '[.models[] | select(.family=="lightglue" and .status=="installed")] | length'
# Expected: 5
```

Also verify: the latest version (`isLatest=true`) is always among the 5 retained.

---

## Scenario 8: ORT version retained across update

```bash
# 1. Note active version
curl -s http://localhost:8600/JellyfinSuite/Stitch/OrtVersions | jq .activeVersion

# 2. Download a second ORT version and activate it
curl -s -X POST http://localhost:8600/JellyfinSuite/Stitch/OrtVersions/Download \
  -H 'Content-Type: application/json' -d '{"version":"2.1.0"}'

# 3. After download: both versions present (retention limit = 2 default)
curl -s http://localhost:8600/JellyfinSuite/Stitch/OrtVersions | jq '[.versions[] | select(.localDir != null)] | length'
# Expected: 2

# 4. Activate old version (rollback)
curl -s -X POST http://localhost:8600/JellyfinSuite/Stitch/OrtVersions/Activate \
  -H 'Content-Type: application/json' -d '{"version":"2.0.0-rc.12"}'
# Expected 200 with activeVersion matching

# 5. Stitch still works after rollback (GPU path)
```

**Pass criterion**: rollback succeeds, stitch completes, log shows rolled-back ORT version.

---

## Scenario 9: localStorage selections survive page reload

1. Open the workshop modal → Advanced section.
2. Change device to the second GPU, model family to EfficientLoFTR, version to "latest".
3. Close and reopen the modal (page reload).

**Pass criterion**: all three selections are restored from localStorage without any network
round-trip to the server.

---

## Scenario 10: No regression when Advanced section never opened

Run a standard stitch without touching the Advanced section (fresh localStorage).

**Pass criterion**: stitch completes with the same quality and success rate as the
pre-feature baseline; no additional UI elements visible to casual users.
