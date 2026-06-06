use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const CAP_BYTES: u64 = 512 * 1024 * 1024; // 512 MB

const TRIM_RATIO: f64 = 0.75;

// ── index ────────────────────────────────────────────────────────────────────

struct Entry {
    frame_idx: i64,
    size: u64,
    written_at: u64,
    video_mtime: u64,
}

#[derive(Default)]
struct Index {
    entries: HashMap<(String, i64, u32), Entry>, // (item_id, pos_ms, width)
    total_bytes: u64,
}

// ── public interface ─────────────────────────────────────────────────────────

pub struct DiskCache {
    label: String,
    cache_dir: PathBuf,
    index_file: PathBuf,
    index: Mutex<Index>,
}

impl DiskCache {
    pub fn new(label: &str) -> Arc<Self> {
        let cache_dir = std::env::temp_dir().join(label);
        let index_file = cache_dir.join("index.txt");
        let _ = std::fs::create_dir_all(&cache_dir);
        sweep_legacy_dirs(&cache_dir, &index_file);
        sweep_legacy_jpgs(&cache_dir);
        let index = load_index(&cache_dir, &index_file).unwrap_or_else(|_| rebuild_index(label, &cache_dir, &index_file));
        eprintln!(
            "[{label}] disk cache: {:.1} MB used / {:.0} MB cap ({} entries)",
            index.total_bytes as f64 / 1e6,
            CAP_BYTES as f64 / 1e6,
            index.entries.len(),
        );
        Arc::new(Self { label: label.to_owned(), cache_dir, index_file, index: Mutex::new(index) })
    }

    fn frame_path(&self, item_id: &str, frame_idx: i64, pos_ms: i64, width: u32) -> PathBuf {
        self.cache_dir.join(item_id).join(format!("{frame_idx}_{}_{width}.webp", format_pos_ms(pos_ms)))
    }

    /// Returns the filesystem path for a cached frame without checking existence.
    pub fn make_path(&self, item_id: &str, frame_idx: i64, pos_ms: i64, width: u32) -> PathBuf {
        self.frame_path(item_id, frame_idx, pos_ms, width)
    }

