#!/usr/bin/env bash
# Fast `cargo check` for frame-forge against the pre-built /opt/opencv-minimal
# (see scripts/build-opencv-minimal.sh) — mirrors scripts/build-frame-forge-linux.sh's
# toolchain/pkg-config setup but skips linking/codegen, so it stays fast and must be
# run before every build-frame-forge-linux per CLAUDE.md's check-before-build rule.
#
# Usage (called from Makefile/mise):
#   podman run --rm -v <workspace>:/workspace -v forge-cargo-home:/root/.cargo \
#     -v opencv-minimal-root:/opt/opencv-minimal -w /workspace ubuntu:24.04 \
#     bash scripts/check-frame-forge-opencv-linux.sh
set -e

OPENCV_PREFIX=/opt/opencv-minimal

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl build-essential pkg-config ca-certificates \
  software-properties-common clang libclang-dev libssl-dev
add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq
apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev

[ -f /root/.cargo/bin/rustup ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null
/root/.cargo/bin/rustup default stable 2>/dev/null || true

if [ -d "$OPENCV_PREFIX/lib/pkgconfig" ]; then
  OPENCV_PKGCONFIG="$OPENCV_PREFIX/lib/pkgconfig"
elif [ -d "$OPENCV_PREFIX/lib/x86_64-linux-gnu/pkgconfig" ]; then
  OPENCV_PKGCONFIG="$OPENCV_PREFIX/lib/x86_64-linux-gnu/pkgconfig"
else
  echo "[check] FATAL: no opencv4.pc found under $OPENCV_PREFIX — run build-opencv-minimal-linux first" >&2
  exit 1
fi
# Prepend (not replace) — ort's build script needs the system openssl.pc to stay discoverable.
export PKG_CONFIG_PATH="$OPENCV_PKGCONFIG:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/lib/pkgconfig"

export LIBCLANG_PATH=/usr/lib/llvm-18/lib
/root/.cargo/bin/cargo check -p frame-forge --features 'cli,opencv'
