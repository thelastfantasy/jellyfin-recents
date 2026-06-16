#!/usr/bin/env bash
# Stitch quality demo — runs inside the frame-forge Docker build container.
# Usage (called from Makefile/mise):
#   docker run --rm -v <workspace>:/workspace -w /workspace \
#     -v forge-cargo-home:/root/.cargo ubuntu:24.04 \
#     sh tests/stitch-eval/run_demo.sh
set -e

FIXTURES=/workspace/tests/stitch-eval/fixtures
DOWNLOADS=/workspace/tests/stitch-eval/downloads/example-data
SCORE_PY=/workspace/tests/stitch-eval/score.py
STITCH_PY=/workspace/tests/stitch-eval/stitch_py.py
OUTPUT=/workspace/tests/stitch-eval/demo-output
OUTPUT_PY=/workspace/tests/stitch-eval/demo-output-py

mkdir -p "$OUTPUT" "$OUTPUT_PY"

# ── Install deps ─────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl build-essential pkg-config ca-certificates \
  software-properties-common clang libclang-dev ffmpeg \
  libopencv-dev python3-pip python3-pil libssl-dev 2>/dev/null
add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq
apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev
apt-get install -y -qq python3-numpy python3-opencv 2>/dev/null || true
pip3 install --quiet Pillow numpy opencv-python-headless 2>/dev/null || true

# Install Rust if needed
[ -f /root/.cargo/bin/rustup ] || \
  (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null)
/root/.cargo/bin/rustup default stable 2>/dev/null || true

# ── Scene 1: Landscape (CMU0 consecutive frames) ─────────────────────────────
mkdir -p "$FIXTURES/landscape_cmu"
SRC_A="$DOWNLOADS/CMU0/medium14.JPG"
SRC_B="$DOWNLOADS/CMU0/medium15.JPG"
SRC_REF="$DOWNLOADS/CMU0/medium14.JPG"   # proxy reference (same as A for SSIM baseline)

if [ -f "$SRC_A" ] && [ -f "$SRC_B" ]; then
  echo "[demo] Preparing landscape fixtures (CMU0 frames 14+15)..."
  # Convert to PNG (forge expects PNG/WebP for reliability)
  ffmpeg -y -i "$SRC_A" "$FIXTURES/landscape_cmu/input_a.png" 2>/dev/null
  ffmpeg -y -i "$SRC_B" "$FIXTURES/landscape_cmu/input_b.png" 2>/dev/null
  cp "$FIXTURES/landscape_cmu/input_a.png" "$FIXTURES/landscape_cmu/reference.png"
  # Also copy to seagull dir for Rust test compatibility
  mkdir -p "$FIXTURES/seagull"
  cp "$FIXTURES/landscape_cmu/input_a.png" "$FIXTURES/seagull/input_a.png"
  cp "$FIXTURES/landscape_cmu/input_b.png" "$FIXTURES/seagull/input_b.png"
  cp "$FIXTURES/landscape_cmu/reference.png" "$FIXTURES/seagull/reference.png"
fi

# ── Scene 2: Synthetic (wide crop → two overlapping halves → reference=original) ─
mkdir -p "$FIXTURES/synthetic_landscape"
SRC_WIDE="$DOWNLOADS/CMU0/medium00.JPG"
if [ -f "$SRC_WIDE" ]; then
  echo "[demo] Preparing synthetic landscape fixtures (CMU0 frame 0, crop overlap)..."
  W=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=width -of csv=p=0 "$SRC_WIDE")
  H=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=height -of csv=p=0 "$SRC_WIDE")
  OV=$((W * 60 / 100))   # left 60% as input_a
  OFF=$((W * 40 / 100))   # start input_b at 40% offset
  B_W=$((W - OFF))        # input_b covers remaining 60%
  ffmpeg -y -i "$SRC_WIDE" -vf "crop=${OV}:${H}:0:0" "$FIXTURES/synthetic_landscape/input_a.png" 2>/dev/null
  ffmpeg -y -i "$SRC_WIDE" -vf "crop=${B_W}:${H}:${OFF}:0" "$FIXTURES/synthetic_landscape/input_b.png" 2>/dev/null
  ffmpeg -y -i "$SRC_WIDE" "$FIXTURES/synthetic_landscape/reference.png" 2>/dev/null
