use anyhow::{Context, Result};
use std::path::Path;
use std::ptr;

use crate::hwaccel::{self, HwVendor};

/// Optional hardware-decode request threaded through `decode_range`/`decode_and_encode`.
/// `vendor`/`device` mirror `hwaccel::HwDeviceContext::create`'s parameters. Passing
/// `None` for the whole request (at call sites, not this struct) means "hardware
/// decode disabled" — the decoder never attempts `av_hwdevice_ctx_create` at all,
/// satisfying FR-008 (off means *zero* hw path attempts, not just "prefer software").
#[derive(Debug, Clone)]
pub struct HwDecodeRequest {
    pub vendor: HwVendor,
    pub device: Option<String>,
}

/// Reports a hardware-decode fallback event back to the caller, which is responsible
/// for turning it into a `FallbackEvent` in whatever generation-log format applies to
/// the in-flight task (`jfs-common` deliberately has no knowledge of `frame-forge`'s
/// log schema — this crate is shared by other binaries too).
/// Arguments: `(event_type, reason)` — see data-model.md §4 for the two conventional
/// `event_type` values (`hwdecode_init_failed` / `hwdecode_runtime_fallback`).
pub type HwFallbackSink<'a> = &'a mut dyn FnMut(&str, &str);

/// Allocates a not-yet-opened decoder `Context` from stream `params`.
///
/// `avcodec_find_decoder(id)` (what `ffmpeg_next`'s own `Decoder::video()` fallback uses)
/// returns whichever decoder was registered first for that codec ID — for AV1 on a
/// build with `libdav1d` linked in, that is `libdav1d`, not the native `av1` decoder,
/// because `libdav1d` is registered ahead of the native decoder precisely because it's
/// the faster choice for pure software decode. `libdav1d` has no hwaccel hook at all
/// (no `get_format`-based negotiation, no `hw_configs`), so attaching `hw_device_ctx`/
/// `get_format` to a context that ends up opened against it is silently inert — ffmpeg
/// never calls back into `get_format`, and decode just proceeds in software with no
/// error anywhere. This mirrors what `ffmpeg`'s own CLI does when a `-hwaccel` method is
/// requested (verbose log: "Selecting decoder 'av1' because of requested hwaccel
/// method cuda") — it explicitly re-resolves to the codec's *canonical* name
/// (`avcodec_get_name(id)`, e.g. `"av1"`/`"h264"`/`"hevc"`) rather than trusting
/// `avcodec_find_decoder`'s default pick, specifically so the hwaccel-capable generic
/// decoder is the one that actually gets opened.
///
/// Only does this when `want_hw` is true — the existing pure-software path keeps
/// whatever default `avcodec_find_decoder` picks (typically the faster `libdav1d` for
/// AV1), since there's no reason to give that up when no hwaccel was requested anyway.
fn open_decoder_context(
    params: ffmpeg_next::codec::Parameters,
    want_hw: bool,
) -> Result<ffmpeg_next::codec::context::Context> {
    use ffmpeg_next as ff;

    if want_hw {
        if let Some(codec) = ff::codec::decoder::find_by_name(params.id().name()) {
            let mut ctx = ff::codec::context::Context::new_with_codec(codec);
            ctx.set_parameters(params)?;
            return Ok(ctx);
        }
    }
    ff::codec::context::Context::from_parameters(params)
        .map_err(anyhow::Error::from)
}

/// Attempts to create + attach a hw device context to `avctx_ptr`. On failure, reports
/// `hwdecode_init_failed` via `on_fallback` and returns `None` — callers must then
/// proceed exactly as if `hw` had been `None` from the start (FR-003: init failure is
/// silent to the end user, the operation completes via the existing software path).
fn try_attach_hw(
    avctx_ptr: *mut ffmpeg_next::ffi::AVCodecContext,
    hw: &HwDecodeRequest,
    on_fallback: &mut Option<HwFallbackSink<'_>>,
) -> Option<(HwVendor, Box<hwaccel::GetFormatCtx>)> {
    match hwaccel::HwDeviceContext::create(hw.vendor, hw.device.as_deref()) {
        Ok(device_ctx) => {
            let boxed = hwaccel::attach_hw_device(avctx_ptr, device_ctx, hw.vendor);
            Some((hw.vendor, boxed))
        }
        Err(e) => {
            if let Some(sink) = on_fallback.as_mut() {
                sink("hwdecode_init_failed", &e.to_string());
            }
            None
        }
    }
}

