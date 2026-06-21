/// Convert a frame's actual PTS (in ms) to a frame index, given the stream frame rate.
/// Returns -1 if parameters are invalid.
pub fn compute_frame_idx(actual_pts_ms: i64, fps_num: i64, fps_den: i64) -> i64 {
    if fps_num <= 0 || fps_den <= 0 {
        return -1;
    }
    (actual_pts_ms * fps_num + fps_den * 500) / (fps_den * 1000)
}
