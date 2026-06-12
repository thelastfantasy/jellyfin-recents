//! AKAZE feature-based stitching for landscape and low-texture scenes.
//!
//! Uses the OpenCV crate for industrial-grade AKAZE detection, Brute-Force
//! Hamming matching, and RANSAC homography estimation. Falls back to Phase
//! Correlation (stitch_anime) when feature matching produces too few inliers.
//!
//! # Caveats
//! - Requires libopencv-dev in the build environment (Docker only)
//! - AKAZE is Apache 2.0 licensed, no patent concerns
//! - Falls back to Phase Correlation when inliers < 4
//! - Simple alpha blending in overlap regions (not full multi-band)
//! - Wide panoramas (>5 frames) accumulate drift without bundle adjustment
//! - GPU acceleration via OpenCL is auto-detected at daemon startup

use image::{DynamicImage, RgbaImage};
use opencv::prelude::*;
use opencv::{calib3d, core, features2d, imgproc};

/// AKAZE feature-based stitching for landscape/low-texture scenes.
/// Falls back to Phase Correlation when feature matching fails.
pub fn stitch_landscape(frames: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    if frames.len() < 2 {
        anyhow::bail!("need at least 2 frames");
    }

    // Cylindrical projection for wide panoramas (T071: >5 frames)
    let use_cylindrical = frames.len() > 5;
    let focal_length = frames[0].width() as f64; // assume f = image width

    let mut images: Vec<DynamicImage> = frames.iter().map(|f| {
        if use_cylindrical {
            cylindrical_project(f, focal_length)
        } else {
            f.clone()
        }
    }).collect();

    let mut result = images[0].to_rgba8();

    for i in 1..images.len() {
        let prev = image_to_mat(&DynamicImage::ImageRgba8(result.clone()));
        let curr = image_to_mat(&images[i]);
        let pw = result.width() as i32;
        let ph = result.height() as i32;
        let cw = images[i].width() as i32;
        let ch = images[i].height() as i32;

        if let Ok(homo) = estimate_homography_akaze(&prev, &curr) {
            result = warp_expand_blend(&result, &curr, &homo, pw, ph, cw, ch);
        } else {
            // Fallback to Phase Correlation
            let prev_img = DynamicImage::ImageRgba8(result.clone());
            let (dx, dy, _) = crate::stitch_anime::phase_correlate(&prev_img, &images[i]);
            let dst_x = dx.max(0) as u32;
            let dst_y = dy.max(0) as u32;
            let mut new_canvas = RgbaImage::new(
                pw as u32 + dx.unsigned_abs(),
                ph as u32 + dy.unsigned_abs(),
            );
            image::imageops::overlay(&mut new_canvas, &result, 0, 0);
            let rgba = images[i].to_rgba8();
            image::imageops::overlay(&mut new_canvas, &rgba, dst_x as i64, dst_y as i64);
            result = new_canvas;
        }
    }

    Ok(DynamicImage::ImageRgba8(result))
}

pub fn image_to_mat(img: &DynamicImage) -> core::Mat {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let raw = rgba.into_raw();
    let mut mat = core::Mat::new_rows_cols_with_default(
        h as i32, w as i32, core::CV_8UC4, core::Scalar::default()
    ).unwrap();
    mat.data_bytes_mut().unwrap().copy_from_slice(&raw);
    mat
}

