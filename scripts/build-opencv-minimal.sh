#!/usr/bin/env bash
# Compiles a headless, dependency-trimmed OpenCV into /opt/opencv-minimal.
# Runs inside the frame-forge Docker build container (ubuntu:24.04), with
# /opt/opencv-minimal backed by a persistent podman/docker volume so this
# only needs to run again when bumping OPENCV_VERSION below.
#
# Why trimmed: Ubuntu's `libopencv-dev` apt package is built for desktop use
# (GTK/Qt/OpenGL/X11 all ON), which drags ~20MB of GUI-stack .so files into a
# headless server binary that never opens a window. WITH_LAPACK is also OFF
# here — OpenCV falls back to its own internal linear algebra for the small
# matrices frame-forge solves (homography via calib3d::find_homography), so
# this is correctness-neutral and drops liblapack/libblas/libgfortran (~11MB).
# WITH_PROTOBUF stays ON: opencv::objdetect's FaceDetectorYN (ONNX model)
# requires it for parsing, despite the model format not being protobuf itself.
#
# CMAKE_INSTALL_RPATH=$ORIGIN: without this, OpenCV's own .so files ship with
# no RPATH at all. frame-forge's $ORIGIN/native-linux rpath only resolves its
# OWN direct NEEDED entries (e.g. objdetect, core, imgproc) — it does NOT
# propagate to objdetect.so's transitive dependency on dnn.so (used internally
# by FaceDetectorYN), since that lookup happens against objdetect.so's own
# (empty) rpath, not frame-forge's. Baking $ORIGIN into every OpenCV lib makes
# each one self-sufficient: it finds sibling .so files in whatever directory
# it itself ends up in (native-linux/), regardless of who loaded it.
#
# Usage (called from Makefile/mise):
#   podman run --rm -v <workspace>:/workspace -v opencv-minimal-root:/opt/opencv-minimal \
#     -w /workspace ubuntu:24.04 bash scripts/build-opencv-minimal.sh
set -e

OPENCV_VERSION=4.10.0
PREFIX=/opt/opencv-minimal

if [ -f "$PREFIX/lib/pkgconfig/opencv4.pc" ] || [ -f "$PREFIX/lib/x86_64-linux-gnu/pkgconfig/opencv4.pc" ]; then
  echo "[opencv-minimal] already built at $PREFIX (OpenCV $OPENCV_VERSION) — skipping. Remove the opencv-minimal-root volume to force a rebuild."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential cmake git pkg-config ca-certificates python3

rm -rf /tmp/opencv
git clone --branch "$OPENCV_VERSION" --depth 1 https://github.com/opencv/opencv.git /tmp/opencv
mkdir -p /tmp/opencv/build
cd /tmp/opencv/build

cmake -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX="$PREFIX" \
      -DBUILD_SHARED_LIBS=ON \
      -DOPENCV_GENERATE_PKGCONFIG=ON \
      -DCMAKE_INSTALL_RPATH='$ORIGIN' \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
      -DWITH_GTK=OFF -DWITH_QT=OFF -DWITH_OPENGL=OFF -DWITH_WIN32UI=OFF \
      -DWITH_1394=OFF -DWITH_GSTREAMER=OFF -DWITH_V4L=OFF -DWITH_FFMPEG=OFF \
      -DWITH_LAPACK=OFF \
      -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_DOCS=OFF \
      -DBUILD_opencv_apps=OFF -DBUILD_opencv_python2=OFF -DBUILD_opencv_python3=OFF \
      -DBUILD_opencv_java=OFF \
      ..

make -j"$(nproc)"
make install
ldconfig -N "$PREFIX/lib" 2>/dev/null || true

echo "[opencv-minimal] installed to $PREFIX"
find "$PREFIX/lib" -maxdepth 1 -name '*.so*' | sort
