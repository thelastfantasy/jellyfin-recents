// Binary protocol frame read/write functions for frame-forge daemon.
// Follows the same pattern as seek-preview protocol.rs.

pub(crate) struct SingleFrameReq {
    pub request_id: u32,
    pub pos_ms: i64,
    pub width: u32,
    pub path: std::path::PathBuf,
    pub item_id: String, // 32-char hex Jellyfin UUID
}

pub(crate) struct PrefetchRangeReq {
    pub item_id: String,
    pub path: std::path::PathBuf,
    pub start_idx: i64,
    pub before_seconds: f64,
    pub after_seconds: f64,
    pub include_start: bool,
    pub width: u32,
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

    let mut pos_buf = [0u8; 8];
    stream.read_exact(&mut pos_buf).await?;
    let pos_ms = i64::from_le_bytes(pos_buf);

    let mut w_buf = [0u8; 4];
    stream.read_exact(&mut w_buf).await?;
    let width = u32::from_le_bytes(w_buf);

    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let path_len = u32::from_le_bytes(len_buf) as usize;

    let mut path_bytes = vec![0u8; path_len];
    stream.read_exact(&mut path_bytes).await?;
    let path = std::path::PathBuf::from(String::from_utf8(path_bytes)?);

    // item_id: fixed 32 ASCII bytes (Jellyfin UUID in N format)
    let mut id_buf = [0u8; 32];
    stream.read_exact(&mut id_buf).await?;
    let item_id = String::from_utf8(id_buf.to_vec()).unwrap_or_default();

    Ok(SingleFrameReq { request_id, pos_ms, width, path, item_id })
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

// 鈹€鈹€ ANIMATE request (0x11) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

pub(crate) struct AnimateReq {
    pub task_id: String,
    pub paths: Vec<(std::path::PathBuf, i64)>, // (path, frame_idx)
    pub format: u16,      // 0x01=GIF, 0x02=WebP
    pub resize_mode: u16, // 0x01=width, 0x02=height
    pub target_px: u32,   // custom pixel value
    pub speed: f32,       // playback speed multiplier (1.0 = real-time)
    pub loop_count: u16,
    pub crop: Option<(f32, f32, f32, f32)>, // (x, y, w, h) normalized 0-1；None = 不裁切
    pub quality: f32,     // 0.0 = lossless, 0.01-1.0 = lossy quality
}

pub(crate) async fn read_animate_req(
    stream: &mut tokio::net::UnixStream,
) -> anyhow::Result<AnimateReq> {
    use tokio::io::AsyncReadExt;

    // task_id_len + task_id
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let tid_len = u32::from_le_bytes(len_buf) as usize;
    let mut tid_bytes = vec![0u8; tid_len];
    stream.read_exact(&mut tid_bytes).await?;
    let task_id = String::from_utf8(tid_bytes)?;

    // frame_count
    let mut fc_buf = [0u8; 4];
    stream.read_exact(&mut fc_buf).await?;
    let frame_count = u32::from_le_bytes(fc_buf) as usize;

    let mut paths = Vec::with_capacity(frame_count);
    for _ in 0..frame_count {
        let mut pos_buf = [0u8; 8];
        stream.read_exact(&mut pos_buf).await?;
        let pos_ms = i64::from_le_bytes(pos_buf);

        let mut pl_buf = [0u8; 4];
        stream.read_exact(&mut pl_buf).await?;
        let path_len = u32::from_le_bytes(pl_buf) as usize;

        let mut pbytes = vec![0u8; path_len];
        stream.read_exact(&mut pbytes).await?;
        let path = std::path::PathBuf::from(String::from_utf8(pbytes)?);

        paths.push((path, pos_ms));
    }

    let mut fmt_buf = [0u8; 2];
    stream.read_exact(&mut fmt_buf).await?;
    let format = u16::from_le_bytes(fmt_buf);

    let mut rm_buf = [0u8; 2];
    stream.read_exact(&mut rm_buf).await?;
    let resize_mode = u16::from_le_bytes(rm_buf);

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

    Ok(AnimateReq { task_id, paths, format, resize_mode, target_px, speed, loop_count, crop, quality })
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

    Ok(PrefetchRangeReq { item_id, path, start_idx, before_seconds, after_seconds, include_start, width })
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