fn estimate_homography_akaze(img1: &core::Mat, img2: &core::Mat) -> anyhow::Result<core::Mat> {
    // Convert to grayscale
    let mut gray1 = core::Mat::default();
    let mut gray2 = core::Mat::default();
    imgproc::cvt_color(img1, &mut gray1, imgproc::COLOR_RGBA2GRAY, 0)?;
    imgproc::cvt_color(img2, &mut gray2, imgproc::COLOR_RGBA2GRAY, 0)?;

    // AKAZE detector + descriptor
    let mut akaze = features2d::AKAZE::create(
        features2d::AKAZE_DescriptorType::DESCRIPTOR_MLDB, 0, 3, 0.001f32, 4, 4,
        features2d::KAZE_DiffusivityType::DIFF_PM_G2,
    )?;

    let mut kp1 = core::Vector::<core::KeyPoint>::new();
    let mut kp2 = core::Vector::<core::KeyPoint>::new();
    let mut desc1 = core::Mat::default();
    let mut desc2 = core::Mat::default();
    akaze.detect_and_compute(&gray1, &core::no_array(), &mut kp1, &mut desc1, false)?;
    akaze.detect_and_compute(&gray2, &core::no_array(), &mut kp2, &mut desc2, false)?;

    if kp1.len() < 4 || kp2.len() < 4 {
        anyhow::bail!("not enough keypoints ({}/{})", kp1.len(), kp2.len());
    }

    // ROI mask: filter keypoints in low-texture regions (T069)
    // Compute gradient magnitude and exclude keypoints below threshold
    let grad1 = gradient_magnitude(&gray1)?;
    let grad2 = gradient_magnitude(&gray2)?;
    let mut kp1 = filter_keypoints_by_gradient(&kp1, &grad1, 20.0);
    let mut kp2 = filter_keypoints_by_gradient(&kp2, &grad2, 20.0);

    if kp1.len() < 4 || kp2.len() < 4 {
        anyhow::bail!("not enough keypoints after ROI filtering ({}/{})", kp1.len(), kp2.len());
    }

    // Re-compute descriptors on filtered keypoints
    let mut desc1 = core::Mat::default();
    let mut desc2 = core::Mat::default();
    akaze.compute(&gray1, &mut kp1, &mut desc1)?;
    akaze.compute(&gray2, &mut kp2, &mut desc2)?;

    // BFMatcher — add train descriptors then match
    let mut matcher = features2d::BFMatcher::create(core::NORM_HAMMING, false)?;
    let mut matches = core::Vector::<core::DMatch>::new();
    let mut train_mats = core::Vector::<core::Mat>::new();
    train_mats.push(desc2.try_clone()?);
    matcher.add(&train_mats)?;
    matcher.match_(&desc1, &mut matches, &core::no_array())?;

    // Sort by distance and keep top 30%
    let mut match_vec: Vec<core::DMatch> = matches.iter().collect();
    match_vec.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap());
    let n = (match_vec.len() as f64 * 0.3).max(4.0) as usize;
    match_vec.truncate(n);

    if match_vec.len() < 4 {
        anyhow::bail!("not enough good matches");
    }

    // Extract matched point coordinates
    let mut pts1 = core::Mat::new_rows_cols_with_default(match_vec.len() as i32, 1, core::CV_32FC2, core::Scalar::default())?;
    let mut pts2 = core::Mat::new_rows_cols_with_default(match_vec.len() as i32, 1, core::CV_32FC2, core::Scalar::default())?;

    for (i, m) in match_vec.iter().enumerate() {
        let p1 = kp1.get(m.query_idx as usize)?.pt();
        let p2 = kp2.get(m.train_idx as usize)?.pt();
        *pts1.at_2d_mut::<core::Vec2f>(i as i32, 0)? = core::Vec2f::from([p1.x, p1.y]);
        *pts2.at_2d_mut::<core::Vec2f>(i as i32, 0)? = core::Vec2f::from([p2.x, p2.y]);
    }

    // RANSAC homography
    let mut mask = core::Mat::default();
    let h = calib3d::find_homography(&pts1, &pts2, &mut mask, calib3d::RANSAC, 3.0)?;

    Ok(h)
}

pub fn warp_image(img: &core::Mat, h: &core::Mat, width: i32, height: i32) -> RgbaImage {
    let mut warped = core::Mat::default();
    if let Err(e) = imgproc::warp_perspective(
        img, &mut warped, h,
        core::Size::new(width, height),
        imgproc::INTER_LINEAR, core::BORDER_CONSTANT, core::Scalar::default(),
    ) {
        eprintln!("[frame-forge] warp failed: {:?}", e);
        return RgbaImage::new(width as u32, height as u32);
    }

    let mut rgba = RgbaImage::new(width as u32, height as u32);
    for y in 0..height.min(warped.rows()) {
        for x in 0..width.min(warped.cols()) {
            let px = warped.at_2d::<core::Vec4b>(y, x).unwrap();
            rgba.put_pixel(x as u32, y as u32, image::Rgba([px[0], px[1], px[2], px[3]]));
        }
    }
    rgba
}

