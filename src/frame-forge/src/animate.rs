use image::DynamicImage;
use std::io::Cursor;

//! Animated GIF and WebP encoding from decoded video frames.
//!
//! # GIF encoding (`gif` crate)
//! Uses `Frame::from_rgba_speed(quality=10)` for palette quantization.
//! Higher quality values (1-30) produce better color accuracy at the cost
//! of encoding time. Value 10 is a compromise for typical anime/game content.
//! Delay per frame = 100/fps centiseconds.
//!
//! # WebP encoding (`webp` crate)
//! Uses `AnimEncoder` with per-frame RGBA input. Delay in milliseconds.
//! Lossy compression is NOT used 鈥?frames are encoded as-is (lossless).
//!
//! # Caveats
//! - GIF max 256 colors per frame 鈥?severe banding on gradients
//! - WebP animation support in browsers is good but not universal (Edge <18 fails)
//! - No inter-frame compression delta 鈥?each frame is a full image
pub fn encode_gif(frames: &[DynamicImage], fps: u16, loop_count: u16) -> anyhow::Result<Vec<u8>> {
    use gif::{Encoder, Frame, Repeat};
    use image::RgbaImage;

    if frames.is_empty() {
        anyhow::bail!("no frames to encode");
    }

    let first = frames[0].to_rgba8();
    let (w, h) = first.dimensions();
    let mut buf = Cursor::new(Vec::new());

    {
        let mut encoder = Encoder::new(&mut buf, w as u16, h as u16, &[])?;
        encoder.set_repeat(if loop_count == 0 { Repeat::Infinite } else { Repeat::Finite(loop_count) })?;

        let delay = (100u16).saturating_div(fps.max(1)).max(1);

        for img in frames {
            let rgba = img.to_rgba8();
            // Convert RGBA to GIF palette (simple quantization via `gif` crate built-in)
            let frame = Frame::from_rgba_speed(w as u16, h as u16, &mut rgba.into_raw(), 10);
            encoder.write_frame(&frame)?;
        }
    }

    Ok(buf.into_inner())
}

/// Encode a sequence of frames as an animated WebP.
pub fn encode_webp_anim(frames: &[DynamicImage], fps: u16, _loop_count: u16) -> anyhow::Result<Vec<u8>> {
    use webp::AnimEncoder;

    if frames.is_empty() {
        anyhow::bail!("no frames to encode");
    }

    let first = frames[0].to_rgba8();
    let (w, h) = first.dimensions();

    let encoder = AnimEncoder::new(w, h);
    let delay_ms = (1000u32).saturating_div(fps.max(1) as u32).max(10);

    for img in frames {
        let rgba = img.to_rgba8();
        let webp_frame = webp::Frame::from_rgba(&rgba, w, h, delay_ms as i32)?;
        encoder.add_frame(&webp_frame)?;
    }

    let anim = encoder.encode()?;
    Ok(anim.into_vec())
}

/// Scale a frame to target dimensions according to resize parameters.
pub fn scale_frame(img: &DynamicImage, target_w: u32, target_h: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    if target_w == 0 || target_h == 0 || (target_w >= w && target_h >= h) {
        img.clone()
    } else {
        img.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3)
    }
}
