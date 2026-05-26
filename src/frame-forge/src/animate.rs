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

pub fn scale_frame(img: &DynamicImage, target_w: u32, target_h: u32) -> DynamicImage {
    if target_w == 0 || target_h == 0 { img.clone() }
    else { img.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3) }
}