/// Warp frame B into an expanded canvas that covers both frames, then blend.
///
/// `homo` maps frame A (base) coordinates → frame B (curr) coordinates.
/// Projects B's corners through H⁻¹ to find where they land in A's space,
/// computes the bounding box, and creates a canvas that fits both.
pub fn warp_expand_blend(
    base: &RgbaImage,
    curr: &core::Mat,
    homo: &core::Mat,
    bw: i32, bh: i32,
    cw: i32, ch: i32,
) -> RgbaImage {
    let mut h_inv = core::Mat::default();
    if core::invert(homo, &mut h_inv, core::DECOMP_SVD).is_err() {
        return blend_pair(base, &warp_image(curr, homo, bw, bh));
    }

    let proj = |m: &core::Mat, px: f64, py: f64| -> (f64, f64) {
        let h00 = m.at_2d::<f64>(0, 0).copied().unwrap_or(1.0);
        let h01 = m.at_2d::<f64>(0, 1).copied().unwrap_or(0.0);
        let h02 = m.at_2d::<f64>(0, 2).copied().unwrap_or(0.0);
        let h10 = m.at_2d::<f64>(1, 0).copied().unwrap_or(0.0);
        let h11 = m.at_2d::<f64>(1, 1).copied().unwrap_or(1.0);
        let h12 = m.at_2d::<f64>(1, 2).copied().unwrap_or(0.0);
        let h20 = m.at_2d::<f64>(2, 0).copied().unwrap_or(0.0);
        let h21 = m.at_2d::<f64>(2, 1).copied().unwrap_or(0.0);
        let h22 = m.at_2d::<f64>(2, 2).copied().unwrap_or(1.0);
        let denom = (h20 * px + h21 * py + h22).max(1e-8);
        ((h00 * px + h01 * py + h02) / denom,
         (h10 * px + h11 * py + h12) / denom)
    };

    // Project B's four corners through H⁻¹ into A's coordinate space.
    // Clamp to ±4× frame dimensions so degenerate homographies don't overflow i32.
    let max_coord = (bw.max(cw) * 4) as f64;
    let b_pts: Vec<(f64, f64)> = [
        (0.0, 0.0), (cw as f64 - 1.0, 0.0),
        (0.0, ch as f64 - 1.0), (cw as f64 - 1.0, ch as f64 - 1.0),
    ].iter().map(|(x, y)| {
        let (px, py) = proj(&h_inv, *x, *y);
        (px.clamp(-max_coord, max_coord), py.clamp(-max_coord, max_coord))
    }).collect();

    let all_x: Vec<f64> = b_pts.iter().map(|(x,_)| *x)
        .chain([0.0, bw as f64 - 1.0]).collect();
    let all_y: Vec<f64> = b_pts.iter().map(|(_,y)| *y)
        .chain([0.0, bh as f64 - 1.0]).collect();

    let min_x = all_x.iter().cloned().fold(f64::INFINITY, f64::min).floor() as i32;
    let min_y = all_y.iter().cloned().fold(f64::INFINITY, f64::min).floor() as i32;
    let max_x = all_x.iter().cloned().fold(f64::NEG_INFINITY, f64::max).ceil() as i32;
    let max_y = all_y.iter().cloned().fold(f64::NEG_INFINITY, f64::max).ceil() as i32;

    // Reject degenerate homographies: if any projected corner lands more than
    // 2× the frame dimensions away, the homography is unusable — fall back to clip.
    let reject_dist = (bw.max(cw) * 2) as f64;
    if b_pts.iter().any(|(x, y)| x.abs() > reject_dist || y.abs() > reject_dist) {
        return blend_pair(base, &warp_image(curr, homo, bw, bh));
    }

    let off_x = (-min_x).max(0);
    let off_y = (-min_y).max(0);
    let canvas_w = ((max_x - min_x + 1).max(1) as u32).min(bw as u32 * 3);
    let canvas_h = ((max_y - min_y + 1).max(1) as u32).min(bh as u32 * 3);

    // Place frame A on the extended canvas at the computed offset
    let mut canvas_base = RgbaImage::new(canvas_w, canvas_h);
    image::imageops::overlay(&mut canvas_base, base, off_x as i64, off_y as i64);

    // Build H_new = H * T⁻¹  where T shifts canvas coords by (off_x, off_y)
    // For canvas pixel (cx,cy): H_new maps to frame B = H * (cx-off_x, cy-off_y)
    // H_new[:,2] = H[:,0]*(-ox) + H[:,1]*(-oy) + H[:,2]
    let get = |r: i32, c: i32| homo.at_2d::<f64>(r, c).copied()
        .unwrap_or(if r == c { 1.0 } else { 0.0 });
    let ox = off_x as f64;
    let oy = off_y as f64;
    let h_vals = [
        [get(0,0), get(0,1), get(0,0)*(-ox) + get(0,1)*(-oy) + get(0,2)],
        [get(1,0), get(1,1), get(1,0)*(-ox) + get(1,1)*(-oy) + get(1,2)],
        [get(2,0), get(2,1), get(2,0)*(-ox) + get(2,1)*(-oy) + get(2,2)],
    ];
    if let Ok(mut h_new) = core::Mat::new_rows_cols_with_default(
        3, 3, core::CV_64F, core::Scalar::default(),
    ) {
        for r in 0..3i32 {
            for c in 0..3i32 {
                if let Ok(v) = h_new.at_2d_mut::<f64>(r, c) {
                    *v = h_vals[r as usize][c as usize];
                }
            }
        }
        let warped = warp_image(curr, &h_new, canvas_w as i32, canvas_h as i32);
        blend_pair(&canvas_base, &warped)
    } else {
        blend_pair(base, &warp_image(curr, homo, bw, bh))
    }
}

