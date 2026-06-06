use std::collections::{HashMap, HashSet};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use lru::LruCache;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, Mutex, RwLock, Semaphore};

use jfs_common::DiskCache;
use jfs_common::FrameIndexEntry;
use crate::protocol::{read_msg_type, read_single_frame_req, read_prefetch_range_req, read_index_frames_stream_req, read_prefetch_range_stream_req, write_ack, write_jpeg_response};
use crate::quality::detect_quality;


const MSG_SINGLE_FRAME: u8 = 0x10;
const MSG_ANIMATE: u8 = 0x11;
const MSG_STITCH: u8 = 0x12;
const MSG_PREFETCH_FRAME: u8 = 0x13;
const MSG_LIST_CACHED: u8 = 0x14;
const MSG_INDEX_FRAMES: u8 = 0x15;
const MSG_PREFETCH_RANGE: u8 = 0x16;
const MSG_INDEX_FRAMES_STREAM: u8 = 0x17;
const MSG_PREFETCH_STREAM: u8 = 0x18;
const MSG_PREFETCH_RANGE_STREAM: u8 = 0x19;
const MSG_DEBUG_DUMP:           u8 = 0x1A;

const RAM_CACHE_CAP: usize = 100;
const FRAME_INDEX_CAP: usize = 20;
const PREFETCH_WORKERS: usize = 6;
const PREFETCH_QUEUE_CAP: usize = 128;

// RAM cache key: (path, pos_ms, width)
type RamKey = (PathBuf, i64, u32);

/// Shared state for an in-progress Queue B demux on a single path.
/// Multiple `handle_index_frames_stream` callers for the same path share one IndexProgress
/// instead of spawning duplicate Queue B tasks.
struct IndexProgress {
    /// Accumulated SSE batch payloads (Arc to share between bridge tasks without copying).
    batches: std::sync::Mutex<Vec<(Arc<Vec<u8>>, i64)>>,
    /// Fired whenever a new batch is pushed or `finish` is called.
    notify: tokio::sync::Notify,
    /// Set to true once Queue B has pushed all data (including the fps end signal).
    done: AtomicBool,
}

impl IndexProgress {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            batches: std::sync::Mutex::new(Vec::new()),
            notify: tokio::sync::Notify::new(),
            done: AtomicBool::new(false),
        })
    }

    /// Push a batch from any thread (called from spawn_blocking or async).
    fn push(&self, data: Vec<u8>, max_ms: i64) {
        self.batches.lock().unwrap().push((Arc::new(data), max_ms));
        self.notify.notify_waiters();
    }

    /// Mark as done; unblocks all waiting bridge tasks.
    fn finish(&self) {
        self.done.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }
}

struct PrefetchJob {
    item_id: String,
    path: PathBuf,
    pos_ms: i64,
    width: u32,
}

/// Cached frame index per video path: (pts_ms, is_keyframe)[], fps_num, fps_den
type FrameIndexCache = Arc<(Vec<(i64, bool)>, i64, i64)>;

// ── FrameIndexManager ─────────────────────────────────────────────────────────

enum FrameInfoSubscription {
    Cached(FrameIndexCache),
    Existing(Arc<IndexProgress>),
    New(Arc<IndexProgress>),
}

struct FrameIndexManager {
    // RwLock: concurrent reads (peek, no LRU-order update) without serialisation.
    // Writes (put) are rare — only on first load or cache miss.
    index:       RwLock<LruCache<PathBuf, FrameIndexCache>>,
    in_progress: Mutex<HashMap<PathBuf, Arc<IndexProgress>>>,
}

impl FrameIndexManager {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            index:       RwLock::new(LruCache::new(NonZeroUsize::new(FRAME_INDEX_CAP).unwrap())),
            in_progress: Mutex::new(HashMap::new()),
        })
    }

    // peek() — doesn't update LRU order; safe with a shared read lock.
    async fn get(&self, path: &Path) -> Option<FrameIndexCache> {
        self.index.read().await.peek(path).cloned()
    }

    async fn put_if_absent(&self, path: PathBuf, idx: FrameIndexCache) {
        let mut cache = self.index.write().await;
        if cache.peek(&path).is_none() {
            cache.put(path, idx);
        }
    }

    /// Returns the cached index, or builds it by demuxing the file and caches the result.
    async fn get_or_build(&self, path: &Path) -> anyhow::Result<FrameIndexCache> {
        if let Some(idx) = self.get(path).await {
            return Ok(idx);
        }
        let p = path.to_path_buf();
        let (frames, fps_num, fps_den) =
            tokio::task::spawn_blocking(move || jfs_common::index_frames(&p)).await??;
        let new_idx = Arc::new((frames, fps_num, fps_den));
        self.put_if_absent(path.to_path_buf(), new_idx.clone()).await;
        Ok(self.get(path).await.unwrap_or(new_idx))
    }

    /// Returns the cached index (Cached), or an IndexProgress to subscribe to
    /// (Existing = already running Queue B, New = freshly created, caller must spawn Queue B).
    async fn get_or_subscribe(&self, path: &Path) -> FrameInfoSubscription {
        if let Some(idx) = self.get(path).await {
            return FrameInfoSubscription::Cached(idx);
        }
        let mut map = self.in_progress.lock().await;
        if let Some(p) = map.get(path) {
            FrameInfoSubscription::Existing(p.clone())
        } else {
            let p = IndexProgress::new();
            map.insert(path.to_path_buf(), p.clone());
            FrameInfoSubscription::New(p)
        }
    }

    async fn remove_progress(&self, path: &Path) {
        self.in_progress.lock().await.remove(path);
    }
}

// ── State ─────────────────────────────────────────────────────────────────────

pub struct State {
    pub ram: Mutex<LruCache<RamKey, Vec<u8>>>,
    pub disk: Arc<DiskCache>,
    decode_sem: Arc<Semaphore>,
    prefetch_tx: mpsc::Sender<PrefetchJob>,
    in_progress: Mutex<HashSet<(String, i64, u32)>>,
    pub fi: Arc<FrameIndexManager>,
}

impl State {
    pub fn new() -> Arc<Self> {
        let disk = DiskCache::new("frame-forge");
        let (tx, rx) = mpsc::channel(PREFETCH_QUEUE_CAP);
        let state = Arc::new(Self {
            ram: Mutex::new(LruCache::new(NonZeroUsize::new(RAM_CACHE_CAP).unwrap())),
            disk,
            decode_sem: Arc::new(Semaphore::new(1)),
            prefetch_tx: tx,
            in_progress: Mutex::new(HashSet::new()),
            fi: FrameIndexManager::new(),
        });
        let rx = Arc::new(Mutex::new(rx));
        for _ in 0..PREFETCH_WORKERS {
            tokio::spawn(prefetch_worker(rx.clone(), state.clone()));
        }
        state
    }
}

fn compute_frame_idx(actual_pts_ms: i64, fps_num: i64, fps_den: i64) -> i64 {
    if fps_num <= 0 || fps_den <= 0 { return -1; }
    (actual_pts_ms * fps_num + fps_den * 500) / (fps_den * 1000)
}

/// Resolve frameIdx → posMs using the cached frame index.
/// Loads + demuxes the index on first use for the path.
async fn resolve_frame_idx(state: &Arc<State>, path: &Path, frame_idx: i64) -> Option<i64> {
    if frame_idx < 0 { return None; }
    let idx = state.fi.get_or_build(path).await.ok()?;
    let fi = frame_idx as usize;
    if fi < idx.0.len() { Some(idx.0[fi].0) } else { None }
}

