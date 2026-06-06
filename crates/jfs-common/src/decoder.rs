use anyhow::{Context, Result};
use std::path::Path;
use std::ptr;

/// Decode a contiguous range of frames in a single sequential pass.
///
/// Opens the file once, seeks to the range start, and decodes forward — avoiding the
/// O(N × GOP) cost of N independent seeks that `decode_and_encode` incurs.
///
/// `targets`: `(fi_idx, pos_ms)` pairs **sorted ascending by pos_ms**. Only frames whose
/// `fi_idx` (computed from their display PTS) appears in this list are emitted.
///
/// `on_frame(fi_idx, pos_ms, webp_thumb, webp_orig)` is called for each matched frame
/// in decode order. Return `Err` to abort early (e.g. on channel send failure).
pub fn decode_range(
    path: &Path,
    targets: &[(i64, i64)],
    width: u32,
    mut on_frame: impl FnMut(i64, i64, Vec<u8>, Vec<u8>) -> Result<()>,
) -> Result<()> {
    use ffmpeg_next as ff;
    use ffmpeg_next::threading;

    if targets.is_empty() { return Ok(()); }

    let first_ms = targets[0].1;
    let last_ms  = targets[targets.len() - 1].1;

    // fi_idx → pos_ms: look up the canonical pos_ms for each matched frame
    let mut fi_to_pos: std::collections::HashMap<i64, i64> =
        targets.iter().map(|&(fi, ms)| (fi, ms)).collect();

    let mut ictx = ff::format::input(path)
        .with_context(|| format!("cannot open {:?}", path))?;

    let (stream_idx, tb, fps_num, fps_den, stream_start_ms, codec_ctx) = {
        let s = ictx.streams().best(ff::media::Type::Video)
            .context("no video stream")?;
        let rate    = s.avg_frame_rate();
        let fps_num = rate.0 as i64;
        let fps_den = if rate.1 > 0 { rate.1 as i64 } else { 1 };
        let tb      = s.time_base();
        let spts    = s.start_time().max(0);
        let start_ms = if spts > 0 && tb.0 != 0 && tb.1 != 0 {
            (spts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64
        } else { 0 };
        let ctx = ff::codec::context::Context::from_parameters(s.parameters())?;
        (s.index(), tb, fps_num, fps_den, start_ms, ctx)
    };

    let thread_count = std::thread::available_parallelism()
        .map(|n| n.get()).unwrap_or(2).min(4);

    let mut decoder = {
        let mut ctx = codec_ctx;
        ctx.set_threading(threading::Config {
            kind: threading::Type::Slice,
            count: thread_count,
        });
        ctx.decoder().video()?
    };

    // Seek to just before first target so we land on the preceding keyframe
    let seek_ts = first_ms.saturating_sub(100) * 1000;
    let _ = ictx.seek(seek_ts, ..seek_ts);
    decoder.flush();

    'outer: for (s, pkt) in ictx.packets() {
        if s.index() != stream_idx { continue; }

        // Packet-level early exit: past the range + one extra second
        let pkt_pts = pkt.pts().or_else(|| pkt.dts()).unwrap_or(0);
        if tb.0 != 0 && tb.1 != 0 {
            let pkt_ms = (pkt_pts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64
                - stream_start_ms;
            if pkt_ms > last_ms + 1000 { break; }
        }

        if decoder.send_packet(&pkt).is_err() { continue; }

        loop {
            let mut frame = ff::frame::Video::empty();
            match decoder.receive_frame(&mut frame) {
                Err(_) => break,
                Ok(_) => {
                    // Use frame display PTS (set by decoder) for correct B-frame ordering
                    let fpts = frame.pts().unwrap_or(pkt_pts);
                    let pts_ms = if tb.0 != 0 && tb.1 != 0 {
                        let raw = (fpts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64;
                        (raw - stream_start_ms).max(0)
                    } else { 0 };

                    if pts_ms < first_ms { continue; }
                    if pts_ms > last_ms + 500 { break 'outer; }

                    let fi_idx = crate::compute_frame_idx(pts_ms, fps_num, fps_den);
                    if let Some(pos_ms) = fi_to_pos.remove(&fi_idx) {
                        let (webp_thumb, webp_orig) = if width == 0 {
                            (encode_webp_lossless(&frame)?, vec![])
                        } else {
                            (encode_webp_lossy(&frame, width, 85.0)?,
                             encode_webp_lossless(&frame)?)
                        };
                        on_frame(fi_idx, pos_ms, webp_thumb, webp_orig)?;
                        if fi_to_pos.is_empty() { break 'outer; }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Decode one frame and encode to WebP. Returns a `DecodeResult`.
/// `webp` = WebP at target_width (lossy if width > 0, lossless if width == 0).
/// `webp_orig` = WebP lossless at native frame size (empty when target_width == 0).
pub fn decode_and_encode(path: &Path, pos_ms: i64, target_width: u32) -> Result<DecodeResult> {
    use ffmpeg_next as ff;
    use ffmpeg_next::threading;

    let mut ictx = ff::format::input(path)
        .with_context(|| format!("cannot open {:?}", path))?;

    let stream_idx;
    let tb;
    let fps_num: i64;
    let fps_den: i64;
    let codec_ctx;
    let stream_start_ms: i64;

    {
        let stream = ictx
            .streams()
            .best(ff::media::Type::Video)
            .context("no video stream")?;
        stream_idx = stream.index();
        tb = stream.time_base();
        let rate = stream.avg_frame_rate();
        fps_num = rate.0 as i64;
        fps_den = if rate.1 > 0 { rate.1 as i64 } else { 1 };
        let params = stream.parameters();
        codec_ctx = ff::codec::context::Context::from_parameters(params)?;

        // Normalize pts to stream start so frame #0 = first real content frame.
        // stream.start_time() returns i64; AV_NOPTS_VALUE is i64::MIN (very negative).
        let start_pts = stream.start_time().max(0);
        stream_start_ms = if start_pts > 0 && tb.0 != 0 && tb.1 != 0 {
            (start_pts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64
        } else {
            0
        };
    }

    let thread_count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .min(2);

    let mut decoder = {
        let mut ctx = codec_ctx;
        ctx.set_threading(threading::Config {
            kind: threading::Type::Slice,
            count: thread_count,
        });
        ctx.decoder().video()?
    };

    let ts_us = pos_ms * 1000;
    let _ = ictx.seek(ts_us, ..ts_us);
    decoder.flush();

    let target_pts = if tb.0 != 0 && tb.1 != 0 {
        (pos_ms as f64 * tb.1 as f64 / (tb.0 as f64 * 1000.0)) as i64
    } else {
        0
    };

    let mut best: Option<ff::frame::Video> = None;
    let mut best_pts: i64 = 0;

    'outer: for (s, pkt) in ictx.packets() {
        if s.index() != stream_idx {
            continue;
        }
        let pkt_pts = pkt.pts().or_else(|| pkt.dts()).unwrap_or(0);
        if pkt_pts > target_pts && best.is_some() {
            break 'outer;
        }
        if decoder.send_packet(&pkt).is_err() {
            continue;
        }
        loop {
            let mut frame = ff::frame::Video::empty();
            match decoder.receive_frame(&mut frame) {
                Ok(_) => {
                    best_pts = pkt_pts;
                    best = Some(frame);
                }
                Err(_) => break,
            }
        }
        if pkt_pts >= target_pts {
            break 'outer;
        }
    }

    if best.is_none() {
        let _ = decoder.send_eof();
        loop {
            let mut frame = ff::frame::Video::empty();
            match decoder.receive_frame(&mut frame) {
                Ok(_) => { best = Some(frame); }
                Err(_) => break,
            }
        }
    }

    let frame = best.context("no frame decoded")?;
    let actual_pts_ms = if tb.0 != 0 && tb.1 != 0 {
        let raw_ms = (best_pts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64;
        (raw_ms - stream_start_ms).max(0)
    } else {
        pos_ms
    };

    let (webp, webp_orig) = if target_width == 0 {
        (encode_webp_lossless(&frame)?, vec![])
    } else {
        let thumb = encode_webp_lossy(&frame, target_width, 85.0)?;
        let orig  = encode_webp_lossless(&frame)?;
        (thumb, orig)
    };

    Ok(DecodeResult { webp, webp_orig, pts_ms: actual_pts_ms, fps_num, fps_den })
}

pub struct DecodeResult {
    pub webp:      Vec<u8>,
    pub webp_orig: Vec<u8>,
    pub pts_ms:    i64,
    pub fps_num:   i64,
    pub fps_den:   i64,
}

/// Enumerate all video frame timestamps by demuxing (no decoding).
/// Calls `on_frame(frame_index, pts_ms, is_keyframe)` for each frame as it is read.
/// Returns (total_frame_count, fps_num, fps_den).
/// Fast: reads container index without decoding pixel data.
pub fn demux_frames(
    path: &Path,
    mut on_frame: impl FnMut(usize, i64, bool),
) -> Result<(usize, i64, i64)> {
    use ffmpeg_next as ff;

    let mut ictx = ff::format::input(path)
        .with_context(|| format!("cannot open {:?}", path))?;

    let stream_idx;
    let tb;
    let fps_num: i64;
    let fps_den: i64;
    let stream_start_ms: i64;

    {
        let stream = ictx
            .streams()
            .best(ff::media::Type::Video)
            .context("no video stream")?;
        stream_idx = stream.index();
        tb = stream.time_base();
        let rate = stream.avg_frame_rate();
        fps_num = rate.0 as i64;
        fps_den = if rate.1 > 0 { rate.1 as i64 } else { 1 };

        let start_pts = stream.start_time().max(0);
        stream_start_ms = if start_pts > 0 && tb.0 != 0 && tb.1 != 0 {
            (start_pts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64
        } else {
            0
        };
    }

    let mut frame_count = 0usize;

    for (stream, pkt) in ictx.packets() {
        if stream.index() != stream_idx {
            continue;
        }
        let pts = pkt.pts().or_else(|| pkt.dts()).unwrap_or(0);
        let is_key = pkt.is_key();

        let pts_ms = if tb.0 != 0 && tb.1 != 0 {
            let raw = (pts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64;
            (raw - stream_start_ms).max(0)
        } else if fps_num > 0 {
            (frame_count as i64 * fps_den * 1000) / fps_num
        } else {
            frame_count as i64 * 42
        };

        on_frame(frame_count, pts_ms, is_key);
        frame_count += 1;
    }

    anyhow::ensure!(frame_count > 0, "no video frames found in {:?}", path);
    Ok((frame_count, fps_num, fps_den))
}

/// Convenience wrapper: collects all frames into a Vec.
pub fn index_frames(path: &Path) -> Result<(Vec<(i64, bool)>, i64, i64)> {
    let mut frames = Vec::new();
    let (count, fps_num, fps_den) = demux_frames(path, |_fi, ms, is_key| {
        frames.push((ms, is_key));
    })?;
    debug_assert_eq!(frames.len(), count);
    Ok((frames, fps_num, fps_den))
}

// ── WebP encoding helpers ────────────────────────────────────────────────────

/// Convert ffmpeg frame to packed RGBA bytes at the given target width (0 = original size).
fn frame_to_rgba(frame: &ffmpeg_next::frame::Video, target_width: u32) -> Result<(Vec<u8>, u32, u32)> {
    use ffmpeg_next::ffi::*;

    let aspect = frame.width() as f64 / frame.height() as f64;
    let (w, h) = if target_width == 0 {
        (frame.width() as i32, frame.height() as i32)
    } else {
        let w = ((target_width + 1) & !1) as i32;
        let h = ((((target_width as f64 / aspect) as u32).max(2) + 1) & !1) as i32;
        (w, h)
    };

    unsafe {
        let src = frame.as_ptr();
        let src_fmt: AVPixelFormat = std::mem::transmute((*src).format);

        let src_is_full_range = matches!(
            src_fmt,
            AVPixelFormat::AV_PIX_FMT_YUVJ420P
                | AVPixelFormat::AV_PIX_FMT_YUVJ422P
                | AVPixelFormat::AV_PIX_FMT_YUVJ444P
                | AVPixelFormat::AV_PIX_FMT_YUVJ440P
        ) || (*src).color_range == AVColorRange::AVCOL_RANGE_JPEG;

        let src_fmt_nd = match src_fmt {
            AVPixelFormat::AV_PIX_FMT_YUVJ420P => AVPixelFormat::AV_PIX_FMT_YUV420P,
            AVPixelFormat::AV_PIX_FMT_YUVJ422P => AVPixelFormat::AV_PIX_FMT_YUV422P,
            AVPixelFormat::AV_PIX_FMT_YUVJ444P => AVPixelFormat::AV_PIX_FMT_YUV444P,
            AVPixelFormat::AV_PIX_FMT_YUVJ440P => AVPixelFormat::AV_PIX_FMT_YUV440P,
            other => other,
        };

        let sws = sws_getContext(
            (*src).width, (*src).height, src_fmt_nd,
            w, h, AVPixelFormat::AV_PIX_FMT_RGBA,
            SWS_BILINEAR as i32,
            ptr::null_mut(), ptr::null_mut(), ptr::null(),
        );
        anyhow::ensure!(!sws.is_null(), "sws_getContext failed");

        let coeffs = sws_getCoefficients(SWS_CS_DEFAULT as i32);
        sws_setColorspaceDetails(
            sws,
            coeffs, if src_is_full_range { 1 } else { 0 },
            coeffs, 1,
            0, 1 << 16, 1 << 16,
        );

        let mut dst = av_frame_alloc();
        if dst.is_null() { sws_freeContext(sws); anyhow::bail!("av_frame_alloc failed"); }
        (*dst).format = AVPixelFormat::AV_PIX_FMT_RGBA as i32;
        (*dst).width  = w;
        (*dst).height = h;
        if av_frame_get_buffer(dst, 0) < 0 {
            av_frame_free(&mut dst); sws_freeContext(sws);
            anyhow::bail!("av_frame_get_buffer failed");
        }

        sws_scale(
            sws,
            (*src).data.as_ptr() as *const *const u8,
            (*src).linesize.as_ptr(),
            0, (*src).height,
            (*dst).data.as_mut_ptr() as *mut *mut u8,
            (*dst).linesize.as_mut_ptr(),
        );
        sws_freeContext(sws);

        // Copy packed RGBA, stripping stride padding
        let stride    = (*dst).linesize[0] as usize;
        let row_bytes = w as usize * 4;
        let mut rgba  = Vec::with_capacity(row_bytes * h as usize);
        let data_ptr  = (*dst).data[0];
        for row in 0..h as usize {
            let slice = std::slice::from_raw_parts(data_ptr.add(row * stride), row_bytes);
            rgba.extend_from_slice(slice);
        }

        av_frame_free(&mut dst);
        Ok((rgba, w as u32, h as u32))
    }
}

fn encode_webp_lossy(frame: &ffmpeg_next::frame::Video, target_width: u32, quality: f32) -> Result<Vec<u8>> {
    let (rgba, w, h) = frame_to_rgba(frame, target_width)?;
    let out = webpx::Encoder::new_rgba(&rgba, w, h)
        .quality(quality)
        .encode(enough::Unstoppable)
        .map_err(|e| anyhow::anyhow!("WebP lossy encode: {e}"))?;
    Ok(out.to_vec())
}

fn encode_webp_lossless(frame: &ffmpeg_next::frame::Video) -> Result<Vec<u8>> {
    let (rgba, w, h) = frame_to_rgba(frame, 0)?;
    let out = webpx::Encoder::new_rgba(&rgba, w, h)
        .lossless(true)
        .encode(enough::Unstoppable)
        .map_err(|e| anyhow::anyhow!("WebP lossless encode: {e}"))?;
    Ok(out.to_vec())
}