pub fn blend_pair(base: &RgbaImage, overlay: &RgbaImage) -> RgbaImage {
    // Laplacian pyramid multi-band blending (T075-T076)
    pyramid_blend(base, overlay)
}

// ── Cylindrical projection (T071) ──────────────────────────────────────────

/// Project image to cylindrical coordinates to reduce edge distortion in wide panoramas.
/// f = focal length in pixels (typically image width).
fn cylindrical_project(img: &DynamicImage, f: f64) -> DynamicImage {
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width() as f64, rgba.height() as f64);
    let mut result = image::RgbaImage::new(w as u32, h as u32);

    let cx = w / 2.0;
    let cy = h / 2.0;

    for y in 0..(h as u32) {
        for x in 0..(w as u32) {
            // Map cylindrical (x,y) back to planar coordinates
            let theta = (x as f64 - cx) / f;
            let h_scale = theta.cos().max(0.01);
            let src_x = (cx + f * theta.tan()).clamp(0.0, w - 1.0) as u32;
            let src_y = (cy + (y as f64 - cy) / h_scale).clamp(0.0, h - 1.0) as u32;
            result.put_pixel(x, y, *rgba.get_pixel(src_x, src_y));
        }
    }
    DynamicImage::ImageRgba8(result)
}

// ── Gradient & ROI filter (T069) ───────────────────────────────────────────

/// Compute gradient magnitude for each pixel (Sobel).
fn gradient_magnitude(gray: &core::Mat) -> anyhow::Result<core::Mat> {
    let mut gx = core::Mat::default();
    let mut gy = core::Mat::default();
    let mut mag = core::Mat::default();
    imgproc::sobel(gray, &mut gx, core::CV_32F, 1, 0, 3, 1.0, 0.0, core::BORDER_DEFAULT)?;
    imgproc::sobel(gray, &mut gy, core::CV_32F, 0, 1, 3, 1.0, 0.0, core::BORDER_DEFAULT)?;
    core::magnitude(&gx, &gy, &mut mag)?;
    Ok(mag)
}

/// Remove keypoints whose gradient magnitude is below threshold.
fn filter_keypoints_by_gradient(
    kp: &core::Vector::<core::KeyPoint>,
    grad: &core::Mat,
    threshold: f64,
) -> core::Vector::<core::KeyPoint> {
    let mut filtered = core::Vector::<core::KeyPoint>::new();
    for i in 0..kp.len() {
        let pt = kp.get(i).unwrap().pt();
        let gx = pt.x.round() as i32;
        let gy = pt.y.round() as i32;
        if gx >= 0 && gx < grad.cols() && gy >= 0 && gy < grad.rows() {
            let val = *grad.at_2d::<f32>(gy, gx).unwrap_or(&0.0);
            if val as f64 >= threshold {
                filtered.push(kp.get(i).unwrap());
            }
        }
    }
    filtered
}

/// Alpha-aware blending with feathered seam in the overlap region.
///
/// Uses each image's alpha channel as the content mask — warp_perspective fills
/// out-of-bounds pixels with alpha=0, so this correctly identifies content vs
/// empty canvas without relying on canvas dimensions which would halve brightness.
fn pyramid_blend(base: &RgbaImage, overlay: &RgbaImage) -> RgbaImage {
    let w = base.width().max(overlay.width());
    let h = base.height().max(overlay.height());

    let base_mask   = alpha_mask(base,    w, h);
    let overlay_mask = alpha_mask(overlay, w, h);

    blend_two(base, overlay, &base_mask, &overlay_mask)
}

