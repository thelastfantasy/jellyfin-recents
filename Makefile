# Global shell: bash (used by all existing targets)
SHELL       := bash
.SHELLFLAGS := -c

# DEPLOY_WORKDIR: Windows-style forward-slash path for PowerShell-native deploy
ifeq ($(OS),Windows_NT)
  DEPLOY_WORKDIR := $(subst \,/,$(CURDIR))
else
  DEPLOY_WORKDIR := $(CURDIR)
  export PATH  := /c/Program Files/nodejs:$(PATH)
endif

.PHONY: build-frontend build-plugin build-poster-gen build-poster-gen-win build-seek-preview build-frame-forge \
        check-seek-preview check-frame-forge check-frame-forge-opencv demo-stitch \
        build update deploy update-quick deploy-enhancer clean test test-rust test-frontend test-csharp workflow-test workflow-test-release \
        build-poster-gen-linux build-seek-preview-linux build-frame-forge-linux \
        check-seek-preview-linux check-frame-forge-linux check-frame-forge-opencv-linux \
        demo-stitch-linux demo-stitch-gpu-linux build-linux update-linux \
        build-opencv-minimal-linux

build-frontend:
	cd apps/frontend && DEPLOY_MAP=1 pnpm run build

build-enhancer:
	cd apps/player-enhancer && pnpm install && DEPLOY_MAP=1 pnpm run build

# Build Linux Rust binary via Docker (cross 在 Windows 上有工具链检测 bug，改用 docker run 直接编译)
build-poster-gen:
	MSYS_NO_PATHCONV=1 docker run --rm \
		-v "$$(cygpath -m $(CURDIR)):/workspace" \
		-w /workspace \
		rust:1.88-slim-bookworm \
		cargo build -p poster-gen --release
	cp target/release/poster-gen \
		packages/JellyfinSuite.Plugin/poster-gen-linux-x64

# Build seek-preview Linux binary via Docker.
# Uses Ubuntu 24.04 + ppa:ubuntuhandbook1/ffmpeg7 to get FFmpeg 7.x dev headers,
# matching the jellyfin-ffmpeg7 runtime (.so.61) in the Jellyfin container.
# Rust toolchain is cached in a named Docker volume (seek-cargo-home) across builds.
build-seek-preview:
	docker volume create seek-cargo-home > /dev/null 2>&1 || true
	docker volume create seek-rustup-home > /dev/null 2>&1 || true
	MSYS_NO_PATHCONV=1 docker run --rm \
		-v "$$(cygpath -m $(CURDIR)):/workspace" \
		-v seek-cargo-home:/root/.cargo \
		-v seek-rustup-home:/root/.rustup \
		-w /workspace \
		ubuntu:24.04 \
		sh -c "DEBIAN_FRONTEND=noninteractive && \
		       apt-get update -qq && \
		       apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang && \
		       add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && \
		       apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && \
		       [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && \
		       /root/.cargo/bin/rustup default stable 2>/dev/null || true && \
		       /root/.cargo/bin/cargo build -p seek-preview --release"
	cp target/release/seek-preview \
		packages/JellyfinSuite.Plugin/seek-preview-linux-x64

# Build frame-forge Linux binary via Docker (no opencv — Jellyfin container doesn't ship it).
build-frame-forge:
	docker volume create forge-cargo-home > /dev/null 2>&1 || true
	MSYS_NO_PATHCONV=1 docker run --rm \
		-v "$$(cygpath -m $(CURDIR)):/workspace" \
		-v forge-cargo-home:/root/.cargo \
		-w /workspace \
		ubuntu:24.04 \
		sh -c "DEBIAN_FRONTEND=noninteractive && \
		       apt-get update -qq && \
		       apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang libclang-dev libopencv-dev && \
		       add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && \
		       apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && \
		       apt-get install -y -qq intel-opencl-icd clinfo ocl-icd-libopencl1 2>/dev/null || true && \
		       clinfo --list 2>/dev/null || echo '[build] no OpenCL platforms (CPU fallback)' && \
		       [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && \
		/root/.cargo/bin/rustup default stable 2>/dev/null || true && \
		LIBCLANG_PATH=/usr/lib/llvm-18/lib /root/.cargo/bin/cargo build -p frame-forge --release --features opencv"
	cp target/release/frame-forge \
		packages/JellyfinSuite.Plugin/frame-forge-linux-x64

