use jfs_common::{decode_and_encode, index_frames, compute_frame_idx};
use jfs_common::DiskCache;
use crate::protocol::{read_priority, read_req_body, write_ack, write_response};
use lru::LruCache;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{Mutex, Semaphore};

const PRIORITY_FETCH: u8 = 0x01;
const PRIORITY_PREFETCH: u8 = 0x02;
const PRIORITY_LIST: u8 = 0x03;
const PRIORITY_FRAME_INFO: u8 = 0x04;
const PRIORITY_INDEX_FRAMES: u8 = 0x05;
const CACHE_CAP: usize = 20;

#[derive(Clone, Hash, PartialEq, Eq)]
struct CacheKey {
    item_id: String,
    pos_ms: i64,
    width: u32,
}

#[derive(Clone)]
struct FrameMeta {
    actual_pts_ms: i64,
    fps_num: i64,
    fps_den: i64,
}

/// Cached decode result: JPEG bytes + frame metadata.
/// Populated by every FETCH/PREFETCH decode so FRAME_INFO can reuse without re-decoding.
#[derive(Clone)]
struct CacheEntry {
    jpeg: Arc<Vec<u8>>,
    meta: FrameMeta,
}

pub struct State {
    cache: Mutex<LruCache<CacheKey, CacheEntry>>,
    pub disk: Arc<DiskCache>,
    active_item_id: Mutex<Option<String>>,
    /// Limits concurrent interactive FETCH decodes.
    decode_sem: Arc<Semaphore>,
    /// Per-item frame index: (pts_ms, is_keyframe)[] + fps. Keyed by item_id.
    frame_index: Mutex<HashMap<String, Arc<(Vec<(i64, bool)>, i64, i64)>>>,
}

impl State {
    pub fn new(disk: Arc<DiskCache>) -> Arc<Self> {
        Arc::new(Self {
            cache: Mutex::new(LruCache::new(NonZeroUsize::new(CACHE_CAP).unwrap())),
            disk,
            active_item_id: Mutex::new(None),
            decode_sem: Arc::new(Semaphore::new(1)),
            frame_index: Mutex::new(HashMap::new()),
        })
    }
}

async fn evict_on_switch(state: &Arc<State>, item_id: &str) {
    let mut active = state.active_item_id.lock().await;
    if active.as_deref() != Some(item_id) {
        if active.is_some() {
            state.cache.lock().await.clear();
        }
        *active = Some(item_id.to_owned());
    }
}

