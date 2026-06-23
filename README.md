# Jellyfin Suite

A Jellyfin plugin suite: recently played view, poster sheet generator, and web player enhancer.

[中文文档](README.zh-CN.md)

---

## Features

### Recently Played View

- **Grouping**: Browse play history grouped by day / week / month / quarter / year
- **Sorting**: Play time, title, release date, add date, favorites-first
- **Media filter**: All / video / audio
- **Dedup mode**: Hide repeated plays; optionally dedup within each group independently
- **Episode info**: Series name and episode code (S×E× / SP× for specials) shown on every card
- **Smart links**: Series name links to the series page; episode title links to the episode page
- **Folder view**: Click the folder icon on any card to open a popover showing the item's parent folder hierarchy with direct links — supports thumbnail, poster, and list view modes *(requires **Dashboard → Libraries → Display → Show folder view for library items** to be enabled in Jellyfin)*
- **View modes**: Thumbnail (16:9) / Poster (2:3) / List
- **Full pagination**: First / prev / jump / next / last with configurable items per page
- **Internationalization**: English, 简体中文, 日本語

### Thumbnail Grid Generator

Unlock by clicking the **Thumbnail** view button 7 times within 5 seconds. Once unlocked, a grid icon appears on each video card.

- **Grid configuration**: Freely adjust rows (1–10) and columns (1–12); short videos automatically show only valid presets to maintain ≥2 s/frame spacing
- **Modes**: Deterministic (same video always produces the same sheet, cache-eligible) or Random (fresh frame selection each time)
- **Skip segments**: Skip intro/outro by chapter or custom time range; one-tap quick-add buttons for skipping first/last 60s or 90s; supports global skip presets shared across all videos; OP/ED auto-detection heuristic
- **Overlay**: Configurable branding label, video metadata block (filename, file size, resolution & FPS, codec, audio, duration), per-frame timestamp badges at 6 configurable positions; badge size scales proportionally with thumbnail width (~¼ cell width)
- **Timestamp style**: Choose font (Roboto Mono, Vollkorn old-style numerals, or any uploaded custom font); toggle background badge and shadow/outline effect; shadow color is defined per-theme and automatically adapts between badge-on and floating-on-video modes
- **Themes**: Classic / Dark / Light / Cinematic / Minimal / Transparent — each with a distinct color palette
- **Fonts**: Automatic download of Noto Sans, Noto Serif, Roboto, Oswald, Playfair Display, Cinzel, Vollkorn; custom font upload (TTF/OTF, auto-detected as Latin or CJK); mixed-script branding label renders Latin and CJK characters with their respective fonts
- **QR watermark**: GitHub repo QR code embedded in the header with a gradient color scheme
- **Jellyfin logo**: Semi-transparent logo composited in the header area
- **Output**: Lossless WebP with alpha channel (transparent theme)
- **Task queue widget**: Bottom-right overlay showing all in-progress and completed jobs; per-job progress bar, thumbnail preview, download, and delete actions
- **Lightbox**: Full-screen viewer with wheel zoom (cursor-anchored), mouse drag pan, touch pan, and pinch-to-zoom; download and delete buttons

### Web Player Enhancer

Automatically injected into the Jellyfin web player. No configuration needed.

