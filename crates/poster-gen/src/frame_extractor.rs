// Frame extraction via ffmpeg subprocess

use std::process::{Command, Stdio};

/// Spawns ffmpeg to extract one frame at timestamp_secs, returns DynamicImage.
pub fn extract_frame(
    ffmpeg_path: &str,
    input: &str,
    timestamp_secs: f64,
    thumb_width: u32,
) -> Result<image::DynamicImage, String> {
    let timestamp = format_timestamp(timestamp_secs);

    let output = Command::new(ffmpeg_path)
        .args([
            "-ss",
            &timestamp,
            "-i",
            input,
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={}:-1", thumb_width),
            "-f",
            "image2",
            "-vcodec",
            "png",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to spawn ffmpeg: {e}"))?;

    if !output.status.success() && output.stdout.is_empty() {
        return Err(format!(
            "ffmpeg failed for timestamp {timestamp_secs:.3}s (exit code: {:?})",
            output.status.code()
        ));
    }

    image::load_from_memory(&output.stdout)
        .map_err(|e| format!("Failed to decode frame at {timestamp_secs:.3}s: {e}"))
}

fn format_timestamp(secs: f64) -> String {
    let total = secs as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    let ms = ((secs - total as f64) * 1000.0) as u64;
    format!("{h:02}:{m:02}:{s:02}.{ms:03}")
}
