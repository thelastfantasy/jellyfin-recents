pub mod decoder;
pub mod disk_cache;
pub mod fps_utils;

pub use decoder::{decode_and_encode, index_frames};
pub use disk_cache::DiskCache;
pub use fps_utils::compute_frame_idx;

/// Initialize ffmpeg. Must be called once at process startup before any
/// decode operations.
pub fn init() {
    ffmpeg_next::init().expect("ffmpeg initialization failed");
}