- **Frame stepping**: F−10 / F−1 / F+1 / F+10 buttons for frame-accurate navigation; frame rate auto-detected from MediaInfo; steps pause playback automatically
- **Screenshot**: One-click PNG download of the current video frame; optional subtitle overlay (ASS and SRT); client-side only, no server files created
- **Mobile double-tap seek**: Double-tap left third to seek back, right third to seek forward, center third to toggle play/pause; seek duration configurable in the plugin management panel (default 10 s, touch devices only)
- **Mobile swipe controls**: Swipe up/down on the left half to adjust brightness (0–200%), right half for volume (0–100%); OSD percentage indicator shown during gesture (touch devices only)
- **Mobile long-press speed-up**: Long-press the bottom third of the screen during playback to accelerate to a configurable speed (1.25×–4×, default 2×) with haptic feedback and OSD; drag horizontally while holding to seek in real time at 1× speed; release the drag to resume speed automatically; speed rate configurable in the plugin management panel (touch devices only)
- **Mobile trickplay seek-preview**: Drag horizontally on the video during playback to seek; a frame thumbnail from Jellyfin's trickplay index is displayed above the seek OSD in real time, letting you confirm the target frame before release; seek commits on finger-lift; falls back gracefully if trickplay data is unavailable (touch devices only)
- **Frame export & stitching**: Click the frame-export button in the player OSD to browse keyframes around the current playback position; select frames and export as animated GIF/WebP/MP4 or stitch into a panorama (PNG/WebP-lossless); three-scene panorama stitching algorithms (anime Phase Correlation / landscape AKAZE / live-action motion-masked AKAZE) with automatic scene classification and junk frame detection; frame decoding is hardware-accelerated by default (VAAPI for Intel/AMD, NVDEC/CUDA for NVIDIA) with automatic, silent fallback to software decode on any failure — a toggle in the Advanced panel lets you disable it, and on multi-GPU hosts a device-selection strategy (favor the discrete GPU, or favor whichever device is currently idle) is also configurable there
- **AI upscale**: From any exported animation (GIF/WebP/MP4) or panorama result, run one-click AI super-resolution (Real-ESRGAN, ×2/×4, photo-realistic or anime-tuned model variants) with optional GFPGAN face restoration; before/after comparison view shows the resolution and file-size delta; the result queue also keeps both versions afterwards, with a toggle to compare and download either; runs on whichever compute device is configured (GPU or CPU), with automatic CPU fallback on GPU failure
- **GPU/model management**: An Advanced panel lets any user pick the compute device (CPU or any detected GPU, auto-ranked by VRAM) and the DL model version used for stitching/upscaling; models are downloaded on demand and version-managed automatically (latest version always kept, older versions LRU-evicted); the ONNX Runtime version can be upgraded without restarting Jellyfin

---

## Screenshots

### Recently Played View

<img src="screenshots/01-recently-played.png" width="49%"> <img src="screenshots/02-recently-played-folder-view.png" width="49%">

### Thumbnail Grid Generator

<img src="screenshots/07-poster-result.png" width="100%">

<img src="screenshots/04-poster-settings-grid-mode.png" width="32%"> <img src="screenshots/05-poster-settings-theme-font.png" width="32%"> <img src="screenshots/08-poster-skip-segments.png" width="32%">

<img src="screenshots/03-poster-queue-widget.png" width="49%"> <img src="screenshots/09-poster-queue-done.png" width="49%">

### Web Player Enhancer

<img src="screenshots/10-player-enhancer-panel.png" width="49%"> <img src="screenshots/11-player-enhancer-player.png" width="49%">

---

## Installation

### Plugin Repository (recommended)

1. Open Jellyfin dashboard → **Plugins** → **Repositories**
2. Add repository URL:
   ```
   https://thelastfantasy.github.io/jellyfin-suite/manifest.json
   ```
3. Find **Jellyfin Suite** in the **Catalog** and install
4. Restart Jellyfin

> **Jellyfin Suite + Fonts** is a separate catalog entry that bundles Latin fonts (Roboto, Oswald, Playfair Display, Cinzel) so no internet access is required for font acquisition. Use this variant for air-gapped servers.

### Manual