fi

# ── Scene 3: Live-action (myself — real-world overlapping shots) ──────────────
mkdir -p "$FIXTURES/walking_tour"
SRC_LA="$DOWNLOADS/myself/medium05.jpg"
SRC_LB="$DOWNLOADS/myself/medium06.jpg"
if [ -f "$SRC_LA" ] && [ -f "$SRC_LB" ]; then
  echo "[demo] Preparing live-action fixtures (myself 05+06)..."
  ffmpeg -y -i "$SRC_LA" "$FIXTURES/walking_tour/input_a.png" 2>/dev/null
  ffmpeg -y -i "$SRC_LB" "$FIXTURES/walking_tour/input_b.png" 2>/dev/null
  cp "$FIXTURES/walking_tour/input_a.png" "$FIXTURES/walking_tour/reference.png"
fi

# ── Scene 4: Flower macro (repeating flower patterns, bokeh bg) ───────────────
mkdir -p "$FIXTURES/flower_landscape"
SRC_F1="$DOWNLOADS/flower/1.jpg"
SRC_F2="$DOWNLOADS/flower/2.jpg"
if [ -f "$SRC_F1" ] && [ -f "$SRC_F2" ]; then
  echo "[demo] Preparing flower fixtures (1+2)..."
  ffmpeg -y -i "$SRC_F1" "$FIXTURES/flower_landscape/input_a.png" 2>/dev/null
  ffmpeg -y -i "$SRC_F2" "$FIXTURES/flower_landscape/input_b.png" 2>/dev/null
  cp "$FIXTURES/flower_landscape/input_a.png" "$FIXTURES/flower_landscape/reference.png"
fi

# ── Scene 5: CMU1 (different CMU building exterior) ──────────────────────────
mkdir -p "$FIXTURES/cmu1"
SRC_CMU1A="$DOWNLOADS/CMU1/medium00.jpg"
SRC_CMU1B="$DOWNLOADS/CMU1/medium01.jpg"
if [ -f "$SRC_CMU1A" ] && [ -f "$SRC_CMU1B" ]; then
  echo "[demo] Preparing CMU1 fixtures (medium00+01)..."
  ffmpeg -y -i "$SRC_CMU1A" "$FIXTURES/cmu1/input_a.png" 2>/dev/null
  ffmpeg -y -i "$SRC_CMU1B" "$FIXTURES/cmu1/input_b.png" 2>/dev/null
  cp "$FIXTURES/cmu1/input_a.png" "$FIXTURES/cmu1/reference.png"
fi

# ── Scene 6: UAV aerial footage (top-down drone shots) ───────────────────────
mkdir -p "$FIXTURES/uav"
SRC_UAVA="$DOWNLOADS/uav/medium01.jpg"
SRC_UAVB="$DOWNLOADS/uav/medium02.jpg"
if [ -f "$SRC_UAVA" ] && [ -f "$SRC_UAVB" ]; then
  echo "[demo] Preparing UAV fixtures (medium01+02)..."
  ffmpeg -y -i "$SRC_UAVA" "$FIXTURES/uav/input_a.png" 2>/dev/null
  ffmpeg -y -i "$SRC_UAVB" "$FIXTURES/uav/input_b.png" 2>/dev/null
  cp "$FIXTURES/uav/input_a.png" "$FIXTURES/uav/reference.png"
fi

