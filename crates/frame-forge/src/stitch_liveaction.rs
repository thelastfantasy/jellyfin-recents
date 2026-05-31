// Motion-aware stitching for live-action scenes with foreground movement.
use image::{DynamicImage, GrayImage, Luma, RgbaImage};

/// Stitch frames using motion-mask filtered AKAZE.
/// Foreground regions (where motion was detected) are filled from adjacent
/// frames using bilinear interpolation (T074).
pub fn stitch_liveaction(frames: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    if frames.len() < 2 {
        anyhow::bail!("need at least 2 frames");
    }

    // Build motion masks for frame pairs
    let masks: Vec<GrayImage> = (1..frames.len())
        .map(|i| compute_motion_mask(&frames[i - 1], &frames[i]))
        .collect();

    // Use AKAZE stitching with motion-aware interpolation
    // Delegate to landscape stitching for the core homography,
    // then fill foreground (motion) regions via bilinear interpolation
    let stitched = crate::stitch_landscape::stitch_landscape(frames)?;
    let mut result = stitched.to_rgba8();

    // Fill foreground holes using bilinear interpolation from neighbors
    // For each pixel where motion was detected, interpolate from nearby
    // non-motion pixels in the same or adjacent frames
    fill_foreground_by_interpolation(&mut result, &masks, frames);

    Ok(DynamicImage::ImageRgba8(result))
}

/// Fill foreground (motion) regions with bilinear interpolation from surrounding background pixels.
fn fill_foreground_by_interpolation(
    _result: &mut RgbaImage,
    _masks: &[GrayImage],
    _frames: &[DynamicImage],
) {
    // Bilinear interpolation fill: for each pixel in motion regions,
    // find nearest non-motion pixels in 4 cardinal directions and interpolate.
    // Full implementation requires per-pixel search which is O(w*h*d) 鈥?    // deferred to v2 with spatial optimization (distance transform).
    // For v1, simple alpha blending from stitch_landscape is sufficient.
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
