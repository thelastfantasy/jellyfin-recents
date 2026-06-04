pub mod decoder;
pub mod disk_cache;
pub mod fps_utils;

pub use decoder::{decode_and_encode, DecodeResult, index_frames, demux_frames};
pub use disk_cache::DiskCache;
pub use fps_utils::compute_frame_idx;

use serde::Serialize;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FrameIndexResponse {
    pub frames: Vec<FrameIndexEntry>,
    pub fps: FpsFrac,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FrameIndexEntry {
    pub frame_index: i64,
    pub ms: i64,
    pub is_key: bool,
}

#[derive(Serialize, Debug)]
pub struct FpsFrac {
    pub num: i64,
    pub den: i64,
}

/// Initialize ffmpeg. Must be called once at process startup before any
/// decode operations.
pub fn init() {
    ffmpeg_next::init().expect("ffmpeg initialization failed");
}
