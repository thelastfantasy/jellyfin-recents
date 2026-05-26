// Binary protocol frame read/write functions for frame-forge daemon.
// Follows the same pattern as seek-preview protocol.rs.

pub(crate) struct SingleFrameReq {
    pub request_id: u32,
    pub pos_ms: i64,
    pub width: u32,
    pub path: std::path::PathBuf,
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

    Ok(SingleFrameReq { request_id, pos_ms, width, path })
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

// ── ANIMATE request (0x11) ─────────────────────────────────────────────────

pub(crate) struct AnimateReq {
    pub task_id: String,
    pub paths: Vec<(std::path::PathBuf, i64)>, // (path, pos_ms)
    pub format: u16,     // 0x01=GIF, 0x02=WebP
    pub resize_mode: u16, // 0x01=width, 0x02=height
    pub target_px: u32,  // custom pixel value
    pub fps: u16,
    pub loop_count: u16,
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

    let mut fps_buf = [0u8; 2];
    stream.read_exact(&mut fps_buf).await?;
    let fps = u16::from_le_bytes(fps_buf);

    let mut lc_buf = [0u8; 2];
    stream.read_exact(&mut lc_buf).await?;
    let loop_count = u16::from_le_bytes(lc_buf);

    Ok(AnimateReq { task_id, paths, format, resize_mode, target_px, fps, loop_count })
}
