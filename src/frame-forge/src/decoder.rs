use anyhow::Context;
use std::path::Path;
use std::time::Instant;

/// Decode a single video frame at `pos_ms` into a JPEG byte buffer.
/// If `width > 0`, scale the decoded frame to the given width (Lanczos3).
pub fn decode_and_encode(
    path: &Path,
    pos_ms: i64,
    width: u32,
) -> anyhow::Result<Vec<u8>> {
    let _t = Instant::now();

    let ictx = ffmpeg_next::format::input(&path)
        .with_context(|| format!("failed to open {}", path.display()))?;

    let video_stream = ictx
        .streams()
        .best(ffmpeg_next::media::Type::Video)
        .context("no video stream")?;
    let stream_index = video_stream.index();

    let mut decoder = ffmpeg_next::codec::context::Context::from_parameters(video_stream.parameters())?
        .decoder()
        .video()
        .context("failed to create video decoder")?;

    let time_base = video_stream.time_base();
    let target_pts = (pos_ms as i64)
        .checked_mul(time_base.den() as i64)
        .and_then(|v| v.checked_div(time_base.num() as i64 * 1000))
        .unwrap_or(0);

    // Seek to keyframe before target
    ictx.seek(
        stream_index as i32,
        target_pts,
        std::ops::Range { start: target_pts.saturating_sub(100), end: target_pts + 100 },
    )?;

    let mut decoded_rgb: Option<image::DynamicImage> = None;

    for (stream, packet) in ictx.packets() {
        if stream.index() != stream_index {
            continue;
        }
        decoder.send_packet(&packet)?;
        let mut decoded = ffmpeg_next::frame::Video::empty();
        while decoder.receive_frame(&mut decoded).is_ok() {
            let pts = decoded.pts().unwrap_or(0);
            if let Some(ref _existing) = decoded_rgb {
                if pts >= target_pts {
                    break;
                }
            }
            let mut rgb_frame = ffmpeg_next::frame::Video::empty();
            let mut scaler = ffmpeg_next::software::scaling::context::Context::get(
                decoder.format(),
                decoder.width(),
                decoder.height(),
                ffmpeg_next::format::Pixel::RGB24,
                decoder.width(),
                decoder.height(),
                ffmpeg_next::software::scaling::flag::Flags::BILINEAR,
            )?;
            scaler.run(&decoded, &mut rgb_frame)?;

            let rgb_data = rgb_frame.data(0).to_vec();
            let stride = rgb_frame.stride(0) as u32;
            let w = decoder.width();
            let h = decoder.height();

            let img = image::ImageBuffer::from_fn(w, h, |x, y| {
                let offset = (y * stride + x * 3) as usize;
                image::Rgb([rgb_data[offset], rgb_data[offset + 1], rgb_data[offset + 2]])
            });
            let dyn_img = image::DynamicImage::ImageRgb8(img);

            decoded_rgb = Some(if width > 0 && width < w {
                let new_h = (h as f64 * width as f64 / w as f64).round() as u32;
                dyn_img.resize_exact(width, new_h, image::imageops::FilterType::Lanczos3)
            } else {
                dyn_img
            });

            if pts >= target_pts {
                break;
            }
        }
        if decoded_rgb.is_some() {
            break;
        }
    }

    let img = decoded_rgb.context("no frame decoded")?;
    let mut jpeg_buf = std::io::Cursor::new(Vec::new());
    img.write_to(
        &mut jpeg_buf,
        image::ImageFormat::Jpeg,
    )?;

    let elapsed = _t.elapsed();
    let bytes = jpeg_buf.into_inner();
    eprintln!(
        "[frame-forge] decode {path} @{pos_ms}ms w={width} 鈫?{:.0}ms ({} B)",
        path.display(),
        elapsed.as_secs_f64() * 1000.0,
        bytes.len()
    );

    Ok(bytes)
}
