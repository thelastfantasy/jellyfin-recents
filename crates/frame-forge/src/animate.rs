use anyhow::Context as _;
use image::DynamicImage;
use std::io::Cursor;

// ── GIF encoding ────────────────────────────────────────────────────────────

pub fn encode_gif(frames: &[DynamicImage], delays_ms: &[u32], loop_count: u16) -> anyhow::Result<Vec<u8>> {
    use gif::{Encoder, Frame, Repeat};
    if frames.is_empty() { anyhow::bail!("no frames to encode"); }
    let first = frames[0].to_rgba8();
    let (w, h) = first.dimensions();
    let mut buf = Cursor::new(Vec::new());
    {
        let mut encoder = Encoder::new(&mut buf, w as u16, h as u16, &[])?;
        encoder.set_repeat(if loop_count == 0 { Repeat::Infinite } else { Repeat::Finite(loop_count) })?;
        for (i, img) in frames.iter().enumerate() {
            let rgba = img.to_rgba8();
            let mut frame = Frame::from_rgba_speed(w as u16, h as u16, &mut rgba.into_raw(), 10);
            // GIF delay unit = 1/100 s (centiseconds); clamp to minimum 2cs (20ms)
            frame.delay = delays_ms.get(i).map(|&ms| (ms / 10).max(2) as u16).unwrap_or(20);
            encoder.write_frame(&frame)?;
        }
    }
    Ok(buf.into_inner())
}

/// Decode a GIF previously produced by `encode_gif`. Assumes every frame covers the
/// full canvas at (0,0) — true for our own output, but not GIFs with partial-frame
/// disposal methods in general — so no canvas compositing is attempted.
pub fn decode_gif(data: &[u8]) -> anyhow::Result<(Vec<DynamicImage>, Vec<u32>, u16)> {
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::RGBA);
    let mut decoder = options.read_info(Cursor::new(data))?;
    let loop_count = match decoder.repeat() {
        gif::Repeat::Infinite => 0,
        gif::Repeat::Finite(n) => n,
    };
    let mut frames = Vec::new();
    let mut delays = Vec::new();
    while let Some(frame) = decoder.read_next_frame()? {
        let img = image::RgbaImage::from_raw(frame.width as u32, frame.height as u32, frame.buffer.to_vec())
            .context("invalid GIF frame buffer")?;
        frames.push(DynamicImage::ImageRgba8(img));
        delays.push(frame.delay as u32 * 10);
    }
    Ok((frames, delays, loop_count))
}

/// Decode an animated WebP previously produced by `encode_webp_anim`.
pub fn decode_webp_anim(data: &[u8]) -> anyhow::Result<(Vec<DynamicImage>, Vec<u32>, u16)> {
    let mut dec = webpx::AnimationDecoder::new(data)?;
    let raw_frames = dec.decode_all()?;
    let mut frames = Vec::with_capacity(raw_frames.len());
    let mut delays = Vec::with_capacity(raw_frames.len());
    for f in raw_frames {
        let img = image::RgbaImage::from_raw(f.width, f.height, f.data).context("invalid WebP frame buffer")?;
        frames.push(DynamicImage::ImageRgba8(img));
        delays.push(f.duration_ms);
    }
    Ok((frames, delays, 0))
}

