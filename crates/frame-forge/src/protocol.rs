// Binary protocol frame read/write functions for frame-forge daemon.
// Follows the same pattern as seek-preview protocol.rs.

// Sanity bounds on length-prefixed fields read directly off the wire (untrusted u32 LE).
// Every read_*_req function below previously did `vec![0u8; len]` / `Vec::with_capacity(len)`
// straight from the wire value with zero validation — a single byte-offset desync between the
// C# writer and this reader (e.g. a field added/reordered on one side only) makes every
// subsequent length field garbage, which can then demand a multi-GB allocation with no chance
// to log anything first (the crash/OOM happens inside the allocator, before any of this
// function's own log lines run). These caps turn that failure mode into an immediate, logged
// `anyhow::bail!` instead of a silent resource-exhaustion crash — see investigation in the PR
// that introduced this comment (two production OOM kills of frame-forge with zero application
// log output, traced back to this file having no bounds anywhere).
const MAX_STR_FIELD_LEN: usize = 1 << 20; // 1 MiB — generous for any path/id/family/version string
const MAX_FRAME_COUNT: usize = 4096; // no real export UI ever submits anywhere near this many

/// Device selection strategy for hardware decode (spec FR-012). Wire-encoded as a
/// single `u8` (0 = Performance, 1 = IdleResource; anything else degrades to
/// Performance — see contracts/rest-api.md's "never 400 on a bad setting" philosophy,
/// applied here too rather than failing the whole request over one bad byte).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeviceStrategy {
    Performance,
    IdleResource,
}

impl DeviceStrategy {
    pub fn from_u8(v: u8) -> Self {
        if v == 1 { Self::IdleResource } else { Self::Performance }
    }
}

/// Every decode-triggering request carries these two fields (spec FR-005/FR-008/
/// FR-012) — see contracts/socket-protocol.md §1 for the full list of which wire
/// structs include this and why (`SingleFrameReq`/`AnimateReq`/`PrefetchRangeReq`/
/// `PrefetchRangeStreamReq`; `StitchReq` inherits it from `AnimateReq`'s base read).
/// `hw_decode_enabled = false` means the decode path must never call
/// `av_hwdevice_ctx_create` at all (FR-008), not just "prefer software".
#[derive(Debug, Clone, Copy)]
pub(crate) struct HwDecodeFlags {
    pub hw_decode_enabled: bool,
    pub device_strategy: DeviceStrategy,
}

async fn read_hw_decode_flags(stream: &mut tokio::net::UnixStream) -> anyhow::Result<HwDecodeFlags> {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 2];
    stream.read_exact(&mut buf).await?;
    Ok(HwDecodeFlags {
        hw_decode_enabled: buf[0] != 0,
        device_strategy: DeviceStrategy::from_u8(buf[1]),
    })
}

pub(crate) struct SingleFrameReq {
    pub request_id: u32,
    pub frame_idx: i64,
    pub width: u32,
    pub path: std::path::PathBuf,
    pub item_id: String,
    pub hw: HwDecodeFlags,
}

pub(crate) struct PrefetchRangeReq {
    pub item_id: String,
    pub path: std::path::PathBuf,
    pub start_idx: i64,
    pub before_seconds: f64,
    pub after_seconds: f64,
    pub include_start: bool,
    pub width: u32,
    pub hw: HwDecodeFlags,
}

pub(crate) async fn read_msg_type(
    stream: &mut tokio::net::UnixStream,
) -> anyhow::Result<u8> {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 1];
    stream.read_exact(&mut buf).await?;
    Ok(buf[0])
}

