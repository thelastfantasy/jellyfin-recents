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
