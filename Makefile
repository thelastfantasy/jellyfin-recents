SHELL := bash
export PATH := /c/Program Files/nodejs:$(PATH)

.PHONY: build-frontend build-plugin build-poster-gen build-poster-gen-win build-seek-preview build-frame-forge \
        build update clean test test-rust test-frontend test-csharp workflow-test workflow-test-release

build-frontend:
	cd src/frontend && npm run build

build-enhancer:
	cd src/player-enhancer && npm install && npm run build

# Build Linux Rust binary via Docker (cross 在 Windows 上有工具链检测 bug，改用 docker run 直接编译)
build-poster-gen:
	MSYS_NO_PATHCONV=1 docker run --rm \
		-v "$$(cygpath -m $(CURDIR))/src/poster-gen:/workspace" \
		-w /workspace \
		rust:1.88-slim-bookworm \
		cargo build --release
	cp src/poster-gen/target/release/poster-gen \
		src/JellyfinSuite.Plugin/poster-gen-linux-x64

# Build seek-preview Linux binary via Docker.
# Uses Ubuntu 24.04 + ppa:ubuntuhandbook1/ffmpeg7 to get FFmpeg 7.x dev headers,
# matching the jellyfin-ffmpeg7 runtime (.so.61) in the Jellyfin container.
# Rust toolchain is cached in a named Docker volume (seek-cargo-home) across builds.
build-seek-preview:
	docker volume create seek-cargo-home > /dev/null 2>&1 || true
	docker volume create seek-rustup-home > /dev/null 2>&1 || true
	MSYS_NO_PATHCONV=1 docker run --rm \
		-v "$$(cygpath -m $(CURDIR))/src/seek-preview:/workspace" \
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
		       /root/.cargo/bin/cargo build --release"
	cp src/seek-preview/target/release/seek-preview \
		src/JellyfinSuite.Plugin/seek-preview-linux-x64

# Build frame-forge Linux binary via Docker.
# Uses Ubuntu 24.04 + libopencv-dev + ffmpeg dev libs for OpenCV and ffmpeg-next.
build-frame-forge:
	docker volume create forge-cargo-home > /dev/null 2>&1 || true
	MSYS_NO_PATHCONV=1 docker run --rm \
		-v "$$(cygpath -m $(CURDIR))/src/frame-forge:/workspace" \
		-v forge-cargo-home:/root/.cargo \
		-w /workspace \
		ubuntu:24.04 \
		sh -c "DEBIAN_FRONTEND=noninteractive && \
		       apt-get update -qq && \
		       apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang libopencv-dev && \
		       add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && \
		       apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && \
		       [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && \
		/root/.cargo/bin/rustup default stable 2>/dev/null || true && \
		/root/.cargo/bin/cargo build --release --features opencv"
	cp src/frame-forge/target/release/frame-forge \
		src/JellyfinSuite.Plugin/frame-forge-linux-x64

# Build Windows Rust binary natively (run on Windows where cargo targets Windows by default)
build-poster-gen-win:
	cd src/poster-gen && cargo build --release
	cp src/poster-gen/target/release/poster-gen.exe \
		src/JellyfinSuite.Plugin/poster-gen-win-x64.exe

build-plugin:
	dotnet build src/JellyfinSuite.Plugin -c Debug --output build/plugin

build: build-frontend build-enhancer build-plugin build-seek-preview build-frame-forge

update: build-poster-gen build
	MSYS_NO_PATHCONV=1 docker cp build/plugin/JellyfinSuite.Plugin.dll \
		jellyfin-dev:/config/plugins/JellyfinSuite/JellyfinSuite.Plugin.dll
	MSYS_NO_PATHCONV=1 docker cp build/plugin/poster-gen-linux-x64 \
		jellyfin-dev:/config/plugins/JellyfinSuite/poster-gen-linux-x64
	MSYS_NO_PATHCONV=1 docker cp src/JellyfinSuite.Plugin/seek-preview-linux-x64 \
		jellyfin-dev:/config/plugins/JellyfinSuite/seek-preview-linux-x64
	MSYS_NO_PATHCONV=1 docker cp src/JellyfinSuite.Plugin/frame-forge-linux-x64 \
		jellyfin-dev:/config/plugins/JellyfinSuite/frame-forge-linux-x64
	MSYS_NO_PATHCONV=1 docker cp src/JellyfinSuite.Plugin/meta.json \
		jellyfin-dev:/config/plugins/JellyfinSuite/meta.json
	docker restart jellyfin-dev
	@echo "Waiting for Jellyfin to start..."
	@sleep 20
	@MSYS_NO_PATHCONV=1 docker exec jellyfin-dev \
		curl -s -o /dev/null -w "Health check: %{http_code}\n" http://localhost:8096/health