# Build Windows Rust binary natively (run on Windows where cargo targets Windows by default)
build-poster-gen-win:
	cd crates/poster-gen && cargo build --release
	cp target/release/poster-gen.exe \
		packages/JellyfinSuite.Plugin/poster-gen-win-x64.exe

build-plugin:
	dotnet build packages/JellyfinSuite.Plugin -c Debug --output build/plugin

build: build-frontend build-enhancer build-plugin build-seek-preview build-frame-forge

update: build-poster-gen build
	MSYS_NO_PATHCONV=1 docker cp build/plugin/JellyfinSuite.Plugin.dll \
		jellyfin-dev:/config/plugins/JellyfinSuite/JellyfinSuite.Plugin.dll
	MSYS_NO_PATHCONV=1 docker cp build/plugin/poster-gen-linux-x64 \
		jellyfin-dev:/config/plugins/JellyfinSuite/poster-gen-linux-x64
	MSYS_NO_PATHCONV=1 docker cp packages/JellyfinSuite.Plugin/seek-preview-linux-x64 \
		jellyfin-dev:/config/plugins/JellyfinSuite/seek-preview-linux-x64
	MSYS_NO_PATHCONV=1 docker cp packages/JellyfinSuite.Plugin/frame-forge-linux-x64 \
		jellyfin-dev:/config/plugins/JellyfinSuite/frame-forge-linux-x64
	MSYS_NO_PATHCONV=1 docker cp packages/JellyfinSuite.Plugin/Web/jellyfin-suite-enhancer.js \
		jellyfin-dev:/config/plugins/JellyfinSuite/jellyfin-suite-enhancer.js
	MSYS_NO_PATHCONV=1 docker cp packages/JellyfinSuite.Plugin/meta.json \
		jellyfin-dev:/config/plugins/JellyfinSuite/meta.json
	docker restart jellyfin-dev
	@echo "Waiting for Jellyfin to start..."
	@sleep 20
	@MSYS_NO_PATHCONV=1 docker exec jellyfin-dev \
		curl -s -o /dev/null -w "Health check: %{http_code}\n" http://localhost:8096/health

# ── PowerShell-native deploy ──────────────────────────────────────────────────
# Prefer `mise run deploy` which runs pwsh directly (bypassing make shell issues).
deploy:
	@echo "Use 'mise run deploy' instead (make shell on Windows cannot run pwsh commands)."

# Quick update: rebuild frontend + enhancer + C# only, skip Rust builds
update-quick:
	make build-frontend
	make build-enhancer
	make build-plugin
	MSYS_NO_PATHCONV=1 docker cp build/plugin/JellyfinSuite.Plugin.dll \
		jellyfin-dev:/config/plugins/JellyfinSuite/JellyfinSuite.Plugin.dll
	MSYS_NO_PATHCONV=1 docker cp packages/JellyfinSuite.Plugin/Web/jellyfin-suite-enhancer.js \
		jellyfin-dev:/config/plugins/JellyfinSuite/jellyfin-suite-enhancer.js
	MSYS_NO_PATHCONV=1 docker cp packages/JellyfinSuite.Plugin/meta.json \
		jellyfin-dev:/config/plugins/JellyfinSuite/meta.json
	docker restart jellyfin-dev
	@echo "Waiting for Jellyfin to start..."
	@sleep 20
	@MSYS_NO_PATHCONV=1 docker exec jellyfin-dev \
		curl -s -o /dev/null -w "Health check: %{http_code}\n" http://localhost:8096/health

# Quick deploy: rebuild enhancer JS only, copy to container. No restart needed.
deploy-enhancer:
	cd apps/player-enhancer && pnpm run build
	MSYS_NO_PATHCONV=1 docker cp packages/JellyfinSuite.Plugin/Web/jellyfin-suite-enhancer.js \
		jellyfin-dev:/config/plugins/JellyfinSuite/jellyfin-suite-enhancer.js
	@echo "Enhancer deployed — reload browser to pick up changes"

