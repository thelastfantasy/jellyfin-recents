// Media info extraction via ffprobe subprocess

use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct MediaInfo {
    pub filename: String,
    pub file_size: String,
    pub file_size_bytes: u64,
    pub resolution: String,
    /// Raw source width in pixels (used to cap thumb_width and detect portrait orientation)
    pub source_width: u32,
    pub source_height: u32,
    pub fps: f64,
    pub video_codec: String,
    pub video_profile: Option<String>,
    pub video_bitrate: Option<String>,
    pub bit_depth: Option<i32>,
    pub hdr_type: Option<String>,
    pub colour_space: Option<String>,
    pub audio_codec: Option<String>,
    pub audio_format: Option<String>,
    pub audio_bitrate: Option<String>,
    pub audio_sample_rate: Option<u32>,
    pub audio_tracks: i32,
    pub subtitle_count: i32,
    pub duration: String,
    pub duration_secs: f64,
}

pub fn extract_media_info(ffmpeg_path: &str, input: &str) -> Result<MediaInfo, String> {
    // Derive ffprobe path from ffmpeg path
    let ffprobe_path = derive_ffprobe_path(ffmpeg_path);

    let output = Command::new(&ffprobe_path)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            input,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to spawn ffprobe ({ffprobe_path}): {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe failed (exit code: {:?})",
            output.status.code()
        ));
    }

    let json_str =
        std::str::from_utf8(&output.stdout).map_err(|e| format!("ffprobe output not UTF-8: {e}"))?;

    parse_ffprobe_json(json_str, input)
}

fn derive_ffprobe_path(ffmpeg_path: &str) -> String {
    let path = Path::new(ffmpeg_path);
    let parent = path.parent().unwrap_or(Path::new(""));
    let ext = path.extension().unwrap_or_default().to_string_lossy();
    if ext.is_empty() {
        parent
            .join("ffprobe")
            .to_string_lossy()
            .into_owned()
    } else {
        parent
            .join(format!("ffprobe.{ext}"))
            .to_string_lossy()
            .into_owned()
    }
}

