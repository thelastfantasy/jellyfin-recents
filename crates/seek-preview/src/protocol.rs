use anyhow::Result;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

pub struct Request {
    pub priority: u8,
    pub request_id: u32,
    pub pos_ms: i64,
    pub width: u32,
    pub path: PathBuf,
    pub item_id: String,
}

/// Read just the priority byte — caller branches on it, then reads the body.
pub async fn read_priority(stream: &mut UnixStream) -> Result<u8> {
    Ok(stream.read_u8().await?)
}

/// Read the request body after the priority byte has already been consumed.
pub async fn read_req_body(stream: &mut UnixStream, priority: u8) -> Result<Request> {
    let request_id = stream.read_u32_le().await?;
    let pos_ms = stream.read_i64_le().await?;
    let width = stream.read_u32_le().await?;
    let path_len = stream.read_u32_le().await? as usize;
    let mut path_bytes = vec![0u8; path_len];
    stream.read_exact(&mut path_bytes).await?;
    let path_str = String::from_utf8(path_bytes)?;
    let mut id_bytes = [0u8; 32];
    stream.read_exact(&mut id_bytes).await?;
    let item_id = String::from_utf8(id_bytes.to_vec())?;
    Ok(Request { priority, request_id, pos_ms, width, path: PathBuf::from(path_str), item_id })
}

pub async fn write_response(stream: &mut UnixStream, id: u32, data: &[u8]) -> Result<()> {
    stream.write_u32_le(id).await?;
    stream.write_u32_le(data.len() as u32).await?;
    if !data.is_empty() {
        stream.write_all(data).await?;
    }
    stream.flush().await?;
    Ok(())
}

pub async fn write_ack(stream: &mut UnixStream, id: u32) -> Result<()> {
    stream.write_u32_le(id).await?;
    stream.write_u32_le(0u32).await?;
    stream.flush().await?;
    Ok(())
}
