use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FallbackEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub reason: String,
    pub timestamp: String,
}

/// `event_type` values used for hardware-decode fallback events (FR-011, see
/// data-model.md §4). Recorded both as structured `FallbackEvent`s (for tasks that
/// already write a `generation-log.json`, e.g. stitch/upscale) and via `log::warn!`
/// (for the plain decode paths — single-frame/prefetch — which have no per-task JSON
/// log file today).
pub const HWDECODE_INIT_FAILED: &str = "hwdecode_init_failed";
pub const HWDECODE_RUNTIME_FALLBACK: &str = "hwdecode_runtime_fallback";

impl FallbackEvent {
    /// Builds a hw-decode fallback event with the current timestamp. `event_type`
    /// should be one of `HWDECODE_INIT_FAILED`/`HWDECODE_RUNTIME_FALLBACK`.
    pub fn hwdecode(event_type: &str, reason: &str) -> Self {
        Self {
            event_type: event_type.to_string(),
            reason: reason.to_string(),
            timestamp: now_timestamp(),
        }
    }
}

/// Logs a hw-decode fallback event via the daemon's normal logging (`log::warn!`) —
/// used by decode paths (single-frame/prefetch family) that have no per-task
/// `generation-log.json` to append a structured `FallbackEvent` to. Suitable as the
/// `on_fallback` sink passed to `jfs_common::decode_range_hw`/`decode_and_encode_hw`.
pub fn log_hw_fallback(event_type: &str, reason: &str) {
    log::warn!("[hwdecode] {event_type}: {reason}");
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GenerationLog {
    pub algorithm: String,
    pub model_file_name: String,
    pub model_version: String,
    pub ort_version: String,
    pub device_name: String,
    pub device_type: String,
    pub device_id: String,
    pub keypoint_match_count: u32,
    pub inference_duration_ms: u64,
    pub total_duration_ms: u64,
    pub fallbacks: Vec<FallbackEvent>,
}

impl GenerationLog {
    pub fn write_to_file(&self, path: &std::path::Path) -> anyhow::Result<()> {
        write_json_atomic(self, path)
    }
}

/// Stats collected during an upscale (Real-ESRGAN + optional GFPGAN) job — written to
/// `UpscaleReq::log_path` for the C# side to read GPU-fallback info and the face-restoration
/// outcome, the same way `GenerationLog` does for stitch jobs.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleLog {
    pub device_name: String,
    pub device_type: String,
    pub device_id: String,
    pub face_restore_requested: bool,
    pub face_restore_skipped_no_face: bool,
    pub fallbacks: Vec<FallbackEvent>,
}

impl UpscaleLog {
    pub fn write_to_file(&self, path: &std::path::Path) -> anyhow::Result<()> {
        write_json_atomic(self, path)
    }
}

fn write_json_atomic<T: Serialize>(value: &T, path: &std::path::Path) -> anyhow::Result<()> {
    let json = serde_json::to_string_pretty(value)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Stats collected during stitch execution — returned alongside the stitched image.
#[derive(Debug, Default)]
pub struct StitchStats {
    pub algorithm: String,
    pub model_file_name: String,
    pub keypoint_match_count: u32,
    pub inference_duration_ms: u64,
    pub fallbacks: Vec<FallbackEvent>,
}

/// Returns seconds-since-epoch as an ISO-ish timestamp string (no chrono dep).
pub fn now_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Format as a simple ISO-ish string without chrono
    let (y, mo, d, h, mi, s) = epoch_to_parts(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn epoch_to_parts(mut secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60; secs /= 60;
    let mi = secs % 60; secs /= 60;
    let h = secs % 24; secs /= 24;
    // Simple Gregorian calendar approximation
    let (y, remaining) = days_to_year(secs);
    let (mo, d) = days_to_month(remaining, is_leap(y));
    (y, mo, d, h, mi, s)
}

fn is_leap(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_to_year(mut days: u64) -> (u64, u64) {
    let mut y = 1970u64;
    loop {
        let dy = if is_leap(y) { 366 } else { 365 };
        if days < dy { break; }
        days -= dy;
        y += 1;
    }
    (y, days)
}

fn days_to_month(mut days: u64, leap: bool) -> (u64, u64) {
    let months = [31u64, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut mo = 1u64;
    for &dm in &months {
        if days < dm { break; }
        days -= dm;
        mo += 1;
    }
    (mo, days + 1)
}