pub async fn handle_conn(mut stream: UnixStream, state: Arc<State>) {
    loop {
        let priority = match read_priority(&mut stream).await {
            Ok(p) => p,
            Err(_) => break,
        };

        match priority {
            PRIORITY_FETCH | PRIORITY_PREFETCH => {
                let req = match read_req_body(&mut stream, priority).await {
                    Ok(r) => r,
                    Err(_) => break,
                };
                evict_on_switch(&state, &req.item_id).await;

                let key = CacheKey { item_id: req.item_id.clone(), pos_ms: req.pos_ms, width: req.width };
                let is_fetch = priority == PRIORITY_FETCH;
                let pos_ms = req.pos_ms;
                let width = req.width;

                // RAM cache hit
                let cached = { state.cache.lock().await.get(&key).cloned() };
                if let Some(entry) = cached {
                    if is_fetch {
                        let _ = write_response(&mut stream, req.request_id, &entry.jpeg).await;
                    } else {
                        let _ = write_ack(&mut stream, req.request_id).await;
                    }
                    continue;
                }

                // Disk cache
                if is_fetch {
                    if let Some(jpeg) = state.disk.read(&req.item_id, &req.path, pos_ms, width) {
                        eprintln!("[seek-preview] FETCH disk hit @{pos_ms}ms ({} B)", jpeg.len());
                        let arc = Arc::new(jpeg);
                        // fps unknown from disk cache; store sentinel meta so later FRAME_INFO still triggers decode
                        let entry = CacheEntry { jpeg: arc.clone(), meta: FrameMeta { actual_pts_ms: -1, fps_num: 0, fps_den: 1 } };
                        state.cache.lock().await.put(key, entry);
                        let _ = write_response(&mut stream, req.request_id, &arc).await;
                        continue;
                    }
                } else if state.disk.exists(&req.item_id, &req.path, pos_ms, width) {
                    let _ = write_ack(&mut stream, req.request_id).await;
                    continue;
                }

                // Decode (blocking)
                let disk = state.disk.clone();
                let item_id = req.item_id.clone();
                let path = req.path.clone();
                let s2 = state.clone();
                let k2 = key.clone();

                let _permit = if is_fetch {
                    Some(state.decode_sem.clone().acquire_owned().await.unwrap())
                } else {
                    None
                };

                match tokio::task::spawn_blocking(move || -> anyhow::Result<(Vec<u8>, FrameMeta)> {
                    let _p = _permit;
                    let t = Instant::now();
                    let (bytes, actual_pts_ms, fps_num, fps_den) = decode_and_encode(&path, pos_ms, width)?;
                    let frame_idx = compute_frame_idx(actual_pts_ms, fps_num, fps_den);
                    eprintln!(
                        "[seek-preview] {} f{frame_idx}@{pos_ms}ms → {:.0}ms ({} B)",
                        if is_fetch { "FETCH" } else { "PREFETCH" },
                        t.elapsed().as_secs_f64() * 1000.0,
                        bytes.len()
                    );
                    disk.write(&item_id, &path, frame_idx, pos_ms, width, &bytes);
                    Ok((bytes, FrameMeta { actual_pts_ms, fps_num, fps_den }))
                }).await {
                    Ok(Ok((bytes, meta))) => {
                        let arc = Arc::new(bytes);
                        let entry = CacheEntry { jpeg: arc.clone(), meta };
                        s2.cache.lock().await.put(k2, entry);
                        if is_fetch {
                            let _ = write_response(&mut stream, req.request_id, &arc).await;
                        } else {
                            let _ = write_ack(&mut stream, req.request_id).await;
                        }
                    }
                    _ => {
                        let _ = write_ack(&mut stream, req.request_id).await;
                    }
                }
            }

            PRIORITY_LIST => {
                if handle_list_cached(&mut stream, &state).await.is_err() {
                    break;
                }
            }

            PRIORITY_FRAME_INFO => {
                if handle_frame_info(&mut stream, state.clone()).await.is_err() {
                    break;
                }
            }

            PRIORITY_INDEX_FRAMES => {
                if handle_index_frames(&mut stream, state.clone()).await.is_err() {
                    break;
                }
            }

            _ => {
                eprintln!("[seek-preview] unknown priority: 0x{priority:02x}");
                break;
            }
        }
    }
}

/// FRAME_INFO (0x04): return frame_idx + fps for the given pos_ms.
/// Checks RAM cache first — populated for free by every FETCH/PREFETCH decode.
/// Only decodes if the RAM cache has no valid metadata for this key.
/// Wire response: request_id(4) + frame_idx(8) + fps_num(8) + fps_den(8) = 28 bytes.
/// On error: frame_idx = -1, fps_num = 0, fps_den = 1.
async fn handle_frame_info(stream: &mut UnixStream, state: Arc<State>) -> anyhow::Result<()> {
    let req = read_req_body(stream, PRIORITY_FRAME_INFO).await?;
    let pos_ms = req.pos_ms;
    let key = CacheKey { item_id: req.item_id.clone(), pos_ms, width: req.width };

    // RAM cache hit with valid metadata → return without decoding
    let cached_meta = {
        state.cache.lock().await
            .get(&key)
            .filter(|e| e.meta.fps_num > 0)
            .map(|e| e.meta.clone())
    };

    let meta = if let Some(m) = cached_meta {
        let frame_idx = compute_frame_idx(m.actual_pts_ms, m.fps_num, m.fps_den);
        eprintln!("[seek-preview] FRAME_INFO RAM hit @{pos_ms}ms f{frame_idx}");
        m
    } else {
        // Decode to get accurate pts + fps; also populates RAM cache for future calls
        let path = req.path.clone();
        let permit = state.decode_sem.clone().acquire_owned().await.unwrap();
        let s2 = state.clone();
        let k2 = key.clone();
        let result = tokio::task::spawn_blocking(move || -> anyhow::Result<(Vec<u8>, FrameMeta)> {
            let _p = permit;
            let (bytes, actual_pts_ms, fps_num, fps_den) = decode_and_encode(&path, pos_ms, req.width.max(1))?;
            let frame_idx = compute_frame_idx(actual_pts_ms, fps_num, fps_den);
            eprintln!("[seek-preview] FRAME_INFO decoded @{pos_ms}ms f{frame_idx}");
            Ok((bytes, FrameMeta { actual_pts_ms, fps_num, fps_den }))
        }).await;

        match result {
            Ok(Ok((bytes, meta))) => {
                let arc = Arc::new(bytes);
                let entry = CacheEntry { jpeg: arc, meta: meta.clone() };
                s2.cache.lock().await.put(k2, entry);
                meta
            }
            _ => FrameMeta { actual_pts_ms: -1, fps_num: 0, fps_den: 1 },
        }
    };

    // Wire: request_id(4) + actual_pts_ms(8) + fps_num(8) + fps_den(8) = 28 bytes
    // C# reads actual_pts_ms at offset 4 and computes frame_idx from it.
    let mut buf = [0u8; 28];
    buf[0..4].copy_from_slice(&req.request_id.to_le_bytes());
    buf[4..12].copy_from_slice(&meta.actual_pts_ms.to_le_bytes());
    buf[12..20].copy_from_slice(&meta.fps_num.to_le_bytes());
    buf[20..28].copy_from_slice(&meta.fps_den.to_le_bytes());
    stream.write_all(&buf).await?;
    stream.flush().await?;
    Ok(())
}

