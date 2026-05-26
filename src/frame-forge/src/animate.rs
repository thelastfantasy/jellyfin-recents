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
    let first = frames[0].to_rgba8();
    let (w, h) = first.dimensions();
    let delay_ms = (1000u32).saturating_div(fps.max(1) as u32).max(10) as i32;

    // Ensure all frames have identical dimensions (required by WebP AnimEncoder)
    let w = frames.iter().map(|f| f.width()).max().unwrap_or(1);
    let h = frames.iter().map(|f| f.height()).max().unwrap_or(1);
    let rgba_data: Vec<Vec<u8>> = frames.iter().map(|img| {
        if img.width() == w && img.height() == h {
            img.to_rgba8().into_raw()
        } else {
            let padded = image::DynamicImage::new_rgba8(w, h)
                .to_rgba8();
            let mut padded = padded;
            image::imageops::overlay(&mut padded, &img.to_rgba8(), 0, 0);
            padded.into_raw()
        }
    }).collect();

    let config = unsafe { std::mem::zeroed::<webp::WebPConfig>() };
    let mut encoder = webp::AnimEncoder::new(w, h, &config);
    for rgba in &rgba_data {
        let frame = webp::AnimFrame::from_rgba(rgba, w, h, delay_ms);
        encoder.add_frame(frame);
    }
    let anim = encoder.try_encode().map_err(|e| anyhow::anyhow!("WebP encode: {:?}", e))?;
    Ok(anim.to_vec())
}

pub fn scale_frame(img: &DynamicImage, target_w: u32, target_h: u32) -> DynamicImage {
    if target_w == 0 || target_h == 0 { img.clone() }
    else { img.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3) }
}
