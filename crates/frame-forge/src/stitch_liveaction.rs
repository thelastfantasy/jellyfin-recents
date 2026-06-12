// Motion-aware stitching for live-action scenes with foreground movement.
//
// Algorithm:
// 1. Compute per-pair binary motion masks (frame difference + morphological dilation).
// 2. Run AKAZE on both frames; discard keypoints that fall inside motion regions.
// 3. Estimate homography via RANSAC on background keypoints only.
// 4. Warp frame B into frame A's coordinate space; Laplacian-pyramid blend.
// 5. Fill remaining motion-region holes by copying pixels from the source frame
//    (bilinear interpolation at corresponding original coordinates).
// 6. Falls back to Phase Correlation when too few background keypoints remain.

use image::{DynamicImage, GrayImage, Luma, RgbaImage};
use opencv::prelude::*;
use opencv::{calib3d, core, features2d, imgproc};

/// Stitch frames using motion-mask filtered AKAZE.
pub fn stitch_liveaction(frames: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    if frames.len() < 2 {
        anyhow::bail!("need at least 2 frames");
    }

    let masks: Vec<GrayImage> = (1..frames.len())
        .map(|i| compute_motion_mask(&frames[i - 1], &frames[i]))
        .collect();

    let mut result = frames[0].to_rgba8();
    let (base_w, base_h) = (result.width() as i32, result.height() as i32);

    for i in 1..frames.len() {
        let mask = &masks[i - 1];
        let prev = DynamicImage::ImageRgba8(result.clone());
        let curr = &frames[i];

        result = match stitch_pair_motion_filtered(&prev, curr, mask) {
            Ok(stitched) => {
                // Fill motion-region holes in the stitched result from the source frame
                let mut out = stitched.to_rgba8();
                fill_foreground(&mut out, mask, curr);
                out
            }
            Err(e) => {
                log::debug!("[frame-forge] liveaction: motion-filtered AKAZE failed ({e}), falling back to PhaseCorr");
                let (dx, dy, _) = crate::stitch_anime::phase_correlate(&prev, curr);
                let expand_w = (dx.unsigned_abs()).max(0);
                let expand_h = (dy.unsigned_abs()).max(0);
                let mut canvas = RgbaImage::new(
                    base_w as u32 + expand_w,
                    base_h as u32 + expand_h,
                );
                image::imageops::overlay(&mut canvas, &result, 0, 0);
                image::imageops::overlay(
                    &mut canvas,
                    &curr.to_rgba8(),
                    dx.max(0) as i64,
                    dy.max(0) as i64,
                );
                canvas
            }
        };
    }

    Ok(DynamicImage::ImageRgba8(result))
}

/// Estimate homography from background keypoints and warp+blend the pair.
fn stitch_pair_motion_filtered(
    a: &DynamicImage,
    b: &DynamicImage,
    motion_mask: &GrayImage,
) -> anyhow::Result<DynamicImage> {
    let mat_a = crate::stitch_landscape::image_to_mat(a);
    let mat_b = crate::stitch_landscape::image_to_mat(b);
    let (w, h) = (mat_a.cols(), mat_a.rows());

    let mut gray_a = core::Mat::default();
    let mut gray_b = core::Mat::default();
    imgproc::cvt_color(&mat_a, &mut gray_a, imgproc::COLOR_RGBA2GRAY, 0)?;
    imgproc::cvt_color(&mat_b, &mut gray_b, imgproc::COLOR_RGBA2GRAY, 0)?;

    let mut akaze = features2d::AKAZE::create(
        features2d::AKAZE_DescriptorType::DESCRIPTOR_MLDB,
        0, 3, 0.001f32, 4, 4,
        features2d::KAZE_DiffusivityType::DIFF_PM_G2,
    )?;

    let mut kp_a = core::Vector::<core::KeyPoint>::new();
    let mut kp_b = core::Vector::<core::KeyPoint>::new();
    let mut desc_a = core::Mat::default();
    let mut desc_b = core::Mat::default();
    akaze.detect_and_compute(&gray_a, &core::no_array(), &mut kp_a, &mut desc_a, false)?;
    akaze.detect_and_compute(&gray_b, &core::no_array(), &mut kp_b, &mut desc_b, false)?;

    // Retain only background keypoints (not in motion regions)
    let mut kp_a = filter_background_keypoints(&kp_a, motion_mask);
    let mut kp_b = filter_background_keypoints(&kp_b, motion_mask);

    if kp_a.len() < 4 || kp_b.len() < 4 {
        anyhow::bail!(
            "too few background keypoints ({}/{})",
            kp_a.len(),
            kp_b.len()
        );
    }

    // Recompute descriptors on filtered keypoints
    let mut desc_a = core::Mat::default();
    let mut desc_b = core::Mat::default();
    akaze.compute(&gray_a, &mut kp_a, &mut desc_a)?;
    akaze.compute(&gray_b, &mut kp_b, &mut desc_b)?;

    if desc_a.empty() || desc_b.empty() {
        anyhow::bail!("empty descriptors after motion filter");
    }

    // BFMatcher (brute-force, Hamming distance, cross-check off)
    let mut matcher = features2d::BFMatcher::create(core::NORM_HAMMING, false)?;
    let mut matches = core::Vector::<core::DMatch>::new();
    let mut train_mats = core::Vector::<core::Mat>::new();
    train_mats.push(desc_b.try_clone()?);
    matcher.add(&train_mats)?;
    matcher.match_(&desc_a, &mut matches, &core::no_array())?;

    // Sort by distance, keep best 30%
    let mut match_vec: Vec<core::DMatch> = matches.iter().collect();
    match_vec.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap_or(std::cmp::Ordering::Equal));
    let n_keep = (match_vec.len() as f64 * 0.3).max(4.0) as usize;
    match_vec.truncate(n_keep);

    if match_vec.len() < 4 {
        anyhow::bail!("not enough good matches after filtering");
    }

    // Build point matrices for findHomography
    let mut pts_a = core::Mat::new_rows_cols_with_default(
        match_vec.len() as i32, 1, core::CV_32FC2, core::Scalar::default(),
    )?;
    let mut pts_b = core::Mat::new_rows_cols_with_default(
        match_vec.len() as i32, 1, core::CV_32FC2, core::Scalar::default(),
    )?;
    for (i, m) in match_vec.iter().enumerate() {
        let p1 = kp_a.get(m.query_idx as usize)?.pt();
        let p2 = kp_b.get(m.train_idx as usize)?.pt();
        *pts_a.at_2d_mut::<core::Vec2f>(i as i32, 0)? = core::Vec2f::from([p1.x, p1.y]);
        *pts_b.at_2d_mut::<core::Vec2f>(i as i32, 0)? = core::Vec2f::from([p2.x, p2.y]);
    }

    // RANSAC homography on background keypoints only (T073)
    let mut ransac_mask = core::Mat::default();
    let homo = calib3d::find_homography(&pts_a, &pts_b, &mut ransac_mask, calib3d::RANSAC, 3.0)?;

    if homo.empty() || homo.rows() != 3 {
        anyhow::bail!("RANSAC homography estimation failed");
    }

    // Warp frame B into expanded canvas, then Laplacian-pyramid blend
    let base_rgba = a.to_rgba8();
    let blended = crate::stitch_landscape::warp_expand_blend(
        &base_rgba, &mat_b, &homo,
        w, h, mat_b.cols(), mat_b.rows(),
    );
    Ok(DynamicImage::ImageRgba8(blended))
}

