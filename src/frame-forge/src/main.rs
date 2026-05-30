// frame-forge: video frame decoding, quality analysis, animation, and stitching daemon.
//
// Architecture: tokio-based Unix socket server.
// Three message types:
//   0x10 SINGLE_FRAME — decode + quality check → JPEG + quality flags
//   0x11 ANIMATE      — batch decode → scale → GIF/WebP → progress events → output
//   0x12 STITCH       — batch decode → crop/dedup/classify → stitch → PNG/WebP-lossless
//
// All heavy work runs in spawn_blocking; socket I/O is fully async.

mod animate;
mod blender;
mod decoder;
mod disk_cache;
mod protocol;
mod quality;
mod scene_classifier;
mod server;
mod stitch_anime;
#[cfg(feature = "opencv")]
mod stitch_landscape;
#[cfg(feature = "opencv")]
mod stitch_liveaction;

use anyhow::{Context, Result};
use tokio::net::UnixListener;

fn main() -> Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let sock_path = args.get(1).context("Usage: frame-forge <socket-path>")?;

    ffmpeg_next::init()?;

    let _ = std::fs::remove_file(sock_path);
    let listener = UnixListener::bind(sock_path)?;
    eprintln!(
        "[frame-forge] listening on {sock_path} | OpenCL: unavailable (CPU fallback)"
    );

    let state = server::State::new();

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(server::handle_conn(stream, state.clone()));
            }
            Err(e) => eprintln!("[frame-forge] accept error: {e}"),
        }
    }
}
