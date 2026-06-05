use jfs_common::{decode_and_encode, compute_frame_idx};
use jfs_common::DiskCache;
use crate::protocol::{read_priority, read_req_body, write_ack, write_response};
use lru::LruCache;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{Mutex, Semaphore};

const PRIORITY_FETCH: u8 = 0x01;
const PRIORITY_PREFETCH: u8 = 0x02;
const PRIORITY_LIST: u8 = 0x03;
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

#[derive(Clone)]
struct CacheEntry {
    webp: Arc<Vec<u8>>,
    meta: FrameMeta,
}

pub struct State {
    cache: Mutex<LruCache<CacheKey, CacheEntry>>,
    pub disk: Arc<DiskCache>,
    active_item_id: Mutex<Option<String>>,
    decode_sem: Arc<Semaphore>,
}

impl State {
    pub fn new(disk: Arc<DiskCache>) -> Arc<Self> {
        Arc::new(Self {
            cache: Mutex::new(LruCache::new(NonZeroUsize::new(CACHE_CAP).unwrap())),
            disk,
            active_item_id: Mutex::new(None),
            decode_sem: Arc::new(Semaphore::new(1)),
        })
    }
}

async fn evict_on_switch(state: &Arc<State>, item_id: &str) {
    let mut active = state.active_item_id.lock().await;
    if active.as_deref() != Some(item_id) {
        if active.is_some() { state.cache.lock().await.clear(); }
        *active = Some(item_id.to_owned());
    }
}

pub async fn handle_conn(mut stream: UnixStream, state: Arc<State>) {
    loop {
        let priority = match read_priority(&mut stream).await { Ok(p) => p, Err(_) => break };
        match priority {
            PRIORITY_FETCH | PRIORITY_PREFETCH => {
                let req = match read_req_body(&mut stream, priority).await { Ok(r) => r, Err(_) => break };
                evict_on_switch(&state, &req.item_id).await;
                let key = CacheKey { item_id: req.item_id.clone(), pos_ms: req.pos_ms, width: req.width };
                let is_fetch = priority == PRIORITY_FETCH;
                let pos_ms = req.pos_ms;
                let width = req.width;
                let cached = { state.cache.lock().await.get(&key).cloned() };
                if let Some(entry) = cached {
                    if is_fetch { let _ = write_response(&mut stream, req.request_id, &entry.webp).await; }
                    else { let _ = write_ack(&mut stream, req.request_id).await; }
                    continue;
                }
                if is_fetch {
                    if let Some(webp) = state.disk.read(&req.item_id, &req.path, pos_ms, width) {
                        let arc = Arc::new(webp);
                        let entry = CacheEntry { webp: arc.clone(), meta: FrameMeta { actual_pts_ms: -1, fps_num: 0, fps_den: 1 } };
                        state.cache.lock().await.put(key, entry);
                        let _ = write_response(&mut stream, req.request_id, &arc).await;
                        continue;
                    }
                } else if state.disk.exists(&req.item_id, &req.path, pos_ms, width) {
                    let _ = write_ack(&mut stream, req.request_id).await;
                    continue;
                }
                let disk = state.disk.clone();
                let item_id = req.item_id.clone();
                let path = req.path.clone();
                let s2 = state.clone();
                let k2 = key.clone();
                let _permit = if is_fetch { Some(state.decode_sem.clone().acquire_owned().await.unwrap()) } else { None };
                match tokio::task::spawn_blocking(move || -> anyhow::Result<(Vec<u8>, FrameMeta)> {
                    let _p = _permit;
                    let r = decode_and_encode(&path, pos_ms, width)?;
                    let frame_idx = compute_frame_idx(r.pts_ms, r.fps_num, r.fps_den);
                    disk.write(&item_id, &path, frame_idx, pos_ms, width, &r.webp);
                    Ok((r.webp, FrameMeta { actual_pts_ms: r.pts_ms, fps_num: r.fps_num, fps_den: r.fps_den }))
                }).await {
                    Ok(Ok((bytes, meta))) => {
                        let arc = Arc::new(bytes);
                        s2.cache.lock().await.put(k2, CacheEntry { webp: arc.clone(), meta });
                        if is_fetch { let _ = write_response(&mut stream, req.request_id, &arc).await; }
                        else { let _ = write_ack(&mut stream, req.request_id).await; }
                    }
                    _ => { let _ = write_ack(&mut stream, req.request_id).await; }
                }
            }
            PRIORITY_LIST => { if handle_list_cached(&mut stream, &state).await.is_err() { break; } }
            _ => { eprintln!("[seek-preview] unknown priority: 0x{priority:02x}"); break; }
        }
    }
}

async fn handle_list_cached(stream: &mut UnixStream, state: &Arc<State>) -> anyhow::Result<()> {
    let request_id = stream.read_u32_le().await?;
    let mut id_bytes = [0u8; 32];
    stream.read_exact(&mut id_bytes).await?;
    let item_id = String::from_utf8(id_bytes.to_vec()).unwrap_or_default();
    let width = stream.read_u32_le().await?;

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
