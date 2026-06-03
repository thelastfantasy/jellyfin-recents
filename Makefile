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
        check-seek-preview check-frame-forge \
        build update deploy update-quick deploy-enhancer clean test test-rust test-frontend test-csharp workflow-test workflow-test-release

build-frontend:
	cd apps/frontend && pnpm run build

build-enhancer:
	cd apps/player-enhancer && pnpm install && pnpm run build

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
		       apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang libclang-dev && \
		       add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && \
		       apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && \
		       [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && \
		/root/.cargo/bin/rustup default stable 2>/dev/null || true && \
		LIBCLANG_PATH=/usr/lib/llvm-18/lib /root/.cargo/bin/cargo build -p frame-forge --release"
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
	MSYS_NO_PATHCONV=1 docker cp packages/JellyfinSuite.Plugin/Web/jellyfin-suite-enhancer.js.map \
		jellyfin-dev:/config/plugins/JellyfinSuite/jellyfin-suite-enhancer.js.map
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
	MSYS_NO_PATHCONV=1 docker cp packages/JellyfinSuite.Plugin/Web/jellyfin-suite-enhancer.js.map \
		jellyfin-dev:/config/plugins/JellyfinSuite/jellyfin-suite-enhancer.js.map
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

# ── Tests ────────────────────────────────────────────────────────────────────

test-rust:
	cd crates/poster-gen && cargo test
	@if [ "$$(uname -s 2>/dev/null)" = "Linux" ]; then \
		cd crates/seek-preview && cargo test; \
		cd crates/frame-forge && cargo test; \
	else \
		echo "[seek-preview] Skipping tests (Linux-only)"; \
		echo "[frame-forge] Skipping tests (Linux-only)"; \
	fi

test-frontend:
	cd apps/frontend && bun test ../../tests/frontend/

test-csharp:
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
