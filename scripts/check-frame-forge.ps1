# Cargo check frame-forge inside Docker (needs FFmpeg 7 + OpenCV dev libs).
# Call via: mise run check-frame-forge-ps1

$ErrorActionPreference = "Stop"
$RepoRoot = (Get-Location).Path

docker volume create forge-cargo-home 2>$null
docker run --rm `
  -v "${RepoRoot}:/workspace" `
  -v forge-cargo-home:/root/.cargo `
  -w /workspace `
  ubuntu:24.04 `
  sh -c "DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq curl build-essential pkg-config ca-certificates software-properties-common clang libclang-dev && add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7 2>/dev/null && apt-get update -qq && apt-get install -y -qq libavcodec-dev libavformat-dev libavutil-dev libswscale-dev && [ -f /root/.cargo/bin/rustup ] || (curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal 2>/dev/null) && /root/.cargo/bin/rustup default stable 2>/dev/null || true && LIBCLANG_PATH=/usr/lib/llvm-18/lib /root/.cargo/bin/cargo check -p frame-forge --all-targets --features cli"

if ($LASTEXITCODE -ne 0) { throw "frame-forge check failed" }
Write-Host "frame-forge check passed"
