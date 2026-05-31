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

