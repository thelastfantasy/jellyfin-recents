#!/usr/bin/env bash
# GPU stitch verification pass — proves DL matching actually runs on the CUDA EP
# rather than silently falling back to CPU (see specs/012-ort-gpu-model-ui/research.md
# for the two hangs found and fixed while building this: the Blackwell/ORT-1.26.0
# "gpu" build hang, fixed by using the gpu_cuda13 build; and a GPU-flavored ORT build
# hanging on CPU-only session creation, fixed by registering CPUExecutionProvider
# explicitly in build_ep_session's make_cpu()).
#
# Requires: GPU passthrough (podman --device nvidia.com/gpu=all / docker --gpus all)
# and a container with matching CUDA 13 runtime + cuDNN 9 libs, e.g.:
#   nvidia/cuda:13.1.2-cudnn-runtime-ubuntu24.04
#
# Usage (called from Makefile/mise):
#   podman run --rm --device nvidia.com/gpu=all -v <workspace>:/workspace -w /workspace \
#     -v forge-cargo-home:/root/.cargo nvidia/cuda:13.1.2-cudnn-runtime-ubuntu24.04 \
#     bash tests/stitch-eval/run_demo_gpu.sh
set -e

FIXTURES=/workspace/tests/stitch-eval/fixtures
OUTPUT_GPU=/workspace/tests/stitch-eval/demo-output-gpu
SCORE_PY=/workspace/tests/stitch-eval/score.py
ORT_DIR=/workspace/.cache/ort-gpu-cuda13
mkdir -p "$OUTPUT_GPU" "$ORT_DIR"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl build-essential pkg-config ca-certificates \
  software-properties-common clang libclang-dev ffmpeg \
  libopencv-dev python3-pip python3-pil libssl-dev 2>/dev/null
add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq
apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev
apt-get install -y -qq python3-numpy python3-opencv 2>/dev/null || true
pip3 install --quiet Pillow numpy opencv-python-headless 2>/dev/null || true

[ -f /root/.cargo/bin/rustup ] || \
  (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null)
/root/.cargo/bin/rustup default stable 2>/dev/null || true

# ── Fetch CUDA-13-flavored ORT build (cached across runs) ───────────────────
# The plain "gpu" tarball (CUDA 12) hangs/silently CPU-falls-back on Blackwell
# (RTX 50-series, sm_120) GPUs under ORT 1.26.0 — the gpu_cuda13 variant has
# working Blackwell kernels. Adjust ORT_VERSION if a newer release is verified.
ORT_VERSION="1.26.0"
if [ ! -f "$ORT_DIR/lib/libonnxruntime.so" ]; then
  echo "[gpu-demo] Downloading onnxruntime-linux-x64-gpu_cuda13-${ORT_VERSION}..."
  curl -fL --retry 3 --connect-timeout 30 \
    "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-linux-x64-gpu_cuda13-${ORT_VERSION}.tgz" \
    -o /tmp/ort-cuda13.tgz
  tar xzf /tmp/ort-cuda13.tgz -C "$ORT_DIR" --strip-components=1
  rm -f /tmp/ort-cuda13.tgz
else
  echo "[gpu-demo] ORT cuda13 build already cached: $ORT_DIR"
fi
export ORT_DYLIB_PATH="$ORT_DIR/lib/libonnxruntime.so"
export LD_LIBRARY_PATH="$ORT_DIR/lib:${LD_LIBRARY_PATH:-}"

MODELS_DIR=/workspace/models
if [ ! -f "$MODELS_DIR/superpoint_lightglue_pipeline.onnx" ] || [ ! -f "$MODELS_DIR/eloftr_640x480.onnx" ]; then
  echo "[gpu-demo] ERROR: models/ missing — run run_demo.sh once first to download DL models, or place them manually." >&2
  exit 1
fi

echo "[gpu-demo] nvidia-smi snapshot before run:"
nvidia-smi --query-gpu=name,driver_version,compute_cap,memory.used --format=csv,noheader || true

echo "[gpu-demo] Cleaning frame-forge cache (Windows NTFS mtime workaround)..."
/root/.cargo/bin/cargo clean -p frame-forge 2>/dev/null || true
echo "[gpu-demo] Building forge (cli + opencv features)..."
LIBCLANG_PATH=/usr/lib/llvm-18/lib \
  /root/.cargo/bin/cargo build -p frame-forge --features "cli,opencv" --release
FORGE=/workspace/target/release/forge