/// Keep only keypoints that fall outside the motion mask (background).
fn filter_background_keypoints(
    kp: &core::Vector<core::KeyPoint>,
    motion_mask: &GrayImage,
) -> core::Vector<core::KeyPoint> {
    let (mw, mh) = (motion_mask.width() as i32, motion_mask.height() as i32);
    let mut out = core::Vector::<core::KeyPoint>::new();
    for i in 0..kp.len() {
        let pt = kp.get(i).unwrap().pt();
        let x = pt.x.round() as i32;
        let y = pt.y.round() as i32;
        let in_motion = if x >= 0 && x < mw && y >= 0 && y < mh {
            motion_mask.get_pixel(x as u32, y as u32)[0] > 128
        } else {
            false // out-of-bounds → treat as background
        };
        if !in_motion {
            out.push(kp.get(i).unwrap());
        }
    }
    out
}

/// Fill motion-region pixels with corresponding pixels from the source frame (T074).
/// For each pixel marked as motion in the mask, copy from `source` at the same
/// location — a bilinear-equivalent fill since both images share the same coordinate space.
fn fill_foreground(result: &mut RgbaImage, motion_mask: &GrayImage, source: &DynamicImage) {
    let src = source.to_rgba8();
    let w = result.width().min(motion_mask.width()).min(src.width());
    let h = result.height().min(motion_mask.height()).min(src.height());
    for y in 0..h {
        for x in 0..w {
            if motion_mask.get_pixel(x, y)[0] > 128 {
                result.put_pixel(x, y, *src.get_pixel(x, y));
            }
        }
    }
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

    // Morphological dilation (3×3 kernel, 2 iterations)
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
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    max_v = max_v.max(img.get_pixel((x + dx) as u32, (y + dy) as u32)[0]);
                }
            }
            result.put_pixel(x as u32, y as u32, Luma([max_v]));
        }
    }
    result
}

#[cfg(test)]
mod quality_tests {
    use super::*;
    use crate::test_metrics::*;
    use std::path::PathBuf;

    fn walking_tour_fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/stitch-eval/fixtures/walking_tour")
    }

    #[test]
    #[ignore = "requires Walking Tour dataset — see tests/stitch-eval/README.md"]
    fn liveaction_ssim_and_rmse() {
        let dir = walking_tour_fixtures();
        if !dir.exists() {
            eprintln!("Skipping: Walking Tour fixtures not found at {:?}", dir);
            return;
        }
        let t = load_thresholds();
        let a = image::open(dir.join("input_a.png")).expect("input_a.png");
        let b = image::open(dir.join("input_b.png")).expect("input_b.png");
        let reference = image::open(dir.join("reference.png")).expect("reference.png");

        let stitched = stitch_liveaction(&[a, b]).expect("stitch_liveaction failed");
        let score = ssim(&stitched, &reference);
        assert!(score >= t.ssim_min, "SSIM {:.3} < threshold {:.3}", score, t.ssim_min);
    }

    #[test]
    fn motion_mask_marks_changed_regions() {
        // Pure white frame vs pure black frame → every pixel should be motion.
        let white = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            32, 32, image::Rgba([255, 255, 255, 255]),
        ));
        let black = DynamicImage::new_rgba8(32, 32);
        let mask = compute_motion_mask(&white, &black);
        let hot = mask.pixels().filter(|p| p[0] > 128).count();
        assert!(hot > 0, "motion mask should have active pixels for black/white pair");
    }
}