# Quick type-check seek-preview in Docker (no binary produced, much faster than build)
check-seek-preview:
	docker volume create seek-cargo-home > /dev/null 2>&1 || true
	docker volume create seek-rustup-home > /dev/null 2>&1 || true
	MSYS_NO_PATHCONV=1 docker run --rm \
		-v "$$(cygpath -m $(CURDIR)):/workspace" \
		-v seek-cargo-home:/root/.cargo \
		-v seek-rustup-home:/root/.rustup \
		-w /workspace \
		ubuntu:24.04 \
		sh -c "DEBIAN_FRONTEND=noninteractive && \
		       apt-get update -qq && \
		       apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang && \
		       add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && \
		       apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && \
		       [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && \
		       /root/.cargo/bin/rustup default stable 2>/dev/null || true && \
		       /root/.cargo/bin/cargo check -p seek-preview"

# Quick type-check frame-forge in Docker (no binary produced, much faster than build)
check-frame-forge:
	docker volume create forge-cargo-home > /dev/null 2>&1 || true
	MSYS_NO_PATHCONV=1 docker run --rm \
		-v "$$(cygpath -m $(CURDIR)):/workspace" \
		-v forge-cargo-home:/root/.cargo \
		-w /workspace \
		ubuntu:24.04 \
		sh -c "DEBIAN_FRONTEND=noninteractive && \
		       apt-get update -qq && \
		       apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang libclang-dev && \
		       add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && \
		       apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && \
		       [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && \
		/root/.cargo/bin/rustup default stable 2>/dev/null || true && \
		LIBCLANG_PATH=/usr/lib/llvm-18/lib /root/.cargo/bin/cargo check -p frame-forge --all-targets --features cli"

check-frame-forge-opencv:
	docker volume create forge-cargo-home > /dev/null 2>&1 || true
	MSYS_NO_PATHCONV=1 docker run --rm \
		-v "$$(cygpath -m $(CURDIR)):/workspace" \
		-v forge-cargo-home:/root/.cargo \
		-w /workspace \
		ubuntu:24.04 \
		sh -c "DEBIAN_FRONTEND=noninteractive && \
		       apt-get update -qq && \
		       apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang libclang-dev libopencv-dev libssl-dev && \
		       add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && \
		       apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && \
		       [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && \
		/root/.cargo/bin/rustup default stable 2>/dev/null || true && \
		LIBCLANG_PATH=/usr/lib/llvm-18/lib /root/.cargo/bin/cargo check -p frame-forge --features 'cli,opencv'"

# Run stitch quality demo: build forge (cli+opencv), create fixtures, stitch, score.
# Requires OpenPano example data in tests/stitch-eval/downloads/example-data/.
demo-stitch:
	docker volume create forge-cargo-home > /dev/null 2>&1 || true
	MSYS_NO_PATHCONV=1 docker run --rm \
		-v "$$(cygpath -m $(CURDIR)):/workspace" \
		-v forge-cargo-home:/root/.cargo \
		-w /workspace \
		ubuntu:24.04 \
		bash tests/stitch-eval/run_demo.sh

# ── Tests ────────────────────────────────────────────────────────────────────

test-rust:
	cd crates/poster-gen && cargo test
	@if [ "$$(uname -s 2>/dev/null)" = "Linux" ]; then \
		(cd crates/jfs-common && cargo test) && \
		(cd crates/seek-preview && cargo test) && \
		(cd crates/frame-forge && cargo test); \
	else \
		echo "[jfs-common] Skipping tests (Linux-only)"; \
		echo "[seek-preview] Skipping tests (Linux-only)"; \
		echo "[frame-forge] Skipping tests (Linux-only)"; \
	fi

test-frontend:
	cd apps/frontend && bun test ../../tests/frontend/

test-csharp:
	# dotnet's CopyToOutputDirectory=PreserveNewest sometimes hardlinks rather than copies
	# poster-gen-linux-x64/seek-preview-linux-x64/frame-forge-linux-x64 into the test project's
	# bin dir; after a Rust rebuild replaces the source inode, the stale hardlinked copy is left
	# behind read-only and `dotnet test` fails trying to overwrite it. Removing it first forces
	# a fresh copy every run instead of relying on the (broken) up-to-date check.
	rm -f tests/JellyfinSuite.Tests/bin/Debug/net9.0/poster-gen-linux-x64 \
	      tests/JellyfinSuite.Tests/bin/Debug/net9.0/seek-preview-linux-x64 \
	      tests/JellyfinSuite.Tests/bin/Debug/net9.0/frame-forge-linux-x64
	dotnet test tests/JellyfinSuite.Tests

