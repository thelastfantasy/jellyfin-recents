# Deploy script for jellyfin-recents — builds all components then copies to jellyfin-dev container.
# Call via: mise run deploy

$ErrorActionPreference = "Stop"

# mise sets working directory to project root, use that instead of script location
$RepoRoot = (Get-Location).Path

Write-Host "=== Building frontend ==="
Set-Location "$RepoRoot/apps/frontend"
pnpm run build
if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }

Write-Host "=== Building player-enhancer ==="
Set-Location "$RepoRoot/apps/player-enhancer"
pnpm install
$env:DEPLOY_MAP = '1'
pnpm run build
if ($LASTEXITCODE -ne 0) { throw "enhancer build failed" }

Set-Location $RepoRoot
Write-Host "=== Building C# plugin ==="
dotnet build packages/JellyfinSuite.Plugin -c Debug --output build/plugin
if ($LASTEXITCODE -ne 0) { throw "C# build failed" }

Write-Host "=== Building seek-preview (Docker) ==="
docker volume create seek-cargo-home 2>$null
docker volume create seek-rustup-home 2>$null
docker run --rm `
  -v "${RepoRoot}:/workspace" `
  -v seek-cargo-home:/root/.cargo `
  -v seek-rustup-home:/root/.rustup `
  -w /workspace `
  ubuntu:24.04 `
  sh -c "DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang && add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && /root/.cargo/bin/rustup default stable 2>/dev/null || true && /root/.cargo/bin/cargo build -p seek-preview --release"
if ($LASTEXITCODE -ne 0) { throw "seek-preview Docker build failed" }
Copy-Item -LiteralPath "$RepoRoot/target/release/seek-preview" -Destination "$RepoRoot/packages/JellyfinSuite.Plugin/seek-preview-linux-x64" -Force

Write-Host "=== Building frame-forge (Docker) ==="
docker volume create forge-cargo-home 2>$null
docker run --rm `
  -v "${RepoRoot}:/workspace" `
  -v forge-cargo-home:/root/.cargo `
  -w /workspace `
  ubuntu:24.04 `
  sh -c "DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang libclang-dev && add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && /root/.cargo/bin/rustup default stable 2>/dev/null || true && LIBCLANG_PATH=/usr/lib/llvm-18/lib /root/.cargo/bin/cargo build -p frame-forge --release"
if ($LASTEXITCODE -ne 0) { throw "frame-forge Docker build failed" }
Copy-Item -LiteralPath "$RepoRoot/target/release/frame-forge" -Destination "$RepoRoot/packages/JellyfinSuite.Plugin/frame-forge-linux-x64" -Force

Write-Host "=== Building poster-gen (Docker) ==="
docker volume create poster-cargo-home 2>$null
docker run --rm `
  -v "${RepoRoot}:/workspace" `
  -v poster-cargo-home:/root/.cargo `
  -w /workspace `
  ubuntu:24.04 `
  sh -c "DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq curl build-essential ca-certificates && [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && /root/.cargo/bin/rustup default stable 2>/dev/null || true && /root/.cargo/bin/cargo build -p poster-gen --release"
if ($LASTEXITCODE -ne 0) { throw "poster-gen Docker build failed" }
Copy-Item -LiteralPath "$RepoRoot/target/release/poster-gen" -Destination "$RepoRoot/packages/JellyfinSuite.Plugin/poster-gen-linux-x64" -Force

Write-Host "=== Deploying to jellyfin-dev ==="
docker cp "$RepoRoot/build/plugin/JellyfinSuite.Plugin.dll" jellyfin-dev:/config/plugins/JellyfinSuite/JellyfinSuite.Plugin.dll
docker cp "$RepoRoot/build/plugin/poster-gen-linux-x64" jellyfin-dev:/config/plugins/JellyfinSuite/poster-gen-linux-x64
docker cp "$RepoRoot/packages/JellyfinSuite.Plugin/seek-preview-linux-x64" jellyfin-dev:/config/plugins/JellyfinSuite/seek-preview-linux-x64
docker cp "$RepoRoot/packages/JellyfinSuite.Plugin/frame-forge-linux-x64" jellyfin-dev:/config/plugins/JellyfinSuite/frame-forge-linux-x64
docker cp "$RepoRoot/packages/JellyfinSuite.Plugin/Web/jellyfin-suite-enhancer.js" jellyfin-dev:/config/plugins/JellyfinSuite/jellyfin-suite-enhancer.js
docker cp "$RepoRoot/packages/JellyfinSuite.Plugin/Web/jellyfin-suite-enhancer.js.map" jellyfin-dev:/config/plugins/JellyfinSuite/jellyfin-suite-enhancer.js.map
docker cp "$RepoRoot/packages/JellyfinSuite.Plugin/meta.json" jellyfin-dev:/config/plugins/JellyfinSuite/meta.json
docker restart jellyfin-dev

Write-Host "Waiting for Jellyfin to start..."
Start-Sleep -Seconds 20
docker exec jellyfin-dev curl -s -o /dev/null -w "Health check: %{http_code}" http://localhost:8096/health
