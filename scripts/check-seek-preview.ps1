# Cargo check seek-preview inside Docker (needs FFmpeg 7 dev libs).
# Call via: mise run check-seek-preview-ps1

$ErrorActionPreference = "Stop"
$RepoRoot = (Get-Location).Path

docker volume create seek-cargo-home 2>$null
docker volume create seek-rustup-home 2>$null
docker run --rm `
  -v "${RepoRoot}:/workspace" `
  -v seek-cargo-home:/root/.cargo `
  -v seek-rustup-home:/root/.rustup `
  -w /workspace `
  ubuntu:24.04 `
  sh -c "DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang && add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && /root/.cargo/bin/rustup default stable 2>/dev/null || true && /root/.cargo/bin/cargo check -p seek-preview"

if ($LASTEXITCODE -ne 0) { throw "seek-preview check failed" }
Write-Host "seek-preview check passed"