1. Download the latest `.zip` from [Releases](https://github.com/thelastfantasy/jellyfin-suite/releases)
2. Extract to your Jellyfin plugins directory:
   - Linux: `/var/lib/jellyfin/plugins/JellyfinSuite/`
   - Windows: `%APPDATA%\Jellyfin\plugins\JellyfinSuite\`
   - Docker: `/config/plugins/JellyfinSuite/`
3. Restart Jellyfin

After installation, a **Recently Played** entry will appear in the sidebar.

### Player Enhancer — Docker/Linux permission

The web player enhancer patches Jellyfin's `index.html` at server startup. If Jellyfin runs as a non-root user (common on Unraid, TrueNAS, or custom Docker setups), that file must be writable by the Jellyfin process. Run this **once** after installation, replacing `568:568` with your actual Jellyfin UID:GID:

```bash
docker exec -u root $(docker ps --filter name=jellyfin --format '{{.Names}}') \
  ls /jellyfin/jellyfin-web/index.html >/dev/null && \
  chown 568:568 $(docker inspect \
    $(docker ps --filter name=jellyfin --format '{{.Names}}') \
    --format '{{.GraphDriver.Data.MergedDir}}')/jellyfin/jellyfin-web/index.html
```

If the enhancer is not injecting (frame-step buttons not visible in the player), check that the Jellyfin process has write access to `index.html`.

---

## Migrating from Jellyfin Recents

If you previously installed the **Jellyfin Recents** plugin, follow these steps to migrate to Jellyfin Suite.

> The two plugins share the same internal GUID. Having both installed simultaneously may cause conflicts — uninstall the old one before installing the new one.

1. **Remove the old repository**: Jellyfin dashboard → **Plugins** → **Repositories** → delete the old entry:
   ```
   https://thelastfantasy.github.io/jellyfin-recents/manifest.json
   ```
2. **Uninstall Jellyfin Recents**: **Plugins** → **My Plugins** → find *Jellyfin Recents* (or *Jellyfin Recents + Fonts*) → Uninstall
3. **Restart Jellyfin** to complete the uninstall
4. **Add the new repository** (see Installation above) and install **Jellyfin Suite**
5. **Restart Jellyfin** again

Your play history and plugin configuration are stored in the Jellyfin database and data directory — they are not affected by the migration.

---

## Custom Fonts

The plugin downloads Noto Sans JP and Noto Serif JP automatically on first use (requires internet access). Latin fonts (Roboto, Oswald, Playfair Display, Cinzel) are also downloaded automatically.

To use your own fonts, upload them from the Thumbnail Grid settings panel, or place them manually:

```
<jellyfin data dir>/plugins/JellyfinSuite/fonts/
  custom-MyFont.ttf     ← uploaded via settings panel
```

Supported formats: TTF, OTF (TTC collections are not supported). The plugin reads the internal font family name from the file, so the filename is generated automatically on upload.

---

## Compatibility

| Plugin version | Minimum Jellyfin |
|----------------|------------------|
| 2.x            | 10.11.0          |
| 1.x            | 10.10.0          |

---

## Development

```bash
# Run all tests
make test

# Build and deploy to local Jellyfin dev container
make update
```

### Frontend dev server

```bash
cd src/frontend
npm install
npm run dev
```

Copy `.env.example` to `.env` and set your Jellyfin URL:

```
VITE_JELLYFIN_URL=http://localhost:8096
```

### Player enhancer

The web player enhancer is a separate Vite bundle injected into Jellyfin's `index.html` at server startup:

```bash
make build-enhancer   # build src/player-enhancer → JellyfinSuite.Plugin/Web/
```

Or run the dev cycle directly:

```bash
cd src/player-enhancer
npm install
npm run build
```

### Thumbnail generator

The Rust thumbnail generator binary (`poster-gen`) is built separately via Docker:

```bash
make build-poster-gen      # Linux binary (via Docker)
make build-poster-gen-win  # Windows binary (native)
```

---

## AI Disclosure

This project was primarily developed with the assistance of an AI language model (Claude by Anthropic). In accordance with [Jellyfin's LLM policies](https://jellyfin.org/docs/general/contributing/llm-policies), this disclosure is provided so users can make an informed decision about whether to use this plugin.
