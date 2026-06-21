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
OUTPUT=/workspace/tests/stitch-eval/demo-output           # LightGlue (new)
OUTPUT_LEGACY=/workspace/tests/stitch-eval/demo-output-legacy  # AKAZE-only (old)
OUTPUT_LOFTR=/workspace/tests/stitch-eval/demo-output-loftr    # EfficientLoFTR
OUTPUT_PY=/workspace/tests/stitch-eval/demo-output-py

mkdir -p "$OUTPUT" "$OUTPUT_LEGACY" "$OUTPUT_LOFTR" "$OUTPUT_PY"

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

# ── Download DL models (LightGlue + EfficientLoFTR) ──────────────────────────
# frame-forge find_model() searches /workspace/models/ as last candidate.
# Models are cached across runs via the forge-cargo-home volume mount.
MODELS_DIR=/workspace/models
mkdir -p "$MODELS_DIR"
# v2.0 pipeline model (preferred Tier 1a)
LIGHTGLUE_V2_MODEL="$MODELS_DIR/superpoint_lightglue_pipeline.onnx"
# v1.0.0 fused model (legacy Tier 1b, kept for back-compat if user placed it manually)
LIGHTGLUE_V1_MODEL="$MODELS_DIR/superpoint_lightglue.onnx"
LOFTR_MODEL="$MODELS_DIR/eloftr_640x480.onnx"

if [ ! -f "$LIGHTGLUE_V2_MODEL" ]; then
  echo "[demo] Downloading LightGlue v2 model (~100 MB, v2.0 pipeline)..."
  curl -fL --retry 3 --connect-timeout 30 \
    "https://github.com/fabio-sim/LightGlue-ONNX/releases/download/v2.0/superpoint_lightglue_pipeline.onnx" \
    -o "$LIGHTGLUE_V2_MODEL" \
    && echo "[demo] LightGlue v2 OK: $LIGHTGLUE_V2_MODEL" \
    || {
      echo "[demo] LightGlue v2 download failed — trying v1.0.0 fused fallback..."
      rm -f "$LIGHTGLUE_V2_MODEL"
      if [ ! -f "$LIGHTGLUE_V1_MODEL" ]; then
        curl -fL --retry 3 --connect-timeout 30 \
          "https://github.com/fabio-sim/LightGlue-ONNX/releases/download/v1.0.0/superpoint_lightglue_fused.onnx" \
          -o "$LIGHTGLUE_V1_MODEL" \
          && echo "[demo] LightGlue v1 OK: $LIGHTGLUE_V1_MODEL" \
          || { echo "[demo] LightGlue download failed — will use AKAZE fallback"; rm -f "$LIGHTGLUE_V1_MODEL"; }
      fi
    }
else
  echo "[demo] LightGlue v2 already cached: $LIGHTGLUE_V2_MODEL"
fi

# EfficientLoFTR Tier 2 fallback (zahilaty/EfficientLoFTR-ONNX, public).
if [ ! -f "$LOFTR_MODEL" ]; then
  echo "[demo] Downloading EfficientLoFTR model (~50 MB)..."
  curl -fL --retry 3 --connect-timeout 30 \
    "https://huggingface.co/zahilaty/EfficientLoFTR-ONNX/resolve/main/eloftr_640x480.onnx" \
    -o "$LOFTR_MODEL" \
    && echo "[demo] EfficientLoFTR OK: $LOFTR_MODEL" \
    || { echo "[demo] EfficientLoFTR download failed — will skip LoFTR fallback"; rm -f "$LOFTR_MODEL"; }
else
  echo "[demo] EfficientLoFTR already cached: $LOFTR_MODEL"
fi

# ── Scene 1: Landscape (CMU0 consecutive frames) ─────────────────────────────
mkdir -p "$FIXTURES/landscape_cmu" "$FIXTURES/seagull"
if [ ! -f "$FIXTURES/landscape_cmu/input_a.png" ]; then
  SRC_A="$DOWNLOADS/CMU0/medium14.JPG"
  SRC_B="$DOWNLOADS/CMU0/medium15.JPG"
  if [ -f "$SRC_A" ] && [ -f "$SRC_B" ]; then
    echo "[demo] Preparing landscape fixtures (CMU0 frames 14+15)..."
    ffmpeg -y -i "$SRC_A" "$FIXTURES/landscape_cmu/input_a.png" 2>/dev/null
    ffmpeg -y -i "$SRC_B" "$FIXTURES/landscape_cmu/input_b.png" 2>/dev/null
    cp "$FIXTURES/landscape_cmu/input_a.png" "$FIXTURES/landscape_cmu/reference.png"
    cp "$FIXTURES/landscape_cmu/input_a.png" "$FIXTURES/seagull/input_a.png"
    cp "$FIXTURES/landscape_cmu/input_b.png" "$FIXTURES/seagull/input_b.png"
    cp "$FIXTURES/landscape_cmu/reference.png" "$FIXTURES/seagull/reference.png"
  fi