pub(crate) async fn read_single_frame_req(
    stream: &mut tokio::net::UnixStream,
) -> anyhow::Result<SingleFrameReq> {
    use tokio::io::AsyncReadExt;

    let mut id_buf = [0u8; 4];
    stream.read_exact(&mut id_buf).await?;
    let request_id = u32::from_le_bytes(id_buf);

    let mut fi_buf = [0u8; 8];
    stream.read_exact(&mut fi_buf).await?;
    let frame_idx = i64::from_le_bytes(fi_buf);

    let mut w_buf = [0u8; 4];
    stream.read_exact(&mut w_buf).await?;
    let width = u32::from_le_bytes(w_buf);

    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let path_len = u32::from_le_bytes(len_buf) as usize;
    if path_len > MAX_STR_FIELD_LEN {
        anyhow::bail!("read_single_frame_req: path_len {path_len} exceeds {MAX_STR_FIELD_LEN} — likely a wire desync");
    }

    let mut path_bytes = vec![0u8; path_len];
    stream.read_exact(&mut path_bytes).await?;
    let path = std::path::PathBuf::from(String::from_utf8(path_bytes)?);

    // item_id: fixed 32 ASCII bytes (Jellyfin UUID in N format)
    let mut id_buf = [0u8; 32];
    stream.read_exact(&mut id_buf).await?;
    let item_id = String::from_utf8(id_buf.to_vec()).unwrap_or_default();

    let hw = read_hw_decode_flags(stream).await?;

    Ok(SingleFrameReq { request_id, frame_idx, width, path, item_id, hw })
}

/// Wire: [request_id(4)] [jpeg_len(4)] [jpeg_data(N)] [quality_flags(2)] [actual_pts_ms(8)]
/// actual_pts_ms is normalized to stream start. -1 means "cache hit, use posMs as fallback".
pub(crate) async fn write_jpeg_response(
    stream: &mut tokio::net::UnixStream,
    request_id: u32,
    jpeg_data: &[u8],
    quality_flags: u16,
    actual_pts_ms: i64,
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut header = Vec::with_capacity(22 + jpeg_data.len());
    header.extend_from_slice(&request_id.to_le_bytes());
    header.extend_from_slice(&(jpeg_data.len() as u32).to_le_bytes());
    header.extend_from_slice(jpeg_data);
    header.extend_from_slice(&quality_flags.to_le_bytes());
    header.extend_from_slice(&actual_pts_ms.to_le_bytes());

    stream.write_all(&header).await?;
    Ok(())
}

pub(crate) async fn write_ack(
    stream: &mut tokio::net::UnixStream,
    request_id: u32,
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut buf = Vec::with_capacity(8);
    buf.extend_from_slice(&request_id.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // jpeg_len = 0

    stream.write_all(&buf).await?;
    Ok(())
}

// ── ANIMATE request (0x11) ─────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AnimFormat {
    Gif,
    WebP,
    Mp4,
}