# Run all test suites sequentially; fail fast on first error
test: test-rust test-frontend test-csharp

workflow-test:
	act -W .github/workflows/build.yml \
		-P ubuntu-latest=catthehacker/ubuntu:act-latest

# Release workflow：构建步骤可测，GitHub Release/Pages 步骤因需真实 token 会失败（属正常）
# gh auth token 仅用于拉取 Action 定义（公开仓库），Release/Pages 上传因 local repo 而失败属预期
workflow-test-release:
	act push -W .github/workflows/release.yml \
		-P ubuntu-latest=catthehacker/ubuntu:act-latest \
		-e .github/act-events/tag-push.json \
		--secret GITHUB_TOKEN=$$(gh auth token) \
		--env GITHUB_REF=refs/tags/v0.0.0-test \
		--env GITHUB_REPOSITORY=local/jellyfin-suite

clean:
	rm -rf build/
	cd apps/frontend && rm -rf dist/
	cd crates/poster-gen && cargo clean

# ── Linux-native targets (Podman/Docker, no cygpath) ─────────────────────────
# 专供 Linux 开发机使用，自动检测 podman/docker，无需 cygpath。
# Windows 开发机继续使用上面不带 -linux 后缀的原始 target。

_CRUN := $(shell which podman 2>/dev/null || which docker 2>/dev/null || echo docker)

build-poster-gen-linux:
	$(_CRUN) run --rm \
		-v "$(CURDIR):/workspace" \
		-w /workspace \
		rust:1.88-slim-bookworm \
		cargo build -p poster-gen --release
	cp target/release/poster-gen \
		packages/JellyfinSuite.Plugin/poster-gen-linux-x64
	chmod u+w packages/JellyfinSuite.Plugin/poster-gen-linux-x64

build-seek-preview-linux:
	$(_CRUN) volume create seek-cargo-home > /dev/null 2>&1 || true
	$(_CRUN) volume create seek-rustup-home > /dev/null 2>&1 || true
	$(_CRUN) run --rm \
		-v "$(CURDIR):/workspace" \
		-v seek-cargo-home:/root/.cargo \
		-v seek-rustup-home:/root/.rustup \
		-w /workspace \
		ubuntu:24.04 \
		sh -c "DEBIAN_FRONTEND=noninteractive && \
		       apt-get update -qq && \
		       apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang && \
		       add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && \
		       apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && \
		       [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && \
		       /root/.cargo/bin/rustup default stable 2>/dev/null || true && \
		       /root/.cargo/bin/cargo build -p seek-preview --release"
	cp target/release/seek-preview \
		packages/JellyfinSuite.Plugin/seek-preview-linux-x64

# Compiles a headless, dependency-trimmed OpenCV (no GTK/Qt/OpenGL/X11/LAPACK)
# into the opencv-minimal-root volume. One-time cost — only rerun after
# bumping OPENCV_VERSION in the script or deleting the volume. See
# scripts/build-opencv-minimal.sh for the rationale.
build-opencv-minimal-linux:
	$(_CRUN) volume create opencv-minimal-root > /dev/null 2>&1 || true
	$(_CRUN) run --rm \
		-v "$(CURDIR):/workspace" \
		-v opencv-minimal-root:/opt/opencv-minimal \
		-w /workspace \
		ubuntu:24.04 \
		bash scripts/build-opencv-minimal.sh

build-frame-forge-linux: build-opencv-minimal-linux
	$(_CRUN) volume create forge-cargo-home > /dev/null 2>&1 || true
	$(_CRUN) run --rm \
		-v "$(CURDIR):/workspace" \
		-v forge-cargo-home:/root/.cargo \
		-v opencv-minimal-root:/opt/opencv-minimal \
		-w /workspace \
		ubuntu:24.04 \
		bash scripts/build-frame-forge-linux.sh

check-seek-preview-linux:
	$(_CRUN) volume create seek-cargo-home > /dev/null 2>&1 || true
	$(_CRUN) volume create seek-rustup-home > /dev/null 2>&1 || true
	$(_CRUN) run --rm \
		-v "$(CURDIR):/workspace" \
		-v seek-cargo-home:/root/.cargo \
		-v seek-rustup-home:/root/.rustup \
		-w /workspace \
		ubuntu:24.04 \
		sh -c "DEBIAN_FRONTEND=noninteractive && \
		       apt-get update -qq && \
		       apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang && \
		       add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && \
		       apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && \
		       [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && \
		       /root/.cargo/bin/rustup default stable 2>/dev/null || true && \
		       /root/.cargo/bin/cargo check -p seek-preview"