/// Decode every frame of an MP4 (or any container ffmpeg can demux) at `path`.
/// Returns (frames, fps) — MP4 is CFR with no per-frame delay or loop count, unlike
/// GIF/WebP, so the shape deliberately differs from `decode_gif`/`decode_webp_anim`.
pub fn decode_mp4(path: &std::path::Path) -> anyhow::Result<(Vec<DynamicImage>, f64)> {
    let (raw_frames, fps) = jfs_common::decode_all_frames_rgba(path)?;
    let frames = raw_frames
        .into_iter()
        .map(|(rgba, w, h)| {
            image::RgbaImage::from_raw(w, h, rgba)
                .map(DynamicImage::ImageRgba8)
                .context("invalid decoded MP4 frame buffer")
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok((frames, fps))
}

// ── WebP encoding (webpx crate) ─────────────────────────────────────────────

/// Variable-delay WebP animation. `delays_ms[i]` = how long frame i is shown (ms).
pub fn encode_webp_anim(frames: &[DynamicImage], delays_ms: &[u32], _loop_count: u16) -> anyhow::Result<Vec<u8>> {
    if frames.is_empty() { anyhow::bail!("no frames to encode"); }
    let w = frames.iter().map(|f| f.width()).max().unwrap_or(1);
    let h = frames.iter().map(|f| f.height()).max().unwrap_or(1);

    // webpx takes cumulative start-timestamps, not per-frame durations
    let mut encoder = webpx::AnimationEncoder::with_options(w, h, false, 80)?;
    let mut cursor_ms = 0i32;
    for (i, img) in frames.iter().enumerate() {
        let rgba = pad_to_canvas(img, w, h);
        encoder.add_frame_rgba(&rgba, cursor_ms)?;
        cursor_ms += delays_ms.get(i).map(|&ms| ms.max(10) as i32).unwrap_or(200);
    }
    Ok(encoder.finish(cursor_ms)?)
}


/// Timestamp-driven WebP animation — only used by the `forge` CLI binary.
#[cfg(feature = "cli")]
pub fn encode_webp_timed(frames: &[DynamicImage], timestamps: &[u64], _loop_count: u16) -> anyhow::Result<Vec<u8>> {
    if frames.is_empty() { anyhow::bail!("no frames to encode"); }
    let w = frames.iter().map(|f| f.width()).max().unwrap_or(1);
    let h = frames.iter().map(|f| f.height()).max().unwrap_or(1);
    let n = frames.len().min(timestamps.len());
    let avg_gap_ms = if n > 1 {
        (timestamps[n - 1] - timestamps[0]).max(10) / (n - 1).max(1) as u64
    } else { 200u64 };

    let mut positions: Vec<i32> = Vec::with_capacity(n);
    positions.push(0);
    for i in 1..n {
        let prev = positions[i - 1] as u64;
        let gap = if i == 1 || i == n - 1 { avg_gap_ms } else { timestamps[i] - timestamps[i - 1] };
        positions.push((prev + gap.max(10)) as i32);
    }
    let mut encoder = webpx::AnimationEncoder::with_options(w, h, false, 80)?;
    for (i, img) in frames.iter().take(n).enumerate() {
        let rgba = pad_to_canvas(img, w, h);
        encoder.add_frame_rgba(&rgba, positions[i])?;
    }
    Ok(encoder.finish(positions[n - 1] + avg_gap_ms as i32)?)
}

/// Timestamp-driven GIF — only used by the `forge` CLI binary.
#[cfg(feature = "cli")]
pub fn encode_gif_timed(frames: &[DynamicImage], timestamps: &[u64], loop_count: u16) -> anyhow::Result<Vec<u8>> {
    use gif::{Encoder, Frame, Repeat};
    if frames.is_empty() { anyhow::bail!("no frames to encode"); }
    let first = frames[0].to_rgba8();
    let (w, h) = first.dimensions();
    let n = frames.len().min(timestamps.len());
    let avg_gap_ms = if n > 1 {
        (timestamps[n - 1] - timestamps[0]).max(10) / (n - 1).max(1) as u64
    } else { 200u64 };

    let mut buf = Cursor::new(Vec::new());
    {
        let mut encoder = Encoder::new(&mut buf, w as u16, h as u16, &[])?;
        encoder.set_repeat(if loop_count == 0 { Repeat::Infinite } else { Repeat::Finite(loop_count) })?;
        for i in 0..n {
            let delay_cs = if i == 0 || i == n - 1 {
                (avg_gap_ms / 10) as u16
            } else if i + 1 < timestamps.len() {
                ((timestamps[i + 1] - timestamps[i]).max(10) / 10) as u16
            } else {
                (avg_gap_ms / 10) as u16
            };
            let rgba = frames[i].to_rgba8();
            let mut frame = Frame::from_rgba_speed(w as u16, h as u16, &mut rgba.into_raw(), 10);
            frame.delay = delay_cs.max(2);
            encoder.write_frame(&frame)?;
        }
    }
    Ok(buf.into_inner())
}

pub fn scale_frame(img: &DynamicImage, target_w: u32, target_h: u32) -> DynamicImage {
    if target_w == 0 || target_h == 0 { img.clone() }
    else { img.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3) }
}

// ── MP4 (H.264, no audio) encoding ───────────────────────────────────────────

fn find_ffmpeg() -> Option<&'static str> {
    for p in ["/usr/lib/jellyfin-ffmpeg/ffmpeg", "/usr/bin/ffmpeg", "ffmpeg"] {
        if std::process::Command::new(p)
            .arg("-version").output()
            .map(|o| o.status.success()).unwrap_or(false)
        {
            return Some(p);
        }
    }
    None
}

