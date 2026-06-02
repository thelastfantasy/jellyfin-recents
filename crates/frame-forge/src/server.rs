use std::collections::{HashMap, HashSet};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use lru::LruCache;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, Mutex, Semaphore};

use jfs_common::DiskCache;
use jfs_common::FrameIndexEntry;
use crate::protocol::{read_msg_type, read_single_frame_req, read_prefetch_range_req, read_index_frames_stream_req, write_ack, write_jpeg_response};
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

const RAM_CACHE_CAP: usize = 100;
const PREFETCH_WORKERS: usize = 2;
const PREFETCH_QUEUE_CAP: usize = 64;

// RAM cache key: (path, pos_ms, width)
type RamKey = (PathBuf, i64, u32);

struct PrefetchJob {
    item_id: String,
    path: PathBuf,
    pos_ms: i64,
    width: u32,
}

/// Cached frame index per video path: (pts_ms, is_keyframe)[], fps_num, fps_den
type FrameIndexCache = Arc<(Vec<(i64, bool)>, i64, i64)>;

pub struct State {
    pub ram: Mutex<LruCache<RamKey, Vec<u8>>>,
    pub disk: Arc<DiskCache>,
    decode_sem: Arc<Semaphore>,
    prefetch_tx: mpsc::Sender<PrefetchJob>,
    in_progress: Mutex<HashSet<(String, i64, u32)>>,
    frame_index: Mutex<HashMap<PathBuf, FrameIndexCache>>,
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
            frame_index: Mutex::new(HashMap::new()),
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
    let cache = state.frame_index.lock().await;
    let idx = match cache.get(path) { Some(i) => i.clone(), None => {
        drop(cache);
        let p = path.to_path_buf();
        let p2 = p.clone();
        let (frames, fps_num, fps_den) = match tokio::task::spawn_blocking(move || jfs_common::index_frames(&p)).await {
            Ok(Ok(v)) => v,
            _ => return None,
        };
        let i = Arc::new((frames, fps_num, fps_den));
        state.frame_index.lock().await.insert(p2, i.clone());
        i
    }};
    let (frames, _, _) = idx.as_ref();
    let fi = frame_idx as usize;
    if fi < frames.len() { Some(frames[fi].0) } else { None }
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
            Ok(Ok((bytes, actual_pts_ms, fps_num, fps_den))) => {
                let frame_idx = compute_frame_idx(actual_pts_ms, fps_num, fps_den);
                disk.write(&item_id, &job.path, frame_idx, pos_ms, width, &bytes);
                state.ram.lock().await.put((job.path, pos_ms, width), bytes);
                eprintln!("[frame-forge] PREFETCH done: {item_id} f{frame_idx}@{pos_ms}ms w={width}");
            }
            Ok(Err(e)) => eprintln!("[frame-forge] prefetch decode error: {e}"),
            Err(e) => eprintln!("[frame-forge] prefetch spawn error: {e}"),
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
                    eprintln!("[frame-forge] single_frame error: {e}");
                }
            }
            MSG_PREFETCH_FRAME => {
                if let Err(e) = handle_prefetch_frame(&mut stream, &state).await {
                    eprintln!("[frame-forge] prefetch error: {e}");
                }
            }
            MSG_ANIMATE => {
                if let Err(e) = handle_animate(&mut stream, &state).await {
                    eprintln!("[frame-forge] animate error: {e}");
                }
            }
            MSG_STITCH => {
                if let Err(e) = handle_stitch(&mut stream, &state).await {
                    eprintln!("[frame-forge] stitch error: {e}");
                }
            }
            MSG_LIST_CACHED => {
                if let Err(e) = handle_list_cached(&mut stream, &state).await {
                    eprintln!("[frame-forge] list_cached error: {e}");
                    break;
                }
            }
            MSG_INDEX_FRAMES => {
                if let Err(e) = handle_index_frames(&mut stream, &state).await {
                    eprintln!("[frame-forge] index_frames error: {e}");
                    break;
                }
            }
            MSG_PREFETCH_RANGE => {
                if let Err(e) = handle_prefetch_range(&mut stream, &state).await {
                    eprintln!("[frame-forge] prefetch_range error: {e}");
                    break;
                }
            }
            MSG_INDEX_FRAMES_STREAM => {
                if let Err(e) = handle_index_frames_stream(&mut stream, state.clone()).await {
                    eprintln!("[frame-forge] index_frames_stream error: {e}");
                    break;
                }
            }
            MSG_PREFETCH_STREAM => {
                if let Err(e) = handle_prefetch_stream(&mut stream, &state).await {
                    eprintln!("[frame-forge] prefetch_stream error: {e}");
                    break;
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

async fn handle_single_frame(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    let req = read_single_frame_req(stream).await?;

    // Resolve frameIdx → posMs via internal frame index
    let pos_ms = resolve_frame_idx(state, &req.path, req.frame_idx).await
        .unwrap_or(req.frame_idx.max(0));

    // 1. RAM cache
    let ram_key: RamKey = (req.path.clone(), pos_ms, req.width);
    let cached = state.ram.lock().await.get(&ram_key).cloned();
    if let Some(jpeg) = cached {
        let img = image::load_from_memory(&jpeg)?;
        let flags = detect_quality(&img).to_bitmask();
        return write_jpeg_response(stream, req.request_id, &jpeg, flags, -1).await;
    }

    // 2. Disk cache
    if let Some(jpeg) = state.disk.read(&req.item_id, &req.path, pos_ms, req.width) {
        state.ram.lock().await.put(ram_key, jpeg.clone());
        let img = image::load_from_memory(&jpeg)?;
        let flags = detect_quality(&img).to_bitmask();
        return write_jpeg_response(stream, req.request_id, &jpeg, flags, -1).await;
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
        Ok(Ok((jpeg, actual_pts_ms, fps_num, fps_den))) => {
            let frame_idx = compute_frame_idx(actual_pts_ms, fps_num, fps_den);
            state_clone.disk.write(&req.item_id, &req.path, frame_idx, pos_ms, req.width, &jpeg);
            state_clone.ram.lock().await.put(ck, jpeg.clone());
            let img = match image::load_from_memory(&jpeg) {
                Ok(i) => i,
                Err(e) => {
                    eprintln!("[frame-forge] image decode error: {e}");
                    write_ack(stream, req.request_id).await?;
                    return Ok(());
                }
            };
            let flags = detect_quality(&img).to_bitmask();
            write_jpeg_response(stream, req.request_id, &jpeg, flags, actual_pts_ms).await?;
        }
        Ok(Err(e)) => {
            eprintln!("[frame-forge] decode error: {e}");
            write_ack(stream, req.request_id).await?;
        }
        Err(e) => {
            eprintln!("[frame-forge] spawn error: {e}");
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
    eprintln!(
        "[frame-forge] ANIMATE task={} frames={} fmt={} speed={}",
        req.task_id, req.paths.len(), req.format, req.speed
    );

    let total_input = req.paths.len();
    send_progress(stream, "running", "decoding", 0, total_input as u32, 0.0).await?;
    eprintln!("[frame-forge] ANIMATE progress sent, loading frame index...");

    // Load frame index for the first path (all frames share the same video)
    let fi = if let Some((path, _)) = req.paths.first() {
        let cache = state.frame_index.lock().await;
        cache.get(path).cloned()
    } else { None };
    let fi = match fi {
        Some(i) => i,
        None => {
            let p = req.paths.first().map(|(p, _)| p.clone()).unwrap_or_default();
            let p_clone = p.clone();
            let (frames, fps_num, fps_den) = tokio::task::spawn_blocking(move || {
                jfs_common::index_frames(&p_clone)
            }).await??;
            let i = Arc::new((frames, fps_num, fps_den));
            state.frame_index.lock().await.insert(p, i.clone());
            i
        }
    };
    let (fi_frames, _, _) = fi.as_ref();
    eprintln!("[frame-forge] ANIMATE frame index loaded: {} frames", fi_frames.len());

    let mut images: Vec<image::DynamicImage> = Vec::with_capacity(total_input);
    let mut actual_pts_vec: Vec<i64> = Vec::with_capacity(total_input);

    for (i, (path, frame_idx)) in req.paths.iter().enumerate() {
        let p = path.clone();
        let pos_ms = if *frame_idx >= 0 && (*frame_idx as usize) < fi_frames.len() {
            fi_frames[*frame_idx as usize].0
        } else {
            0
        };
        eprintln!("[frame-forge] ANIMATE frame {} idx={} pos_ms={}", i, frame_idx, pos_ms);
        let (bytes, pts_ms, _fps_num, _fps_den) = tokio::task::spawn_blocking(move || jfs_common::decode_and_encode(&p, pos_ms, 0)).await??;

        images.push(image::load_from_memory(&bytes)?);
        actual_pts_vec.push(pts_ms);
        if i == 0 { eprintln!("[frame-forge] ANIMATE first frame decoded"); }
        send_progress(
            stream, "running", "decoding",
            (i + 1) as u32, total_input as u32,
            (i + 1) as f64 / total_input as f64 * 50.0,
        ).await?;
    }
    eprintln!("[frame-forge] ANIMATE decode done, {} images", images.len());

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

    let (tw, th) = if req.target_px > 0 {
        let first = &images[0];
        let (fw, fh) = (first.width(), first.height());
        if req.resize_mode == 0x02 {
            let ratio = req.target_px as f64 / fh as f64;
            ((fw as f64 * ratio) as u32, req.target_px)
        } else {
            let ratio = req.target_px as f64 / fw as f64;
            (req.target_px, (fh as f64 * ratio) as u32)
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
        if format == 0x02 {
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
            eprintln!("[frame-forge] ANIMATE encoder: {}x{} lossless={} quality={}", tw, th, lossless, if lossless { 0.0 } else { quality * 100.0 });

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
                eprintln!("[frame-forge] ANIMATE add_frame {} cursor_ms={} rgba_bytes={}", i, cursor_ms, rgba.len());
                encoder.add_frame_rgba(&rgba, cursor_ms)
                    .map_err(|e| anyhow::anyhow!("add_frame: {e}"))?;
                cursor_ms += delays_ms.get(i).map(|&ms| ms as i32).unwrap_or(200);
                let _ = prog_tx.send(50.0 + (i + 1) as f64 / n as f64 * 49.0);
            }

            eprintln!("[frame-forge] ANIMATE webp finish start, {} frames added, {} input images", n, n);
            let output = encoder.finish(cursor_ms).map_err(|e| anyhow::anyhow!("finish: {e}"))?;
            eprintln!("[frame-forge] ANIMATE webp finish done, {} bytes", output.len());
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

    eprintln!("[frame-forge] ANIMATE encoding done, output {} bytes", output.len());

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
    eprintln!("[frame-forge] STITCH task={} frames={}", req.task_id, req.paths.len());

    // Load frame index (same pattern as animate)
    let fi = if let Some((path, _)) = req.paths.first() {
        let cache = state.frame_index.lock().await;
        cache.get(path).cloned()
    } else { None };
    let fi = match fi {
        Some(i) => i,
        None => {
            let p = req.paths.first().map(|(p, _)| p.clone()).unwrap_or_default();
            let p_clone = p.clone();
            let (frames, fps_num, fps_den) = tokio::task::spawn_blocking(move || {
                jfs_common::index_frames(&p_clone)
            }).await??;
            let i = Arc::new((frames, fps_num, fps_den));
            state.frame_index.lock().await.insert(p, i.clone());
            i
        }
    };
    let (fi_frames, _, _) = fi.as_ref();

    send_progress(stream, "running", "decoding", 0, req.paths.len() as u32, 0.0).await?;
    let mut images: Vec<image::DynamicImage> = Vec::with_capacity(req.paths.len());
    for (i, (path, frame_idx)) in req.paths.iter().enumerate() {
        let p = path.clone();
        let pos_ms = if *frame_idx >= 0 && (*frame_idx as usize) < fi_frames.len() {
            fi_frames[*frame_idx as usize].0
        } else {
            0
        };
        let (bytes, ..) = tokio::task::spawn_blocking(move || jfs_common::decode_and_encode(&p, pos_ms, 0)).await??;
        images.push(image::load_from_memory(&bytes)?);
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
    eprintln!(
        "[frame-forge] auto-crop: ({},{})→({},{}) → {}x{}",
        crop_rect.0, crop_rect.1, crop_rect.2, crop_rect.3,
        images[0].width(), images[0].height()
    );

    let class = crate::scene_classifier::classify(&images);
    eprintln!(
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
        if enc_format == 0x02 {
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

    eprintln!("[frame-forge] STITCH encoding done, output {} bytes", output.len());

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

    // Check cache
    {
        let cache = state.frame_index.lock().await;
        if let Some(idx) = cache.get(&path) {
    let (frames, fps_num, fps_den) = idx.as_ref();
            return write_frame_index(stream, frames, *fps_num, *fps_den).await;
        }
    }

    // Load frame index
    let path_clone = path.clone();
    let (frames, fps_num, fps_den) = tokio::task::spawn_blocking(move || {
        jfs_common::index_frames(&path_clone)
    }).await??;

    let idx = Arc::new((frames.clone(), fps_num, fps_den));
    state.frame_index.lock().await.insert(path, idx);

    write_frame_index(stream, &frames, fps_num, fps_den).await
}

// ── MSG_PREFETCH_RANGE (0x16): decode frames by index range ──────────
/// Uses PTS comparison to select frames, not frame counts.
/// Backward: frames where pts_ms ∈ [center_ms - before_seconds*1000, center_ms]
/// Forward:  frames where pts_ms ∈ (center_ms, center_ms + after_seconds*1000]
/// include_start controls whether frame at start_idx is included.

async fn handle_prefetch_range(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    let req = read_prefetch_range_req(stream).await?;

    // Load/cache frame index
    let idx = {
        let cache = state.frame_index.lock().await;
        cache.get(&req.path).cloned()
    };
    let idx = match idx {
        Some(i) => i,
        None => {
            let path_clone = req.path.clone();
            let (frames, fps_num, fps_den) = tokio::task::spawn_blocking(move || {
                jfs_common::index_frames(&path_clone)
            }).await??;
            let i = Arc::new((frames, fps_num, fps_den));
            state.frame_index.lock().await.insert(req.path.clone(), i.clone());
            i
        }
    };

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

const BATCH_SIZE: usize = 200;

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

/// 队列 A：seek demux ±1s，用估计帧号发送 SSE
async fn queue_a_demux(
    path: PathBuf,
    current_time_ms: i64,
    tx: mpsc::UnboundedSender<Vec<u8>>,
) -> anyhow::Result<()> {
    let p_start = (current_time_ms - 1000).max(0);
    let p_end = current_time_ms + 1000;

    let tx_inner = tx.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        use ffmpeg_next as ff;
        let mut ictx = ff::format::input(&path).map_err(|e| anyhow::anyhow!("open {:?}: {}", path, e))?;
        let stream_idx = ictx.streams().best(ff::media::Type::Video)
            .ok_or_else(|| anyhow::anyhow!("no video stream"))?.index();
        
        // 估计帧号用
        let (fps_num, fps_den) = {
            let s = ictx.streams().best(ff::media::Type::Video)
                .ok_or_else(|| anyhow::anyhow!("no video"))?;
            let rate = s.avg_frame_rate();
            (rate.0 as i64, if rate.1 > 0 { rate.1 as i64 } else { 1 })
        };
        
        ictx.seek((p_start as i64) * 1000, ..(p_start as i64) * 1000)?;
        
        let mut batch = Vec::new();
        
        for (stream, pkt) in ictx.packets() {
            if stream.index() != stream_idx { continue; }
            let pts = pkt.pts().or_else(|| pkt.dts()).unwrap_or(0);
            let ms = (pts as f64 * stream.time_base().numerator() as f64 * 1000.0 
                     / stream.time_base().denominator() as f64) as i64;
            
            if ms < p_start { continue; }
            if ms > p_end { break; }
            
            let fi = ((ms * fps_num + fps_den * 500) / (fps_den * 1000)) as usize;
            batch.push((fi, ms, pkt.is_key()));
            
            if batch.len() >= BATCH_SIZE {
                tx_inner.send(make_batch(&batch)).ok();
                batch.clear();
            }
        }
        
        if !batch.is_empty() {
            tx_inner.send(make_batch(&batch)).ok();
        }
        
        Ok(())
    }).await??;

    Ok(())
}

/// 队列 B：从 0 顺序 demux，通过共享 channel 发送，末尾发 fps 消息
async fn queue_b_demux(
    path: PathBuf,
    tx: mpsc::UnboundedSender<Vec<u8>>,
) -> anyhow::Result<()> {
    let tx_inner = tx.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<(i64, i64)> {
        use ffmpeg_next as ff;
        let mut ictx = ff::format::input(&path).map_err(|e| anyhow::anyhow!("open {:?}: {}", path, e))?;
        let stream_idx = ictx.streams().best(ff::media::Type::Video)
            .ok_or_else(|| anyhow::anyhow!("no video stream"))?.index();
        
        let (fps_num, fps_den) = {
            let s = ictx.streams().best(ff::media::Type::Video)
                .ok_or_else(|| anyhow::anyhow!("no video"))?;
            let rate = s.avg_frame_rate();
            (rate.0 as i64, if rate.1 > 0 { rate.1 as i64 } else { 1 })
        };
        
        let mut batch = Vec::new();
        let mut fi = 0;
        
        for (stream, pkt) in ictx.packets() {
            if stream.index() != stream_idx { continue; }
            let pts = pkt.pts().or_else(|| pkt.dts()).unwrap_or(0);
            let ms = (pts as f64 * stream.time_base().numerator() as f64 * 1000.0 
                     / stream.time_base().denominator() as f64) as i64;
            
            batch.push((fi, ms, pkt.is_key()));
            fi += 1;
            
            if batch.len() >= BATCH_SIZE {
                tx_inner.send(make_batch(&batch)).ok();
                batch.clear();
            }
        }
        
        if !batch.is_empty() {
            tx_inner.send(make_batch(&batch)).ok();
        }
        
        Ok((fps_num, fps_den))
    }).await??;

    // 发送 fps 消息作为流结束信号
    let end_data = format!("data: {}\n\n", serde_json::json!({ "fps": { "num": result.0, "den": result.1 } }));
    tx.send(end_data.into_bytes()).ok();

    Ok(())
}

/// INDEX_FRAMES_STREAM (0x17): SSE stream of frame index.
/// 共享 channel：Queue A（优先 seek demux）+ Queue B（顺序 demux）都发到同一 channel
async fn handle_index_frames_stream(stream: &mut UnixStream, _state: Arc<State>) -> anyhow::Result<()> {
    let req = read_index_frames_stream_req(stream).await?;

    stream.write_u32_le(req.request_id).await?;

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();

    // Queue B（全量 demux，精确帧号）
    let tx_b = tx.clone();
    let path_b = req.path.clone();
    tokio::spawn(async move {
        if let Err(e) = queue_b_demux(path_b, tx_b).await {
            eprintln!("[frame-forge] queue_b_demux error: {e}");
        }
    });

    // Queue A（优先 seek demux，估计帧号）
    let tx_a = tx;
    let path_a = req.path.clone();
    tokio::spawn(async move {
        if let Err(e) = queue_a_demux(path_a, req.current_time_ms, tx_a).await {
            eprintln!("[frame-forge] queue_a_demux error: {e}");
        }
    });

    while let Some(bytes) = rx.recv().await {
        write_chunk(stream, &bytes).await?;
    }

    stream.write_u32_le(0).await?;
    stream.flush().await?;
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
            Ok(Ok((bytes, actual_pts_ms, fps_num, fps_den))) => {
                let fi = compute_frame_idx(actual_pts_ms, fps_num, fps_den);
                disk.write(&item_id_c, &path, fi, pos_ms, width, &bytes);
                ram_state.ram.lock().await.put((path.clone(), pos_ms, width), bytes);
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

fn read_u32(buf: &[u8; 4]) -> u32 {
    u32::from_le_bytes(*buf)
}

fn read_i64(buf: &[u8; 8]) -> i64 {
    i64::from_le_bytes(*buf)
}

