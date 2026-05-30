// Binary protocol frame read/write functions for frame-forge daemon.
// Follows the same pattern as seek-preview protocol.rs.

pub(crate) struct SingleFrameReq {
    pub request_id: u32,
    pub pos_ms: i64,
    pub width: u32,
    pub path: std::path::PathBuf,
    pub item_id: String, // 32-char hex Jellyfin UUID
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

pub(crate) async fn write_jpeg_response(
    stream: &mut tokio::net::UnixStream,
    request_id: u32,
    jpeg_data: &[u8],
    quality_flags: u16,
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut header = Vec::with_capacity(14 + jpeg_data.len());
    header.extend_from_slice(&request_id.to_le_bytes());
    header.extend_from_slice(&(jpeg_data.len() as u32).to_le_bytes());
    header.extend_from_slice(jpeg_data);
    header.extend_from_slice(&quality_flags.to_le_bytes());

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
    pub paths: Vec<(std::path::PathBuf, i64)>, // (path, pos_ms)
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