async fn prefetch_worker(rx: Arc<Mutex<mpsc::Receiver<PrefetchJob>>>, state: Arc<State>) {
    loop {
        let job = match rx.lock().await.recv().await {
            Some(j) => j,
            None => break,
        };

        // Skip if already in RAM or on disk
        {
            let ram = state.ram.lock().await;
            if ram.peek(&(job.path.clone(), job.pos_ms, job.width)).is_some() {
                state.in_progress.lock().await.remove(&(job.item_id.clone(), job.pos_ms, job.width));
                continue;
            }
        }
        if state.disk.exists(&job.item_id, &job.path, job.pos_ms, job.width) {
            state.in_progress.lock().await.remove(&(job.item_id.clone(), job.pos_ms, job.width));
            continue;
        }

        let path = job.path.clone();
        let pos_ms = job.pos_ms;
        let width = job.width;
        let disk = state.disk.clone();
        let item_id = job.item_id.clone();

        match tokio::task::spawn_blocking(move || jfs_common::decode_and_encode(&path, pos_ms, width)).await {
            Ok(Ok(r)) => {
                let frame_idx = compute_frame_idx(r.pts_ms, r.fps_num, r.fps_den);
                if !r.webp_orig.is_empty() {
                    disk.write(&item_id, &job.path, frame_idx, pos_ms, 0, &r.webp_orig);
                }
                disk.write(&item_id, &job.path, frame_idx, pos_ms, width, &r.webp);
                let mut ram = state.ram.lock().await;
                if !r.webp_orig.is_empty() {
                    ram.put((job.path.clone(), pos_ms, 0), r.webp_orig);
                }
                ram.put((job.path, pos_ms, width), r.webp);
                log::warn!("[frame-forge] PREFETCH done: {item_id} f{frame_idx}@{pos_ms}ms w={width}");
            }
            Ok(Err(e)) => log::warn!("[frame-forge] prefetch decode error: {e}"),
            Err(e) => log::warn!("[frame-forge] prefetch spawn error: {e}"),
        }

        state.in_progress.lock().await.remove(&(item_id, pos_ms, width));
    }
}

pub async fn handle_conn(mut stream: UnixStream, state: Arc<State>) {
    use tokio::io::AsyncWriteExt;

    loop {
        let msg_type = match read_msg_type(&mut stream).await {
            Ok(t) => t,
            Err(_) => break,
        };

        match msg_type {
            MSG_SINGLE_FRAME => {
                if let Err(e) = handle_single_frame(&mut stream, &state).await {
                    log::warn!("[frame-forge] single_frame error: {e}");
                }
            }
            MSG_PREFETCH_FRAME => {
                if let Err(e) = handle_prefetch_frame(&mut stream, &state).await {
                    log::warn!("[frame-forge] prefetch error: {e}");
                }
            }
            MSG_ANIMATE => {
                if let Err(e) = handle_animate(&mut stream, &state).await {
                    log::warn!("[frame-forge] animate error: {e}");
                }
            }
            MSG_STITCH => {
                if let Err(e) = handle_stitch(&mut stream, &state).await {
                    log::warn!("[frame-forge] stitch error: {e}");
                }
            }
            MSG_LIST_CACHED => {
                if let Err(e) = handle_list_cached(&mut stream, &state).await {
                    log::warn!("[frame-forge] list_cached error: {e}");
                    break;
                }
            }
            MSG_INDEX_FRAMES => {
                if let Err(e) = handle_index_frames(&mut stream, &state).await {
                    log::warn!("[frame-forge] index_frames error: {e}");
                    break;
                }
            }
            MSG_PREFETCH_RANGE => {
                if let Err(e) = handle_prefetch_range(&mut stream, &state).await {
                    log::warn!("[frame-forge] prefetch_range error: {e}");
                    break;
                }
            }
            MSG_INDEX_FRAMES_STREAM => {
                if let Err(e) = handle_index_frames_stream(&mut stream, state.clone()).await {
                    log::warn!("[frame-forge] index_frames_stream error: {e}");
                    break;
                }
            }
            MSG_PREFETCH_STREAM => {
                if let Err(e) = handle_prefetch_stream(&mut stream, &state).await {
                    log::warn!("[frame-forge] prefetch_stream error: {e}");
                    break;
                }
            }
            MSG_PREFETCH_RANGE_STREAM => {
                if let Err(e) = handle_prefetch_range_stream(&mut stream, &state).await {
                    log::warn!("[frame-forge] prefetch_range_stream error: {e}");
                    break;
                }
            }
            MSG_DEBUG_DUMP => {
                if let Err(e) = handle_debug_dump(&mut stream, &state).await {
                    log::warn!("[frame-forge] debug_dump error: {e}");
                    break;
                }
            }
            _ => {
                log::warn!("[frame-forge] unknown msg_type: 0x{msg_type:02x}");
                break;
            }
        }
    }
    let _ = stream.shutdown().await;
}

async fn handle_single_frame(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    let req = read_single_frame_req(stream).await?;

    // Resolve frameIdx → posMs via internal frame index
    let pos_ms = resolve_frame_idx(state, &req.path, req.frame_idx).await
        .unwrap_or(req.frame_idx.max(0));

    // 1. RAM cache
    let ram_key: RamKey = (req.path.clone(), pos_ms, req.width);
    let cached = state.ram.lock().await.get(&ram_key).cloned();
    if let Some(webp) = cached {
        let img = image::load_from_memory(&webp)?;
        let flags = detect_quality(&img).to_bitmask();
        return write_jpeg_response(stream, req.request_id, &webp, flags, -1).await;
    }

    // 2. Disk cache
    if let Some(webp) = state.disk.read(&req.item_id, &req.path, pos_ms, req.width) {
        state.ram.lock().await.put(ram_key, webp.clone());
        let img = image::load_from_memory(&webp)?;
        let flags = detect_quality(&img).to_bitmask();
        return write_jpeg_response(stream, req.request_id, &webp, flags, -1).await;
    }

    // 3. Decode on demand (blocking)
    let path = req.path.clone();
    let width = req.width;
    let state_clone = state.clone();
    let ck = ram_key.clone();

    let _permit = state.decode_sem.clone().acquire_owned().await?;
    let result = tokio::task::spawn_blocking(move || {
        jfs_common::decode_and_encode(&path, pos_ms, width)
    })
    .await;

    match result {
        Ok(Ok(r)) => {
            let frame_idx = compute_frame_idx(r.pts_ms, r.fps_num, r.fps_den);
            if !r.webp_orig.is_empty() {
                state_clone.disk.write(&req.item_id, &req.path, frame_idx, pos_ms, 0, &r.webp_orig);
            }
            state_clone.disk.write(&req.item_id, &req.path, frame_idx, pos_ms, req.width, &r.webp);
            state_clone.ram.lock().await.put(ck, r.webp.clone());
            let img = match image::load_from_memory(&r.webp) {
                Ok(i) => i,
                Err(e) => {
                    log::warn!("[frame-forge] image decode error: {e}");
                    write_ack(stream, req.request_id).await?;
                    return Ok(());
                }
            };
            let flags = detect_quality(&img).to_bitmask();
            write_jpeg_response(stream, req.request_id, &r.webp, flags, r.pts_ms).await?;
        }
        Ok(Err(e)) => {
            log::warn!("[frame-forge] decode error: {e}");
            write_ack(stream, req.request_id).await?;
        }
        Err(e) => {
            log::warn!("[frame-forge] spawn error: {e}");
            write_ack(stream, req.request_id).await?;
        }
    }
    Ok(())
}

async fn handle_prefetch_frame(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    let req = read_single_frame_req(stream).await?;

    // ACK immediately — background worker does the actual decode
    write_ack(stream, req.request_id).await?;

    let pos_ms = resolve_frame_idx(state, &req.path, req.frame_idx).await
        .unwrap_or(req.frame_idx.max(0));

    // Skip if already cached
    if state.disk.exists(&req.item_id, &req.path, pos_ms, req.width) {
        return Ok(());
    }

    let progress_key = (req.item_id.clone(), pos_ms, req.width);
    {
        let mut ip = state.in_progress.lock().await;
        if !ip.insert(progress_key) {
            return Ok(()); // already queued
        }
    }

    let _ = state.prefetch_tx.try_send(PrefetchJob {
        item_id: req.item_id,
        path: req.path,
        pos_ms,
        width: req.width,
    });

    Ok(())
}