impl AnimFormat {
    pub fn from_u16(v: u16) -> Self {
        match v {
            0x02 => Self::WebP,
            0x03 => Self::Mp4,
            _ => Self::Gif,
        }
    }
    // StitchReq reuses this enum but only ever sends WebP or Gif-as-"png" (never Mp4) — kept
    // as a binary helper for that one two-way call site; ANIMATE's three-way dispatch matches
    // on the enum directly instead.
    pub fn is_webp(self) -> bool { matches!(self, Self::WebP) }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResizeMode {
    Width,
    Height,
}

impl ResizeMode {
    pub fn from_u16(v: u16) -> Self {
        if v == 0x02 { Self::Height } else { Self::Width }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolutionPreset {
    Original,
    P1080,
    P720,
    P480,
    P360,
}

impl ResolutionPreset {
    pub fn from_str(s: &str) -> Self {
        match s {
            "1080p" => Self::P1080,
            "720p"  => Self::P720,
            "480p"  => Self::P480,
            "360p"  => Self::P360,
            _       => Self::Original,
        }
    }
    pub fn to_px(self) -> u32 {
        match self {
            Self::P1080 => 1080,
            Self::P720  => 720,
            Self::P480  => 480,
            Self::P360  => 360,
            Self::Original => 0,
        }
    }
}

pub(crate) struct AnimateReq {
    pub item_id: String,
    pub task_id: String,
    pub paths: Vec<(std::path::PathBuf, i64)>, // (path, frame_idx)
    pub format: AnimFormat,
    pub resize_mode: ResizeMode,
    pub target_px: u32,   // custom pixel value (0 means use resolution_preset)
    pub speed: f32,       // playback speed multiplier (1.0 = real-time)
    pub loop_count: u16,
    pub crop: Option<(f32, f32, f32, f32)>, // (x, y, w, h) normalized 0-1；None = 不裁切
    pub quality: f32,     // 0.0 = lossless, 0.01-1.0 = lossy quality
    pub resolution_preset: ResolutionPreset,
    pub hw: HwDecodeFlags,
}

pub(crate) async fn read_animate_req(
    stream: &mut tokio::net::UnixStream,
) -> anyhow::Result<AnimateReq> {
    use tokio::io::AsyncReadExt;

    // item_id: fixed 32 ASCII bytes (Jellyfin UUID in N format)
    let mut id_buf = [0u8; 32];
    stream.read_exact(&mut id_buf).await?;
    let item_id = String::from_utf8(id_buf.to_vec()).unwrap_or_default();

    // task_id_len + task_id
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let tid_len = u32::from_le_bytes(len_buf) as usize;
    if tid_len > MAX_STR_FIELD_LEN {
        anyhow::bail!("read_animate_req: tid_len {tid_len} exceeds {MAX_STR_FIELD_LEN} — likely a wire desync");
    }
    let mut tid_bytes = vec![0u8; tid_len];
    stream.read_exact(&mut tid_bytes).await?;
    let task_id = String::from_utf8(tid_bytes)?;

    // frame_count
    let mut fc_buf = [0u8; 4];
    stream.read_exact(&mut fc_buf).await?;
    let frame_count = u32::from_le_bytes(fc_buf) as usize;
    if frame_count > MAX_FRAME_COUNT {
        anyhow::bail!("read_animate_req: frame_count {frame_count} exceeds {MAX_FRAME_COUNT} — likely a wire desync");
    }

    let mut paths = Vec::with_capacity(frame_count);
    for _ in 0..frame_count {
        let mut fi_buf = [0u8; 8];
        stream.read_exact(&mut fi_buf).await?;
        let frame_idx = i64::from_le_bytes(fi_buf);

        let mut pl_buf = [0u8; 4];
        stream.read_exact(&mut pl_buf).await?;
        let path_len = u32::from_le_bytes(pl_buf) as usize;
        if path_len > MAX_STR_FIELD_LEN {
            anyhow::bail!("read_animate_req: path_len {path_len} exceeds {MAX_STR_FIELD_LEN} — likely a wire desync");
        }

        let mut pbytes = vec![0u8; path_len];
        stream.read_exact(&mut pbytes).await?;
        let path = std::path::PathBuf::from(String::from_utf8(pbytes)?);

        paths.push((path, frame_idx));
    }

    let mut fmt_buf = [0u8; 2];
    stream.read_exact(&mut fmt_buf).await?;
    let format = AnimFormat::from_u16(u16::from_le_bytes(fmt_buf));

    let mut rm_buf = [0u8; 2];
    stream.read_exact(&mut rm_buf).await?;
    let resize_mode = ResizeMode::from_u16(u16::from_le_bytes(rm_buf));

    let mut tp_buf = [0u8; 4];
    stream.read_exact(&mut tp_buf).await?;
    let target_px = u32::from_le_bytes(tp_buf);

    let mut spd_buf = [0u8; 4];
    stream.read_exact(&mut spd_buf).await?;
    let speed = f32::from_le_bytes(spd_buf);

    let mut lc_buf = [0u8; 2];
    stream.read_exact(&mut lc_buf).await?;
    let loop_count = u16::from_le_bytes(lc_buf);

    // crop: 4×f32 LE；crop_w == 0.0 表示禁用
    let mut cx_buf = [0u8; 4]; stream.read_exact(&mut cx_buf).await?; let crop_x = f32::from_le_bytes(cx_buf);
    let mut cy_buf = [0u8; 4]; stream.read_exact(&mut cy_buf).await?; let crop_y = f32::from_le_bytes(cy_buf);
    let mut cw_buf = [0u8; 4]; stream.read_exact(&mut cw_buf).await?; let crop_w = f32::from_le_bytes(cw_buf);
    let mut ch_buf = [0u8; 4]; stream.read_exact(&mut ch_buf).await?; let crop_h = f32::from_le_bytes(ch_buf);
    let crop = if crop_w > 0.0 { Some((crop_x, crop_y, crop_w, crop_h)) } else { None };

    let mut q_buf = [0u8; 4]; stream.read_exact(&mut q_buf).await?; let quality = f32::from_le_bytes(q_buf);

    let mut preset_len_buf = [0u8; 4];
    stream.read_exact(&mut preset_len_buf).await?;
    let preset_len = u32::from_le_bytes(preset_len_buf) as usize;
    if preset_len > MAX_STR_FIELD_LEN {
        anyhow::bail!("read_animate_req: preset_len {preset_len} exceeds {MAX_STR_FIELD_LEN} — likely a wire desync");
    }
    let mut preset_bytes = vec![0u8; preset_len];
    stream.read_exact(&mut preset_bytes).await?;
    let resolution_preset = ResolutionPreset::from_str(&String::from_utf8(preset_bytes).unwrap_or_default());

    let hw = read_hw_decode_flags(stream).await?;

    Ok(AnimateReq { item_id, task_id, paths, format, resize_mode, target_px, speed, loop_count, crop, quality, resolution_preset, hw })
}

// ── STITCH request (0x12) ─────────────────────────────────────────────────────
// Wire: same as AnimateReq, then six trailing fields (spec 012 US2/US3):
//   [device_id_len(4LE)][device_id(UTF-8)]       -- e.g. "cuda:0"; empty = default EP
//   [log_path_len(4LE)] [log_path(UTF-8)]        -- absolute path for GenerationLog JSON; empty = skip
//   [model_disabled(1)]                          -- 1 = skip DL matching entirely (AKAZE-only, FR-006)
//   [model_family_len(4)][model_family(UTF-8)]   -- "lightglue" | "efficient-loftr" | "" (auto)
//   [model_version_len(4)][model_version(UTF-8)] -- echoed verbatim into GenerationLog.model_version
//   [model_path_len(4)][model_path(UTF-8)]       -- explicit absolute model file path; empty = let
//                                                    dl_match auto-detect by family/canonical filename

pub(crate) struct StitchReq {
    pub item_id: String,
    pub task_id: String,
    pub paths: Vec<(std::path::PathBuf, i64)>,
    pub format: AnimFormat, // WebP or Gif-as-"png" only — stitch never produces Mp4
    pub quality: f32,
    pub device_id: String,
    pub log_path: String,
    pub model_disabled: bool,
    pub model_family: String,
    pub model_version: String,
    pub model_path: String,
    pub hw: HwDecodeFlags,
}

async fn read_len_prefixed_string(stream: &mut tokio::net::UnixStream) -> anyhow::Result<String> {
    use tokio::io::AsyncReadExt;
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 {
        return Ok(String::new());
    }
    if len > MAX_STR_FIELD_LEN {
        anyhow::bail!("read_len_prefixed_string: len {len} exceeds {MAX_STR_FIELD_LEN} — likely a wire desync");
    }
    let mut bytes = vec![0u8; len];
    stream.read_exact(&mut bytes).await?;
    Ok(String::from_utf8(bytes)?)
}

pub(crate) async fn read_stitch_req(
    stream: &mut tokio::net::UnixStream,
) -> anyhow::Result<StitchReq> {
    use tokio::io::AsyncReadExt;

    // Reuse the animate wire format for the base fields
    let base = read_animate_req(stream).await?;

    let device_id = read_len_prefixed_string(stream).await?;
    let log_path = read_len_prefixed_string(stream).await?;

    let mut disabled_buf = [0u8; 1];
    stream.read_exact(&mut disabled_buf).await?;
    let model_disabled = disabled_buf[0] != 0;

    let model_family = read_len_prefixed_string(stream).await?;
    let model_version = read_len_prefixed_string(stream).await?;
    let model_path = read_len_prefixed_string(stream).await?;

    Ok(StitchReq {
        item_id: base.item_id,
        task_id: base.task_id,
        paths: base.paths,
        format: base.format,
        quality: base.quality,
        device_id,
        log_path,
        model_disabled,
        model_family,
        model_version,
        model_path,
        hw: base.hw,
    })
}

// ── MSG_PREFETCH_RANGE (0x16) ───────────────────────────────────────
// Wire: [item_id(32)] [path_len(4)][path(N)] [start_idx(8)] [before_seconds(8)] [after_seconds(8)] [include_start(1)] [width(4)]

pub(crate) async fn read_prefetch_range_req(
    stream: &mut tokio::net::UnixStream,
) -> anyhow::Result<PrefetchRangeReq> {
    use tokio::io::AsyncReadExt;

    let mut id_buf = [0u8; 32];
    stream.read_exact(&mut id_buf).await?;
    let item_id = String::from_utf8(id_buf.to_vec()).unwrap_or_default();

    let mut pl_buf = [0u8; 4];
    stream.read_exact(&mut pl_buf).await?;
    let path_len = u32::from_le_bytes(pl_buf) as usize;
    if path_len > MAX_STR_FIELD_LEN {
        anyhow::bail!("read_prefetch_range_req: path_len {path_len} exceeds {MAX_STR_FIELD_LEN} — likely a wire desync");
    }
    let mut pbytes = vec![0u8; path_len];
    stream.read_exact(&mut pbytes).await?;
    let path = std::path::PathBuf::from(String::from_utf8(pbytes)?);

    let mut si_buf = [0u8; 8];
    stream.read_exact(&mut si_buf).await?;
    let start_idx = i64::from_le_bytes(si_buf);

    let mut bs_buf = [0u8; 8];
    stream.read_exact(&mut bs_buf).await?;
    let before_seconds = f64::from_le_bytes(bs_buf);

    let mut as_buf = [0u8; 8];
    stream.read_exact(&mut as_buf).await?;
    let after_seconds = f64::from_le_bytes(as_buf);

    let mut is_buf = [0u8; 1];
    stream.read_exact(&mut is_buf).await?;
    let include_start = is_buf[0] != 0;

    let mut w_buf = [0u8; 4];
    stream.read_exact(&mut w_buf).await?;
    let width = u32::from_le_bytes(w_buf);

    let hw = read_hw_decode_flags(stream).await?;

    Ok(PrefetchRangeReq { item_id, path, start_idx, before_seconds, after_seconds, include_start, width, hw })
}

/// Wire: [frame_count(4)][fps_num(8)][fps_den(8)] × frame_count: [pts_ms(8)][is_key(1)]
pub(crate) async fn write_frame_index(
    stream: &mut tokio::net::UnixStream,
    frames: &[(i64, bool)],
    fps_num: i64,
    fps_den: i64,
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let fc = frames.len() as u32;
    let mut buf = Vec::with_capacity(20 + fc as usize * 9);
    buf.extend_from_slice(&fc.to_le_bytes());
    buf.extend_from_slice(&fps_num.to_le_bytes());
    buf.extend_from_slice(&fps_den.to_le_bytes());
    for &(pts_ms, is_key) in frames {
        buf.extend_from_slice(&pts_ms.to_le_bytes());
        buf.push(if is_key { 1 } else { 0 });
    }
    stream.write_all(&buf).await?;
    stream.flush().await?;
    Ok(())
}

// ── MSG_LIST_CACHED (0x14 write) ────────────────────────────────────
/// Wire: [request_id(4)][count(4)] × [pos_ms(8)]

pub(crate) async fn write_list_cached(
    stream: &mut tokio::net::UnixStream,
    request_id: u32,
    positions: &[i64],
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut buf = Vec::with_capacity(8 + positions.len() * 8);
    buf.extend_from_slice(&request_id.to_le_bytes());
    buf.extend_from_slice(&(positions.len() as u32).to_le_bytes());
    for &pos in positions {
        buf.extend_from_slice(&pos.to_le_bytes());
    }
    stream.write_all(&buf).await?;
    stream.flush().await?;
    Ok(())
}

// ── MSG_PREFETCH_RANGE_STREAM (0x19) ────────────────────────────────
// Wire: [item_id(32)] [path_len(4)][path(N)] [current_time_ms(8)] [current_frame_idx(8)] [before_ms(8)] [after_ms(8)] [include_current(1)] [width(4)]
// current_frame_idx == -1 means not provided; fall back to current_time_ms for anchor lookup.

pub(crate) struct PrefetchRangeStreamReq {
    pub item_id: String,
    pub path: std::path::PathBuf,
    pub current_time_ms: i64,
    pub current_frame_idx: i64,
    pub before_ms: i64,
    pub after_ms: i64,
    pub include_current: bool,
    pub width: u32,
    pub session_id: String,
    pub hw: HwDecodeFlags,
}

pub(crate) async fn read_prefetch_range_stream_req(
    stream: &mut tokio::net::UnixStream,
) -> anyhow::Result<PrefetchRangeStreamReq> {
    use tokio::io::AsyncReadExt;

    let mut id_buf = [0u8; 32];
    stream.read_exact(&mut id_buf).await?;
    let item_id = String::from_utf8(id_buf.to_vec()).unwrap_or_default();

    let mut pl_buf = [0u8; 4];
    stream.read_exact(&mut pl_buf).await?;
    let path_len = u32::from_le_bytes(pl_buf) as usize;
    if path_len > MAX_STR_FIELD_LEN {
        anyhow::bail!("read_prefetch_range_stream_req: path_len {path_len} exceeds {MAX_STR_FIELD_LEN} — likely a wire desync");
    }
    let mut pbytes = vec![0u8; path_len];
    stream.read_exact(&mut pbytes).await?;
    let path = std::path::PathBuf::from(String::from_utf8(pbytes)?);

    let mut ct_buf = [0u8; 8];
    stream.read_exact(&mut ct_buf).await?;
    let current_time_ms = i64::from_le_bytes(ct_buf);

    let mut fi_buf = [0u8; 8];
    stream.read_exact(&mut fi_buf).await?;
    let current_frame_idx = i64::from_le_bytes(fi_buf);

    let mut bm_buf = [0u8; 8];
    stream.read_exact(&mut bm_buf).await?;
    let before_ms = i64::from_le_bytes(bm_buf);

    let mut am_buf = [0u8; 8];
    stream.read_exact(&mut am_buf).await?;
    let after_ms = i64::from_le_bytes(am_buf);

    let mut ic_buf = [0u8; 1];
    stream.read_exact(&mut ic_buf).await?;
    let include_current = ic_buf[0] != 0;

    let mut w_buf = [0u8; 4];
    stream.read_exact(&mut w_buf).await?;
    let width = u32::from_le_bytes(w_buf);

    let mut sl_buf = [0u8; 4];
    stream.read_exact(&mut sl_buf).await?;
    let session_id_len = u32::from_le_bytes(sl_buf) as usize;
    if session_id_len > MAX_STR_FIELD_LEN {
        anyhow::bail!("read_prefetch_range_stream_req: session_id_len {session_id_len} exceeds {MAX_STR_FIELD_LEN} — likely a wire desync");
    }
    let session_id = if session_id_len > 0 {
        let mut sb = vec![0u8; session_id_len];
        stream.read_exact(&mut sb).await?;
        String::from_utf8(sb).unwrap_or_default()
    } else {
        String::new()
    };

    let hw = read_hw_decode_flags(stream).await?;

    Ok(PrefetchRangeStreamReq { item_id, path, current_time_ms, current_frame_idx, before_ms, after_ms, include_current, width, session_id, hw })
}

// ── MSG_INDEX_FRAMES_STREAM (0x17) ──────────────────────────────────
// Wire: [request_id(4)] [item_id(32)] [path_len(4)][path(N)] [current_time_ms(8)]

pub(crate) struct IndexFramesStreamReq {
    pub request_id: u32,
    pub item_id: String,
    pub path: std::path::PathBuf,
    pub current_time_ms: i64,
}

pub(crate) async fn read_index_frames_stream_req(
    stream: &mut tokio::net::UnixStream,
) -> anyhow::Result<IndexFramesStreamReq> {
    use tokio::io::AsyncReadExt;

    let mut id_buf = [0u8; 4];
    stream.read_exact(&mut id_buf).await?;
    let request_id = u32::from_le_bytes(id_buf);

    let mut item_buf = [0u8; 32];
    stream.read_exact(&mut item_buf).await?;
    let item_id = String::from_utf8(item_buf.to_vec()).unwrap_or_default();

    let mut pl_buf = [0u8; 4];
    stream.read_exact(&mut pl_buf).await?;
    let path_len = u32::from_le_bytes(pl_buf) as usize;
    if path_len > MAX_STR_FIELD_LEN {
        anyhow::bail!("read_index_frames_stream_req: path_len {path_len} exceeds {MAX_STR_FIELD_LEN} — likely a wire desync");
    }
    let mut pbytes = vec![0u8; path_len];
    stream.read_exact(&mut pbytes).await?;
    let path = std::path::PathBuf::from(String::from_utf8(pbytes)?);

    let mut ct_buf = [0u8; 8];
    stream.read_exact(&mut ct_buf).await?;
    let current_time_ms = i64::from_le_bytes(ct_buf);

    Ok(IndexFramesStreamReq { request_id, item_id, path, current_time_ms })
}

// ── MSG_UPSCALE (0x1B) ───────────────────────────────────────────────
// Wire: [item_id(32)] [input_path_len(4)][input_path] [output_path_len(4)][output_path]
//       [model_path_len(4)][model_path] [device_id_len(4)][device_id] [is_animation(1)]
//       [face_restore_model_path_len(4)][face_restore_model_path] [log_path_len(4)][log_path]
//       [post_downscale_factor(4, f32 LE)]
// Note: tasks.md's spec text says "MSG_UPSCALE (0x1A)", but 0x1A is already MSG_DEBUG_DUMP
// (see server.rs) — this uses 0x1B instead to avoid colliding with that existing handler.
// Empty face_restore_model_path means face restoration is disabled for this job (FR-025).
// log_path: absolute path for UpscaleLog JSON (fallbacks + face-restore outcome); empty = skip.
// post_downscale_factor: applied to the model's native output size after upscaling (and after
// face restore, which runs at the higher native resolution for better face crops). 1.0 = no-op;
// e.g. 0.5 lets the caller request an effective x2 result from an x4 model when no native x2
// variant of that style exists in the catalog (anime-x2 — see UpscaleService.cs).

pub(crate) struct UpscaleReq {
    pub item_id: String,
    pub input_path: std::path::PathBuf,
    pub output_path: std::path::PathBuf,
    pub model_path: String,
    pub device_id: String,
    pub is_animation: bool,
    pub face_restore_model_path: String,
    pub log_path: String,
    pub post_downscale_factor: f32,
    /// C#-side UpscaleJobState.JobId — lets MSG_CANCEL_UPSCALE (sent on a separate connection,
    /// since this one is busy running the job) target this exact job without ambiguity, rather
    /// than reusing item_id (which doesn't uniquely identify a job if the same item is upscaled
    /// more than once).
    pub job_id: String,
}

pub(crate) async fn read_upscale_req(
    stream: &mut tokio::net::UnixStream,
) -> anyhow::Result<UpscaleReq> {
    use tokio::io::AsyncReadExt;

    let mut item_buf = [0u8; 32];
    stream.read_exact(&mut item_buf).await?;
    let item_id = String::from_utf8(item_buf.to_vec()).unwrap_or_default();

    let input_path = std::path::PathBuf::from(read_len_prefixed_string(stream).await?);
    let output_path = std::path::PathBuf::from(read_len_prefixed_string(stream).await?);
    let model_path = read_len_prefixed_string(stream).await?;
    let device_id = read_len_prefixed_string(stream).await?;

    let mut anim_buf = [0u8; 1];
    stream.read_exact(&mut anim_buf).await?;
    let is_animation = anim_buf[0] != 0;

    let face_restore_model_path = read_len_prefixed_string(stream).await?;
    let log_path = read_len_prefixed_string(stream).await?;

    let mut downscale_buf = [0u8; 4];
    stream.read_exact(&mut downscale_buf).await?;
    let post_downscale_factor = f32::from_le_bytes(downscale_buf);

    let job_id = read_len_prefixed_string(stream).await?;

    Ok(UpscaleReq {
        item_id,
        input_path,
        output_path,
        model_path,
        device_id,
        is_animation,
        face_restore_model_path,
        log_path,
        post_downscale_factor,
        job_id,
    })
}

/// MSG_CANCEL_UPSCALE (0x1C): fire-and-forget — sent on a fresh connection (the one running the
/// job is busy) to flag a running UPSCALE job's job_id for cooperative early-exit. No response
/// is sent; the client already knows it cancelled (UpscaleService.Cancel sets job state
/// independently) and only needs this to reclaim the daemon's CPU/GPU resources sooner.
pub(crate) struct CancelUpscaleReq {
    pub job_id: String,
}

pub(crate) async fn read_cancel_upscale_req(
    stream: &mut tokio::net::UnixStream,
) -> anyhow::Result<CancelUpscaleReq> {
    let job_id = read_len_prefixed_string(stream).await?;
    Ok(CancelUpscaleReq { job_id })
}

// ── MSG_HW_DECODE_CAPS (0x1D) ────────────────────────────────────────────────
// Request: no body (just the 1-byte msg_type already consumed by read_msg_type).
// Response wire (see contracts/socket-protocol.md §2):
//   [supported(1)] [vendor_count(1)]
//   × vendor_count: [vendor(1): 0=NVIDIA,1=AMD,2=Intel] [supported(1)] [reason_len(4)][reason(N)]
//
// Queried by C# once when the player-enhancer modal opens (FR-010); the daemon
// answers from a cache (`jfs_common::HwDecodeCapabilities`) populated once at
// startup (server.rs), never re-probing per-request.

fn hw_vendor_to_wire(vendor: jfs_common::DecodeVendor) -> u8 {
    match vendor {
        jfs_common::DecodeVendor::Nvidia => 0,
        jfs_common::DecodeVendor::Amd => 1,
        jfs_common::DecodeVendor::Intel => 2,
    }
}

pub(crate) async fn write_hw_decode_caps(
    stream: &mut tokio::net::UnixStream,
    caps: &jfs_common::HwDecodeCapabilities,
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut buf = Vec::with_capacity(2 + caps.vendors.len() * 8);
    buf.push(if caps.supported { 1 } else { 0 });
    buf.push(caps.vendors.len() as u8);
    for v in &caps.vendors {
        buf.push(hw_vendor_to_wire(v.vendor));
        buf.push(if v.supported { 1 } else { 0 });
        let reason_bytes = v.reason.as_bytes();
        buf.extend_from_slice(&(reason_bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(reason_bytes);
    }
    stream.write_all(&buf).await?;
    stream.flush().await?;
    Ok(())
}