# ── Tests ────────────────────────────────────────────────────────────────────

test-rust:
	cd src/poster-gen && cargo test
	@if [ "$$(uname -s 2>/dev/null)" = "Linux" ]; then \
		cd src/seek-preview && cargo test; \
		cd src/frame-forge && cargo test; \
	else \
		echo "[seek-preview] Skipping tests (Linux-only)"; \
		echo "[frame-forge] Skipping tests (Linux-only)"; \
	fi

test-frontend:
	cd src/frontend && bun test ../../tests/frontend/

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
	cd src/frontend && rm -rf dist/
	cd src/poster-gen && cargo clean

# ═══════════════════════════════════════════════════════════════════════════════
# Windows/cmd.exe targets — use via: mise run deploy-win
# Target naming: *-win-cmd = Windows OS + cmd.exe shell
# ═══════════════════════════════════════════════════════════════════════════════

build-frame-forge-win-cmd:
	docker volume create forge-cargo-home > NUL 2>&1 || cd .
	docker run --rm -v "D:/Dev/jellyfin-recents/src/frame-forge:/workspace" -v forge-cargo-home:/root/.cargo -w /workspace ubuntu:24.04 sh -c "DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang libclang-18-dev libopencv-dev && add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && ldconfig && [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && /root/.cargo/bin/rustup default stable 2>/dev/null || true && /root/.cargo/bin/cargo build --release --features opencv"
	CMD /C copy /Y src\frame-forge\target\release\frame-forge src\JellyfinSuite.Plugin\frame-forge-linux-x64

build-poster-gen-win-cmd:
	docker run --rm -v "D:/Dev/jellyfin-recents/src/poster-gen:/workspace" -w /workspace rust:1.88-slim-bookworm cargo build --release
	CMD /C copy /Y src\poster-gen\target\release\poster-gen src\JellyfinSuite.Plugin\poster-gen-linux-x64

build-seek-preview-win-cmd:
	docker volume create seek-cargo-home > NUL 2>&1 || cd .
	docker run --rm -v "D:/Dev/jellyfin-recents/src/seek-preview:/workspace" -v seek-cargo-home:/root/.cargo -w /workspace -e LIBCLANG_PATH=/usr/lib/llvm-18/lib ubuntu:24.04 sh -c "DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang libclang-18-dev && add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && /root/.cargo/bin/rustup default stable 2>/dev/null || true && /root/.cargo/bin/cargo build --release"
	CMD /C copy /Y src\seek-preview\target\release\seek-preview src\JellyfinSuite.Plugin\seek-preview-linux-x64

deploy-win-cmd: build-poster-gen-win-cmd build-seek-preview-win-cmd build-frame-forge-win-cmd
	cd src/frontend && npm run build
	cd src/player-enhancer && npm install && npm run build
	dotnet build src\JellyfinSuite.Plugin -c Debug --output build\plugin
	docker cp build\plugin\JellyfinSuite.Plugin.dll jellyfin-dev:/config/plugins/JellyfinSuite/JellyfinSuite.Plugin.dll
	docker cp src\JellyfinSuite.Plugin\poster-gen-linux-x64 jellyfin-dev:/config/plugins/JellyfinSuite/poster-gen-linux-x64
	docker cp src\JellyfinSuite.Plugin\seek-preview-linux-x64 jellyfin-dev:/config/plugins/JellyfinSuite/seek-preview-linux-x64
	docker cp src\JellyfinSuite.Plugin\frame-forge-linux-x64 jellyfin-dev:/config/plugins/JellyfinSuite/frame-forge-linux-x64
	docker cp src\JellyfinSuite.Plugin\meta.json jellyfin-dev:/config/plugins/JellyfinSuite/meta.json
	docker restart jellyfin-dev
	@echo Waiting for Jellyfin to start...
	@timeout /t 20 /nobreak > NUL
	@docker exec jellyfin-dev curl -s -o /dev/null -w "Health: %%{http_code}" http://localhost:8096/health
