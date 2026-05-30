use std::collections::HashSet;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Arc;

use lru::LruCache;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, Mutex, Semaphore};

use crate::disk_cache::DiskCache;
use crate::protocol::{read_msg_type, read_single_frame_req, write_ack, write_jpeg_response};
use crate::quality::detect_quality;

const MSG_SINGLE_FRAME: u8 = 0x10;
const MSG_ANIMATE: u8 = 0x11;
const MSG_STITCH: u8 = 0x12;
const MSG_PREFETCH_FRAME: u8 = 0x13;
const MSG_LIST_CACHED: u8 = 0x14;

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

pub struct State {
    pub ram: Mutex<LruCache<RamKey, Vec<u8>>>,
    pub disk: Arc<DiskCache>,
    decode_sem: Arc<Semaphore>,
    prefetch_tx: mpsc::Sender<PrefetchJob>,
    in_progress: Mutex<HashSet<(String, i64, u32)>>,
}

impl State {
    pub fn new() -> Arc<Self> {
        let disk = DiskCache::new();
        let (tx, rx) = mpsc::channel(PREFETCH_QUEUE_CAP);
        let state = Arc::new(Self {
            ram: Mutex::new(LruCache::new(NonZeroUsize::new(RAM_CACHE_CAP).unwrap())),
            disk,
            decode_sem: Arc::new(Semaphore::new(1)),
            prefetch_tx: tx,
            in_progress: Mutex::new(HashSet::new()),
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

        match tokio::task::spawn_blocking(move || crate::decoder::decode_and_encode(&path, pos_ms, width)).await {
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

    // 1. RAM cache (actual_pts_ms unknown from cache → sentinel -1 means "use posMs")
    let ram_key: RamKey = (req.path.clone(), req.pos_ms, req.width);
    let cached = state.ram.lock().await.get(&ram_key).cloned();
    if let Some(jpeg) = cached {
        let img = image::load_from_memory(&jpeg)?;
        let flags = detect_quality(&img).to_bitmask();
        return write_jpeg_response(stream, req.request_id, &jpeg, flags, -1).await;
    }

    // 2. Disk cache
    if let Some(jpeg) = state.disk.read(&req.item_id, &req.path, req.pos_ms, req.width) {
        state.ram.lock().await.put(ram_key, jpeg.clone());
        let img = image::load_from_memory(&jpeg)?;
        let flags = detect_quality(&img).to_bitmask();
        return write_jpeg_response(stream, req.request_id, &jpeg, flags, -1).await;
    }

    // 3. Decode on demand (blocking)
    let path = req.path.clone();
    let pos_ms = req.pos_ms;
    let width = req.width;
    let state_clone = state.clone();
    let ck = ram_key.clone();

    let _permit = state.decode_sem.clone().acquire_owned().await?;
    let result = tokio::task::spawn_blocking(move || {
        crate::decoder::decode_and_encode(&path, pos_ms, width)
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

    // Skip if already cached
    if state.disk.exists(&req.item_id, &req.path, req.pos_ms, req.width) {
        return Ok(());
    }

    let progress_key = (req.item_id.clone(), req.pos_ms, req.width);
    {
        let mut ip = state.in_progress.lock().await;
        if !ip.insert(progress_key) {
            return Ok(()); // already queued
        }
    }

    let _ = state.prefetch_tx.try_send(PrefetchJob {
        item_id: req.item_id,
        path: req.path,
        pos_ms: req.pos_ms,
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

    let positions = state.disk.list_cached(&item_id, width);

    let mut buf = Vec::with_capacity(8 + positions.len() * 8);
    buf.extend_from_slice(&request_id.to_le_bytes());
    buf.extend_from_slice(&(positions.len() as u32).to_le_bytes());
    for pos_ms in positions {
        buf.extend_from_slice(&pos_ms.to_le_bytes());
    }
    stream.write_all(&buf).await?;
    stream.flush().await?;
    Ok(())
}

async fn handle_animate(stream: &mut UnixStream, _state: &Arc<State>) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    use tokio::sync::mpsc;

    let req = crate::protocol::read_animate_req(stream).await?;
    eprintln!(
        "[frame-forge] ANIMATE task={} frames={} fmt={} speed={}",
        req.task_id, req.paths.len(), req.format, req.speed
    );

    let total_input = req.paths.len();
    send_progress(stream, "running", "decoding", 0, total_input as u32, 0.0).await?;

    let mut images: Vec<image::DynamicImage> = Vec::with_capacity(total_input);
    let mut actual_pts_vec: Vec<i64> = Vec::with_capacity(total_input);
    let mut last_pts: Option<i64> = None;

    for (i, (path, pos_ms)) in req.paths.iter().enumerate() {
        let p = path.clone();
        let pm = *pos_ms;
        let (bytes, pts_ms, ..) = tokio::task::spawn_blocking(move || crate::decoder::decode_and_encode(&p, pm, 0)).await??;

        // Skip duplicate frames (same actual pts as previous, e.g. two posMs values decode to same frame)
        if last_pts == Some(pts_ms) {
            send_progress(
                stream, "running", "decoding",
                (i + 1) as u32, total_input as u32,
                (i + 1) as f64 / total_input as f64 * 50.0,
            ).await?;
            continue;
        }

        last_pts = Some(pts_ms);
        images.push(image::load_from_memory(&bytes)?);
        actual_pts_vec.push(pts_ms);
        send_progress(
            stream, "running", "decoding",
            (i + 1) as u32, total_input as u32,
            (i + 1) as f64 / total_input as f64 * 50.0,
        ).await?;
    }

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
    // Compute delays from actual decoded pts differences (accurate for both CFR and VFR)
    let delays_ms: Vec<u32> = (0..n).map(|i| {
        let gap_ms = if i + 1 < n {
            (actual_pts_vec[i + 1] - actual_pts_vec[i]).unsigned_abs() as f32
        } else if i > 0 {
            (actual_pts_vec[i] - actual_pts_vec[i - 1]).unsigned_abs() as f32
        } else {
            200.0
        };
        ((gap_ms / speed).max(10.0)) as u32
    }).collect();

    // Per-frame scale+encode with progress reported via channel (50%→100%)
    let (prog_tx, mut prog_rx) = mpsc::channel::<f64>(n + 4);
    let format = req.format;
    let loop_count = req.loop_count;
    let quality = req.quality;

    let encode_handle = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let n = images.len();
        if format == 0x02 {
            use image::imageops;
            let lossless = quality <= 0.0;
            let quality_val: u32 = if lossless { 0 } else { (quality.clamp(0.01, 1.0) * 100.0) as u32 };
            let mut encoder = webpx::AnimationEncoder::with_options(tw, th, lossless, quality_val)
                .map_err(|e| anyhow::anyhow!("webp encoder: {e}"))?;
            let mut cursor_ms = 0i32;
            for (i, img) in images.iter().enumerate() {
                let scaled = crate::animate::scale_frame(img, tw, th);
                let rgba = if scaled.width() == tw && scaled.height() == th {
                    scaled.to_rgba8().into_raw()
                } else {
                    let mut padded = image::RgbaImage::new(tw, th);
                    imageops::overlay(&mut padded, &scaled.to_rgba8(), 0, 0);
                    padded.into_raw()
                };
                encoder.add_frame_rgba(&rgba, cursor_ms)
                    .map_err(|e| anyhow::anyhow!("add_frame: {e}"))?;
                cursor_ms += delays_ms.get(i).map(|&ms| ms.max(10) as i32).unwrap_or(200);
                let _ = prog_tx.blocking_send(50.0 + (i + 1) as f64 / n as f64 * 49.0);
            }
            Ok(encoder.finish(cursor_ms).map_err(|e| anyhow::anyhow!("finish: {e}"))?)
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
                    let _ = prog_tx.blocking_send(50.0 + (i + 1) as f64 / n as f64 * 49.0);
                }
            }
            Ok(buf.into_inner())
        }
    });

    // Forward per-frame encoding progress to stream while waiting for completion
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

    send_progress(stream, "running", "done", 1, 1, 100.0).await?;

    let mut header = Vec::with_capacity(8 + output.len());
    header.extend_from_slice(&2u32.to_le_bytes());
    header.extend_from_slice(&(output.len() as u32).to_le_bytes());
    header.extend_from_slice(&output);
    stream.write_all(&header).await?;

    Ok(())
}

async fn handle_stitch(stream: &mut UnixStream, _state: &Arc<State>) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let req = crate::protocol::read_animate_req(stream).await?;
    eprintln!("[frame-forge] STITCH task={} frames={}", req.task_id, req.paths.len());

    send_progress(stream, "running", "decoding", 0, req.paths.len() as u32, 0.0).await?;
    let mut images: Vec<image::DynamicImage> = Vec::with_capacity(req.paths.len());
    for (i, (path, pos_ms)) in req.paths.iter().enumerate() {
        let p = path.clone();
        let pm = *pos_ms;
        let (bytes, ..) = tokio::task::spawn_blocking(move || crate::decoder::decode_and_encode(&p, pm, 0)).await??;
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

    send_progress(stream, "running", "done", 1, 1, 100.0).await?;

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