async fn handle_list_cached(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    let mut id_buf = [0u8; 4];
    stream.read_exact(&mut id_buf).await?;
    let request_id = u32::from_le_bytes(id_buf);

    let mut item_id_bytes = [0u8; 32];
    stream.read_exact(&mut item_id_bytes).await?;
    let item_id = String::from_utf8(item_id_bytes.to_vec()).unwrap_or_default();

    let mut w_buf = [0u8; 4];
    stream.read_exact(&mut w_buf).await?;
    let width = u32::from_le_bytes(w_buf);

    let entries = state.disk.list_cached(&item_id, width);

    let mut buf = Vec::with_capacity(8 + entries.len() * 16);
    buf.extend_from_slice(&request_id.to_le_bytes());
    buf.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (pos_ms, frame_idx) in entries {
        buf.extend_from_slice(&frame_idx.to_le_bytes());
        buf.extend_from_slice(&pos_ms.to_le_bytes());
    }
    stream.write_all(&buf).await?;
    stream.flush().await?;
    Ok(())
}

async fn handle_animate(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    use tokio::sync::mpsc;

    let req = crate::protocol::read_animate_req(stream).await?;
    log::warn!(
        "[frame-forge] ANIMATE task={} frames={} fmt={:?} speed={}",
        req.task_id, req.paths.len(), req.format, req.speed
    );

    let total_input = req.paths.len();
    send_progress(stream, "running", "decoding", 0, total_input as u32, 0.0).await?;
    log::warn!("[frame-forge] ANIMATE progress sent, loading frame index...");

    // Load frame index for the first path (all frames share the same video)
    let fi = {
        let p = req.paths.first().map(|(p, _)| p.clone()).unwrap_or_default();
        state.fi.get_or_build(&p).await?
    };
    let (fi_frames, _, _) = fi.as_ref();
    log::warn!("[frame-forge] ANIMATE frame index loaded: {} frames", fi_frames.len());

    let mut images: Vec<image::DynamicImage> = Vec::with_capacity(total_input);
    let mut actual_pts_vec: Vec<i64> = Vec::with_capacity(total_input);

    for (i, (path, frame_idx)) in req.paths.iter().enumerate() {
        let pos_ms = if *frame_idx >= 0 && (*frame_idx as usize) < fi_frames.len() {
            fi_frames[*frame_idx as usize].0
        } else {
            0
        };
        log::warn!("[frame-forge] ANIMATE frame {} idx={} pos_ms={}", i, frame_idx, pos_ms);

        let (img, actual_pts) = if let Some(cached) = state.disk.read(&req.item_id, path, pos_ms, 0) {
            log::warn!("[frame-forge] ANIMATE frame {} → disk cache hit", i);
            (image::load_from_memory(&cached)?, pos_ms)
        } else {
            log::warn!("[frame-forge] ANIMATE frame {} → decode", i);
            let p = path.clone();
            let r = tokio::task::spawn_blocking(move || jfs_common::decode_and_encode(&p, pos_ms, 0)).await??;
            (image::load_from_memory(&r.webp)?, r.pts_ms)
        };

        images.push(img);
        actual_pts_vec.push(actual_pts);
        if i == 0 { log::warn!("[frame-forge] ANIMATE first frame ready"); }
        send_progress(
            stream, "running", "decoding",
            (i + 1) as u32, total_input as u32,
            (i + 1) as f64 / total_input as f64 * 50.0,
        ).await?;
    }
    log::warn!("[frame-forge] ANIMATE decode done, {} images", images.len());

    if images.is_empty() {
        anyhow::bail!("no unique frames after deduplication");
    }

    // 先裁切（用户指定的归一化区域）
    if let Some((cx, cy, cw, ch)) = req.crop {
        images = images.into_iter().map(|img| {
            let (iw, ih) = (img.width(), img.height());
            let x  = (cx * iw as f32).round() as u32;
            let y  = (cy * ih as f32).round() as u32;
            let w  = ((cw * iw as f32).round() as u32).min(iw.saturating_sub(x)).max(1);
            let h  = ((ch * ih as f32).round() as u32).min(ih.saturating_sub(y)).max(1);
            img.crop_imm(x, y, w, h)
        }).collect();
    }

    let effective_px = if req.target_px > 0 {
        req.target_px
    } else {
        req.resolution_preset.to_px()
    };
    let (tw, th) = if effective_px > 0 {
        let first = &images[0];
        let (fw, fh) = (first.width(), first.height());
        if req.resize_mode == crate::protocol::ResizeMode::Height {
            let ratio = effective_px as f64 / fh as f64;
            ((fw as f64 * ratio) as u32, effective_px)
        } else {
            let ratio = effective_px as f64 / fw as f64;
            (effective_px, (fh as f64 * ratio) as u32)
        }
    } else {
        (images[0].width(), images[0].height())
    };

    let n = images.len();
    let speed = req.speed.max(0.01);
    let default_interval = if actual_pts_vec.len() >= 2 {
        let total_ms = actual_pts_vec.last().unwrap() - actual_pts_vec.first().unwrap();
        let total_ms = total_ms.max(1) as f64;
        (total_ms / (n - 1) as f64).max(10.0)
    } else {
        42.0
    };
    let delays_ms: Vec<u32> = vec![((default_interval / speed as f64).max(10.0).min(2000.0)) as u32; n];

    // Per-frame scale+encode with progress reported via channel (50%→99%)
    // Use unbounded channel to prevent deadlock if progress consumer is blocked on socket write
    let (prog_tx, mut prog_rx) = mpsc::unbounded_channel::<f64>();
    let format = req.format;
    let loop_count = req.loop_count;
    let quality = req.quality;

    let encode_handle = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let n = images.len();
        if format.is_webp() {
            use image::imageops;
            use webpx::AnimationEncoder;
            use enough::Unstoppable;

            let mut encoder = AnimationEncoder::with_options(tw, th, false, 0)
                .map_err(|e| anyhow::anyhow!("webp encoder: {e}"))?;
            let lossless = quality <= 0.0;
            if lossless {
                encoder.set_lossless(true);
            } else {
                encoder.set_quality((quality.clamp(0.01, 1.0) * 100.0) as f32);
            }
            log::warn!("[frame-forge] ANIMATE encoder: {}x{} lossless={} quality={}", tw, th, lossless, if lossless { 0.0 } else { quality * 100.0 });

            // Workaround: libwebp's minimize_size (default true) merges too-similar frames.
            // Flip the last byte of each frame's RGBA data to guarantee uniqueness,
            // preventing minimize_size from dropping frames.
            let bypass_min = true;
            let mut cursor_ms = 0i32;
            for (i, img) in images.iter().enumerate() {
                let scaled = crate::animate::scale_frame(img, tw, th);
                let mut rgba = if scaled.width() == tw && scaled.height() == th {
                    scaled.to_rgba8().into_raw()
                } else {
                    let mut padded = image::RgbaImage::new(tw, th);
                    imageops::overlay(&mut padded, &scaled.to_rgba8(), 0, 0);
                    padded.into_raw()
                };
                if bypass_min && !rgba.is_empty() {
                    let last = rgba.len() - 1;
                    rgba[last] ^= 1;
                }
                log::warn!("[frame-forge] ANIMATE add_frame {} cursor_ms={} rgba_bytes={}", i, cursor_ms, rgba.len());
                encoder.add_frame_rgba(&rgba, cursor_ms)
                    .map_err(|e| anyhow::anyhow!("add_frame: {e}"))?;
                cursor_ms += delays_ms.get(i).map(|&ms| ms as i32).unwrap_or(200);
                let _ = prog_tx.send(50.0 + (i + 1) as f64 / n as f64 * 49.0);
            }

            log::warn!("[frame-forge] ANIMATE webp finish start, {} frames added, {} input images", n, n);
            let output = encoder.finish(cursor_ms).map_err(|e| anyhow::anyhow!("finish: {e}"))?;
            log::warn!("[frame-forge] ANIMATE webp finish done, {} bytes", output.len());
            Ok(output)
        } else {
            use gif::{Encoder as GifEnc, Frame as GifFrame, Repeat};
            let gif_speed = if quality <= 0.0 { 1 } else {
                (1.0 + (1.0 - quality.clamp(0.0, 1.0)) * 29.0).round() as i32
            };
            let mut buf = std::io::Cursor::new(Vec::new());
            {
                let mut encoder = GifEnc::new(&mut buf, tw as u16, th as u16, &[])?;
                encoder.set_repeat(if loop_count == 0 { Repeat::Infinite } else { Repeat::Finite(loop_count) })?;
                for (i, img) in images.iter().enumerate() {
                    let scaled = crate::animate::scale_frame(img, tw, th);
                    let mut rgba = scaled.to_rgba8().into_raw();
                    let mut frame = GifFrame::from_rgba_speed(tw as u16, th as u16, &mut rgba, gif_speed);
                    frame.delay = delays_ms.get(i).map(|&ms| (ms / 10).max(2) as u16).unwrap_or(20);
                    encoder.write_frame(&frame)?;
                    let _ = prog_tx.send(50.0 + (i + 1) as f64 / n as f64 * 49.0);
                }
            }
            Ok(buf.into_inner())
        }
    });

    // Forward progress while encoding completes
    tokio::pin!(encode_handle);
    let output = loop {
        tokio::select! {
            result = &mut encode_handle => {
                while let Ok(pct) = prog_rx.try_recv() {
                    send_progress(stream, "running", "encoding", 0, 1, pct).await?;
                }
                break result??;
            }
            Some(pct) = prog_rx.recv() => {
                send_progress(stream, "running", "encoding", 0, 1, pct).await?;
            }
        }
    };

    log::warn!("[frame-forge] ANIMATE encoding done, output {} bytes", output.len());

    // Skip "done" progress — it can block the final output write on Unix socket.
    // C# detects completion via statusCode=2 in the final output.
    let mut header = Vec::with_capacity(8 + output.len());
    header.extend_from_slice(&2u32.to_le_bytes());
    header.extend_from_slice(&(output.len() as u32).to_le_bytes());
    header.extend_from_slice(&output);
    stream.write_all(&header).await?;

    Ok(())
}

