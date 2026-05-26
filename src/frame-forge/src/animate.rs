use image::DynamicImage;
use std::io::Cursor;

pub fn encode_gif(_frames: &[DynamicImage], _fps: u16, _loop_count: u16) -> anyhow::Result<Vec<u8>> {
    use gif::{Encoder, Frame, Repeat};
    if _frames.is_empty() { anyhow::bail!("no frames to encode"); }
    let first = _frames[0].to_rgba8();
    let (w, h) = first.dimensions();
    let delay = (100u16).saturating_div(_fps.max(1)).max(2); // centiseconds per frame
    let mut buf = Cursor::new(Vec::new());
    {
        let mut encoder = Encoder::new(&mut buf, w as u16, h as u16, &[])?;
        encoder.set_repeat(if _loop_count == 0 { Repeat::Infinite } else { Repeat::Finite(_loop_count) })?;
        for img in _frames {
            let rgba = img.to_rgba8();
            let mut frame = Frame::from_rgba_speed(w as u16, h as u16, &mut rgba.into_raw(), 10);
            frame.delay = delay;
            encoder.write_frame(&frame)?;
        }
    }
    Ok(buf.into_inner())
}

pub fn encode_webp_anim(frames: &[DynamicImage], fps: u16, _loop_count: u16) -> anyhow::Result<Vec<u8>> {
    if frames.is_empty() { anyhow::bail!("no frames to encode"); }
    let w = frames.iter().map(|f| f.width()).max().unwrap_or(1);
    let h = frames.iter().map(|f| f.height()).max().unwrap_or(1);
    let delay_ms = (1000u32).saturating_div(fps.max(1) as u32).max(10) as i32;

    // Per-frame config so WebPAnimEncoderAdd gets valid config, not zeroed
    // WebPConfig must have valid segments (1-4) and pass (1-10).
    // Using unsafe { zeroed() } fills them as 0 which libwebp rejects
    // silently — WebPAnimEncoderAdd returns 0 (failure) with pic.error_code
    // still at VP8_ENC_OK (default 0), giving the misleading error.
    // lossless=1: lossless encoding; quality: 75=balanced speed/size.
    let cfg: webp::WebPConfig = webp::WebPConfig {
        lossless: 1, quality: 75.0, method: 4, segments: 4, pass: 1,
        ..unsafe { std::mem::zeroed() }
    };
    let dummy_cfg: webp::WebPConfig = unsafe { std::mem::zeroed() };
    // AnimEncoder::new requires a &WebPConfig even though per-frame
    // configs (passed via AnimFrame::new with Some(&cfg)) take priority.
    // This dummy is never used for actual encoding.
    let mut encoder = webp::AnimEncoder::new(w, h, &dummy_cfg);
    // Pad all frames to identical canvas so WebPAnimEncoderAdd accepts them
    let rgba_data: Vec<(Vec<u8>, u32, u32)> = frames.iter().map(|img| {
        let (iw, ih) = (img.width(), img.height());
        if iw == w && ih == h {
            (img.to_rgba8().into_raw(), iw, ih)
        } else {
            let mut padded = image::RgbaImage::new(w, h);
            image::imageops::overlay(&mut padded, &img.to_rgba8(), 0, 0);
            (padded.into_raw(), w, h)
        }
    }).collect();
    for (i, (rgba, _, _)) in rgba_data.iter().enumerate() {
        // timestamp is absolute position in ms, not per-frame delay
        let frame = webp::AnimFrame::new(rgba, webp::PixelLayout::Rgba, w, h, delay_ms * i as i32, Some(&cfg));
        encoder.add_frame(frame);
    }
    let anim = encoder.try_encode().map_err(|e| anyhow::anyhow!("WebP: {:?}", e))?;
    Ok(anim.to_vec())
}

// ── Timestamp-aware variants — preserves original video playback speed ──────

/// GIF with per-frame delays derived from original video timestamps (ms).
/// Each frame's delay = (next_pos_ms - current_pos_ms) / 10 centiseconds.
pub fn encode_gif_timed(frames: &[DynamicImage], timestamps: &[u64], loop_count: u16) -> anyhow::Result<Vec<u8>> {
    use gif::{Encoder, Frame, Repeat};
    if frames.is_empty() { anyhow::bail!("no frames to encode"); }
    let first = frames[0].to_rgba8();
    let (w, h) = first.dimensions();
    let mut buf = Cursor::new(Vec::new());
    {
        let mut encoder = Encoder::new(&mut buf, w as u16, h as u16, &[])?;
        encoder.set_repeat(if loop_count == 0 { Repeat::Infinite } else { Repeat::Finite(loop_count) })?;
        for i in 0..frames.len() {
            let delay_cs = if i + 1 < timestamps.len() {
                ((timestamps[i + 1] - timestamps[i]).max(10) / 10) as u16
            } else {
                // last frame: use average of previous delays, or fallback
                let avg = if i > 0 { (timestamps[i] - timestamps[0]) / i.max(1) as u64 } else { 200 };
                (avg.max(10) / 10) as u16
            };
            let rgba = frames[i].to_rgba8();
            let mut frame = Frame::from_rgba_speed(w as u16, h as u16, &mut rgba.into_raw(), 10);
            frame.delay = delay_cs.max(2);
            encoder.write_frame(&frame)?;
        }
    }
    Ok(buf.into_inner())
}

/// WebP with per-frame absolute timestamps from original video (ms).
/// Each frame's timestamp = original_pos_ms - first_pos_ms.
pub fn encode_webp_timed(frames: &[DynamicImage], timestamps: &[u64], _loop_count: u16) -> anyhow::Result<Vec<u8>> {
    if frames.is_empty() { anyhow::bail!("no frames to encode"); }
    let w = frames.iter().map(|f| f.width()).max().unwrap_or(1);
    let h = frames.iter().map(|f| f.height()).max().unwrap_or(1);
    let first_ts = timestamps.first().copied().unwrap_or(0) as i32;

    let cfg = webp::WebPConfig {
        lossless: 1, quality: 75.0, method: 4, segments: 4, pass: 1,
        ..unsafe { std::mem::zeroed() }
    };
    let dummy_cfg: webp::WebPConfig = unsafe { std::mem::zeroed() };
    let mut encoder = webp::AnimEncoder::new(w, h, &dummy_cfg);
    let rgba_data: Vec<Vec<u8>> = frames.iter().map(|img| {
        if img.width() == w && img.height() == h {
            img.to_rgba8().into_raw()
        } else {
            let mut padded = image::RgbaImage::new(w, h);
            image::imageops::overlay(&mut padded, &img.to_rgba8(), 0, 0);
            padded.into_raw()
        }
    }).collect();
    for (i, rgba) in rgba_data.iter().enumerate() {
        let ts = timestamps.get(i).copied().unwrap_or(0) as i32;
        let frame = webp::AnimFrame::new(rgba, webp::PixelLayout::Rgba, w, h, ts - first_ts, Some(&cfg));
        encoder.add_frame(frame);
    }
    let anim = encoder.try_encode().map_err(|e| anyhow::anyhow!("WebP: {:?}", e))?;
    Ok(anim.to_vec())
}

pub fn scale_frame(img: &DynamicImage, target_w: u32, target_h: u32) -> DynamicImage {
    if target_w == 0 || target_h == 0 { img.clone() }
    else { img.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3) }
}
