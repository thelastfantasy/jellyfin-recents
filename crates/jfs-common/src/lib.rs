pub mod decoder;
pub mod disk_cache;
pub mod fps_utils;
pub mod hwaccel;

pub use decoder::{
    decode_all_frames_rgba, decode_and_encode, decode_and_encode_hw, decode_range,
    decode_range_hw, DecodeResult, HwDecodeRequest, HwFallbackSink, index_frames, demux_frames,
};
pub use disk_cache::DiskCache;
pub use fps_utils::compute_frame_idx;
pub use hwaccel::{
    detect_capabilities, first_render_node_for, query_load_percent, DecodeVendor,
    HwDecodeCapabilities, HwVendor, VendorCapability,
};

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
