#!/usr/bin/env bash
# Generate 4 horizontally-offset sub-images from a reference image for Phase Correlation tests.
# Usage: ./gen_synthetic.sh [offset_px] [reference_image]
#   offset_px       — horizontal offset between frames (default: 100)
#   reference_image — source PNG/JPG (default: ./reference.png next to this script)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures/scene_a"
OFFSET="${1:-100}"
REF="${2:-$SCRIPT_DIR/reference.png}"

if [ ! -f "$REF" ]; then
  echo "ERROR: reference image not found: $REF"
  echo "Provide a reference image as the second argument, e.g.:"
  echo "  $0 100 /path/to/frame.png"
  exit 1
fi

mkdir -p "$FIXTURES_DIR"

WIDTH=$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=width -of csv=p=0 "$REF")
HEIGHT=$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=height -of csv=p=0 "$REF")
CROP_W=$(( WIDTH - 4 * OFFSET ))

if [ "$CROP_W" -le 0 ]; then
  echo "ERROR: image too narrow for offset=${OFFSET}px (width=${WIDTH}, need > $((4 * OFFSET)))"
  exit 1
fi

for i in 0 1 2 3; do
  X=$(( i * OFFSET ))
  ffmpeg -y -i "$REF" \
    -vf "crop=${CROP_W}:${HEIGHT}:${X}:0" \
    "$FIXTURES_DIR/frame_${i}.png" \
    -loglevel error
done

echo "Generated frames 0-3 in $FIXTURES_DIR"
echo "  offset=${OFFSET}px  crop_w=${CROP_W}px  height=${HEIGHT}px"
