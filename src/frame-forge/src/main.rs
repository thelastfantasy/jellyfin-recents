mod decoder;
mod protocol;
mod quality;
mod resources;

use anyhow::Context;
use lru::LruCache;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::UnixListener;
use tokio::sync::Mutex;

use protocol::{read_msg_type, read_single_frame_req, write_ack, write_jpeg_response};
use quality::detect_quality;

const MSG_SINGLE_FRAME: u8 = 0x10;
// 0x11 = ANIMATE, 0x12 = STITCH — Phase 6/10
const FRAME_CACHE_CAP: usize = 100;

type CacheKey = (PathBuf, i64); // (canonical_path, pos_ms/500*500)

pub struct State {
    pub cache: Mutex<LruCache<CacheKey, Vec<u8>>>,
    pub gpu_available: bool,
}

fn main() -> anyhow::Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let sock_path = args.get(1).context("Usage: frame-forge <socket-path>")?;

    ffmpeg_next::init()?;
    let gpu_available = opencv::core::ocl::have_opencl().unwrap_or(false);

    let _ = std::fs::remove_file(sock_path);
    let listener = UnixListener::bind(sock_path)?;
    eprintln!(
        "[frame-forge] listening on {sock_path} | OpenCL: {}",
        if gpu_available { "enabled" } else { "unavailable (CPU fallback)" }
    );

    let state = Arc::new(State {
        cache: Mutex::new(LruCache::new(
            NonZeroUsize::new(FRAME_CACHE_CAP).unwrap(),
        )),
        gpu_available,
    });

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let state = state.clone();
                tokio::spawn(handle_conn(stream, state));
            }
            Err(e) => eprintln!("[frame-forge] accept error: {e}"),
        }
    }
}

async fn handle_conn(
    mut stream: tokio::net::UnixStream,
    state: Arc<State>,
) {
    use tokio::io::AsyncWriteExt;

    loop {
        let msg_type = match read_msg_type(&mut stream).await {
            Ok(t) => t,
            Err(_) => break, // connection closed
        };

        match msg_type {
            MSG_SINGLE_FRAME => {
                if let Err(e) = handle_single_frame(&mut stream, &state).await {
                    eprintln!("[frame-forge] single_frame error: {e}");
                }
            }
            _ => {
                eprintln!("[frame-forge] unknown msg_type: 0x{msg_type:02x}");
                break;
            }
        }
    }
    let _ = stream.shutdown().await;
}

async fn handle_single_frame(
    stream: &mut tokio::net::UnixStream,
    state: &Arc<State>,
) -> anyhow::Result<()> {
    let req = read_single_frame_req(stream).await?;

    let cache_key: CacheKey = (req.path.clone(), req.pos_ms / 500 * 500);

    // Check cache
    let cached = {
        let mut c = state.cache.lock().await;
        c.get(&cache_key).cloned()
    };

    let jpeg = if let Some(data) = cached {
        data
    } else {
        // Decode via spawn_blocking
        let path = req.path.clone();
        let pos_ms = req.pos_ms;
        let width = req.width;
        let state_clone = state.clone();
        let ck = cache_key.clone();

        let result = tokio::task::spawn_blocking(move || {
            decoder::decode_and_encode(&path, pos_ms, width)
        })
        .await??;

        // Cache result
        state_clone.cache.lock().await.put(ck, result.clone());
        result
    };

    // Quality detection on decoded image (re-decode to image::DynamicImage for quality check)
    // For efficiency, we compute quality flags inline; in production this could be done
    // during decode. For now we do a second lightweight pass.
    let img = image::load_from_memory(&jpeg)?;
    let quality = detect_quality(&img, None);
    let flags = quality.to_bitmask();

    write_jpeg_response(stream, req.request_id, &jpeg, flags).await?;
    Ok(())
}