    pub fn read(&self, item_id: &str, video_path: &Path, pos_ms: i64, width: u32) -> Option<Vec<u8>> {
        let current_mtime = video_mtime(video_path);
        let path = {
            let mut idx = self.index.lock().unwrap();
            match idx.entries.get(&(item_id.to_owned(), pos_ms, width)) {
                None => return None,
                Some(e) if e.video_mtime != current_mtime => {
                    let stale: Vec<_> = idx.entries
                        .iter()
                        .filter(|(k, e)| k.0 == item_id && e.video_mtime != current_mtime)
                        .map(|(k, e)| (k.clone(), e.frame_idx, e.size))
                        .collect();
                    for (k, fi, size) in stale {
                        idx.entries.remove(&k);
                        idx.total_bytes = idx.total_bytes.saturating_sub(size);
                        let _ = std::fs::remove_file(self.frame_path(&k.0, fi, k.1, k.2));
                    }
                    return None;
                }
                Some(e) => self.frame_path(item_id, e.frame_idx, pos_ms, width),
            }
        };
        match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(_) => {
                let mut idx = self.index.lock().unwrap();
                let key = (item_id.to_owned(), pos_ms, width);
                if let Some(e) = idx.entries.remove(&key) {
                    idx.total_bytes = idx.total_bytes.saturating_sub(e.size);
                }
                None
            }
        }
    }

    pub fn exists(&self, item_id: &str, video_path: &Path, pos_ms: i64, width: u32) -> bool {
        let current_mtime = video_mtime(video_path);
        let maybe_path = {
            let idx = self.index.lock().unwrap();
            idx.entries.get(&(item_id.to_owned(), pos_ms, width))
                .filter(|e| e.video_mtime == current_mtime)
                .map(|e| self.frame_path(item_id, e.frame_idx, pos_ms, width))
        };
        maybe_path.map(|p| p.exists()).unwrap_or(false)
    }

    pub fn write(&self, item_id: &str, video_path: &Path, frame_idx: i64, pos_ms: i64, width: u32, data: &[u8]) {
        let p = self.frame_path(item_id, frame_idx, pos_ms, width);
        let current_mtime = video_mtime(video_path);
        {
            let mut idx = self.index.lock().unwrap();
            let key = (item_id.to_owned(), pos_ms, width);
            if let Some(e) = idx.entries.get(&key) {
                // File already cached with current video mtime — nothing to do
                if e.video_mtime == current_mtime && p.exists() { return; }
                // Stale mtime or missing file — remove old entry so we rewrite
                idx.total_bytes = idx.total_bytes.saturating_sub(e.size);
                idx.entries.remove(&key);
            }
        }
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if std::fs::write(&p, data).is_err() { return; }

        let size = data.len() as u64;
        let ts = now_secs();
        let vmtime = video_mtime(video_path);
        let over_cap = {
            let mut idx = self.index.lock().unwrap();
            idx.entries.insert(
                (item_id.to_owned(), pos_ms, width),
                Entry { frame_idx, size, written_at: ts, video_mtime: vmtime },
            );
            idx.total_bytes += size;
            idx.total_bytes > CAP_BYTES
        };
        self.flush();
        if over_cap { self.cleanup(); }
    }

    /// Returns cached (pos_ms, frame_idx) pairs for the given item and width.
    pub fn list_cached(&self, item_id: &str, width: u32) -> Vec<(i64, i64)> {
        let idx = self.index.lock().unwrap();
        idx.entries.iter()
            .filter(|((id, _, w), _)| id == item_id && *w == width)
            .map(|((_, pos_ms, _), e)| (*pos_ms, e.frame_idx))
            .collect()
    }

    fn flush(&self) {
        let idx = self.index.lock().unwrap();
        let _ = write_index(&self.index_file, &idx);
    }

    fn cleanup(&self) {
        let mut idx = self.index.lock().unwrap();
        let target = (CAP_BYTES as f64 * TRIM_RATIO) as u64;
        if idx.total_bytes <= target { return; }

        let mut keys: Vec<_> = idx.entries.keys().cloned().collect();
        keys.sort_unstable_by_key(|k| idx.entries.get(k).map(|e| e.written_at).unwrap_or(0));

        for key in keys {
            if idx.total_bytes <= target { break; }
            let p = match idx.entries.get(&key) {
                Some(e) => self.frame_path(&key.0, e.frame_idx, key.1, key.2),
                None => continue,
            };
            if std::fs::remove_file(&p).is_ok() {
                if let Some(e) = idx.entries.remove(&key) {
                    idx.total_bytes = idx.total_bytes.saturating_sub(e.size);
                }
            }
        }

        if let Ok(dirs) = std::fs::read_dir(&self.cache_dir) {
            for entry in dirs.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    if std::fs::read_dir(&p).map(|mut d| d.next().is_none()).unwrap_or(false) {
                        let _ = std::fs::remove_dir(&p);
                    }
                }
            }
        }

        eprintln!(
            "[{}] disk cache cleanup: {:.1} MB remaining ({} entries)",
            self.label,
            idx.total_bytes as f64 / 1e6,
            idx.entries.len(),
        );
        let _ = write_index(&self.index_file, &idx);
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

// 41708 → "00h00m41s708ms"
fn format_pos_ms(ms: i64) -> String {
    let h  = ms / 3_600_000;
    let m  = (ms % 3_600_000) / 60_000;
    let s  = (ms % 60_000)    / 1_000;
    let ms = ms % 1_000;
    format!("{h:02}h{m:02}m{s:02}s{ms:03}ms")
}