# ── Run all scenes on cuda:0, recording EP + fallback_events + timing per scene ──
MANIFEST="$OUTPUT_GPU/gpu_verification_manifest.json"
printf '{\n' > "$MANIFEST"
_first=1
ANY_FALLBACK=0
for SCENE in landscape_cmu synthetic_landscape walking_tour flower_landscape cmu1 uav zijing; do
  DIR="$FIXTURES/$SCENE"
  [ -f "$DIR/input_a.png" ] || continue
  echo ""
  echo "[gpu-demo] === $SCENE (--device cuda:0) ==="
  OUT="$OUTPUT_GPU/${SCENE}_stitched.png"
  TMPLOG=$(mktemp)
  T0=$(date +%s%N)
  RUST_LOG=info "$FORGE" stitch --device cuda:0 \
    --input "$DIR/input_a.png" "$DIR/input_b.png" --output "$OUT" 2>&1 | tee "$TMPLOG"
  T1=$(date +%s%N)
  ELAPSED_MS=$(( (T1 - T0) / 1000000 ))

  EP_LINE=$(grep -oP '\[forge\] device=\S+ model=\S+ fallback_events=\K.*' "$TMPLOG" | head -1)
  EP_USED=$(grep -oP '\[dl_match\] \w+ (?:v2 )?loaded \(ep=\K[^)]+' "$TMPLOG" | head -1)
  [ -z "$EP_USED" ] && EP_USED="unknown"
  if [ "$EP_LINE" != "[]" ]; then ANY_FALLBACK=1; fi
  rm -f "$TMPLOG"

  [ "$_first" -eq 1 ] && _first=0 || printf ',\n' >> "$MANIFEST"
  printf '  "%s": {"ep_used": "%s", "fallback_events": %s, "elapsed_ms": %d}' \
    "$SCENE" "$EP_USED" "${EP_LINE:-[]}" "$ELAPSED_MS" >> "$MANIFEST"
  echo "[gpu-demo] $SCENE: ep=$EP_USED fallback=${EP_LINE:-[]} elapsed=${ELAPSED_MS}ms"
done
printf '\n}\n' >> "$MANIFEST"

echo ""
echo "[gpu-demo] nvidia-smi snapshot after run:"
nvidia-smi --query-gpu=name,memory.used,utilization.gpu --format=csv,noheader || true

echo ""
echo "[gpu-demo] === score.py — GPU (cuda:0) stitches ==="
python3 "$SCORE_PY" "$FIXTURES" "$OUTPUT_GPU" 2>&1 | tee "$OUTPUT_GPU/scores.json" || true

echo ""
if [ "$ANY_FALLBACK" -eq 1 ]; then
  echo "[gpu-demo] WARNING: at least one scene recorded a GPU→CPU fallback_event — GPU EP was NOT used for that scene. See $MANIFEST"
else
  echo "[gpu-demo] OK: zero fallback_events across all scenes — every scene's DL matching ran on ep=cuda:0, confirmed by ONNX Runtime, not assumed."
fi
echo "[gpu-demo] Manifest: $MANIFEST"
echo "[gpu-demo] Output:   $OUTPUT_GPU/"
ls -lh "$OUTPUT_GPU/"

# ── Merge into the main HTML report if the CPU passes have already been run ──
GEN_REPORT=/workspace/tests/stitch-eval/gen_report.py
REPORT_HTML=/workspace/tests/stitch-eval/report.html
OUTPUT=/workspace/tests/stitch-eval/demo-output
OUTPUT_LEGACY=/workspace/tests/stitch-eval/demo-output-legacy
OUTPUT_LOFTR=/workspace/tests/stitch-eval/demo-output-loftr
OUTPUT_PY=/workspace/tests/stitch-eval/demo-output-py
if [ -f "$GEN_REPORT" ] && [ -d "$OUTPUT" ] && [ -d "$OUTPUT_LEGACY" ] && [ -d "$OUTPUT_LOFTR" ] && [ -d "$OUTPUT_PY" ]; then
  echo ""
  echo "[gpu-demo] Regenerating HTML report (with GPU column)..."
  python3 "$GEN_REPORT" "$FIXTURES" "$OUTPUT" "$OUTPUT_LEGACY" "$OUTPUT_LOFTR" "$OUTPUT_PY" "$REPORT_HTML" "$OUTPUT_GPU" 2>&1 || true
  echo "[gpu-demo] Report: $REPORT_HTML"
else
  echo ""
  echo "[gpu-demo] Skipping HTML report merge — run 'mise run demo-stitch-linux' first to populate the CPU-pass output dirs."
fi