/// Build a GrayMask from the image's alpha channel, padded to canvas size.
/// Pixels with alpha=0 (out-of-bounds from warp_perspective) get weight 0.
fn alpha_mask(img: &RgbaImage, canvas_w: u32, canvas_h: u32) -> GrayMask {
    let mut mask = GrayMask::new(canvas_w, canvas_h);
    for y in 0..img.height().min(canvas_h) {
        for x in 0..img.width().min(canvas_w) {
            mask.put_pixel(x, y, image::Luma([img.get_pixel(x, y)[3]]));
        }
    }
    mask
}


fn build_gaussian_pyramid(img: &RgbaImage, levels: usize, canvas_w: u32, canvas_h: u32) -> Vec<RgbaImage> {
    let mut pyr = Vec::new();
    let mut current = RgbaImage::new(canvas_w, canvas_h);
    for y in 0..img.height().min(canvas_h) {
        for x in 0..img.width().min(canvas_w) {
            current.put_pixel(x, y, *img.get_pixel(x, y));
        }
    }
    pyr.push(current);
    for _ in 1..levels {
        let prev = pyr.last().unwrap();
        let (pw, ph) = (prev.width() / 2, prev.height() / 2);
        let (pw, ph) = (pw.max(1), ph.max(1));
        let mut down = RgbaImage::new(pw, ph);
        for y in 0..ph {
            for x in 0..pw {
                let mut r = 0u32; let mut g = 0u32; let mut b = 0u32; let mut a = 0u32; let mut n = 0u32;
                for dy in 0..2u32 {
                    for dx in 0..2u32 {
                        let sx = x * 2 + dx;
                        let sy = y * 2 + dy;
                        if sx < prev.width() && sy < prev.height() {
                            let p = prev.get_pixel(sx, sy);
                            r += p[0] as u32; g += p[1] as u32; b += p[2] as u32; a += p[3] as u32; n += 1;
                        }
                    }
                }
                if n > 0 {
                    down.put_pixel(x, y, image::Rgba([(r/n) as u8, (g/n) as u8, (b/n) as u8, (a/n) as u8]));
                }
            }
        }
        pyr.push(down);
    }
    pyr
}

fn upsample(img: &RgbaImage, target_w: u32, target_h: u32) -> RgbaImage {
    let mut up = RgbaImage::new(target_w, target_h);
    for y in 0..target_h {
        for x in 0..target_w {
            let sx = (x as f64 * img.width() as f64 / target_w as f64) as u32;
            let sy = (y as f64 * img.height() as f64 / target_h as f64) as u32;
            let sx = sx.min(img.width() - 1);
            let sy = sy.min(img.height() - 1);
            up.put_pixel(x, y, *img.get_pixel(sx, sy));
        }
    }
    up
}

fn subtract(a: &RgbaImage, b: &RgbaImage) -> RgbaImage {
    let mut result = RgbaImage::new(a.width(), a.height());
    for y in 0..a.height().min(b.height()) {
        for x in 0..a.width().min(b.width()) {
            let ap = a.get_pixel(x, y);
            let bp = b.get_pixel(x, y);
            result.put_pixel(x, y, image::Rgba([
                ap[0].saturating_sub(bp[0]),
                ap[1].saturating_sub(bp[1]),
                ap[2].saturating_sub(bp[2]),
                255,
            ]));
        }
    }
    result
}

fn add(a: &RgbaImage, b: &RgbaImage) -> RgbaImage {
    let mut result = RgbaImage::new(a.width(), a.height());
    for y in 0..a.height().min(b.height()) {
        for x in 0..a.width().min(b.width()) {
            let ap = a.get_pixel(x, y);
            let bp = b.get_pixel(x, y);
            result.put_pixel(x, y, image::Rgba([
                ap[0].saturating_add(bp[0]),
                ap[1].saturating_add(bp[1]),
                ap[2].saturating_add(bp[2]),
                255,
            ]));
        }
    }
    result
}