/// Shared by both the main decode loop and the EOF-flush recovery loop in
/// `decode_range_hw`: turns a just-received frame into the frame that should actually
/// be encoded, transparently transferring hw-surface frames to software. Returns
/// `None` when a hw frame's transfer failed (FR-004 runtime fallback) — the caller
/// must skip emitting that frame rather than encode garbage; the caller's own
/// missing-frame handling covers the gap.
fn resolve_decoded_frame(
    frame: ffmpeg_next::frame::Video,
    hw_active: &mut Option<(HwVendor, Box<hwaccel::GetFormatCtx>)>,
    on_fallback: &mut Option<HwFallbackSink<'_>>,
) -> Option<ffmpeg_next::frame::Video> {
    if let Some((vendor, ctx)) = hw_active.as_mut() {
        if hwaccel::is_hw_frame(&frame, *vendor) {
            return match hwaccel::transfer_to_software(&frame) {
                Ok(sw) => Some(sw),
                Err(e) => {
                    if let Some(sink) = on_fallback.as_mut() {
                        sink("hwdecode_runtime_fallback", &e.to_string());
                    }
                    // Best-effort: stop offering the hw format from the next GOP
                    // boundary onward in this same call (see GetFormatCtx::disable's
                    // doc comment for why this can't help the *current* GOP).
                    ctx.disable();
                    None
                }
            };
        }
    }
    Some(frame)
}

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
///
/// Pure-software entry point — equivalent to `decode_range_hw(.., None, None, ..)`.
/// Existing call sites keep working unmodified; hw decode is strictly opt-in via the
/// `_hw` variant below (FR-008: disabled means zero hw path attempts).
pub fn decode_range(
    path: &Path,
    targets: &[(i64, i64)],
    width: u32,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    on_frame: impl FnMut(i64, i64, Vec<u8>, Vec<u8>) -> Result<()>,
) -> Result<()> {
    decode_range_hw(path, targets, width, cancel, None, None, on_frame)
}

/// Same as `decode_range`, with optional hardware-decode acceleration.
///
/// `hw = None` behaves identically to `decode_range` (no `av_hwdevice_ctx_create` call
/// is ever made — FR-008). `hw = Some(req)`: attempts to attach a hw device context
/// before decoding starts; on failure, reports `hwdecode_init_failed` via
/// `on_fallback` and proceeds entirely in software for this call (FR-003). If hw
/// attaches successfully but a specific frame's `av_hwframe_transfer_data` fails
/// mid-stream, reports `hwdecode_runtime_fallback` and skips emitting that one frame
/// (the caller's existing missing-frame handling — e.g. the `frameFailed` SSE event in
/// `handle_prefetch_range_stream` — covers a target that never received an `on_frame`
/// callback) while best-effort signalling the decoder to stop offering the hw format
/// for any later GOP boundary in this same call (FR-004).
///
/// Internally pipelined: a dedicated producer thread does demux/decode/(if hw)
/// transfer/color-convert, handing finished RGBA buffers to this (the caller's) thread
/// over a small bounded channel for the actual WebP encode. Measured cost breakdown on
/// 1080p10 AV1 content is decode+transfer ≈1-2ms/frame (GPU-bound, hw or sw) vs WebP
/// encode ≈150-300ms/frame (CPU-bound) — without pipelining, those run strictly
/// sequentially on one thread, so a hw decode that's *faster* at decoding still loses
/// overall to software decode, because it adds the `av_hwframe_transfer_data` PCIe
/// round-trip as pure extra serial latency with the GPU sitting idle the whole time the
/// CPU is encoding. Pipelining lets the producer decode (and, for hw, transfer) frame
/// N+1 while the consumer is still encoding frame N, hiding the GPU-side cost almost
/// entirely behind the dominant CPU-side encode cost, and frees the CPU from
/// slice-decode duty entirely when hw is active (so encode gets the whole CPU to
/// itself). The bounded channel (capacity 3) caps how many decoded-but-not-yet-encoded
/// frames' RGBA buffers can be in flight at once, bounding memory growth if the
/// consumer falls behind.
pub fn decode_range_hw(
    path: &Path,
    targets: &[(i64, i64)],
    width: u32,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    hw: Option<HwDecodeRequest>,
    mut on_fallback: Option<HwFallbackSink<'_>>,
    mut on_frame: impl FnMut(i64, i64, Vec<u8>, Vec<u8>) -> Result<()>,
) -> Result<()> {
    if targets.is_empty() { return Ok(()); }

    let path_owned = path.to_path_buf();
    let targets_owned = targets.to_vec();
    let cancel_producer = std::sync::Arc::clone(&cancel);

    let (tx, rx) = std::sync::mpsc::sync_channel::<DecodedItem>(3);

    let producer = std::thread::Builder::new()
        .name("jfs-decode-range".into())
        .spawn(move || decode_range_producer(&path_owned, &targets_owned, width, cancel_producer, hw, tx))
        .context("failed to spawn decode-range producer thread")?;

    for item in rx {
        match item {
            DecodedItem::Fallback { event, reason } => {
                if let Some(sink) = on_fallback.as_mut() {
                    sink(event, &reason);
                }
            }
            DecodedItem::Frame { fi_idx, pos_ms, thumb, orig } => {
                let (webp_thumb, webp_orig) = match orig {
                    None => (encode_webp_lossless_rgba(&thumb.rgba, thumb.w, thumb.h)?, vec![]),
                    Some(orig) => (
                        encode_webp_lossy_rgba(&thumb.rgba, thumb.w, thumb.h, 85.0)?,
                        encode_webp_lossless_rgba(&orig.rgba, orig.w, orig.h)?,
                    ),
                };
                on_frame(fi_idx, pos_ms, webp_thumb, webp_orig)?;
                if cancel.load(std::sync::atomic::Ordering::Relaxed) { break; }
            }
        }
    }

    match producer.join() {
        Ok(result) => result,
        Err(_) => anyhow::bail!("decode-range producer thread panicked"),
    }
}

