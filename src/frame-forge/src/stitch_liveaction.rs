//! Motion-aware stitching for live-action scenes with foreground movement.
//!
//! Computes a frame-difference motion mask to exclude foreground (moving
//! actors/objects) keypoints from homography estimation. The homography is
//! then estimated from static background features only, preventing the
//! panorama from warping toward moving subjects.
//!
//! Currently delegates stitching to stitch_landscape (AKAZE). The full
//! motion-mask-filtered AKAZE pipeline is planned for a future iteration.
//!
//! # Caveats
//! - Motion mask threshold (diff > 30) is hardcoded; adjustable per scene
//! - Morphological dilation uses fixed 3×3 kernel, 2 iterations
//! - Does not handle parallax (different depth planes moving at different rates)
//! - Fast camera pans may cause entire frame to be masked as motion

use image::{DynamicImage, GrayImage, Luma, RgbaImage};

/// Frame-diff motion mask + AKAZE stitching for live-action scenes.
/// Filters out keypoints in foreground motion regions before homography estimation.
pub fn stitch_liveaction(frames: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    if frames.len() < 2 {
        anyhow::bail!("need at least 2 frames");
    }

    // For now, delegate to landscape AKAZE stitching.
    // Full frame-diff mask implementation will be added in Phase 10 iterations.
    // The key difference from landscape: compute motion mask via frame differencing
    // + morphology dilation, then filter AKAZE keypoints that fall in motion regions.
    crate::stitch_landscape::stitch_landscape(frames)
}

/// Generate a binary motion mask from frame difference.
/// White pixels (255) indicate motion regions where keypoints should be excluded.
pub fn compute_motion_mask(prev: &DynamicImage, curr: &DynamicImage) -> GrayImage {
    let gp = prev.to_luma8();
    let gc = curr.to_luma8();
    let (w, h) = gp.dimensions();
    let mut mask = GrayImage::new(w, h);

    for y in 0..h.min(gc.height()) {
        for x in 0..w.min(gc.width()) {
            let dp = gp.get_pixel(x, y)[0] as i16;
            let dc = gc.get_pixel(x, y)[0] as i16;
            let diff = (dp - dc).unsigned_abs();
            mask.put_pixel(x, y, Luma([if diff > 30 { 255 } else { 0 }]));
        }
    }

    // Morphological dilation (3x3 kernel, 2 iterations)
    for _ in 0..2 {
        mask = dilate(&mask);
    }
    mask
}

fn dilate(img: &GrayImage) -> GrayImage {
    let (w, h) = img.dimensions();
    let mut result = GrayImage::new(w, h);
    for y in 1..(h as i32 - 1) {
        for x in 1..(w as i32 - 1) {
            let mut max_v = 0u8;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    max_v = max_v.max(img.get_pixel((x + dx) as u32, (y + dy) as u32)[0]);
                }
            }
            result.put_pixel(x as u32, y as u32, Luma([max_v]));
        }
    }
    result
}
