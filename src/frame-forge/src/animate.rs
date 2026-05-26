use image::DynamicImage;
use std::io::Cursor;

pub fn encode_gif(_frames: &[DynamicImage], _fps: u16, _loop_count: u16) -> anyhow::Result<Vec<u8>> {
    use gif::{Encoder, Frame, Repeat};
    if _frames.is_empty() { anyhow::bail!("no frames to encode"); }
    let first = _frames[0].to_rgba8();
    let (w, h) = first.dimensions();
    let mut buf = Cursor::new(Vec::new());
    {
        let mut encoder = Encoder::new(&mut buf, w as u16, h as u16, &[])?;
        encoder.set_repeat(if _loop_count == 0 { Repeat::Infinite } else { Repeat::Finite(_loop_count) })?;
        for img in _frames {
            let rgba = img.to_rgba8();
            let frame = Frame::from_rgba_speed(w as u16, h as u16, &mut rgba.into_raw(), 10);
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
    let cfg: webp::WebPConfig = webp::WebPConfig {
        lossless: 1, quality: 75.0, method: 4,
        ..unsafe { std::mem::zeroed() }
    };
    let dummy_cfg: webp::WebPConfig = unsafe { std::mem::zeroed() }; // only needed for AnimEncoder ctor
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
    for (rgba, _, _) in &rgba_data {
        let frame = webp::AnimFrame::new(rgba, webp::PixelLayout::Rgba, w, h, delay_ms, Some(&cfg));
        encoder.add_frame(frame);
    }
    let anim = encoder.try_encode().map_err(|e| anyhow::anyhow!("WebP: {:?}", e))?;
    Ok(anim.to_vec())
}

pub fn scale_frame(img: &DynamicImage, target_w: u32, target_h: u32) -> DynamicImage {
    if target_w == 0 || target_h == 0 { img.clone() }
    else { img.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3) }
}
