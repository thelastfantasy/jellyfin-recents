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
  libopencv-dev python3-pip python3-pil 2>/dev/null
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

# ── Build forge with opencv ───────────────────────────────────────────────────
echo "[demo] Building forge (cli + opencv features)..."
LIBCLANG_PATH=/usr/lib/llvm-18/lib \
  /root/.cargo/bin/cargo build -p frame-forge --features "cli,opencv" --release 2>&1 | grep -E "^error|Compiling frame-forge|Finished"
FORGE=/workspace/target/release/forge

# ── Run stitches ─────────────────────────────────────────────────────────────
for SCENE in landscape_cmu synthetic_landscape walking_tour; do
  DIR="$FIXTURES/$SCENE"
  [ -f "$DIR/input_a.png" ] || continue
  MODE="landscape"
  [ "$SCENE" = "walking_tour" ] && MODE="liveaction"
  echo ""
  echo "[demo] === $SCENE ($MODE) ==="
  OUT="$OUTPUT/${SCENE}_stitched.png"
  $FORGE stitch-${MODE} --input "$DIR/input_a.png" "$DIR/input_b.png" --output "$OUT" 2>&1
  echo "[demo] Output: $OUT"
done

# ── Python reference stitches ─────────────────────────────────────────────────
echo ""
echo "[demo] === Python reference stitches (AKAZE+RANSAC+canvas expansion) ==="
for SCENE in landscape_cmu synthetic_landscape walking_tour; do
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