async fn handle_stitch(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let req = crate::protocol::read_animate_req(stream).await?;
    log::warn!("[frame-forge] STITCH task={} frames={}", req.task_id, req.paths.len());

    // Load frame index (same pattern as animate)
    let fi = {
        let p = req.paths.first().map(|(p, _)| p.clone()).unwrap_or_default();
        state.fi.get_or_build(&p).await?
    };
    let (fi_frames, _, _) = fi.as_ref();

    send_progress(stream, "running", "decoding", 0, req.paths.len() as u32, 0.0).await?;
    let mut images: Vec<image::DynamicImage> = Vec::with_capacity(req.paths.len());
    for (i, (path, frame_idx)) in req.paths.iter().enumerate() {
        let pos_ms = if *frame_idx >= 0 && (*frame_idx as usize) < fi_frames.len() {
            fi_frames[*frame_idx as usize].0
        } else {
            0
        };

        let img = if let Some(cached) = state.disk.read(&req.item_id, path, pos_ms, 0) {
            log::warn!("[frame-forge] STITCH frame {} → disk cache hit", i);
            image::load_from_memory(&cached)?
        } else {
            log::warn!("[frame-forge] STITCH frame {} → decode", i);
            let p = path.clone();
            let r = tokio::task::spawn_blocking(move || jfs_common::decode_and_encode(&p, pos_ms, 0)).await??;
            image::load_from_memory(&r.webp)?
        };

        images.push(img);
        send_progress(
            stream, "running", "decoding",
            (i + 1) as u32, req.paths.len() as u32,
            (i + 1) as f64 / req.paths.len() as f64 * 30.0,
        ).await?;
    }

    send_progress(stream, "running", "classifying", 0, 1, 30.0).await?;
    let _hashes: Vec<u64> = images.iter().map(|img| crate::scene_classifier::phash(img)).collect();

    let crop_rect = crate::quality::detect_border_crop(&images[0], 5.0);
    let images: Vec<image::DynamicImage> = images.iter()
        .map(|img| crate::quality::crop_image(img, crop_rect))
        .collect();
    log::debug!(
        "[frame-forge] auto-crop: ({},{})→({},{}) → {}x{}",
        crop_rect.0, crop_rect.1, crop_rect.2, crop_rect.3,
        images[0].width(), images[0].height()
    );

    let class = crate::scene_classifier::classify(&images);
    log::debug!(
        "[frame-forge] scene={:?} motion={:?} edge={:.3} entropy={:.1}",
        class.category, class.motion, class.edge_density, class.color_entropy
    );

    send_progress(stream, "running", &format!("{:?}", class.category).to_lowercase(), 0, 1, 35.0).await?;
    send_progress(stream, "running", "matching", 0, 1, 40.0).await?;

    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<image::DynamicImage> {
        match class.category {
            crate::scene_classifier::SceneCategory::Anime => crate::stitch_anime::stitch_anime(&images),
            #[cfg(feature = "opencv")]
            crate::scene_classifier::SceneCategory::Landscape => crate::stitch_landscape::stitch_landscape(&images),
            #[cfg(feature = "opencv")]
            crate::scene_classifier::SceneCategory::LiveAction => crate::stitch_liveaction::stitch_liveaction(&images),
            #[cfg(not(feature = "opencv"))]
            _ => crate::stitch_anime::stitch_anime(&images),
        }
    }).await??;

    send_progress(stream, "running", "encoding", 0, 1, 85.0).await?;

    let enc_format = req.format;
    let enc_quality = req.quality;
    let output = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        if enc_format.is_webp() {
            let rgba = result.to_rgba8();
            let (w, h) = (rgba.width(), rgba.height());
            let data = if enc_quality <= 0.0 {
                webpx::Encoder::new_rgba(rgba.as_raw(), w, h)
                    .lossless(true)
                    .encode(enough::Unstoppable)?
            } else {
                webpx::Encoder::new_rgba(rgba.as_raw(), w, h)
                    .quality(enc_quality.clamp(0.01, 1.0) * 100.0)
                    .encode(enough::Unstoppable)?
            };
            Ok(data)
        } else {
            use image::codecs::png::{PngEncoder, CompressionType, FilterType};
            use image::ImageEncoder;
            let rgba = result.to_rgba8();
            let (w, h) = (rgba.width(), rgba.height());
            let comp = if enc_quality <= 0.5 { CompressionType::Best } else { CompressionType::Default };
            let mut out_buf = std::io::Cursor::new(Vec::new());
            PngEncoder::new_with_quality(&mut out_buf, comp, FilterType::Adaptive)
                .write_image(rgba.as_raw(), w, h, image::ExtendedColorType::Rgba8)?;
            Ok(out_buf.into_inner())
        }
    }).await??;

    log::warn!("[frame-forge] STITCH encoding done, output {} bytes", output.len());

    // Skip "done" progress — C# detects completion via statusCode=2
    let mut header = Vec::with_capacity(8 + output.len());
    header.extend_from_slice(&2u32.to_le_bytes());
    header.extend_from_slice(&(output.len() as u32).to_le_bytes());
    header.extend_from_slice(&output);
    stream.write_all(&header).await?;

    Ok(())
}

async fn send_progress(
    stream: &mut UnixStream,
    status: &str,
    phase: &str,
    current: u32,
    total: u32,
    percent: f64,
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let json = format!(
        r#"{{"taskId":"","status":"{status}","phase":"{phase}","current":{current},"total":{total},"percent":{percent}}}"#
    );
    let json_bytes = json.as_bytes();
    let status_code: u32 = if status == "error" { 1 } else { 0 };

    let mut buf = Vec::with_capacity(8 + json_bytes.len());
    buf.extend_from_slice(&status_code.to_le_bytes());
    buf.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(json_bytes);
    stream.write_all(&buf).await?;
    Ok(())
}