struct FrameRgba { rgba: Vec<u8>, w: u32, h: u32 }

enum DecodedItem {
    Frame { fi_idx: i64, pos_ms: i64, thumb: FrameRgba, orig: Option<FrameRgba> },
    Fallback { event: &'static str, reason: String },
}

/// Runs entirely on `decode_range_hw`'s producer thread: demux, decode, (if hw)
/// transfer-to-software, color-convert to RGBA, and send each matched frame's RGBA
/// buffer(s) to the consumer over `tx`. Mirrors the pre-pipelining version of
/// `decode_range_hw` exactly in matching/flush/cancellation logic — only *where* the
/// WebP-encode step happens (moved to the consumer) and *how* fallback events are
/// reported (sent as channel messages instead of calling `on_fallback` directly, since
/// `HwFallbackSink` is a borrowed, non-`Send` closure that must stay on the caller's
/// thread) have changed.
fn decode_range_producer(
    path: &Path,
    targets: &[(i64, i64)],
    width: u32,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    hw: Option<HwDecodeRequest>,
    tx: std::sync::mpsc::SyncSender<DecodedItem>,
) -> Result<()> {
    use ffmpeg_next as ff;
    use ffmpeg_next::threading;

    let first_ms = targets[0].1;
    let last_ms  = targets[targets.len() - 1].1;

    // pos_ms → fi_idx: match decoded frames to targets by PTS proximity (±half-frame).
    // Using BTreeMap + range query avoids relying on compute_frame_idx consistency and
    // handles B-frame DTS/PTS reordering transparently via ffmpeg's own frame.pts().
    let mut pos_to_fi: std::collections::BTreeMap<i64, i64> =
        targets.iter().map(|&(fi, ms)| (ms, fi)).collect();

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
        let params = s.parameters();
        let ctx = open_decoder_context(params, hw.is_some())?;
        (s.index(), tb, fps_num, fps_den, start_ms, ctx)
    };

    // Match tolerance: ±2 frames. best_effort_timestamp can deviate from demux PTS
    // by up to one B-frame period, so half_frame is too tight for AV1/H.264 B-frames.
    let frame_dur_ms = if fps_num > 0 && fps_den > 0 {
        fps_den * 1000 / fps_num + 1
    } else { 33i64 };
    let two_frame_ms = frame_dur_ms * 2;

    let thread_count = std::thread::available_parallelism()
        .map(|n| n.get()).unwrap_or(2).min(4);

    let mut decoder_ctx = {
        let mut ctx = codec_ctx;
        ctx.set_threading(threading::Config {
            kind: threading::Type::Slice,
            count: thread_count,
        });
        ctx.decoder()
    };

