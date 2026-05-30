use anyhow::Context;
use std::path::Path;
use std::time::Instant;

/// Decode a single video frame at `pos_ms` into a JPEG byte buffer.
/// Returns (jpeg_bytes, actual_pts_ms, fps_num, fps_den).
/// If `width > 0`, scale the decoded frame to the given width (Lanczos3).
pub fn decode_and_encode(
    path: &Path,
    pos_ms: i64,
    width: u32,
) -> anyhow::Result<(Vec<u8>, i64, i64, i64)> {
    let _t = Instant::now();

    let mut ictx = ffmpeg_next::format::input(&path)
        .with_context(|| format!("failed to open {}", path.display()))?;

    let video_stream = ictx
        .streams()
        .best(ffmpeg_next::media::Type::Video)
        .context("no video stream")?;
    let stream_index = video_stream.index();

    let fps_r = video_stream.avg_frame_rate();
    let fps_num = fps_r.0 as i64;
    let fps_den = if fps_r.1 > 0 { fps_r.1 as i64 } else { 1 };

    let time_base = video_stream.time_base();

    // Normalize pts to stream start so frame #0 = first real content frame.
    let start_pts = video_stream.start_time().unwrap_or(0).max(0);
    let stream_start_ms: i64 = if start_pts > 0
        && time_base.numerator() != 0 && time_base.denominator() != 0 {
        (start_pts as f64 * time_base.numerator() as f64 * 1000.0
            / time_base.denominator() as f64) as i64
    } else {
        0
    };

    let mut decoder = ffmpeg_next::codec::context::Context::from_parameters(video_stream.parameters())?
        .decoder()
        .video()
        .context("failed to create video decoder")?;
    // target_pts in stream timebase units (for frame comparison in decode loop)
    let target_pts = (pos_ms as i64)
        .checked_mul(time_base.denominator() as i64)
        .and_then(|v| v.checked_div(time_base.numerator() as i64 * 1000))
        .unwrap_or(0);

    // ictx.seek() uses AV_TIME_BASE (microseconds) when stream_index=-1
    let target_us = pos_ms * 1000;
    ictx.seek(target_us, ..)?;

    let mut decoded_rgb: Option<image::DynamicImage> = None;
    let mut saved_pkt_pts: i64 = 0;

    'outer: for (stream, packet) in ictx.packets() {
        if stream.index() != stream_index {
            continue;
        }
        let pkt_pts = packet.pts().or_else(|| packet.dts()).unwrap_or(0);
        decoder.send_packet(&packet)?;
        let mut decoded = ffmpeg_next::frame::Video::empty();
        while decoder.receive_frame(&mut decoded).is_ok() {
            if decoded_rgb.is_some() && pkt_pts >= target_pts {
                break 'outer;
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
            saved_pkt_pts = pkt_pts;

            if pkt_pts >= target_pts {
                break 'outer;
            }
        }
    }

    let img = decoded_rgb.context("no frame decoded")?;
    let mut jpeg_buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut jpeg_buf, image::ImageFormat::Jpeg)?;

    let elapsed = _t.elapsed();
    let bytes = jpeg_buf.into_inner();

    // Convert saved_pkt_pts to ms, normalized by stream start so frame #0 = first content frame.
    let actual_pts_ms = if time_base.numerator() != 0 && time_base.denominator() != 0 {
        let raw_ms = (saved_pkt_pts as f64 * time_base.numerator() as f64 * 1000.0
            / time_base.denominator() as f64) as i64;
        (raw_ms - stream_start_ms).max(0)
    } else {
        pos_ms
    };

    eprintln!(
        "[frame-forge] decode {} @{pos_ms}ms w={width} -> {:.0}ms ({} B)",
        path.display(),
        elapsed.as_secs_f64() * 1000.0,
        bytes.len()
    );

    Ok((bytes, actual_pts_ms, fps_num, fps_den))
}