# ── Scene 7: Zijing campus garden ────────────────────────────────────────────
mkdir -p "$FIXTURES/zijing"
SRC_ZJA="$DOWNLOADS/zijing/medium01.jpg"
SRC_ZJB="$DOWNLOADS/zijing/medium02.jpg"
if [ -f "$SRC_ZJA" ] && [ -f "$SRC_ZJB" ]; then
  echo "[demo] Preparing Zijing fixtures (medium01+02)..."
  ffmpeg -y -i "$SRC_ZJA" "$FIXTURES/zijing/input_a.png" 2>/dev/null
  ffmpeg -y -i "$SRC_ZJB" "$FIXTURES/zijing/input_b.png" 2>/dev/null
  cp "$FIXTURES/zijing/input_a.png" "$FIXTURES/zijing/reference.png"
fi

# ── Build forge with opencv ───────────────────────────────────────────────────
# cargo clean -p frame-forge is required: Windows NTFS mtime is unreliable
# inside Docker mounts, preventing incremental rebuild from detecting source changes.
echo "[demo] Cleaning frame-forge cache (Windows NTFS mtime workaround)..."
/root/.cargo/bin/cargo clean -p frame-forge 2>/dev/null || true
echo "[demo] Building forge (cli + opencv features)..."
LIBCLANG_PATH=/usr/lib/llvm-18/lib \
  /root/.cargo/bin/cargo build -p frame-forge --features "cli,opencv" --release
FORGE=/workspace/target/release/forge
FORGE_MD5=$(md5sum "$FORGE" | awk '{print $1}')
echo "[demo] forge binary MD5: $FORGE_MD5"

# ── Run stitches ─────────────────────────────────────────────────────────────
for SCENE in landscape_cmu synthetic_landscape walking_tour flower_landscape cmu1 uav zijing; do
  DIR="$FIXTURES/$SCENE"
  [ -f "$DIR/input_a.png" ] || continue
  echo ""
  echo "[demo] === $SCENE (auto-detect) ==="
  OUT="$OUTPUT/${SCENE}_stitched.png"
  # Pass all frame_*.png if present (multi-frame scenes), else the two-frame pair.
  FRAMES=$(ls "$DIR"/frame_*.png 2>/dev/null | sort | tr '\n' ' ')
  if [ -n "$FRAMES" ]; then
    $FORGE stitch --input $FRAMES --output "$OUT" 2>&1
  else
    $FORGE stitch --input "$DIR/input_a.png" "$DIR/input_b.png" --output "$OUT" 2>&1
  fi
  echo "[demo] Output: $OUT"
done

# ── Python reference stitches ─────────────────────────────────────────────────
echo ""
echo "[demo] === Python reference stitches (AKAZE+RANSAC+canvas expansion) ==="
for SCENE in landscape_cmu synthetic_landscape walking_tour flower_landscape cmu1 uav zijing; do
  DIR="$FIXTURES/$SCENE"
  [ -f "$DIR/input_a.png" ] || continue
  OUT_PY="$OUTPUT_PY/${SCENE}_stitched.png"
  python3 "$STITCH_PY" "$DIR/input_a.png" "$DIR/input_b.png" "$OUT_PY" 2>&1 || true
done

# ── Score ─────────────────────────────────────────────────────────────────────
echo ""
echo "[demo] === score.py — Rust stitches ==="
python3 "$SCORE_PY" "$FIXTURES" "$OUTPUT" 2>&1 || true

echo ""
echo "[demo] === score.py — Python stitches ==="
python3 "$SCORE_PY" "$FIXTURES" "$OUTPUT_PY" 2>&1 || true

echo ""
echo "[demo] Done."
echo "  Rust PNGs:   $OUTPUT/"
ls -lh "$OUTPUT/"
echo "  Python PNGs: $OUTPUT_PY/"
ls -lh "$OUTPUT_PY/"

# ── Auto-generate HTML report ────────────────────────────────────────────────
GEN_REPORT=/workspace/tests/stitch-eval/gen_report.py
REPORT_HTML=/workspace/tests/stitch-eval/report.html
if [ -f "$GEN_REPORT" ]; then
  echo ""
  echo "[demo] Generating HTML report..."
  python3 "$GEN_REPORT" "$FIXTURES" "$OUTPUT" "$OUTPUT_PY" "$REPORT_HTML" 2>&1 || true
  echo "[demo] Report: $REPORT_HTML"
fi
