# Quickstart: Frame Export & Stitch

**Feature**: 009-frame-forge-stitch  
**Date**: 2026-05-26

## Prerequisites

- Jellyfin 10.10.x in Docker (`jellyfin-dev` container)
- Rust 1.88 toolchain (via Docker ‚Ä?no local Rust required for Linux build)
- Node.js + npm (for player-enhancer frontend build)
- .NET 8 SDK (for C# plugin build)

## Local Development Setup

```bash
# 1. Ensure jellyfin-dev container is running
docker start jellyfin-dev

# 2. Build and deploy all components
make update   # builds frontend + enhancer + plugin + Rust binaries ‚Ü?cp to container

# 3. Open Jellyfin in browser
# http://localhost:8600
# Navigate to any movie/episode ‚Ü?play ‚Ü?look for new "frame export" button in OSD
```

## Build Individual Components

```bash
# Frontend (player-enhancer with @alivecss/aliveui)
cd src/player-enhancer && npm install && npm run build

# C# plugin
dotnet build src/JellyfinSuite.Plugin -c Debug --output build/plugin

# Rust daemon (Linux, via Docker)
make build-frame-forge    # (once implemented in Makefile)

# Run tests
make test                   # all suites: Rust + TypeScript + C#
make test-rust              # Rust only (includes frame-forge)
make test-frontend          # TypeScript/Vitest
make test-csharp            # C# xUnit
```

## Manual Testing Flow

1. Open any video in Jellyfin web player
2. Click the new "Â∏ßÂØºÂá? button in the OSD control bar
3. Modal opens showing 11 keyframe thumbnails grid
4. Expand forward/backward to browse more frames
5. Uncheck junk frames, check desired frames
6. Expand parameters panel: select format (GIF/WebP), set width/height constraint, adjust fps
7. Click "ÁîüÊàê"
8. Watch SSE progress bar ‚Ü?result preview appears automatically
9. Click "‰∏ãËΩΩ" to save, or "ËøîÂõû" to go back

## cURL Testing (C# endpoints)

```bash
# Get single frame thumbnail
curl "http://localhost:8600/JellyfinSuite/FrameExport/{itemId}?positionMs=5000&width=320&api_key=YOUR_TOKEN" -o frame.jpg

# Submit animation task
curl -X POST "http://localhost:8600/JellyfinSuite/FrameExport/Generate?api_key=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "itemId": "...",
    "itemTitle": "Test",
    "type": "animate",
    "frames": [{"positionMs": 5000}, {"positionMs": 10000}],
    "params": {"format": "gif", "resizeMode": "width", "resolutionPreset": "480p", "fps": 5, "loopCount": 0}
  }'

# Watch progress (SSE)
curl -N "http://localhost:8600/JellyfinSuite/FrameExport/Progress?taskId={uuid}&api_key=YOUR_TOKEN"

# Download result
curl "http://localhost:8600/JellyfinSuite/FrameExport/Result/{taskId}/output.gif?api_key=YOUR_TOKEN" -o output.gif
```

## Key Architecture Notes

- **frame-forge daemon** is a separate Rust binary (`src/frame-forge/`), NOT merged into seek-preview
- Unix socket path: `{DataPath}/jfs-frame-forge.sock` (separate from seek-preview's `jfs-seek-preview.sock`)
- Frame decoding reuses `ffmpeg-next` with same config as seek-preview (slice threading, 4 workers max)
- Progress events flow: Rust ‚Ü?mpsc channel ‚Ü?C# `ChannelReader` ‚Ü?`Response.Body.WriteAsync` SSE
- @alivecss/aliveui CSS is imported in `src/player-enhancer/src/styles.ts` ‚Ü?injected via existing `injectStyles()` pattern
- Temporary files at `{DataPath}/temp/frame-forge/{taskId}/` auto-cleaned after 5 min idle

## File Locations

| Component | Path |
|-----------|------|
| Rust daemon source | `src/frame-forge/` |
| Rust binary (deployed) | `/config/plugins/JellyfinSuite/frame-forge-linux-x64` |
| C# service | `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` |
| C# controller | `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` |
| Frontend modal | `src/player-enhancer/src/frame-forge.ts` |
| Frontend styles (@alivecss/aliveui) | `src/player-enhancer/src/styles.ts` |
| Temp directory | `{DataPath}/temp/frame-forge/` |
| Socket file | `{DataPath}/jfs-frame-forge.sock` |
