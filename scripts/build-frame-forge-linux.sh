#!/usr/bin/env bash
# Builds frame-forge-linux-x64 against the pre-built /opt/opencv-minimal
# (see scripts/build-opencv-minimal.sh) instead of apt's desktop-flavored
# libopencv-dev, and bakes an $ORIGIN rpath so the binary finds its bundled
# .so files without LD_LIBRARY_PATH. A second rpath entry points at the
# jellyfin-dev container's ffmpeg lib dir (present there, just not on the
# default linker search path) — no ffmpeg .so need to be bundled.
#
# Usage (called from Makefile/mise):
#   podman run --rm -v <workspace>:/workspace -v forge-cargo-home:/root/.cargo \
#     -v opencv-minimal-root:/opt/opencv-minimal -w /workspace ubuntu:24.04 \
#     bash scripts/build-frame-forge-linux.sh
set -e

OPENCV_PREFIX=/opt/opencv-minimal
NATIVE_DIR=packages/JellyfinSuite.Plugin/native-linux

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl build-essential pkg-config ca-certificates \
  software-properties-common clang libclang-dev libssl-dev
add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq
apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev
apt-get install -y -qq intel-opencl-icd clinfo ocl-icd-libopencl1 2>/dev/null || true
clinfo --list 2>/dev/null || echo "[build] no OpenCL platforms (CPU fallback)"

[ -f /root/.cargo/bin/rustup ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null
/root/.cargo/bin/rustup default stable 2>/dev/null || true

if [ -d "$OPENCV_PREFIX/lib/pkgconfig" ]; then
  OPENCV_PKGCONFIG="$OPENCV_PREFIX/lib/pkgconfig"
elif [ -d "$OPENCV_PREFIX/lib/x86_64-linux-gnu/pkgconfig" ]; then
  OPENCV_PKGCONFIG="$OPENCV_PREFIX/lib/x86_64-linux-gnu/pkgconfig"
else
  echo "[build] FATAL: no opencv4.pc found under $OPENCV_PREFIX — run build-opencv-minimal-linux first" >&2
  exit 1
fi
# Prepend (not replace) — ort's build script needs the system openssl.pc
# (libssl-dev, installed above) to remain discoverable for its ureq/native-tls
# download step.
export PKG_CONFIG_PATH="$OPENCV_PKGCONFIG:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/lib/pkgconfig"

export LIBCLANG_PATH=/usr/lib/llvm-18/lib
# $ORIGIN/native-linux keeps the bundled .so files out of the plugin dir root —
# they're deployed to that subdirectory alongside frame-forge-linux-x64.
export RUSTFLAGS="-C link-arg=-Wl,-rpath,\$ORIGIN/native-linux -C link-arg=-Wl,-rpath,/usr/lib/jellyfin-ffmpeg/lib"

/root/.cargo/bin/cargo build -p frame-forge --release --features opencv

cp target/release/frame-forge packages/JellyfinSuite.Plugin/frame-forge-linux-x64

# Bundle the .so closure that the target container (Debian trixie, no OpenCV
# at all) doesn't already ship. libc/libm/libstdc++/libgcc_s/ld-linux are
# assumed present on any glibc-based Linux and are deliberately NOT bundled.
mkdir -p "$NATIVE_DIR"
rm -f "$NATIVE_DIR"/*.so*
# The binary's rpath ($ORIGIN/native-linux) only resolves once native-linux/ is
# populated — chicken-and-egg at this point in the script — so LD_LIBRARY_PATH
# must be set explicitly here purely to let ldd resolve the opencv .so for
# collection. This does NOT get baked into the shipped binary.
OPENCV_LD_PATH="$OPENCV_PREFIX/lib:$OPENCV_PREFIX/lib/x86_64-linux-gnu"
for lib in $(LD_LIBRARY_PATH="$OPENCV_LD_PATH" ldd packages/JellyfinSuite.Plugin/frame-forge-linux-x64 | awk '{print $3}' | grep -E '^/opt/opencv-minimal/'); do
  real=$(readlink -f "$lib")
  cp -L "$real" "$NATIVE_DIR/$(basename "$lib")"
done

echo "[build] bundled native libs:"
ls -la "$NATIVE_DIR"
echo "[build] full dependency closure for review:"
LD_LIBRARY_PATH="$OPENCV_LD_PATH" ldd packages/JellyfinSuite.Plugin/frame-forge-linux-x64