else
  echo "[demo] landscape_cmu fixtures already present, skipping download."
  [ ! -f "$FIXTURES/seagull/input_a.png" ] && \
    cp "$FIXTURES/landscape_cmu/input_a.png" "$FIXTURES/seagull/input_a.png" && \
    cp "$FIXTURES/landscape_cmu/input_b.png" "$FIXTURES/seagull/input_b.png" && \
    cp "$FIXTURES/landscape_cmu/reference.png" "$FIXTURES/seagull/reference.png"
fi

# ── Scene 2: Synthetic (wide crop → two overlapping halves → reference=original) ─
mkdir -p "$FIXTURES/synthetic_landscape"
if [ ! -f "$FIXTURES/synthetic_landscape/input_a.png" ]; then
  SRC_WIDE="$DOWNLOADS/CMU0/medium00.JPG"
  if [ -f "$SRC_WIDE" ]; then
    echo "[demo] Preparing synthetic landscape fixtures (CMU0 frame 0, crop overlap)..."
    W=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=width -of csv=p=0 "$SRC_WIDE")
    H=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=height -of csv=p=0 "$SRC_WIDE")
    OV=$((W * 60 / 100))
    OFF=$((W * 40 / 100))
    B_W=$((W - OFF))
    ffmpeg -y -i "$SRC_WIDE" -vf "crop=${OV}:${H}:0:0" "$FIXTURES/synthetic_landscape/input_a.png" 2>/dev/null
    ffmpeg -y -i "$SRC_WIDE" -vf "crop=${B_W}:${H}:${OFF}:0" "$FIXTURES/synthetic_landscape/input_b.png" 2>/dev/null
    ffmpeg -y -i "$SRC_WIDE" "$FIXTURES/synthetic_landscape/reference.png" 2>/dev/null
  fi
else
  echo "[demo] synthetic_landscape fixtures already present, skipping download."
fi

# ── Scene 3: Live-action (myself — real-world overlapping shots) ──────────────
mkdir -p "$FIXTURES/walking_tour"
if [ ! -f "$FIXTURES/walking_tour/input_a.png" ]; then
  SRC_LA="$DOWNLOADS/myself/medium05.jpg"
  SRC_LB="$DOWNLOADS/myself/medium06.jpg"
  if [ -f "$SRC_LA" ] && [ -f "$SRC_LB" ]; then
    echo "[demo] Preparing live-action fixtures (myself 05+06)..."
    ffmpeg -y -i "$SRC_LA" "$FIXTURES/walking_tour/input_a.png" 2>/dev/null
    ffmpeg -y -i "$SRC_LB" "$FIXTURES/walking_tour/input_b.png" 2>/dev/null
    cp "$FIXTURES/walking_tour/input_a.png" "$FIXTURES/walking_tour/reference.png"
  fi
else
  echo "[demo] walking_tour fixtures already present, skipping download."
fi

# ── Scene 4: Flower macro (repeating flower patterns, bokeh bg) ───────────────
mkdir -p "$FIXTURES/flower_landscape"
if [ ! -f "$FIXTURES/flower_landscape/input_a.png" ]; then
  SRC_F1="$DOWNLOADS/flower/1.jpg"
  SRC_F2="$DOWNLOADS/flower/2.jpg"
  if [ -f "$SRC_F1" ] && [ -f "$SRC_F2" ]; then
    echo "[demo] Preparing flower fixtures (1+2)..."
    ffmpeg -y -i "$SRC_F1" "$FIXTURES/flower_landscape/input_a.png" 2>/dev/null
    ffmpeg -y -i "$SRC_F2" "$FIXTURES/flower_landscape/input_b.png" 2>/dev/null
    cp "$FIXTURES/flower_landscape/input_a.png" "$FIXTURES/flower_landscape/reference.png"
  fi
else
  echo "[demo] flower_landscape fixtures already present, skipping download."
fi