/// Encodes frames as a no-audio H.264 (High Profile, yuv420p) MP4 by shelling out to the
/// system ffmpeg already shipped alongside the Jellyfin host, rather than wiring up an encoder
/// through ffmpeg-next (only used for decoding elsewhere in this crate). H.264 is the one codec
/// choice with no compatibility gap across mainstream chat apps and mid-range phones — HEVC/VP9/
/// AV1 all have a hardware-decode or browser-support gap on some mainstream combination (Windows
/// browsers lacking HEVC without a paid codec pack, older mid-range Android lacking AV1 hardware
/// decode, etc). Its real advantage over GIF/WebP for this use case is motion-compensated
/// inter-frame prediction: most of a panning/near-static frame sequence doesn't change frame to
/// frame, so far fewer bits are needed overall, and what's left goes toward whatever *does*
/// change — usually less banding than an image-sequence codec at the same file size.
///
/// `fps` must be a single constant value: H.264 is CFR-only, and the caller already produces a
/// uniform per-frame delay for GIF/WebP, so there's no variable-frame-rate case to support here.
/// `on_frame` is called after each frame is written to ffmpeg's stdin, for progress reporting.
pub fn encode_mp4(
    frames: &[DynamicImage],
    fps: f64,
    quality: f32,
    mut on_frame: impl FnMut(usize),
) -> anyhow::Result<Vec<u8>> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    if frames.is_empty() { anyhow::bail!("encode_mp4: no frames"); }
    let ffmpeg = find_ffmpeg().context("encode_mp4: ffmpeg binary not found")?;
    let (w, h) = (frames[0].width(), frames[0].height());

    // Lower `quality` = more compression, same direction as the WebP quality knob. Mapped onto
    // a CRF range that stays inside "no visible artifacts at normal viewing distance" (16) to
    // "noticeably soft but still small" (26) — anime's hard edges and on-screen text degrade
    // fast past that. `quality <= 0.0` ("lossless" in the WebP/GIF sense) is capped at CRF 18
    // rather than mapped to a literal CRF 0: true lossless H.264 balloons file size for
    // essentially no perceptible gain on this content, defeating the point of offering MP4 at all.
    let crf = if quality <= 0.0 {
        18
    } else {
        (26.0 - quality.clamp(0.01, 1.0) as f64 * 10.0).round().clamp(16.0, 26.0) as u32
    };

    // +faststart needs a seekable output to relocate the moov atom to the front after encoding
    // (so playback can start before the whole file downloads) — that's incompatible with piping
    // straight to stdout, hence a real temp file instead.
    let out_file = tempfile::NamedTempFile::new().context("encode_mp4: create temp output file")?;
    let out_path = out_file.path().to_path_buf();

    let mut child = Command::new(ffmpeg)
        .args([
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgba",
            "-s", &format!("{w}x{h}"),
            "-r", &format!("{fps}"),
            "-i", "-",
            "-an",
            "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
            "-preset", "medium", "-crf", &crf.to_string(),
            "-movflags", "+faststart",
            "-f", "mp4",
        ])
        .arg(&out_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("encode_mp4: spawn ffmpeg")?;

    {
        let mut stdin = child.stdin.take().context("encode_mp4: ffmpeg stdin")?;
        for (i, img) in frames.iter().enumerate() {
            let rgba = if img.width() == w && img.height() == h {
                img.to_rgba8().into_raw()
            } else {
                pad_to_canvas(img, w, h)
            };
            stdin.write_all(&rgba).context("encode_mp4: write frame to ffmpeg stdin")?;
            on_frame(i);
        }
    } // stdin dropped here, closing the pipe — signals EOF to ffmpeg

    let result = child.wait_with_output().context("encode_mp4: wait for ffmpeg")?;
    if !result.status.success() {
        anyhow::bail!("encode_mp4: ffmpeg failed: {}", String::from_utf8_lossy(&result.stderr));
    }

    std::fs::read(&out_path).context("encode_mp4: read encoded output")
}

// ── internal ────────────────────────────────────────────────────────────────

fn pad_to_canvas(img: &DynamicImage, w: u32, h: u32) -> Vec<u8> {
    if img.width() == w && img.height() == h {
        img.to_rgba8().into_raw()
    } else {
        let mut padded = image::RgbaImage::new(w, h);
        image::imageops::overlay(&mut padded, &img.to_rgba8(), 0, 0);
        padded.into_raw()
    }
}

