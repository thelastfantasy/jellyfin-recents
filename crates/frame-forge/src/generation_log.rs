use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FallbackEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub reason: String,
    pub timestamp: String,
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
        let json = serde_json::to_string_pretty(self)?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
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