check-frame-forge-linux:
	$(_CRUN) volume create forge-cargo-home > /dev/null 2>&1 || true
	$(_CRUN) run --rm \
		-v "$(CURDIR):/workspace" \
		-v forge-cargo-home:/root/.cargo \
		-w /workspace \
		ubuntu:24.04 \
		sh -c "DEBIAN_FRONTEND=noninteractive && \
		       apt-get update -qq && \
		       apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang libclang-dev && \
		       add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && \
		       apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && \
		       [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && \
		/root/.cargo/bin/rustup default stable 2>/dev/null || true && \
		LIBCLANG_PATH=/usr/lib/llvm-18/lib /root/.cargo/bin/cargo check -p frame-forge --all-targets --features cli"

check-frame-forge-opencv-linux: build-opencv-minimal-linux
	$(_CRUN) volume create forge-cargo-home > /dev/null 2>&1 || true
	$(_CRUN) run --rm \
		-v "$(CURDIR):/workspace" \
		-v forge-cargo-home:/root/.cargo \
		-v opencv-minimal-root:/opt/opencv-minimal \
		-w /workspace \
		ubuntu:24.04 \
		bash scripts/check-frame-forge-opencv-linux.sh

demo-stitch-linux:
	$(_CRUN) volume create forge-cargo-home > /dev/null 2>&1 || true
	$(_CRUN) run --rm \
		-v "$(CURDIR):/workspace" \
		-v forge-cargo-home:/root/.cargo \
		-w /workspace \
		ubuntu:24.04 \
		bash tests/stitch-eval/run_demo.sh

# GPU verification pass — requires nvidia-container-toolkit + CDI set up on the host
# (see /home/jade/setup-nvidia-container.sh) so --device nvidia.com/gpu=all resolves.
demo-stitch-gpu-linux:
	$(_CRUN) volume create forge-cargo-home > /dev/null 2>&1 || true
	$(_CRUN) run --rm \
		--device nvidia.com/gpu=all \
		-v "$(CURDIR):/workspace" \
		-v forge-cargo-home:/root/.cargo \
		-w /workspace \
		docker.io/nvidia/cuda:13.1.2-cudnn-runtime-ubuntu24.04 \
		bash tests/stitch-eval/run_demo_gpu.sh

build-linux: build-frontend build-enhancer build-plugin build-seek-preview-linux build-frame-forge-linux

update-linux: build-poster-gen-linux build-linux
	$(_CRUN) cp build/plugin/JellyfinSuite.Plugin.dll \
		jellyfin-dev:/config/plugins/JellyfinSuite/JellyfinSuite.Plugin.dll
	$(_CRUN) cp build/plugin/poster-gen-linux-x64 \
		jellyfin-dev:/config/plugins/JellyfinSuite/poster-gen-linux-x64
	$(_CRUN) cp packages/JellyfinSuite.Plugin/seek-preview-linux-x64 \
		jellyfin-dev:/config/plugins/JellyfinSuite/seek-preview-linux-x64
	$(_CRUN) cp packages/JellyfinSuite.Plugin/frame-forge-linux-x64 \
		jellyfin-dev:/config/plugins/JellyfinSuite/frame-forge-linux-x64
	$(_CRUN) exec jellyfin-dev mkdir -p /config/plugins/JellyfinSuite/native-linux
	$(_CRUN) cp packages/JellyfinSuite.Plugin/native-linux/. \
		jellyfin-dev:/config/plugins/JellyfinSuite/native-linux/
	$(_CRUN) cp packages/JellyfinSuite.Plugin/Web/jellyfin-suite-enhancer.js \
		jellyfin-dev:/config/plugins/JellyfinSuite/jellyfin-suite-enhancer.js
	$(_CRUN) cp packages/JellyfinSuite.Plugin/meta.json \
		jellyfin-dev:/config/plugins/JellyfinSuite/meta.json
	$(_CRUN) restart jellyfin-dev
	@echo "Waiting for Jellyfin to start..."
	@sleep 20
	@$(_CRUN) exec jellyfin-dev \
		curl -s -o /dev/null -w "Health check: %{http_code}\n" http://localhost:8096/health