fn parse_ffprobe_json(json_str: &str, input: &str) -> Result<MediaInfo, String> {
    let val: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("Failed to parse ffprobe JSON: {e}"))?;

    let streams = val["streams"].as_array().ok_or("No streams in ffprobe output")?;
    let format = &val["format"];

    // Extract video stream
    let video_stream = streams
        .iter()
        .find(|s| s["codec_type"].as_str() == Some("video"))
        .ok_or("No video stream found")?;

    // Extract audio streams
    let audio_streams: Vec<&serde_json::Value> = streams
        .iter()
        .filter(|s| s["codec_type"].as_str() == Some("audio"))
        .collect();

    let audio_tracks = audio_streams.len() as i32;

    let subtitle_count = streams
        .iter()
        .filter(|s| s["codec_type"].as_str() == Some("subtitle"))
        .count() as i32;

    // Video codec + profile
    let video_codec = friendly_video_codec(
        video_stream["codec_name"].as_str().unwrap_or("unknown"),
    );
    let video_profile = video_stream["profile"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != "unknown" && *s != "Unknown")
        .map(|s| s.to_string());

    // Video bitrate (from stream; fall back to format bitrate minus audio estimate)
    let video_bitrate = video_stream["bit_rate"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&b| b > 0)
        .map(|b| format!("{} kbps", b / 1000));

    // Resolution
    let width = video_stream["width"].as_u64().unwrap_or(0);
    let height = video_stream["height"].as_u64().unwrap_or(0);
    let resolution = format!("{width}\u{d7}{height}"); // ×

    // FPS: parse r_frame_rate like "24000/1001"
    let fps = parse_fps(video_stream["r_frame_rate"].as_str().unwrap_or("0/1"));

    // Bit depth — bits_per_raw_sample may be "0" for some codecs (AV1); fall back to pix_fmt
    let bit_depth = video_stream["bits_per_raw_sample"]
        .as_str()
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|&d| d > 0)
        .or_else(|| video_stream["bits_per_raw_sample"].as_i64().filter(|&d| d > 0).map(|v| v as i32))
        .or_else(|| parse_bit_depth_from_pix_fmt(video_stream["pix_fmt"].as_str().unwrap_or("")));

    // HDR type
    let color_transfer = video_stream["color_transfer"].as_str().unwrap_or("");
    let color_primaries = video_stream["color_primaries"].as_str().unwrap_or("");
    let hdr_type = detect_hdr(color_transfer, color_primaries);

    // Colour space — normalize ffprobe lowercase values to display names
    let colour_space = video_stream["color_space"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != "unknown")
        .map(normalize_colour_space);

    // Duration from format
    let duration_secs: f64 = format["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let duration = secs_to_hhmmss(duration_secs);

    // File size
    let file_size_bytes: u64 = format["size"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let file_size = format_file_size(file_size_bytes);

    // Filename
    let filename = Path::new(input)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| input.to_string());

    // Audio info from the highest-quality audio stream (most channels), falling back to first
    let (audio_codec, audio_format, audio_bitrate, audio_sample_rate): (Option<String>, Option<String>, Option<String>, Option<u32>) =
        if let Some(a) = audio_streams.iter().max_by_key(|a| a["channels"].as_u64().unwrap_or(0)) {
            let codec = a["codec_name"]
                .as_str()
                .map(|s| friendly_audio_codec(s));
            let channels = a["channels"].as_u64().unwrap_or(0);
            let fmt = channel_layout_name(
                a["channel_layout"].as_str().unwrap_or(""),
                channels,
            );
            let br = a["bit_rate"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .map(|b| format!("{} kbps", b / 1000));
            let sr = a["sample_rate"]
                .as_str()
                .and_then(|s| s.parse::<u32>().ok());
            (codec, Some(fmt), br, sr)
        } else {
            (None, None, None, None)
        };

    Ok(MediaInfo {
        filename,
        file_size,
        file_size_bytes,
        resolution,
        source_width: width as u32,
        source_height: height as u32,
        fps,
        video_codec,
        video_profile,
        video_bitrate,
        bit_depth,
        hdr_type,
        colour_space,
        audio_codec,
        audio_format,
        audio_bitrate,
        audio_sample_rate,
        audio_tracks,
        subtitle_count,
        duration,
        duration_secs,
    })
}

fn parse_fps(r_frame_rate: &str) -> f64 {
    if let Some((num, den)) = r_frame_rate.split_once('/') {
        let n: f64 = num.parse().unwrap_or(0.0);
        let d: f64 = den.parse().unwrap_or(1.0);
        if d != 0.0 {
            (n / d * 1000.0).round() / 1000.0
        } else {
            0.0
        }
    } else {
        r_frame_rate.parse().unwrap_or(0.0)
    }
}

fn secs_to_hhmmss(secs: f64) -> String {
    let total = secs as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    format!("{h:02}:{m:02}:{s:02}")
}

fn format_file_size(bytes: u64) -> String {
    const GB: u64 = 1_073_741_824;
    const MB: u64 = 1_048_576;
    const KB: u64 = 1_024;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}

fn friendly_video_codec(name: &str) -> String {
    match name {
        "h264" | "libx264" => "H.264".to_string(),
        "hevc" | "libx265" => "H.265".to_string(),
        "av1" | "libaom-av1" | "libsvtav1" => "AV1".to_string(),
        "vp9" | "libvpx-vp9" => "VP9".to_string(),
        "vp8" | "libvpx" => "VP8".to_string(),
        "mpeg2video" => "MPEG-2".to_string(),
        "mpeg4" => "MPEG-4".to_string(),
        "wmv3" | "wmv2" | "wmv1" => "WMV".to_string(),
        "prores" => "ProRes".to_string(),
        other => other.to_uppercase(),
    }
}

fn friendly_audio_codec(name: &str) -> String {
    match name {
        "aac" => "AAC".to_string(),
        "mp3" => "MP3".to_string(),
        "ac3" => "AC3".to_string(),
        "eac3" => "E-AC3".to_string(),
        "dts" => "DTS".to_string(),
        "flac" => "FLAC".to_string(),
        "opus" => "Opus".to_string(),
        "vorbis" => "Vorbis".to_string(),
        "pcm_s16le" | "pcm_s24le" | "pcm_s32le" => "PCM".to_string(),
        "truehd" => "TrueHD".to_string(),
        other => other.to_uppercase(),
    }
}

fn channel_layout_name(layout: &str, channels: u64) -> String {
    match layout {
        "mono" => "1ch".to_string(),
        "stereo" => "2ch".to_string(),
        "2.1" => "2.1ch".to_string(),
        "3.0" | "3.0(back)" => "3ch".to_string(),
        "4.0" | "quad" | "quad(side)" => "4ch".to_string(),
        "5.1" | "5.1(side)" => "5.1ch".to_string(),
        "7.1" | "7.1(wide)" => "7.1ch".to_string(),
        _ => match channels {
            1 => "1ch".to_string(),
            2 => "2ch".to_string(),
            6 => "5.1ch".to_string(),
            8 => "7.1ch".to_string(),
            n if n > 0 => format!("{n}ch"),
            _ => String::new(),
        },
    }
}

fn normalize_colour_space(cs: &str) -> String {
    match cs {
        "bt709" => "BT.709".to_string(),
        "bt2020nc" | "bt2020" | "bt2020c" => "BT.2020".to_string(),
        "bt470bg" | "bt470m" => "BT.601".to_string(),
        "smpte170m" => "SMPTE 170M".to_string(),
        "smpte240m" => "SMPTE 240M".to_string(),
        "smpte432" => "P3-D65".to_string(),
        "iec61966_2_1" | "iec61966-2-1" => "sRGB".to_string(),
        other => other.to_string(),
    }
}

/// Extract bit depth from pix_fmt string (e.g. "yuv420p10le" → 10, "yuv420p" → 8).
fn parse_bit_depth_from_pix_fmt(pix_fmt: &str) -> Option<i32> {
    if pix_fmt.is_empty() { return None; }
    if let Some(pos) = pix_fmt.rfind('p') {
        let after = &pix_fmt[pos + 1..];
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            return digits.parse().ok();
        }
        // 'p' at end with no digit suffix → standard 8-bit planar
        if pix_fmt.starts_with("yuv") || pix_fmt.starts_with("rgb") || pix_fmt.starts_with("gbr") {
            return Some(8);
        }
    }
    None
}

fn detect_hdr(color_transfer: &str, color_primaries: &str) -> Option<String> {
    match color_transfer {
        "smpte2084" => Some("HDR10".to_string()),
        "arib-std-b67" => Some("HLG".to_string()),
        _ => {
            if color_primaries == "bt2020" {
                Some("HDR".to_string())
            } else {
                None
            }
        }
    }
}