# ── Scene 5: CMU1 (different CMU building exterior) ──────────────────────────
mkdir -p "$FIXTURES/cmu1"
if [ ! -f "$FIXTURES/cmu1/input_a.png" ]; then
  SRC_CMU1A="$DOWNLOADS/CMU1/medium00.jpg"
  SRC_CMU1B="$DOWNLOADS/CMU1/medium01.jpg"
  if [ -f "$SRC_CMU1A" ] && [ -f "$SRC_CMU1B" ]; then
    echo "[demo] Preparing CMU1 fixtures (medium00+01)..."
    ffmpeg -y -i "$SRC_CMU1A" "$FIXTURES/cmu1/input_a.png" 2>/dev/null
    ffmpeg -y -i "$SRC_CMU1B" "$FIXTURES/cmu1/input_b.png" 2>/dev/null
    cp "$FIXTURES/cmu1/input_a.png" "$FIXTURES/cmu1/reference.png"
  fi
else
  echo "[demo] cmu1 fixtures already present, skipping download."
fi

# ── Scene 6: UAV aerial footage (top-down drone shots) ───────────────────────
mkdir -p "$FIXTURES/uav"
if [ ! -f "$FIXTURES/uav/input_a.png" ]; then
  SRC_UAVA="$DOWNLOADS/uav/medium01.jpg"
  SRC_UAVB="$DOWNLOADS/uav/medium02.jpg"
  if [ -f "$SRC_UAVA" ] && [ -f "$SRC_UAVB" ]; then
    echo "[demo] Preparing UAV fixtures (medium01+02)..."
    ffmpeg -y -i "$SRC_UAVA" "$FIXTURES/uav/input_a.png" 2>/dev/null
    ffmpeg -y -i "$SRC_UAVB" "$FIXTURES/uav/input_b.png" 2>/dev/null
    cp "$FIXTURES/uav/input_a.png" "$FIXTURES/uav/reference.png"
  fi
else
  echo "[demo] uav fixtures already present, skipping download."
fi

# ── Scene 7: Zijing campus garden ────────────────────────────────────────────
mkdir -p "$FIXTURES/zijing"
if [ ! -f "$FIXTURES/zijing/input_a.png" ]; then
  SRC_ZJA="$DOWNLOADS/zijing/medium01.jpg"
  SRC_ZJB="$DOWNLOADS/zijing/medium02.jpg"
  if [ -f "$SRC_ZJA" ] && [ -f "$SRC_ZJB" ]; then
    echo "[demo] Preparing Zijing fixtures (medium01+02)..."
    ffmpeg -y -i "$SRC_ZJA" "$FIXTURES/zijing/input_a.png" 2>/dev/null
    ffmpeg -y -i "$SRC_ZJB" "$FIXTURES/zijing/input_b.png" 2>/dev/null
    cp "$FIXTURES/zijing/input_a.png" "$FIXTURES/zijing/reference.png"
  fi
else
  echo "[demo] zijing fixtures already present, skipping download."
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

# Helper: run all scenes, write results to $1 (output dir), log algo to $2 (manifest),
# optionally set FRAME_FORGE_MATCHER=$3 to force a specific matcher.
_run_scenes() {
  local out_dir="$1" manifest="$2" matcher="${3:-}"
  printf '{\n' > "$manifest"
  local _first=1
  for SCENE in landscape_cmu synthetic_landscape walking_tour flower_landscape cmu1 uav zijing; do
    DIR="$FIXTURES/$SCENE"
    [ -f "$DIR/input_a.png" ] || continue
    echo ""
    echo "[demo] === $SCENE ==="
    local OUT="$out_dir/${SCENE}_stitched.png"
    local TMPLOG; TMPLOG=$(mktemp)
    local FRAMES; FRAMES=$(ls "$DIR"/frame_*.png 2>/dev/null | sort | tr '\n' ' ')
    if [ -n "$FRAMES" ]; then
      # shellcheck disable=SC2086
      RUST_LOG=info FRAME_FORGE_MATCHER="$matcher" $FORGE stitch --input $FRAMES --output "$OUT" 2>&1 | tee "$TMPLOG"
    else
      RUST_LOG=info FRAME_FORGE_MATCHER="$matcher" $FORGE stitch --input "$DIR/input_a.png" "$DIR/input_b.png" --output "$OUT" 2>&1 | tee "$TMPLOG"
    fi
    # Extract final algorithm from forge log.
    # DL model name is inferred from the $matcher argument (empty = auto → LightGlue).
    local DL_MODEL_NAME=""
    case "$matcher" in
      "disabled") DL_MODEL_NAME="" ;;
      "efficient-loftr"|"loftr") DL_MODEL_NAME="EfficientLoFTR" ;;
      *) DL_MODEL_NAME="LightGlue v2" ;;
    esac
    # Match count from "[dl_match] N raw matches" log line.
    local DL_COUNT; DL_COUNT=$(grep -oP "\[dl_match\] \K\d+(?= raw matches)" "$TMPLOG" | head -1)

    local ALGO
    if grep -q "OpenCV Stitcher\|SIFT canvas too narrow" "$TMPLOG"; then
      # DL or AKAZE ran but final result used OpenCV Stitcher.
      if [ -n "$DL_MODEL_NAME" ] && [ -n "$DL_COUNT" ]; then
        ALGO="OpenCV Stitcher (${DL_MODEL_NAME}: ${DL_COUNT} kp)"
      else
        ALGO="OpenCV Stitcher"
      fi
    elif grep -q "\[landscape\] DL homography OK" "$TMPLOG"; then
      ALGO="${DL_MODEL_NAME} → warp_expand_blend"
    elif grep -q "\[landscape\] AKAZE homography OK" "$TMPLOG"; then
      ALGO="AKAZE → warp_expand_blend"
    else
      ALGO="AKAZE + USAC-MAGSAC"
    fi
    rm -f "$TMPLOG"
    [ "$_first" -eq 1 ] && _first=0 || printf ',\n' >> "$manifest"
    printf '  "%s": "%s"' "$SCENE" "$ALGO" >> "$manifest"
    echo "[demo] Output: $OUT  [algo: $ALGO]"
  done
  printf '\n}\n' >> "$manifest"
}