    // on_fallback events can't cross to the caller's thread as a borrowed closure
    // (HwFallbackSink isn't Send), so this local closure forwards them as channel
    // messages instead — the consumer loop in decode_range_hw calls the caller's real
    // on_fallback sink on its own thread when it sees a DecodedItem::Fallback.
    let mut on_fallback: Option<HwFallbackSink<'_>> = Some(&mut |event: &str, reason: &str| {
        let _ = tx.send(DecodedItem::Fallback {
            event: if event == "hwdecode_init_failed" { "hwdecode_init_failed" } else { "hwdecode_runtime_fallback" },
            reason: reason.to_string(),
        });
    });

    // Must attach hw_device_ctx/get_format BEFORE the codec is opened — `.video()`
    // below calls `avcodec_open2` internally, and ffmpeg negotiates/binds hwaccel
    // state during open, not lazily on first packet. Setting these fields on an
    // already-opened `AVCodecContext` is a silent no-op: no error, just permanent
    // software decode for the lifetime of this context.
    let mut hw_active: Option<(HwVendor, Box<hwaccel::GetFormatCtx>)> = hw.as_ref().and_then(|req| {
        // SAFETY: `decoder_ctx` is freshly wrapped above and not yet opened (no
        // send_packet/receive_frame call is possible before `.video()`) — `as_mut_ptr`
        // aliasing rules require no other live reference into the same
        // AVCodecContext, which holds here since we have exclusive `&mut decoder_ctx`
        // and nothing else has captured its pointer.
        let avctx_ptr = unsafe { decoder_ctx.as_mut_ptr() };
        try_attach_hw(avctx_ptr, req, &mut on_fallback)
    });

    let mut decoder = decoder_ctx.video()?;

    // Seek to just before first target so we land on the preceding keyframe
    let seek_ts = first_ms.saturating_sub(100) * 1000;
    let _ = ictx.seek(seek_ts, ..seek_ts);
    decoder.flush();

    // Sends one matched+resolved frame's RGBA buffer(s) to the consumer. Returns
    // `Err` only on a hard processing error (e.g. sws_scale failure) — a closed
    // channel (consumer gave up, e.g. its own `on_frame` returned `Err`) is reported
    // via `Ok(false)` so the caller can stop the decode loop without treating
    // abandonment as a real error.
    let emit = |fi_idx: i64,
                target_ms: i64,
                frame: &ffmpeg_next::frame::Video,
                width: u32,
                tx: &std::sync::mpsc::SyncSender<DecodedItem>|
     -> Result<bool> {
        let item = if width == 0 {
            let (rgba, w, h) = frame_to_rgba(frame, 0)?;
            DecodedItem::Frame { fi_idx, pos_ms: target_ms, thumb: FrameRgba { rgba, w, h }, orig: None }
        } else {
            let (rgba_thumb, tw, th) = frame_to_rgba(frame, width)?;
            let (rgba_orig, ow, oh) = frame_to_rgba(frame, 0)?;
            DecodedItem::Frame {
                fi_idx,
                pos_ms: target_ms,
                thumb: FrameRgba { rgba: rgba_thumb, w: tw, h: th },
                orig: Some(FrameRgba { rgba: rgba_orig, w: ow, h: oh }),
            }
        };
        Ok(tx.send(item).is_ok())
    };

    'outer: for (s, pkt) in ictx.packets() {
        if s.index() != stream_idx { continue; }
        if cancel.load(std::sync::atomic::Ordering::Relaxed) { break; }

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
                    // best_effort_timestamp is ffmpeg's corrected display PTS estimate,
                    // more reliable than frame.pts() when pkt.pts was missing in the
                    // container (common for B-frames in AV1/H.264 MP4).
                    let fpts = {
                        let best = unsafe { (*frame.as_ptr()).best_effort_timestamp };
                        if best != i64::MIN { best } else { frame.pts().unwrap_or(pkt_pts) }
                    };
                    let pts_ms = if tb.0 != 0 && tb.1 != 0 {
                        let raw = (fpts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64;
                        (raw - stream_start_ms).max(0)
                    } else { 0 };

                    if pts_ms < first_ms { continue; }
                    if pts_ms > last_ms + 500 { break 'outer; }

                    // ±2-frame tolerance: B-frame DTS/PTS offsets can span up to one frame
                    // period; ±2 frames (≈33ms at 60fps) catches these without false-matching.
                    let lo = pts_ms.saturating_sub(two_frame_ms);
                    let hi = pts_ms + two_frame_ms;
                    let matched = pos_to_fi
                        .range(lo..=hi)
                        .min_by_key(|(&target_ms, _)| (target_ms - pts_ms).abs())
                        .map(|(&target_ms, &fi)| (target_ms, fi));

                    if let Some((target_ms, fi_idx)) = matched {
                        pos_to_fi.remove(&target_ms);
                        let Some(frame) = resolve_decoded_frame(frame, &mut hw_active, &mut on_fallback) else {
                            if cancel.load(std::sync::atomic::Ordering::Relaxed) { break 'outer; }
                            if pos_to_fi.is_empty() { break 'outer; }
                            continue;
                        };
                        if !emit(fi_idx, target_ms, &frame, width, &tx)? { break 'outer; }
                        if cancel.load(std::sync::atomic::Ordering::Relaxed) { break 'outer; }
                        if pos_to_fi.is_empty() { break 'outer; }
                    }
                }
            }
        }
    }

    // Flush frames remaining in decoder buffer. AV1/H.264 with complex B-frame
    // hierarchies may hold frames that need future packets as references; flushing
    // recovers them after the outer loop exits early.
    if !pos_to_fi.is_empty() && !cancel.load(std::sync::atomic::Ordering::Relaxed) {
        let _ = decoder.send_eof();
        loop {
            let mut frame = ff::frame::Video::empty();
            if decoder.receive_frame(&mut frame).is_err() { break; }
            let fpts = {
                let best = unsafe { (*frame.as_ptr()).best_effort_timestamp };
                if best != i64::MIN { best } else { frame.pts().unwrap_or(0) }
            };
            let pts_ms = if tb.0 != 0 && tb.1 != 0 {
                let raw = (fpts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64;
                (raw - stream_start_ms).max(0)
            } else { 0 };
            if pts_ms < first_ms || pts_ms > last_ms + 500 { continue; }
            let lo = pts_ms.saturating_sub(two_frame_ms);
            let hi = pts_ms + two_frame_ms;
            let matched = pos_to_fi.range(lo..=hi)
                .min_by_key(|(&target_ms, _)| (target_ms - pts_ms).abs())
                .map(|(&target_ms, &fi)| (target_ms, fi));
            if let Some((target_ms, fi_idx)) = matched {
                pos_to_fi.remove(&target_ms);
                let Some(frame) = resolve_decoded_frame(frame, &mut hw_active, &mut on_fallback) else {
                    if cancel.load(std::sync::atomic::Ordering::Relaxed) { break; }
                    if pos_to_fi.is_empty() { break; }
                    continue;
                };
                if !emit(fi_idx, target_ms, &frame, width, &tx)? { break; }
                if cancel.load(std::sync::atomic::Ordering::Relaxed) { break; }
                if pos_to_fi.is_empty() { break; }
            }
        }
    }

    Ok(())
}

/// Decode one frame and encode to WebP. Returns a `DecodeResult`.
/// `webp` = WebP at target_width (lossy if width > 0, lossless if width == 0).
/// `webp_orig` = WebP lossless at native frame size (empty when target_width == 0).
///
/// Pure-software entry point — equivalent to `decode_and_encode_hw(.., None, None)`.
pub fn decode_and_encode(path: &Path, pos_ms: i64, target_width: u32) -> Result<DecodeResult> {
    decode_and_encode_hw(path, pos_ms, target_width, None, None)
}

/// Same as `decode_and_encode`, with optional hardware-decode acceleration.
///
/// `hw = None`: identical to `decode_and_encode`, no hw path ever attempted
/// (FR-008). `hw = Some(req)`: init failure reports `hwdecode_init_failed` and
/// proceeds entirely in software (FR-003). If the single frame this function
/// produces fails `av_hwframe_transfer_data` (runtime fallback), this function
/// reports `hwdecode_runtime_fallback` and re-decodes the same `pos_ms` once more via
/// the plain software `decode_and_encode` — unlike `decode_range_hw`'s per-target
/// skip-and-log (which has many other targets in the same call to fall back on),
/// this function has only the one frame to produce, so a full software retry is the
/// only way to honor FR-004's "operation still completes" guarantee here.
pub fn decode_and_encode_hw(
    path: &Path,
    pos_ms: i64,
    target_width: u32,
    hw: Option<HwDecodeRequest>,
    mut on_fallback: Option<HwFallbackSink<'_>>,
) -> Result<DecodeResult> {
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
        codec_ctx = open_decoder_context(params, hw.is_some())?;

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

    let mut decoder_ctx = {
        let mut ctx = codec_ctx;
        ctx.set_threading(threading::Config {
            kind: threading::Type::Slice,
            count: thread_count,
        });
        ctx.decoder()
    };

    // Must attach hw_device_ctx/get_format BEFORE the codec is opened — see
    // decode_range_hw's identical comment for why setting these post-open is a
    // silent permanent-software-decode no-op rather than an error.
    //
    // SAFETY: same reasoning as decode_range_hw — `decoder_ctx` is freshly wrapped
    // and not yet opened, so no other reference into this AVCodecContext is live.
    let mut hw_active: Option<(HwVendor, Box<hwaccel::GetFormatCtx>)> = hw.as_ref().and_then(|req| {
        let avctx_ptr = unsafe { decoder_ctx.as_mut_ptr() };
        try_attach_hw(avctx_ptr, req, &mut on_fallback)
    });

    let mut decoder = decoder_ctx.video()?;

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
    let frame = match resolve_decoded_frame(frame, &mut hw_active, &mut on_fallback) {
        Some(f) => f,
        None => return decode_and_encode(path, pos_ms, target_width),
    };
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

/// Decode every video frame in `path` sequentially as packed RGBA bytes at native
/// resolution. Returns (frames as (rgba_bytes, width, height), fps).
///
/// Intended for short clips only (e.g. re-decoding an already-generated result file
/// for upscaling) — loads every frame into memory at once, unlike `decode_range`'s
/// callback-driven streaming.
pub fn decode_all_frames_rgba(path: &Path) -> Result<(Vec<(Vec<u8>, u32, u32)>, f64)> {
    use ffmpeg_next as ff;
    use ffmpeg_next::threading;

    let mut ictx = ff::format::input(path)
        .with_context(|| format!("cannot open {:?}", path))?;

    let stream_idx;
    let fps: f64;
    let codec_ctx;

    {
        let stream = ictx
            .streams()
            .best(ff::media::Type::Video)
            .context("no video stream")?;
        stream_idx = stream.index();
        let rate = stream.avg_frame_rate();
        fps = if rate.1 > 0 { rate.0 as f64 / rate.1 as f64 } else { 24.0 };
        codec_ctx = ff::codec::context::Context::from_parameters(stream.parameters())?;
    }

    let thread_count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .min(4);

    let mut decoder = {
        let mut ctx = codec_ctx;
        ctx.set_threading(threading::Config {
            kind: threading::Type::Slice,
            count: thread_count,
        });
        ctx.decoder().video()?
    };

    let mut frames = Vec::new();
    for (s, pkt) in ictx.packets() {
        if s.index() != stream_idx { continue; }
        if decoder.send_packet(&pkt).is_err() { continue; }
        loop {
            let mut frame = ff::frame::Video::empty();
            match decoder.receive_frame(&mut frame) {
                Ok(_) => frames.push(frame_to_rgba(&frame, 0)?),
                Err(_) => break,
            }
        }
    }
    let _ = decoder.send_eof();
    loop {
        let mut frame = ff::frame::Video::empty();
        match decoder.receive_frame(&mut frame) {
            Ok(_) => frames.push(frame_to_rgba(&frame, 0)?),
            Err(_) => break,
        }
    }

    anyhow::ensure!(!frames.is_empty(), "no video frames decoded from {:?}", path);
    Ok((frames, fps))
}

/// Enumerate all video frame timestamps by demuxing (no decoding).
/// Calls `on_frame(frame_index, pts_ms, is_keyframe)` for each frame as it is read.
/// Returns (total_frame_count, fps_num, fps_den).
/// Fast: reads container index without decoding pixel data.
///
/// 方案三: Uses `av_parser_parse2` to obtain display-order PTS directly from
/// the codec bitstream parser, eliminating DTS/PTS cross-phase mismatch.
/// If the parser is unsupported for a codec, falls back to packet-level
/// PTS/DTS with a warn log (FR-002 exception).
pub fn demux_frames(
    path: &Path,
    mut on_frame: impl FnMut(usize, i64, bool),
) -> Result<(usize, i64, i64)> {
    use ffmpeg_next as ff;
    use ffmpeg_next::ffi::*;

    let mut ictx = ff::format::input(path)
        .with_context(|| format!("cannot open {:?}", path))?;

    let stream_idx;
    let tb;
    let fps_num: i64;
    let fps_den: i64;
    let stream_start_ms: i64;
    let mut parser_ctx: *mut AVCodecParserContext;
    let mut avctx_ptr: *mut AVCodecContext;

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

        // Initialize codec parser for display-order PTS (方案三).
        // avcodec_parameters_to_context is called here while the stream borrow is live.
        unsafe {
            let codec_id = (*stream.parameters().as_ptr()).codec_id;
            let avcodec  = avcodec_find_decoder(codec_id);
            parser_ctx = av_parser_init(codec_id as i32);
            if parser_ctx.is_null() {
                log::warn!("[demux] av_parser_init returned NULL for codec_id={codec_id:?}; \
                            falling back to DTS (FR-002 exception)");
            }
            avctx_ptr = if !avcodec.is_null() {
                let ctx = avcodec_alloc_context3(avcodec);
                if !ctx.is_null() {
                    avcodec_parameters_to_context(ctx, stream.parameters().as_ptr());
                }
                ctx
            } else {
                std::ptr::null_mut()
            };
        }
    }

    let mut frame_count = 0usize;

    for (stream, pkt) in ictx.packets() {
        if stream.index() != stream_idx {
            continue;
        }
        let is_key = pkt.is_key();

        let pts_ms = if !parser_ctx.is_null() && !avctx_ptr.is_null() {
            // Parser path: call av_parser_parse2 to get display-order PTS.
            let pkt_data = pkt.data().map_or(std::ptr::null(), |d| d.as_ptr());
            let pkt_size = pkt.size() as i32;
            let mut out_data: *mut u8 = std::ptr::null_mut();
            let mut out_size: i32 = 0;
            unsafe {
                av_parser_parse2(
                    parser_ctx, avctx_ptr,
                    &mut out_data, &mut out_size,
                    pkt_data, pkt_size,
                    pkt.pts().unwrap_or(i64::MIN),
                    pkt.dts().unwrap_or(i64::MIN),
                    -1, // byte position unknown; parser uses pts/dts for ordering
                );
            }
            // out_size == 0: parser is buffering or this is a non-show frame
            // (e.g. AV1 invisible reference frames). Skip — not a displayed frame.
            if out_size == 0 {
                continue;
            }
            let corrected_pts = unsafe { (*parser_ctx).pts };
            let raw_pts = if corrected_pts != i64::MIN {
                corrected_pts
            } else {
                pkt.pts().or_else(|| pkt.dts()).unwrap_or(0)
            };
            let raw = if tb.0 != 0 && tb.1 != 0 {
                (raw_pts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64
            } else if fps_num > 0 {
                (frame_count as i64 * fps_den * 1000) / fps_num
            } else {
                frame_count as i64 * 42
            };
            (raw - stream_start_ms).max(0)
        } else {
            // Fallback path: packet-level PTS/DTS (original logic).
            let pts = pkt.pts().or_else(|| pkt.dts()).unwrap_or(0);
            if tb.0 != 0 && tb.1 != 0 {
                let raw = (pts as f64 * tb.0 as f64 * 1000.0 / tb.1 as f64) as i64;
                (raw - stream_start_ms).max(0)
            } else if fps_num > 0 {
                (frame_count as i64 * fps_den * 1000) / fps_num
            } else {
                frame_count as i64 * 42
            }
        };

        on_frame(frame_count, pts_ms, is_key);
        frame_count += 1;
    }

    // Release parser and codec context.
    unsafe {
        if !parser_ctx.is_null() { av_parser_close(parser_ctx); }
        if !avctx_ptr.is_null()  { avcodec_free_context(&mut avctx_ptr); }
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
    encode_webp_lossy_rgba(&rgba, w, h, quality)
}

fn encode_webp_lossless(frame: &ffmpeg_next::frame::Video) -> Result<Vec<u8>> {
    let (rgba, w, h) = frame_to_rgba(frame, 0)?;
    encode_webp_lossless_rgba(&rgba, w, h)
}

/// Same as `encode_webp_lossy`, taking already color-converted RGBA bytes instead of a
/// raw decoded frame — lets `decode_range_hw`'s pipelined producer thread do the
/// (cheap) `frame_to_rgba` conversion while this (the actual ~100-200ms/frame cost)
/// runs on the consumer thread, overlapped with the *next* frame's decode.
fn encode_webp_lossy_rgba(rgba: &[u8], w: u32, h: u32, quality: f32) -> Result<Vec<u8>> {
    let out = webpx::Encoder::new_rgba(rgba, w, h)
        .quality(quality)
        .encode(enough::Unstoppable)
        .map_err(|e| anyhow::anyhow!("WebP lossy encode: {e}"))?;
    Ok(out.to_vec())
}

/// See `encode_webp_lossy_rgba`.
fn encode_webp_lossless_rgba(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>> {
    let out = webpx::Encoder::new_rgba(rgba, w, h)
        .lossless(true)
        .encode(enough::Unstoppable)
        .map_err(|e| anyhow::anyhow!("WebP lossless encode: {e}"))?;
    Ok(out.to_vec())
}

#[cfg(test)]
mod hw_integration_tests {
    use super::*;
    use crate::hwaccel::HwVendor;

    /// Manual hw-decode integration test against a real video file. Real GPU access is
    /// required, so this is `#[ignore]`d by default and must be run explicitly. Point it
    /// at any file under `demo/` (or elsewhere):
    ///
    /// ```sh
    /// FRAME_FORGE_TEST_HW_VIDEO=/abs/path/to/video.mkv RUST_LOG=warn \
    ///   cargo test -p jfs-common hw_decode_engages_real_hardware -- --ignored --nocapture
    /// ```
    ///
    /// Optional: `FRAME_FORGE_TEST_HW_VENDOR=cuda|vaapi` (default `cuda`),
    /// `FRAME_FORGE_TEST_HW_DEVICE=/dev/dri/renderD128` (VAAPI device path, ignored for
    /// CUDA). Runs entirely on the host (no Docker/opencv container needed) since this
    /// crate has no opencv dependency — much faster than redeploying frame-forge into a
    /// container just to re-check hwaccel wiring via the daemon's socket protocol.
    #[test]
    #[ignore]
    fn hw_decode_engages_real_hardware() {
        let _ = env_logger::builder().is_test(false).try_init();

        let path = std::env::var("FRAME_FORGE_TEST_HW_VIDEO")
            .expect("set FRAME_FORGE_TEST_HW_VIDEO=/abs/path/to/video.mkv to run this test");
        let vendor = match std::env::var("FRAME_FORGE_TEST_HW_VENDOR").as_deref() {
            Ok("vaapi") => HwVendor::Vaapi,
            _ => HwVendor::Cuda,
        };
        let device = std::env::var("FRAME_FORGE_TEST_HW_DEVICE").ok();
        let hw = HwDecodeRequest { vendor, device };

        // 60 targets spaced 200ms apart (12s of content) — enough to span several GOPs
        // without requiring a long video.
        let targets: Vec<(i64, i64)> = (0..60).map(|i| (i, i * 200)).collect();

        let mut fallback_events: Vec<(String, String)> = Vec::new();
        let mut sink = |event: &str, reason: &str| {
            fallback_events.push((event.to_string(), reason.to_string()));
        };
        let mut decoded = 0u32;

        decode_range_hw(
            std::path::Path::new(&path),
            &targets,
            320,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Some(hw),
            Some(&mut sink),
            |_fi, _ms, _thumb, _orig| {
                decoded += 1;
                Ok(())
            },
        )
        .expect("decode_range_hw failed");

        eprintln!("[hw-test] decoded={decoded} fallback_events={fallback_events:?}");
        assert!(decoded > 0, "no frames decoded — check FRAME_FORGE_TEST_HW_VIDEO/targets range");
        assert!(
            fallback_events.is_empty(),
            "hw decode fell back to software: {fallback_events:?}"
        );
    }

    /// Decodes `frame_count` consecutive frames from `path` and returns how long that
    /// took. Deliberately stops at `receive_frame`/`resolve_decoded_frame` — no
    /// `frame_to_rgba`/WebP encode, no disk cache, no SSE/socket protocol, nothing
    /// from `frame-forge`'s server.rs. This isolates decode (+ hw transfer, if `hw` is
    /// `Some`) as the only thing being timed, so a hw/sw speed comparison can't be
    /// drowned out or skewed by the (much larger, and identical either way) WebP
    /// encode cost that dominates `decode_range_hw`'s own end-to-end timing.
    fn decode_only(path: &std::path::Path, frame_count: usize, hw: Option<HwDecodeRequest>) -> std::time::Duration {
        use ffmpeg_next as ff;
        use ffmpeg_next::threading;

        let mut ictx = ff::format::input(path).expect("open input");
        let (stream_idx, codec_ctx) = {
            let s = ictx.streams().best(ff::media::Type::Video).expect("no video stream");
            let ctx = open_decoder_context(s.parameters(), hw.is_some()).expect("open_decoder_context");
            (s.index(), ctx)
        };
        let mut decoder_ctx = {
            let mut ctx = codec_ctx;
            ctx.set_threading(threading::Config { kind: threading::Type::Slice, count: 4 });
            ctx.decoder()
        };
        let mut on_fallback: Option<HwFallbackSink<'_>> = Some(&mut |event: &str, reason: &str| {
            eprintln!("[hw-test] decode_only fallback: {event} {reason}");
        });
        let mut hw_active = hw.as_ref().and_then(|req| {
            // SAFETY: same reasoning as decode_range_hw/decode_and_encode_hw — context
            // is freshly wrapped and not yet opened.
            let avctx_ptr = unsafe { decoder_ctx.as_mut_ptr() };
            try_attach_hw(avctx_ptr, req, &mut on_fallback)
        });
        let mut decoder = decoder_ctx.video().expect("open decoder");

        let start = std::time::Instant::now();
        let mut got = 0usize;
        'outer: for (s, pkt) in ictx.packets() {
            if s.index() != stream_idx { continue; }
            if decoder.send_packet(&pkt).is_err() { continue; }
            loop {
                let mut frame = ff::frame::Video::empty();
                if decoder.receive_frame(&mut frame).is_err() { break; }
                let Some(_frame) = resolve_decoded_frame(frame, &mut hw_active, &mut on_fallback) else { continue };
                got += 1;
                if got >= frame_count { break 'outer; }
            }
        }
        let elapsed = start.elapsed();
        eprintln!("[hw-test] decode_only: hw={} frames={got} elapsed={elapsed:?} ({:.2}ms/frame)",
            hw.is_some(), elapsed.as_secs_f64() * 1000.0 / got.max(1) as f64);
        elapsed
    }

    /// Pure decode-speed comparison: hw vs sw, no WebP encode, no disk cache, no
    /// server.rs business logic — just `send_packet`/`receive_frame`(+ hw transfer)
    /// timing on the same file. Set `FRAME_FORGE_TEST_HW_VIDEO` to run:
    ///
    /// ```sh
    /// FRAME_FORGE_TEST_HW_VIDEO=/abs/path/to/video.mkv \
    ///   cargo test -p jfs-common hw_vs_sw_decode_only_speed -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn hw_vs_sw_decode_only_speed() {
        let path = std::env::var("FRAME_FORGE_TEST_HW_VIDEO")
            .expect("set FRAME_FORGE_TEST_HW_VIDEO=/abs/path/to/video.mkv to run this test");
        let path = std::path::Path::new(&path);
        let vendor = match std::env::var("FRAME_FORGE_TEST_HW_VENDOR").as_deref() {
            Ok("vaapi") => HwVendor::Vaapi,
            _ => HwVendor::Cuda,
        };
        let device = std::env::var("FRAME_FORGE_TEST_HW_DEVICE").ok();
        let frame_count: usize = std::env::var("FRAME_FORGE_TEST_HW_FRAMES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(300);

        let sw_elapsed = decode_only(path, frame_count, None);
        let hw_elapsed = decode_only(path, frame_count, Some(HwDecodeRequest { vendor, device }));

        let sw_ms = sw_elapsed.as_secs_f64() * 1000.0 / frame_count as f64;
        let hw_ms = hw_elapsed.as_secs_f64() * 1000.0 / frame_count as f64;
        eprintln!("[hw-test] pure decode: sw={sw_ms:.3}ms/frame hw={hw_ms:.3}ms/frame ratio={:.2}x", hw_ms / sw_ms);
    }
}