fn blend_two(a: &RgbaImage, b: &RgbaImage, ma: &GrayMask, mb: &GrayMask) -> RgbaImage {
    let w = a.width().max(b.width());
    let h = a.height().max(b.height());
    let mut result = RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let wa = if x < ma.width() && y < ma.height() { ma.get_pixel(x, y)[0] as f64 / 255.0 } else { 0.0 };
            let wb = if x < mb.width() && y < mb.height() { mb.get_pixel(x, y)[0] as f64 / 255.0 } else { 0.0 };
            let total = (wa + wb).max(0.001);

            let ap = a.get_pixel_checked(x, y);
            let bp = b.get_pixel_checked(x, y);
            let (ar, ag, ab) = ap.map_or((0, 0, 0), |p| (p[0], p[1], p[2]));
            let (br, bg, bb) = bp.map_or((0, 0, 0), |p| (p[0], p[1], p[2]));
            result.put_pixel(x, y, image::Rgba([
                ((ar as f64 * wa + br as f64 * wb) / total) as u8,
                ((ag as f64 * wa + bg as f64 * wb) / total) as u8,
                ((ab as f64 * wa + bb as f64 * wb) / total) as u8,
                255,
            ]));
        }
    }
    result
}

type GrayMask = image::GrayImage;

fn distance_mask(img_w: u32, img_h: u32, canvas_w: u32, canvas_h: u32) -> GrayMask {
    let mut mask = GrayMask::new(canvas_w, canvas_h);
    for y in 0..canvas_h {
        for x in 0..canvas_w {
            let dx = if x < img_w { (x as f64 / img_w.max(1) as f64 * 2.0 - 1.0).abs() } else { 1.0 };
            let dy = if y < img_h { (y as f64 / img_h.max(1) as f64 * 2.0 - 1.0).abs() } else { 1.0 };
            let w = ((1.0 - dx).max(0.0) * (1.0 - dy).max(0.0) * 255.0) as u8;
            mask.put_pixel(x, y, image::Luma([w]));
        }
    }
    mask
}

fn resize_mask(mask: &GrayMask, target_w: u32, target_h: u32) -> GrayMask {
    let mut resized = GrayMask::new(target_w, target_h);
    for y in 0..target_h {
        for x in 0..target_w {
            let sx = (x as f64 * mask.width() as f64 / target_w as f64) as u32;
            let sy = (y as f64 * mask.height() as f64 / target_h as f64) as u32;
            let sx = sx.min(mask.width() - 1);
            let sy = sy.min(mask.height() - 1);
            resized.put_pixel(x, y, *mask.get_pixel(sx, sy));
        }
    }
    resized
}

#[cfg(test)]
mod quality_tests {
    use super::*;
    use crate::test_metrics::*;
    use std::path::PathBuf;

    fn seagull_fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/stitch-eval/fixtures/seagull")
    }

    #[test]
    fn landscape_ssim_on_seagull_fixtures() {
        let dir = seagull_fixtures();
        if !dir.exists() {
            eprintln!("Skipping: SEAGULL fixtures not found at {:?}", dir);
            return;
        }
        let t = load_thresholds();
        let a = image::open(dir.join("input_a.png")).expect("input_a.png");
        let b = image::open(dir.join("input_b.png")).expect("input_b.png");
        let reference = image::open(dir.join("reference.png")).expect("reference.png");
        let stitched = stitch_landscape(&[a, b]).expect("stitch_landscape failed");
        let score = ssim(&stitched, &reference);
        assert!(score >= t.ssim_min, "SSIM {:.3} < threshold {:.3}", score, t.ssim_min);
    }

    #[test]
    #[ignore = "requires FRAME_FORGE_TEST_GPU=1 and Arc GPU passthrough"]
    fn gpu_cpu_consistency() {
        if std::env::var_os("FRAME_FORGE_TEST_GPU").is_none() { return; }
        let dir = seagull_fixtures();
        if !dir.exists() { eprintln!("Skipping: SEAGULL fixtures not found"); return; }
        let a = image::open(dir.join("input_a.png")).expect("input_a.png");
        let b = image::open(dir.join("input_b.png")).expect("input_b.png");

        #[cfg(feature = "opencl")]
        opencv::core::ocl::set_use_open_cl(false).ok();
        let cpu = stitch_landscape(&[a.clone(), b.clone()]).expect("CPU stitch failed");

        #[cfg(feature = "opencl")]
        opencv::core::ocl::set_use_open_cl(true).ok();
        let gpu = stitch_landscape(&[a, b]).expect("GPU stitch failed");

        let score = ssim(&cpu, &gpu);
        assert!(score >= 0.95, "CPU/GPU consistency SSIM {:.3} < 0.95", score);
    }
}