// ── MSG_INDEX_FRAMES (0x15): return frame index for a video ─────────
/// Request: [path_len(4)][path(N)]
/// Response: [frame_count(4)][fps_num(8)][fps_den(8)] × [pts_ms(8)][is_key(1)]

async fn handle_index_frames(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    use crate::protocol::write_frame_index;

    let mut pl_buf = [0u8; 4];
    stream.read_exact(&mut pl_buf).await?;
    let path_len = u32::from_le_bytes(pl_buf) as usize;
    let mut pbytes = vec![0u8; path_len];
    stream.read_exact(&mut pbytes).await?;
    let path = PathBuf::from(String::from_utf8(pbytes)?);

    let idx = state.fi.get_or_build(&path).await?;
    let (frames, fps_num, fps_den) = idx.as_ref();
    write_frame_index(stream, frames, *fps_num, *fps_den).await
}

// ── MSG_PREFETCH_RANGE (0x16): decode frames by index range ──────────
/// Uses PTS comparison to select frames, not frame counts.
/// Backward: frames where pts_ms ∈ [center_ms - before_seconds*1000, center_ms]
/// Forward:  frames where pts_ms ∈ (center_ms, center_ms + after_seconds*1000]
/// include_start controls whether frame at start_idx is included.

async fn handle_prefetch_range(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    let req = read_prefetch_range_req(stream).await?;

    let idx = state.fi.get_or_build(&req.path).await?;

    let (frames, _, _) = idx.as_ref();
    let si = req.start_idx.max(0) as usize;
    if si >= frames.len() { return write_ack(stream, 0).await; }

    let center_ms = frames[si].0;
    let before_ms = (req.before_seconds * 1000.0).round() as i64;
    let after_ms  = (req.after_seconds  * 1000.0).round() as i64;

    // Backward: pts_ms ∈ [center_ms - before_ms, center_ms)
    // Skip start frame if !include_start
    if before_ms > 0 {
        let mut i = si;
        loop {
            if !req.include_start && i == si { if i == 0 { break; } i -= 1; continue; }
            let pts = frames[i].0;
            if pts < center_ms - before_ms { break; }
            let job = PrefetchJob {
                item_id: req.item_id.clone(), path: req.path.clone(),
                pos_ms: pts, width: req.width,
            };
            state.in_progress.lock().await.insert((req.item_id.clone(), pts, req.width));
            if state.prefetch_tx.try_send(job).is_err() {
                state.in_progress.lock().await.remove(&(req.item_id.clone(), pts, req.width));
            }
            if i == 0 { break; }
            i -= 1;
        }
    }

    // Forward: pts_ms ∈ (center_ms, center_ms + after_ms]
    // Skip start frame if !include_start
    if after_ms > 0 {
        let upper = center_ms + after_ms;
        let mut i = si;
        loop {
            if !req.include_start && i == si { i += 1; if i >= frames.len() { break; } continue; }
            let pts = frames[i].0;
            if pts > upper { break; }
            let job = PrefetchJob {
                item_id: req.item_id.clone(), path: req.path.clone(),
                pos_ms: pts, width: req.width,
            };
            state.in_progress.lock().await.insert((req.item_id.clone(), pts, req.width));
            if state.prefetch_tx.try_send(job).is_err() {
                state.in_progress.lock().await.remove(&(req.item_id.clone(), pts, req.width));
            }
            i += 1;
            if i >= frames.len() { break; }
        }
    }

    // includeStart=true, before_seconds=0, after_seconds=0: decode just the start frame
    if req.include_start && before_ms == 0 && after_ms == 0 {
        let pts = frames[si].0;
        let job = PrefetchJob {
            item_id: req.item_id.clone(), path: req.path.clone(),
            pos_ms: pts, width: req.width,
        };
        state.in_progress.lock().await.insert((req.item_id.clone(), pts, req.width));
        if state.prefetch_tx.try_send(job).is_err() {
            state.in_progress.lock().await.remove(&(req.item_id.clone(), pts, req.width));
        }
    }

    write_ack(stream, 0).await
}

// ── MSG_INDEX_FRAMES_STREAM (0x17): SSE stream of frame index ───────────────

const BATCH_SIZE: usize = 5000;

fn make_batch(entries: &[(usize, i64, bool)]) -> Vec<u8> {
    let items: Vec<_> = entries.iter().map(|(fi, ms, is_key)| FrameIndexEntry {
        frame_index: *fi as i64, ms: *ms, is_key: *is_key,
    }).collect();
    let json = serde_json::to_string(&items).unwrap_or_default();
    format!("data: {}\n\n", json).into_bytes()
}

async fn write_chunk(stream: &mut UnixStream, bytes: &[u8]) -> std::io::Result<()> {
    stream.write_all(&(bytes.len() as u32).to_le_bytes()).await?;
    stream.write_all(bytes).await?;
    Ok(())
}