/// INDEX_FRAMES (0x05): enumerate all video frame timestamps without decoding.
/// Request:  [request_id(4)][item_id(32)][path_len(4)][path(N)]
/// Response: [request_id(4)][frame_count(4)][fps_num(8)][fps_den(8)]
///           ×frame_count: [pts_ms(8)][flags(1): bit0=keyframe]
async fn handle_index_frames(stream: &mut UnixStream, state: Arc<State>) -> anyhow::Result<()> {
    let request_id = stream.read_u32_le().await?;
    let mut id_bytes = [0u8; 32];
    stream.read_exact(&mut id_bytes).await?;
    let item_id = String::from_utf8(id_bytes.to_vec())?;
    let path_len = stream.read_u32_le().await? as usize;
    let mut path_bytes = vec![0u8; path_len];
    stream.read_exact(&mut path_bytes).await?;
    let path = PathBuf::from(String::from_utf8(path_bytes)?);

    // RAM cache check
    let cached = state.frame_index.lock().await.get(&item_id).cloned();
    let index = if let Some(arc) = cached {
        eprintln!("[seek-preview] INDEX_FRAMES cache hit for {item_id}");
        arc
    } else {
        let path2 = path.clone();
        let result = tokio::task::spawn_blocking(move || index_frames(&path2)).await;
        match result {
            Ok(Ok((frames, fps_num, fps_den))) => {
                eprintln!(
                    "[seek-preview] INDEX_FRAMES {} frames fps={}/{} for {item_id}",
                    frames.len(), fps_num, fps_den
                );
                let arc = Arc::new((frames, fps_num, fps_den));
                state.frame_index.lock().await.insert(item_id.clone(), arc.clone());
                arc
            }
            Ok(Err(e)) => {
                eprintln!("[seek-preview] INDEX_FRAMES error for {item_id}: {e}");
                // Return empty response
                let mut buf = [0u8; 24];
                buf[0..4].copy_from_slice(&request_id.to_le_bytes());
                // frame_count=0, fps_num=0, fps_den=1
                buf[20..24].copy_from_slice(&1i32.to_le_bytes());
                stream.write_all(&buf).await?;
                stream.flush().await?;
                return Ok(());
            }
            Err(e) => {
                eprintln!("[seek-preview] INDEX_FRAMES spawn error: {e}");
                let mut buf = [0u8; 24];
                buf[0..4].copy_from_slice(&request_id.to_le_bytes());
                buf[20..24].copy_from_slice(&1i32.to_le_bytes());
                stream.write_all(&buf).await?;
                stream.flush().await?;
                return Ok(());
            }
        }
    };

    let (frames, fps_num, fps_den) = index.as_ref();
    let frame_count = frames.len() as u32;

    let mut buf = Vec::with_capacity(24 + frames.len() * 9);
    buf.extend_from_slice(&request_id.to_le_bytes());
    buf.extend_from_slice(&frame_count.to_le_bytes());
    buf.extend_from_slice(&fps_num.to_le_bytes());
    buf.extend_from_slice(&fps_den.to_le_bytes());
    for (pts_ms, is_key) in frames {
        buf.extend_from_slice(&pts_ms.to_le_bytes());
        buf.push(if *is_key { 1u8 } else { 0u8 });
    }
    stream.write_all(&buf).await?;
    stream.flush().await?;
    Ok(())
}

async fn handle_list_cached(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    let request_id = stream.read_u32_le().await?;
    let mut id_bytes = [0u8; 32];
    stream.read_exact(&mut id_bytes).await?;
    let item_id = String::from_utf8(id_bytes.to_vec()).unwrap_or_default();
    let width = stream.read_u32_le().await?;

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