// "00h00m41s708ms" → 41708
fn parse_pos_ms(s: &str) -> Option<i64> {
    let s = s.strip_suffix("ms").unwrap_or(s);
    let (h_str, rest) = s.split_once('h')?;
    let (m_str, rest) = rest.split_once('m')?;
    let (s_str, ms_str) = rest.split_once('s')?;
    let h: i64 = h_str.parse().ok()?;
    let m: i64 = m_str.parse().ok()?;
    let sec: i64 = s_str.parse().ok()?;
    let ms: i64 = ms_str.parse().ok()?;
    Some(h * 3_600_000 + m * 60_000 + sec * 1_000 + ms)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn video_mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Remove directories left by the old path-hash scheme (16-char hex names).
fn sweep_legacy_dirs(cache_dir: &Path, index_file: &Path) {
    let Ok(dirs) = std::fs::read_dir(cache_dir) else { return };
    let mut found = false;
    for entry in dirs.flatten() {
        let name = entry.file_name();
        let s = name.to_string_lossy();
        if s.len() == 16 && s.chars().all(|c| c.is_ascii_hexdigit()) {
            let _ = std::fs::remove_dir_all(entry.path());
            found = true;
        }
    }
    if found {
        let _ = std::fs::remove_file(index_file);
    }
}

/// Remove old .jpg files left from before the WebP migration.
fn sweep_legacy_jpgs(cache_dir: &Path) {
    let Ok(dirs) = std::fs::read_dir(cache_dir) else { return };
    for dir in dirs.flatten() {
        if !dir.path().is_dir() { continue; }
        let Ok(files) = std::fs::read_dir(dir.path()) else { continue };
        for file in files.flatten() {
            let name = file.file_name();
            if name.to_string_lossy().ends_with(".jpg") {
                let _ = std::fs::remove_file(file.path());
            }
        }
    }
}

// ── index I/O ─────────────────────────────────────────────────────────────────
//
// Format (space-separated, one entry per line):
//   v2
//   total_bytes <N>
//   <item_id> <frame_idx> <pos_ms> <width> <size_bytes> <unix_ts> <video_mtime>

fn write_index(index_file: &Path, idx: &Index) -> std::io::Result<()> {
    use std::fmt::Write as FmtWrite;
    let mut s = String::new();
    writeln!(s, "v2").unwrap();
    writeln!(s, "total_bytes {}", idx.total_bytes).unwrap();
    for ((item_id, pos_ms, width), e) in &idx.entries {
        writeln!(s, "{item_id} {} {pos_ms} {width} {} {} {}", e.frame_idx, e.size, e.written_at, e.video_mtime).unwrap();
    }
    std::fs::write(index_file, s)
}

fn load_index(cache_dir: &Path, index_file: &Path) -> Result<Index, Box<dyn std::error::Error>> {
    let text = std::fs::read_to_string(index_file)?;
    let mut lines = text.lines();

    let version = lines.next().ok_or("empty index")?;
    if version != "v2" {
        return Err("unknown version".into());
    }

    let total_line = lines.next().ok_or("missing total_bytes")?;
    let total_bytes: u64 = total_line.strip_prefix("total_bytes ").ok_or("bad header")?.parse()?;

    let mut entries = HashMap::new();
    for line in lines {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 6 { continue; }
        let item_id = parts[0].to_string();
        let frame_idx: i64 = parts[1].parse()?;
        let pos_ms: i64 = parts[2].parse()?;
        let width: u32 = parts[3].parse()?;
        let size: u64 = parts[4].parse()?;
        let ts: u64 = parts[5].parse()?;
        let vmtime: u64 = parts.get(6).and_then(|s| s.parse().ok()).unwrap_or(0);
        if cache_dir.join(&item_id).join(format!("{frame_idx}_{}_{width}.webp", format_pos_ms(pos_ms))).exists() {
            entries.insert((item_id, pos_ms, width), Entry { frame_idx, size, written_at: ts, video_mtime: vmtime });
        }
    }

    Ok(Index { entries, total_bytes })
}

fn rebuild_index(label: &str, cache_dir: &Path, index_file: &Path) -> Index {
    let mut entries = HashMap::new();
    let mut total_bytes: u64 = 0;

    let Ok(dirs) = std::fs::read_dir(cache_dir) else { return Index::default() };
    for dir in dirs.flatten() {
        let item_id = dir.file_name().to_string_lossy().to_string();
        if item_id == "index.txt" { continue; }
        let Ok(files) = std::fs::read_dir(dir.path()) else { continue };
        for file in files.flatten() {
            let name = file.file_name();
            let stem = name.to_string_lossy();
            // Parse "{frame_idx}_{HHhMMmSSsNNNms}_{width}.webp"
            let stem = match stem.strip_suffix(".webp") { Some(s) => s, None => continue };
            let (rest, width_str) = match stem.rsplit_once('_') { Some(p) => p, None => continue };
            let (frame_idx_str, pos_ms_str) = match rest.split_once('_') { Some(p) => p, None => continue };
            let frame_idx: i64 = match frame_idx_str.parse() { Ok(v) => v, Err(_) => continue };
            let pos_ms: i64 = match parse_pos_ms(pos_ms_str) { Some(v) => v, None => continue };
            let width: u32 = match width_str.parse() { Ok(v) => v, Err(_) => continue };
            let Ok(meta) = file.metadata() else { continue };
            let size = meta.len();
            let ts = meta.modified().ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            total_bytes += size;
            entries.insert((item_id.clone(), pos_ms, width), Entry { frame_idx, size, written_at: ts, video_mtime: 0 });
        }
    }

    eprintln!("[{label}] rebuilt disk index: {:.1} MB ({} entries)", total_bytes as f64 / 1e6, entries.len());
    Index { entries, total_bytes }
}