/// 队列 A：seek demux ±1s，用估计帧号发送 SSE。
/// 若该路径的帧索引已缓存，直接 binary_search，无需打开文件。
async fn queue_a_demux(
    path: PathBuf,
    current_time_ms: i64,
    tx: mpsc::UnboundedSender<Vec<u8>>,
    state: Arc<State>,
) -> anyhow::Result<()> {
    let t0 = bench_now_ms();
    let p_start = (current_time_ms - 1000).max(0);
    let p_end = current_time_ms + 1000;

    // Fast path: use in-memory index (populated by queue_b or resolve_frame_idx)
    if let Some(idx) = state.fi.get(&path).await {
        let (frames, _, _) = idx.as_ref();
        let start = frames.partition_point(|(ms, _)| *ms < p_start);
        let mut batch = Vec::new();
        let mut sent = 0usize;
        for (i, (ms, is_key)) in frames[start..].iter().enumerate() {
            if *ms > p_end { break; }
            batch.push((start + i, *ms, *is_key));
            if batch.len() >= BATCH_SIZE {
                tx.send(make_batch(&batch)).ok();
                sent += batch.len();
                batch.clear();
            }
        }
        if !batch.is_empty() {
            sent += batch.len();
            tx.send(make_batch(&batch)).ok();
        }
        log::debug!("[bench][queue_a] +{}ms fast_path_done current_time={current_time_ms} range=[{p_start},{p_end}] sent={sent} abs={}", bench_now_ms() - t0, bench_now_ms());
        return Ok(());
    }

    // Slow path: open file, seek, demux ±1s window
    log::debug!("[bench][queue_a] +{}ms slow_path_open_file abs={}", bench_now_ms() - t0, bench_now_ms());
    let tx_inner = tx.clone();
    let sent = tokio::task::spawn_blocking(move || -> anyhow::Result<usize> {
        use ffmpeg_next as ff;
        let mut ictx = ff::format::input(&path)
            .map_err(|e| anyhow::anyhow!("open {:?}: {}", path, e))?;

        let (stream_idx, fps_num, fps_den, stream_start_ms) = {
            let s = ictx.streams().best(ff::media::Type::Video)
                .ok_or_else(|| anyhow::anyhow!("no video stream"))?;
            let rate = s.avg_frame_rate();
            let fps_num = rate.0 as i64;
            let fps_den = if rate.1 > 0 { rate.1 as i64 } else { 1 };
            let tb = s.time_base();
            let start_pts = s.start_time().max(0);
            let sms = if start_pts > 0 && tb.0 != 0 && tb.1 != 0 {
                (start_pts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64
            } else { 0 };
            (s.index(), fps_num, fps_den, sms)
        };

        ictx.seek(p_start * 1000, ..p_start * 1000)?;

        let mut batch = Vec::new();
        let mut total = 0usize;

        for (stream, pkt) in ictx.packets() {
            if stream.index() != stream_idx { continue; }
            let pts = pkt.pts().or_else(|| pkt.dts()).unwrap_or(0);
            let tb = stream.time_base();
            let raw_ms = (pts as f64 * tb.numerator() as f64 * 1000.0
                         / tb.denominator() as f64) as i64;
            let ms = (raw_ms - stream_start_ms).max(0);

            if ms < p_start { continue; }
            if ms > p_end { break; }

            let fi = compute_frame_idx(ms, fps_num, fps_den) as usize;
            batch.push((fi, ms, pkt.is_key()));
            total += 1;

            if batch.len() >= BATCH_SIZE {
                tx_inner.send(make_batch(&batch)).ok();
                batch.clear();
            }
        }

        if !batch.is_empty() {
            tx_inner.send(make_batch(&batch)).ok();
        }

        Ok(total)
    }).await??;
    log::debug!("[bench][queue_a] +{}ms slow_path_done current_time={current_time_ms} range=[{p_start},{p_end}] sent={sent} abs={}", bench_now_ms() - t0, bench_now_ms());

    Ok(())
}

/// 队列 B：从 0 顺序全量 demux（无 skip），通过 IndexProgress 广播给所有订阅者。
/// 完成后将完整帧索引写入 state.frame_index，并从 index_in_progress 中移除自身。
async fn queue_b_demux(
    path: PathBuf,
    progress: Arc<IndexProgress>,
    state: Arc<State>,
) -> anyhow::Result<()> {
    let path_spawn = path.clone();
    let progress_inner = progress.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<(i64, i64, Vec<(i64, bool)>)> {
        use ffmpeg_next as ff;
        let mut ictx = ff::format::input(&path_spawn)
            .map_err(|e| anyhow::anyhow!("open {:?}: {}", path_spawn, e))?;

        let (stream_idx, fps_num, fps_den, stream_start_ms) = {
            let s = ictx.streams().best(ff::media::Type::Video)
                .ok_or_else(|| anyhow::anyhow!("no video stream"))?;
            let rate = s.avg_frame_rate();
            let fps_num = rate.0 as i64;
            let fps_den = if rate.1 > 0 { rate.1 as i64 } else { 1 };
            let tb = s.time_base();
            let start_pts = s.start_time().max(0);
            let sms = if start_pts > 0 && tb.0 != 0 && tb.1 != 0 {
                (start_pts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64
            } else { 0 };
            (s.index(), fps_num, fps_den, sms)
        };

        // fps 已知，立即发出，无需等全量 demux 完成
        let fps_first = format!("data: {}\n\n", serde_json::json!({ "fps": { "num": fps_num, "den": fps_den } }));
        progress_inner.push(fps_first.into_bytes(), -1);

        let mut all_frames: Vec<(i64, bool)> = Vec::new();
        let mut batch: Vec<(usize, i64, bool)> = Vec::new();
        let mut max_ms_in_batch = 0_i64;

        for (stream, pkt) in ictx.packets() {
            if stream.index() != stream_idx { continue; }
            let pts = pkt.pts().or_else(|| pkt.dts()).unwrap_or(0);
            let tb = stream.time_base();
            let raw_ms = (pts as f64 * tb.numerator() as f64 * 1000.0
                         / tb.denominator() as f64) as i64;
            let ms = (raw_ms - stream_start_ms).max(0);
            let is_key = pkt.is_key();

            let fi = all_frames.len(); // 用顺序计数作为帧号，与 index_frames 一致
            all_frames.push((ms, is_key));
            batch.push((fi, ms, is_key));
            max_ms_in_batch = max_ms_in_batch.max(ms);

            if batch.len() >= BATCH_SIZE {
                progress_inner.push(make_batch(&batch), max_ms_in_batch);
                batch.clear();
                max_ms_in_batch = 0;
            }
        }

        if !batch.is_empty() {
            progress_inner.push(make_batch(&batch), max_ms_in_batch);
        }

        Ok((fps_num, fps_den, all_frames))
    }).await??;

    let (fps_num, fps_den, all_frames) = result;

    // 写入帧索引缓存，供后续请求直接使用
    let new_idx = Arc::new((all_frames, fps_num, fps_den));
    state.fi.put_if_absent(path.clone(), new_idx).await;

    // done 结束信号（max_ms = i64::MAX 为终止标记；fps 已在 demux 开始时发出）
    progress.push(b"data: {\"done\":true}\n\n".to_vec(), i64::MAX);
    progress.finish();

    // 从 in_progress 移除，后续请求走缓存快路径
    state.fi.remove_progress(&path).await;

    Ok(())
}

/// INDEX_FRAMES_STREAM (0x17): SSE stream of frame index.
/// 三路分支：
///   1. 缓存命中 → 直接从 state.frame_index 发送全量数据，无需打开文件
///   2. 同路径 Queue B 正在运行 → 订阅其 IndexProgress，回放已有批次 + 等待新批次
///   3. 首次请求 → 创建 IndexProgress，spawn Queue B
/// Queue A（±1s 高优先级窗口）始终先于 Queue B 数据发出。
async fn handle_index_frames_stream(stream: &mut UnixStream, state: Arc<State>) -> anyhow::Result<()> {
    let req = read_index_frames_stream_req(stream).await?;
    stream.write_u32_le(req.request_id).await?;

    let t0 = bench_now_ms();
    log::debug!("[bench][frameinfo] recv current_time_ms={} abs={t0}", req.current_time_ms);

    // ── 分支 1/2/3：根据缓存状态分发 ─────────────────────────────────────────
    let progress = match state.fi.get_or_subscribe(&req.path).await {
        FrameInfoSubscription::Cached(idx) => {
            let (frames, fps_num, fps_den) = idx.as_ref();
            log::debug!("[bench][frameinfo] +{}ms branch=cache_hit frames={}", bench_now_ms() - t0, frames.len());
            let entries: Vec<(usize, i64, bool)> = frames.iter().enumerate()
                .map(|(i, &(ms, is_key))| (i, ms, is_key))
                .collect();
            // fps 先发，帧批次随后，done 最后
            let fps_msg = format!("data: {}\n\n",
                serde_json::json!({ "fps": { "num": fps_num, "den": fps_den } }));
            write_chunk(stream, fps_msg.as_bytes()).await?;
            for chunk in entries.chunks(BATCH_SIZE) {
                write_chunk(stream, &make_batch(chunk)).await?;
            }
            write_chunk(stream, b"data: {\"done\":true}\n\n").await?;
            stream.write_u32_le(0).await?;
            stream.flush().await?;
            log::debug!("[bench][frameinfo] +{}ms cache_hit_done", bench_now_ms() - t0);
            return Ok(());
        }
        FrameInfoSubscription::Existing(p) => {
            log::debug!("[bench][frameinfo] +{}ms branch=subscribe_existing_queue_b", bench_now_ms() - t0);
            p
        }
        FrameInfoSubscription::New(p) => {
            log::debug!("[bench][frameinfo] +{}ms branch=new_queue_b_spawn", bench_now_ms() - t0);
            let state_b = state.clone();
            let path_b = req.path.clone();
            let p_b = p.clone();
            tokio::spawn(async move {
                if let Err(e) = queue_b_demux(path_b, p_b, state_b).await {
                    log::warn!("[frame-forge] queue_b_demux error: {e}");
                }
            });
            p
        }
    };

    // Queue A：高优先级，demux ±1s 窗口，先于 Queue B 数据到达前端
    let (high_tx, mut high_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    {
        let path_a = req.path.clone();
        let tx_a = high_tx.clone();
        let state_a = state.clone();
        let t = req.current_time_ms;
        tokio::spawn(async move {
            if let Err(e) = queue_a_demux(path_a, t, tx_a, state_a).await {
                log::warn!("[frame-forge] queue_a_demux error: {e}");
            }
        });
    }

    // Bridge：回放 IndexProgress 中已有批次，再等待新批次，直至 done
    let (normal_tx, mut normal_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    {
        let bp = progress;
        tokio::spawn(async move {
            let mut next = 0usize;
            loop {
                // 取出自上次以来新增的批次
                let snapshot: Vec<(Arc<Vec<u8>>, i64)> = {
                    let b = bp.batches.lock().unwrap();
                    b[next..].iter().map(|(a, m)| (a.clone(), *m)).collect()
                };
                let count = snapshot.len();
                for (arc_data, _max_ms) in snapshot {
                    normal_tx.send((*arc_data).clone()).ok();
                }
                next += count;

                if bp.done.load(Ordering::Acquire) {
                    // done 标记与最后一次 push 之间的竞态：再 drain 一次
                    let b = bp.batches.lock().unwrap();
                    for (arc_data, _) in &b[next..] {
                        normal_tx.send((**arc_data).clone()).ok();
                    }
                    break;
                }
                bp.notify.notified().await;
            }
            // normal_tx 在此 drop → 关闭 channel → normal_rx 返回 None
        });
    }

    let mut normal_queue_finished = false;
    let mut first_a_written = false;

    loop {
        tokio::select! {
            biased;

            Some(bytes) = high_rx.recv() => {
                if !first_a_written {
                    first_a_written = true;
                    log::debug!("[bench][frameinfo] +{}ms FIRST_QUEUE_A_CHUNK bytes={}", bench_now_ms() - t0, bytes.len());
                }
                write_chunk(stream, &bytes).await?;
            }

            msg = normal_rx.recv() => {
                match msg {
                    Some(bytes) => write_chunk(stream, &bytes).await?,
                    None => normal_queue_finished = true,
                }
            }
        }

        if normal_queue_finished && high_rx.is_empty() { break; }
    }

    stream.write_u32_le(0).await?;
    stream.flush().await?;
    log::debug!("[bench][frameinfo] +{}ms stream_done", bench_now_ms() - t0);
    Ok(())
}

// ── MSG_PREFETCH_STREAM (0x18): SSE stream of cached frames ─────────────────
/// Request: [path_len(4)][path(N)][item_id(32)][width(4)][count(4)][count × fi_idx(8)]
/// Response: "data: {\"frameReady\":fi_idx}\n\n" per frame, no done signal
async fn handle_prefetch_stream(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut pl_buf = [0u8; 4];
    stream.read_exact(&mut pl_buf).await?;
    let path_len = read_u32(&pl_buf) as usize;
    let mut pbytes = vec![0u8; path_len];
    stream.read_exact(&mut pbytes).await?;
    let path = PathBuf::from(String::from_utf8(pbytes)?);

    let mut id_bytes = [0u8; 32];
    stream.read_exact(&mut id_bytes).await?;
    let item_id = String::from_utf8(id_bytes.to_vec()).unwrap_or_default();

    let mut w_buf = [0u8; 4];
    stream.read_exact(&mut w_buf).await?;
    let width = read_u32(&w_buf);

    let mut c_buf = [0u8; 4];
    stream.read_exact(&mut c_buf).await?;
    let count = read_u32(&c_buf) as usize;

    let mut fi_indices = Vec::with_capacity(count);
    for _ in 0..count {
        let mut fi_buf = [0u8; 8];
        stream.read_exact(&mut fi_buf).await?;
        fi_indices.push(read_i64(&fi_buf));
    }

    for fi_idx in fi_indices {
        if fi_idx < 0 { continue; }
        let pos_ms = resolve_frame_idx(state, &path, fi_idx).await.unwrap_or(0);

        // Check RAM cache
        {
            let ram = state.ram.lock().await;
            if ram.peek(&(path.clone(), pos_ms, width)).is_some() {
                let line = format!("data: {{\"frameReady\":{fi_idx}}}\n\n");
                stream.write_all(line.as_bytes()).await?;
                continue;
            }
        }

        // Check disk cache
        if state.disk.exists(&item_id, &path, pos_ms, width) {
            let line = format!("data: {{\"frameReady\":{fi_idx}}}\n\n");
            stream.write_all(line.as_bytes()).await?;
            continue;
        }

        // Decode and cache
        let path_c = path.clone();
        let disk = state.disk.clone();
        let item_id_c = item_id.clone();
        let ram_state = state.clone();

        let _permit = state.decode_sem.clone().acquire_owned().await?;
        let result = tokio::task::spawn_blocking(move || {
            jfs_common::decode_and_encode(&path_c, pos_ms, width)
        }).await;

        match result {
            Ok(Ok(r)) => {
                if !r.webp_orig.is_empty() {
                    disk.write(&item_id_c, &path, fi_idx, pos_ms, 0, &r.webp_orig);
                }
                disk.write(&item_id_c, &path, fi_idx, pos_ms, width, &r.webp);
                let mut ram = ram_state.ram.lock().await;
                if !r.webp_orig.is_empty() {
                    ram.put((path.clone(), pos_ms, 0), r.webp_orig);
                }
                ram.put((path.clone(), pos_ms, width), r.webp);
                let line = format!("data: {{\"frameReady\":{fi_idx}}}\n\n");
                stream.write_all(line.as_bytes()).await?;
            }
            _ => {
                // decode failed, skip silently
            }
        }
    }

    Ok(())
}

// ── MSG_PREFETCH_RANGE_STREAM (0x19): time-range prefetch with done signal ───
/// Rust resolves frames from in-memory frameinfo (building it if not cached),
/// decodes/caches each, SSEs {"frameReady":fi_idx} per frame + {"done":true}.
/// Response uses length-prefixed chunks for clean socket termination.
///
/// 若帧索引尚未就绪（Queue B 仍在运行），改为对锚点区域做快速 seek+demux，
/// 无需等待全量索引即可立即开始解码，避免长视频阻塞数分钟。
async fn handle_prefetch_range_stream(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let req = read_prefetch_range_stream_req(stream).await?;
    let item_id = req.item_id;
    let path = req.path;
    let width = req.width;
    let current_time_ms = req.current_time_ms;
    let include_current = req.include_current;

    let t0 = bench_now_ms();
    log::debug!("[bench][prefetch] recv current_time_ms={current_time_ms} current_frame_idx={} include_current={include_current} abs={t0}", req.current_frame_idx);

    // 优先用缓存的完整索引；若 Queue B 还在运行则快速 demux 锚点区域
    let (to_process, fps) = if let Some(frame_idx) = state.fi.get(&path).await {
        let (frames, fps_num, fps_den) = frame_idx.as_ref();
        let fps_num_c = *fps_num;
        let fps_den_c = *fps_den;
        log::debug!("[bench][prefetch] +{}ms [priority_adjust] skipped — index cached frames={}", bench_now_ms() - t0, frames.len());

        let anchor_ms = if req.current_frame_idx >= 0 {
            let pos = frames.partition_point(|(ms, _)| {
                compute_frame_idx(*ms, fps_num_c, fps_den_c) < req.current_frame_idx
            });
            frames.get(pos).map(|(ms, _)| *ms).unwrap_or(current_time_ms)
        } else {
            current_time_ms
        };

        let range_start_ms = anchor_ms.saturating_sub(req.before_ms);
        let range_end_ms   = anchor_ms.saturating_add(req.after_ms);
        log::debug!("[bench][prefetch] anchor_ms={anchor_ms} range=[{range_start_ms},{range_end_ms}]");

        let start = frames.partition_point(|(ms, _)| *ms < range_start_ms);
        let mut tp: Vec<(i64, i64)> = Vec::new();
        for (i, &(ms, _)) in frames[start..].iter().enumerate() {
            if ms > range_end_ms { break; }
            if !include_current && ms == anchor_ms { continue; }
            tp.push(((start + i) as i64, ms));
        }
        let fps = if fps_num_c > 0 && fps_den_c > 0 { fps_num_c / fps_den_c } else { 24 };
        (tp, fps)
    } else {
        // 帧索引尚未就绪：对锚点区域做快速 seek+demux，立即开始解码
        let anchor_ms      = current_time_ms; // frame_idx 无法解析，退回时间戳
        let range_start_ms = anchor_ms.saturating_sub(req.before_ms);
        let range_end_ms   = anchor_ms.saturating_add(req.after_ms);
        log::debug!("[bench][prefetch] +{}ms [priority_adjust] index_not_ready → quick_demux anchor={anchor_ms} range=[{range_start_ms},{range_end_ms}]", bench_now_ms() - t0);

        let path_c = path.clone();
        let tp = tokio::task::spawn_blocking(move || -> anyhow::Result<(Vec<(i64, i64)>, i64)> {
            use ffmpeg_next as ff;
            let mut ictx = ff::format::input(&path_c)
                .map_err(|e| anyhow::anyhow!("open {:?}: {}", path_c, e))?;
            let (stream_idx, fps_num, fps_den, stream_start_ms) = {
                let s = ictx.streams().best(ff::media::Type::Video)
                    .ok_or_else(|| anyhow::anyhow!("no video stream"))?;
                let rate = s.avg_frame_rate();
                let fnum = rate.0 as i64;
                let fden = if rate.1 > 0 { rate.1 as i64 } else { 1 };
                let tb   = s.time_base();
                let spts = s.start_time().max(0);
                let sms  = if spts > 0 && tb.0 != 0 && tb.1 != 0 {
                    (spts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64
                } else { 0 };
                (s.index(), fnum, fden, sms)
            };
            let fps = if fps_num > 0 && fps_den > 0 { fps_num / fps_den } else { 24 };
            ictx.seek(range_start_ms * 1000, ..range_start_ms * 1000).unwrap_or(());
            let mut result: Vec<(i64, i64)> = Vec::new();
            for (s, pkt) in ictx.packets() {
                if s.index() != stream_idx { continue; }
                let pts    = pkt.pts().or_else(|| pkt.dts()).unwrap_or(0);
                let tb     = s.time_base();
                let raw_ms = (pts as f64 * tb.numerator() as f64 * 1000.0 / tb.denominator() as f64) as i64;
                let ms     = (raw_ms - stream_start_ms).max(0);
                if ms < range_start_ms { continue; }
                if ms > range_end_ms   { break; }
                result.push((compute_frame_idx(ms, fps_num, fps_den), ms));
            }
            Ok((result, fps))
        }).await??;
        log::debug!("[bench][prefetch] +{}ms [priority_adjust] quick_demux_done frames={}", bench_now_ms() - t0, tp.0.len());
        (tp.0, tp.1)
    };

    log::debug!("[bench][prefetch] +{}ms to_process={}", bench_now_ms() - t0, to_process.len());
    log::debug!("[bench][prefetch] fps={fps} mode=sequential");

    let mut cache_hits = 0usize;
    let mut misses: Vec<(i64, i64)> = Vec::new();

    // Pass 1: emit cache hits immediately, collect misses for sequential decode
    for (fi_idx, pos_ms) in &to_process {
        let fi_idx = *fi_idx;
        let pos_ms = *pos_ms;
        {
            let ram = state.ram.lock().await;
            if ram.peek(&(path.clone(), pos_ms, width)).is_some() {
                cache_hits += 1;
                let thumb = state.disk.make_path(&item_id, fi_idx, pos_ms, width);
                let orig  = state.disk.make_path(&item_id, fi_idx, pos_ms, 0);
                let line = format!(
                    "data: {{\"frameReady\":{fi_idx},\"thumbPath\":\"{}\",\"origPath\":\"{}\"}}\n\n",
                    thumb.to_string_lossy(), orig.to_string_lossy()
                );
                write_chunk(stream, line.as_bytes()).await?;
                continue;
            }
        }
        if state.disk.exists(&item_id, &path, pos_ms, width) {
            cache_hits += 1;
            let thumb = state.disk.make_path(&item_id, fi_idx, pos_ms, width);
            let orig  = state.disk.make_path(&item_id, fi_idx, pos_ms, 0);
            let line = format!(
                "data: {{\"frameReady\":{fi_idx},\"thumbPath\":\"{}\",\"origPath\":\"{}\"}}\n\n",
                thumb.to_string_lossy(), orig.to_string_lossy()
            );
            write_chunk(stream, line.as_bytes()).await?;
            continue;
        }
        misses.push((fi_idx, pos_ms));
    }

    // Pass 2: sequential decode — one file open, one seek, frames arrive progressively via channel
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(i64, i64, Vec<u8>, Vec<u8>)>(misses.len().max(1));
    let path_c    = path.clone();
    let item_id_c = item_id.clone();
    let disk_c    = state.disk.clone();

    tokio::task::spawn_blocking(move || {
        let result = jfs_common::decode_range(&path_c, &misses, width, |fi_idx, pos_ms, webp_thumb, webp_orig| {
            disk_c.write(&item_id_c, &path_c, fi_idx, pos_ms, 0,     &webp_orig);
            disk_c.write(&item_id_c, &path_c, fi_idx, pos_ms, width, &webp_thumb);
            tx.blocking_send((fi_idx, pos_ms, webp_thumb, webp_orig))
                .map_err(|e| anyhow::anyhow!("channel closed: {e}"))
        });
        if let Err(e) = result {
            log::warn!("[frame-forge] sequential prefetch error: {e}");
        }
    });

    let mut decoded = 0usize;
    while let Some((fi_idx, pos_ms, webp_thumb, webp_orig)) = rx.recv().await {
        decoded += 1;
        if decoded == 1 {
            log::debug!("[bench][prefetch] +{}ms FIRST_DECODE_READY fi={fi_idx} abs={}", bench_now_ms() - t0, bench_now_ms());
        }
        {
            let mut ram = state.ram.lock().await;
            ram.put((path.clone(), pos_ms, 0),     webp_orig);
            ram.put((path.clone(), pos_ms, width),  webp_thumb);
        }
        let thumb = state.disk.make_path(&item_id, fi_idx, pos_ms, width);
        let orig  = state.disk.make_path(&item_id, fi_idx, pos_ms, 0);
        let line = format!(
            "data: {{\"frameReady\":{fi_idx},\"thumbPath\":\"{}\",\"origPath\":\"{}\"}}\n\n",
            thumb.to_string_lossy(), orig.to_string_lossy()
        );
        write_chunk(stream, line.as_bytes()).await?;
    }

    log::debug!("[bench][prefetch] +{}ms DONE cache_hits={cache_hits} decoded={decoded} abs={}", bench_now_ms() - t0, bench_now_ms());
    write_chunk(stream, b"data: {\"done\":true}\n\n").await?;
    stream.write_u32_le(0).await?;
    stream.flush().await?;
    Ok(())
}


// ── MSG_DEBUG_DUMP (0x1A): return internal state as JSON ────────────────────
/// Request: (no body)
/// Response: [json_len(4)][json_bytes]
async fn handle_debug_dump(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    let ram_len = state.ram.lock().await.len();
    let fi_cached: Vec<String> = {
        let cache = state.fi.index.read().await;
        cache.iter().map(|(p, _)| p.to_string_lossy().into_owned()).collect()
    };
    let fi_in_progress: Vec<String> = {
        let map = state.fi.in_progress.lock().await;
        map.keys().map(|p| p.to_string_lossy().into_owned()).collect()
    };
    let prefetch_queued = state.in_progress.lock().await.len();

    let json = serde_json::json!({
        "ramEntries":     ram_len,
        "ramCap":         RAM_CACHE_CAP,
        "fiCached":       fi_cached,
        "fiCap":          FRAME_INDEX_CAP,
        "fiInProgress":   fi_in_progress,
        "prefetchQueued": prefetch_queued,
    });
    let bytes = json.to_string().into_bytes();
    stream.write_all(&(bytes.len() as u32).to_le_bytes()).await?;
    stream.write_all(&bytes).await?;
    stream.flush().await?;
    Ok(())
}

fn read_u32(buf: &[u8; 4]) -> u32 {
    u32::from_le_bytes(*buf)
}

fn read_i64(buf: &[u8; 8]) -> i64 {
    i64::from_le_bytes(*buf)
}

fn bench_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