# ── Pass 1: Legacy (AKAZE-only, no DL model) ─────────────────────────────────
echo ""
echo "[demo] ====== Pass 1: Legacy AKAZE-only (FRAME_FORGE_MATCHER=disabled) ======"
_run_scenes "$OUTPUT_LEGACY" "$OUTPUT_LEGACY/rust_algo_manifest.json" "disabled"

# ── Pass 2: New (LightGlue v2 + fallback cascade) ────────────────────────────
echo ""
echo "[demo] ====== Pass 2: LightGlue v2 (new algorithm) ======"
_run_scenes "$OUTPUT" "$OUTPUT/rust_algo_manifest.json" ""

# ── Pass 3: EfficientLoFTR (explicit --model efficient-loftr) ────────────────
echo ""
echo "[demo] ====== Pass 3: EfficientLoFTR (FRAME_FORGE_MATCHER=efficient-loftr) ======"
_run_scenes "$OUTPUT_LOFTR" "$OUTPUT_LOFTR/rust_algo_manifest.json" "efficient-loftr"

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
echo "[demo] === score.py — Rust LightGlue stitches ==="
python3 "$SCORE_PY" "$FIXTURES" "$OUTPUT" 2>&1 | tee "$OUTPUT/scores.json" || true

echo ""
echo "[demo] === score.py — Rust AKAZE-legacy stitches ==="
python3 "$SCORE_PY" "$FIXTURES" "$OUTPUT_LEGACY" 2>&1 | tee "$OUTPUT_LEGACY/scores.json" || true

echo ""
echo "[demo] === score.py — Rust EfficientLoFTR stitches ==="
python3 "$SCORE_PY" "$FIXTURES" "$OUTPUT_LOFTR" 2>&1 | tee "$OUTPUT_LOFTR/scores.json" || true

echo ""
echo "[demo] === score.py — Python stitches ==="
python3 "$SCORE_PY" "$FIXTURES" "$OUTPUT_PY" 2>&1 | tee "$OUTPUT_PY/scores.json" || true

echo ""
echo "[demo] Done."
echo "  Rust LightGlue PNGs:   $OUTPUT/"
ls -lh "$OUTPUT/"
echo "  Rust AKAZE-legacy:     $OUTPUT_LEGACY/"
ls -lh "$OUTPUT_LEGACY/"
echo "  Rust EfficientLoFTR:   $OUTPUT_LOFTR/"
ls -lh "$OUTPUT_LOFTR/"
echo "  Python PNGs:           $OUTPUT_PY/"
ls -lh "$OUTPUT_PY/"

# ── Auto-generate HTML report ────────────────────────────────────────────────
GEN_REPORT=/workspace/tests/stitch-eval/gen_report.py
REPORT_HTML=/workspace/tests/stitch-eval/report.html
if [ -f "$GEN_REPORT" ]; then
  echo ""
  echo "[demo] Generating HTML report..."
  python3 "$GEN_REPORT" "$FIXTURES" "$OUTPUT" "$OUTPUT_LEGACY" "$OUTPUT_LOFTR" "$OUTPUT_PY" "$REPORT_HTML" 2>&1 || true
  echo "[demo] Report: $REPORT_HTML"
fi
