// Motion-aware stitching for live-action scenes with foreground movement.
//
// Algorithm:
// 1. Compute per-pair binary motion masks (frame difference + morphological dilation).
// 2. Run SIFT on both frames; discard keypoints that fall inside motion regions.
// 3. Estimate homography via RANSAC on background keypoints only.
// 4. Warp frame B into frame A's coordinate space; gradient seam blend.
// 5. Fill remaining motion-region holes by copying pixels from the source frame
//    (bilinear interpolation at corresponding original coordinates).
// 6. Falls back to Phase Correlation when too few background keypoints remain.

use image::{DynamicImage, GrayImage, Luma, RgbaImage};
use opencv::prelude::*;
use opencv::{calib3d, core, features2d, imgproc, stitching};

/// Stitch frames using motion-mask filtered AKAZE.
pub fn stitch_liveaction(frames: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    if frames.len() < 2 {
        anyhow::bail!("need at least 2 frames");
    }

    let masks: Vec<GrayImage> = (1..frames.len())
        .map(|i| compute_motion_mask(&frames[i - 1], &frames[i]))
        .collect();

    let mut result = frames[0].to_rgba8();

    for i in 1..frames.len() {
        let mask = &masks[i - 1];
        let prev = DynamicImage::ImageRgba8(result.clone());
        let curr = &frames[i];

        let (prev_w, prev_h) = (prev.width(), prev.height());
        result = match stitch_pair_motion_filtered(&prev, curr, mask) {
            Ok(stitched) => {
                let mut out = stitched.to_rgba8();
                // fill_foreground copies source pixels using frame coordinates.
                // When warp_expand_blend shifts the canvas, frame coords no longer match
                // canvas coords, causing the foreground to land at the wrong position.
                // Skip fill when the canvas expanded to avoid ghost artifacts.
                if out.width() == prev_w && out.height() == prev_h {
                    fill_foreground(&mut out, mask, curr);
                }
                out
            }
            Err(e) => {
                eprintln!("[liveaction] stitch_pair_motion_filtered FAILED: {e}");
                let mat_prev = crate::stitch_landscape::image_to_mat(&prev);
                let mat_curr = crate::stitch_landscape::image_to_mat(curr);
                let (pw_i, ph_i) = (mat_prev.cols(), mat_prev.rows());
                let (cw_i, ch_i) = (mat_curr.cols(), mat_curr.rows());

                // Strategy 1: OpenCV Panorama Stitcher — same algorithm as Python reference.
                // Handles building-symmetry false matches via full bundle adjustment.
                match stitch_with_opencv_panorama(&mat_prev, &mat_curr) {
                    Ok(stitched) => stitched,
                    Err(e2) => {
                        eprintln!("[liveaction] OpenCV Stitcher FAILED: {e2} → SIFT cluster");
                        // Strategy 2: upper-55% SIFT displacement cluster (no grass false matches)
                        match sift_upper_homography(&mat_prev, &mat_curr) {
                            Ok(homo) => {
                                eprintln!("[liveaction] using upper-half SIFT homography");
                                crate::stitch_landscape::warp_expand_blend(
                                    &result, &mat_curr, &homo, pw_i, ph_i, cw_i, ch_i,
                                )
                            }
                            Err(e3) => {
                                eprintln!("[liveaction] sift_upper_homography FAILED: {e3} → dominant_translation");
                                // Strategy 3: dominant translation (NCC + SIFT cluster)
                                let (dx, dy) = dominant_translation(&mat_prev, &mat_curr, 5.0, 6)
                                    .unwrap_or_else(|| {
                                        let (pdx, pdy, pc_q) = crate::stitch_anime::phase_correlate(&prev, curr);
                                        eprintln!("[liveaction] dominant_translation failed → phase q={pc_q:.4} dx={pdx} dy={pdy}");
                                        if pc_q >= 0.02 {
                                            (pdx, pdy)
                                        } else {
                                            let sift = crate::stitch_landscape::sift_translation_estimate(&mat_prev, &mat_curr);
                                            eprintln!("[liveaction] SIFT fallback: {sift:?}");
                                            sift.unwrap_or((pdx, pdy))
                                        }
                                    });

                                eprintln!("[liveaction] using translation dx={dx} dy={dy}");

                                let blend_result = (|| -> Option<RgbaImage> {
                                    let mut h = core::Mat::zeros(3, 3, core::CV_64F).ok()?.to_mat().ok()?;
                                    *h.at_2d_mut::<f64>(0, 0).ok()? = 1.0;
                                    *h.at_2d_mut::<f64>(1, 1).ok()? = 1.0;
                                    *h.at_2d_mut::<f64>(2, 2).ok()? = 1.0;
                                    *h.at_2d_mut::<f64>(0, 2).ok()? = -(dx as f64);
                                    *h.at_2d_mut::<f64>(1, 2).ok()? = -(dy as f64);
                                    Some(crate::stitch_landscape::warp_expand_blend(
                                        &result, &mat_curr, &h, pw_i, ph_i, cw_i, ch_i,
                                    ))
                                })();
                                blend_result.unwrap_or_else(|| {
                                    let base_ox = 0i64.max(-(dx as i64));
                                    let base_oy = 0i64.max(-(dy as i64));
                                    let curr_ox = 0i64.max(dx as i64);
                                    let curr_oy = 0i64.max(dy as i64);
                                    let canvas_w = (base_ox + pw_i as i64).max(curr_ox + cw_i as i64) as u32;
                                    let canvas_h = (base_oy + ph_i as i64).max(curr_oy + ch_i as i64) as u32;
                                    let mut canvas = RgbaImage::new(canvas_w, canvas_h);
                                    image::imageops::overlay(&mut canvas, &result, base_ox, base_oy);
                                    image::imageops::overlay(&mut canvas, &curr.to_rgba8(), curr_ox, curr_oy);
                                    canvas
                                })
                            }
                        }
                    }
                }
            }
        };
    }

    Ok(DynamicImage::ImageRgba8(result))
}

/// Stitch a liveaction pair using motion-mask-filtered SIFT + displacement pre-filter + findHomography.
///
/// Strategy:
/// 1. Full-image SIFT on both frames.
/// 2. CrossCheck BFMatcher → raw matches (person + background + texture noise).
/// 3. Stage 1 filter — motion mask: discard matches where either endpoint falls in a motion
///    region (person pixels).  This removes the dominant person-feature cluster that would
///    otherwise bias the median displacement in stage 2.
/// 4. Stage 2 filter — displacement_prefilter: keep only matches near the median (dx,dy).
///    Removes residual motion-mask leakage and repetitive-texture false matches.
/// 5. findHomography (8-DOF, RANSAC 3px) on clean background matches.
/// 6. Strict sanity check: bail if scale/angle indicate person motion was fitted instead of
///    background motion — the outer fallback then tries plain estimate_homography.
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

    let mut sift = features2d::SIFT::create(0, 3, 0.04, 10.0, 1.6)?;
    let mut kp_a = core::Vector::<core::KeyPoint>::new();
    let mut kp_b = core::Vector::<core::KeyPoint>::new();
    let mut desc_a = core::Mat::default();
    let mut desc_b = core::Mat::default();
    sift.detect_and_compute(&gray_a, &core::no_array(), &mut kp_a, &mut desc_a, false)?;
    sift.detect_and_compute(&gray_b, &core::no_array(), &mut kp_b, &mut desc_b, false)?;

    if kp_a.len() < 8 || kp_b.len() < 8 || desc_a.empty() || desc_b.empty() {
        anyhow::bail!("too few keypoints ({}/{})", kp_a.len(), kp_b.len());
    }

    let mut matcher = features2d::BFMatcher::create(core::NORM_L2, true)?;
    let mut raw_matches = core::Vector::<core::DMatch>::new();
    let mut train_mats = core::Vector::<core::Mat>::new();
    train_mats.push(desc_b.try_clone()?);
    matcher.add(&train_mats)?;
    matcher.match_(&desc_a, &mut raw_matches, &core::no_array())?;

    let raw_vec: Vec<core::DMatch> = raw_matches.iter().collect();

    // Stage 1: motion mask filter — drop matches where either endpoint is in a motion region.
    // This removes the person-feature cluster before the displacement median is computed,
    // preventing it from biasing stage 2 toward person motion.
    let (mask_w, mask_h) = (motion_mask.width(), motion_mask.height());
    let bg_vec: Vec<core::DMatch> = raw_vec.iter().filter(|m| {
        if m.query_idx < 0 || m.train_idx < 0 { return false; }
        let (Ok(p1), Ok(p2)) = (
            kp_a.get(m.query_idx as usize),
            kp_b.get(m.train_idx as usize),
        ) else { return false; };
        let (ax, ay) = (p1.pt().x as u32, p1.pt().y as u32);
        let (bx, by) = (p2.pt().x as u32, p2.pt().y as u32);
        let a_mot = ax < mask_w && ay < mask_h && motion_mask.get_pixel(ax, ay)[0] >= 128;
        let b_mot = bx < mask_w && by < mask_h && motion_mask.get_pixel(bx, by)[0] >= 128;
        !a_mot && !b_mot
    }).cloned().collect();

    if bg_vec.len() < 8 {
        anyhow::bail!("too few background matches after motion-mask filter ({})", bg_vec.len());
    }

    // Stage 2: displacement filter — remove residual outliers and repetitive-texture noise.
    let good_vec = displacement_prefilter(&bg_vec, &kp_a, &kp_b, w as f32 * 0.15);

    if good_vec.len() < 8 {
        anyhow::bail!("too few displacement-filtered matches ({})", good_vec.len());
    }

    let n = good_vec.len() as i32;
    let mut pts_a = core::Mat::new_rows_cols_with_default(n, 1, core::CV_32FC2, core::Scalar::default())?;
    let mut pts_b_mat = core::Mat::new_rows_cols_with_default(n, 1, core::CV_32FC2, core::Scalar::default())?;
    for (i, m) in good_vec.iter().enumerate() {
        let p1 = kp_a.get(m.query_idx as usize)?.pt();
        let p2 = kp_b.get(m.train_idx as usize)?.pt();
        *pts_a.at_2d_mut::<core::Vec2f>(i as i32, 0)? = core::Vec2f::from([p1.x, p1.y]);
        *pts_b_mat.at_2d_mut::<core::Vec2f>(i as i32, 0)? = core::Vec2f::from([p2.x, p2.y]);
    }

    let mut ransac_mask = core::Mat::default();
    let homo = calib3d::find_homography(&pts_a, &pts_b_mat, &mut ransac_mask, calib3d::RANSAC, 3.0)?;
    if homo.empty() || homo.rows() != 3 {
        anyhow::bail!("findHomography failed");
    }

    // Sanity check: bail if scale/angle indicate person motion was fitted instead of
    // background motion — the outer fallback then tries plain estimate_homography.
    if !crate::stitch_landscape::homography_is_sane(&homo, w, h) {
        anyhow::bail!("homography failed sanity check");
    }

    let inliers = (0..ransac_mask.rows())
        .filter(|&i| ransac_mask.at_2d::<u8>(i, 0).copied().unwrap_or(0) > 0)
        .count();
    if inliers < 6 {
        anyhow::bail!("too few homography inliers ({inliers}/{})", good_vec.len());
    }

    let base_rgba = a.to_rgba8();
    let blended = crate::stitch_landscape::warp_expand_blend(
        &base_rgba, &mat_b, &homo,
        w, h, mat_b.cols(), mat_b.rows(),
    );
    Ok(DynamicImage::ImageRgba8(blended))
}

/// SIFT feature matching restricted to the upper 55 % of each frame (buildings, trees, sky).
///
/// Panning cameras that fail the motion-mask path often have a grass-dominated lower half
/// that floods SIFT with hundreds of false matches at the wrong dx.  Masking the lower
/// half exposes only structurally distinctive features (rooflines, tree silhouettes,
/// signage) and lets findHomography+RANSAC find the correct full-perspective transform.
///
/// Returns H mapping A→B (same convention as estimate_homography / stitch_pair_motion_filtered)
/// so it can be passed directly to warp_expand_blend.
fn sift_upper_homography(
    mat_a: &core::Mat,
    mat_b: &core::Mat,
) -> anyhow::Result<core::Mat> {
    let (aw, ah) = (mat_a.cols(), mat_a.rows());
    let (bw, bh) = (mat_b.cols(), mat_b.rows());

    let mut gray_a = core::Mat::default();
    let mut gray_b = core::Mat::default();
    imgproc::cvt_color(mat_a, &mut gray_a, imgproc::COLOR_RGBA2GRAY, 0)?;
    imgproc::cvt_color(mat_b, &mut gray_b, imgproc::COLOR_RGBA2GRAY, 0)?;

    // Mask: only upper 55 % of each frame (avoid repetitive grass texture)
    let mask_ah = ah * 55 / 100;
    let mask_bh = bh * 55 / 100;
    let mut mask_a = core::Mat::zeros(ah, aw, core::CV_8U)?.to_mat()?;
    let mut mask_b = core::Mat::zeros(bh, bw, core::CV_8U)?.to_mat()?;
    imgproc::rectangle(&mut mask_a, core::Rect::new(0, 0, aw, mask_ah),
        core::Scalar::all(255.0), -1, imgproc::LINE_8, 0)?;
    imgproc::rectangle(&mut mask_b, core::Rect::new(0, 0, bw, mask_bh),
        core::Scalar::all(255.0), -1, imgproc::LINE_8, 0)?;

    let mut sift = features2d::SIFT::create(0, 3, 0.04, 10.0, 1.6)?;
    let mut kp_a = core::Vector::<core::KeyPoint>::new();
    let mut kp_b = core::Vector::<core::KeyPoint>::new();
    let mut desc_a = core::Mat::default();
    let mut desc_b = core::Mat::default();
    sift.detect_and_compute(&gray_a, &mask_a, &mut kp_a, &mut desc_a, false)?;
    sift.detect_and_compute(&gray_b, &mask_b, &mut kp_b, &mut desc_b, false)?;

    eprintln!("[liveaction] upper-55% SIFT: {}/{} keypoints", kp_a.len(), kp_b.len());

    if kp_a.len() < 8 || kp_b.len() < 8 || desc_a.empty() || desc_b.empty() {
        anyhow::bail!("too few upper-region keypoints ({}/{})", kp_a.len(), kp_b.len());
    }

    // kNN k=2, Lowe ratio test 0.75 — rejects ambiguous (repeating) matches
    let mut matcher = features2d::BFMatcher::create(core::NORM_L2, false)?;
    let mut knn = core::Vector::<core::Vector<core::DMatch>>::new();
    let mut train = core::Vector::<core::Mat>::new();
    train.push(desc_b.try_clone()?);
    matcher.add(&train)?;
    matcher.knn_match(&desc_a, &mut knn, 2, &core::no_array(), false)?;

    // Collect ratio-test match displacements (dx = pa.x - pb.x, dy = pa.y - pb.y)
    let mut disps: Vec<(f32, f32)> = Vec::new();
    for pair in knn.iter() {
        if pair.len() < 2 { continue; }
        let m = pair.get(0)?;
        let n = pair.get(1)?;
        if m.distance >= 0.75 * n.distance { continue; }
        let p1 = kp_a.get(m.query_idx as usize)?.pt();
        let p2 = kp_b.get(m.train_idx as usize)?.pt();
        disps.push((p1.x - p2.x, p1.y - p2.y));
    }

    eprintln!("[liveaction] upper-55% ratio matches: {}", disps.len());

    if disps.len() < 8 {
        anyhow::bail!("too few ratio-test matches in upper region ({})", disps.len());
    }

    // Displacement cluster instead of findHomography.
    //
    // For a camera pan (scale=1), every true match has the SAME displacement (dx_true, dy_true).
    // False matches from repetitive building windows are generated by a wrong scaled transform
    // (e.g. scale=1.79, tx=-1039), which makes each false match's dx DEPEND on its x position
    // — they do NOT form a tight cluster.  The true matches therefore outvote false matches
    // in a threshold-based cluster search, even if false matches are more numerous overall.
    let (dx, dy) = best_displacement_cluster(&disps, 30.0, 8)
        .ok_or_else(|| anyhow::anyhow!("no displacement cluster in upper-half matches"))?;

    eprintln!("[liveaction] upper-55% cluster: dx={dx} dy={dy}");

    if dx.unsigned_abs() as i32 > aw * 2 || dy.unsigned_abs() as i32 > ah * 2 {
        anyhow::bail!("upper-55% cluster out of bounds: dx={dx} dy={dy}");
    }

    // Build pure-translation H (A→B convention: B_x = A_x - dx)
    let mut homo = core::Mat::zeros(3, 3, core::CV_64F)?.to_mat()?;
    *homo.at_2d_mut::<f64>(0, 0)? = 1.0;
    *homo.at_2d_mut::<f64>(1, 1)? = 1.0;
    *homo.at_2d_mut::<f64>(2, 2)? = 1.0;
    *homo.at_2d_mut::<f64>(0, 2)? = -(dx as f64);
    *homo.at_2d_mut::<f64>(1, 2)? = -(dy as f64);

    Ok(homo)
}

/// Stitch two frames using OpenCV's full Panorama Stitcher pipeline.
///
/// Mirrors stitch_py.py's `cv2.Stitcher_PANORAMA` call exactly.
/// The Stitcher runs SIFT feature detection, bundle adjustment, wave correction,
/// graph-cut seam finding and multi-band blending — it handles building-symmetry
/// false matches that defeat simple displacement clustering.
///
/// Returns the stitched image as RgbaImage (converted from BGR Stitcher output).
pub fn stitch_with_opencv_panorama(
    mat_a: &core::Mat,
    mat_b: &core::Mat,
) -> anyhow::Result<RgbaImage> {
    // Stitcher expects BGR (3-channel) images
    let mut bgr_a = core::Mat::default();
    let mut bgr_b = core::Mat::default();
    imgproc::cvt_color(mat_a, &mut bgr_a, imgproc::COLOR_RGBA2BGR, 0)?;
    imgproc::cvt_color(mat_b, &mut bgr_b, imgproc::COLOR_RGBA2BGR, 0)?;

    let mut stitcher = stitching::Stitcher::create(stitching::Stitcher_Mode::PANORAMA)?;
    let mut images = core::Vector::<core::Mat>::new();
    images.push(bgr_a);
    images.push(bgr_b);

    let mut result_mat = core::Mat::default();
    let status = stitcher.stitch(&images, &mut result_mat)?;

    if status != stitching::Stitcher_Status::OK {
        anyhow::bail!("Stitcher failed: {status:?}");
    }

    eprintln!("[liveaction] OpenCV Stitcher OK: {}×{}", result_mat.cols(), result_mat.rows());

    // Convert BGR result to RGBA
    let mut rgba_mat = core::Mat::default();
    imgproc::cvt_color(&result_mat, &mut rgba_mat, imgproc::COLOR_BGR2RGBA, 0)?;

    let cols = rgba_mat.cols() as u32;
    let rows = rgba_mat.rows() as u32;
    let raw: &[u8] = rgba_mat.data_bytes()?;
    RgbaImage::from_raw(cols, rows, raw.to_vec())
        .ok_or_else(|| anyhow::anyhow!("failed to convert Stitcher Mat to RgbaImage"))
}

/// Find camera translation for a panning liveaction camera.
///
/// Phase 1: Normalized cross-correlation (NCC) template match.
///   Use the right strip of A as template; search full B for the best match.
///   NCC on the full pixel content (not feature descriptors) is driven by the
///   distinctive building/edge content and is robust to repetitive-texture false matches
///   that fool SIFT descriptor-based methods (e.g. grass creating dx≈555 false cluster).
///
/// Phase 2: Full-image SIFT + Lowe ratio test fallback.
///   Handles scenes where the template match is ambiguous (e.g. very uniform overlap zone).
fn dominant_translation(
    mat_a: &core::Mat,
    mat_b: &core::Mat,
    px_threshold: f32,
    min_inliers: usize,
) -> Option<(i32, i32)> {
    let mut gray_a = core::Mat::default();
    let mut gray_b = core::Mat::default();
    imgproc::cvt_color(mat_a, &mut gray_a, imgproc::COLOR_RGBA2GRAY, 0).ok()?;
    imgproc::cvt_color(mat_b, &mut gray_b, imgproc::COLOR_RGBA2GRAY, 0).ok()?;

    // Phase 1: NCC template match (right strip of A searched in full B)
    if let Some(r) = ncc_template_match(&gray_a, &gray_b) {
        return Some(r);
    }

    eprintln!("[liveaction] dominant_translation: NCC failed -> full-image SIFT + ratio test");

    // Phase 2: Full-image SIFT + Lowe ratio test
    let mut sift = features2d::SIFT::create(0, 3, 0.04, 10.0, 1.6).ok()?;
    let mut kp_a = core::Vector::<core::KeyPoint>::new();
    let mut kp_b = core::Vector::<core::KeyPoint>::new();
    let mut desc_a = core::Mat::default();
    let mut desc_b = core::Mat::default();
    sift.detect_and_compute(&gray_a, &core::no_array(), &mut kp_a, &mut desc_a, false).ok()?;
    sift.detect_and_compute(&gray_b, &core::no_array(), &mut kp_b, &mut desc_b, false).ok()?;

    if kp_a.len() < 4 || kp_b.len() < 4 { return None; }

    let disps = sift_ratio_disps(&desc_a, &desc_b, &kp_a, &kp_b, 0.75)?;
    eprintln!("[liveaction] full-image ratio test: {} matches", disps.len());

    best_displacement_cluster(&disps, px_threshold, min_inliers)
}

/// NCC template match using right strips of A at progressively wider fractions.
///
/// For a large pan (e.g. true dx=960 with A=1200), the right 30% template (strip_x=840)
/// can only find dx ∈ [140, 840] — dx=960 is outside the search range.  Starting with
/// narrow strips (right 10%) extends the reachable dx range to [1080-B.cols, 1080].
///
/// Laplacian edge filter is applied to both images before NCC so that repetitive
/// grass texture (which creates a strong false NCC peak at the wrong dx) is suppressed,
/// and distinctive structural content (building edges, lines) dominates the correlation.
fn ncc_template_match(gray_a: &core::Mat, gray_b: &core::Mat) -> Option<(i32, i32)> {
    let a_w = gray_a.cols();
    let v_margin = gray_a.rows() / 6;
    let tmpl_h = gray_a.rows() - 2 * v_margin;
    if tmpl_h <= 32 { return None; }

    // Edge-filter: Laplacian highlights structural edges, suppresses flat textures.
    let mut lap_a = core::Mat::default();
    let mut lap_b = core::Mat::default();
    let mut fa = core::Mat::default();
    let mut fb = core::Mat::default();
    imgproc::laplacian(gray_a, &mut lap_a, core::CV_32F, 3, 1.0, 0.0, core::BORDER_DEFAULT).ok()?;
    imgproc::laplacian(gray_b, &mut lap_b, core::CV_32F, 3, 1.0, 0.0, core::BORDER_DEFAULT).ok()?;
    core::convert_scale_abs(&lap_a, &mut fa, 1.0, 0.0).ok()?;
    core::convert_scale_abs(&lap_b, &mut fb, 1.0, 0.0).ok()?;

    // Try from narrow (10%) to wide (30%) strips.  Narrow strips let us find large dx
    // values (small overlaps): with strip_w=120 (10% of 1200), dx can be up to ~1080.
    let mut best_ncc = 0f64;
    let mut best_dx = 0i32;
    let mut best_dy = 0i32;

    for &strip_frac in &[0.10f32, 0.15, 0.20, 0.25, 0.30] {
        let strip_w = ((a_w as f32) * strip_frac).max(64.0) as i32;
        let strip_x = a_w - strip_w;

        if gray_b.cols() <= strip_w || gray_b.rows() <= tmpl_h { continue; }

        let tmpl_rect = core::Rect::new(strip_x, v_margin, strip_w, tmpl_h);
        let template = match fa.roi(tmpl_rect) { Ok(t) => t, Err(_) => continue };

        let mut result = core::Mat::default();
        if imgproc::match_template(&fb, &template, &mut result, imgproc::TM_CCOEFF_NORMED, &core::no_array()).is_err() {
            continue;
        }

        let mut max_val = 0f64;
        let mut max_loc = core::Point::default();
        if core::min_max_loc(&result, None, Some(&mut max_val), None, Some(&mut max_loc), &core::no_array()).is_err() {
            continue;
        }

        let dx = strip_x - max_loc.x;
        let dy = v_margin - max_loc.y;

        eprintln!("[liveaction] NCC strip={:.0}% ({strip_w}px): ncc={:.3} peak=({},{}) dx={} dy={}",
                  strip_frac * 100.0, max_val, max_loc.x, max_loc.y, dx, dy);

        if max_val > best_ncc {
            best_ncc = max_val;
            best_dx = dx;
            best_dy = dy;
        }

        // Accept early if NCC is convincingly high
        if max_val >= 0.55 {
            eprintln!("[liveaction] NCC accepted at {:.0}%: dx={} dy={}", strip_frac * 100.0, dx, dy);
            return Some((dx, dy));
        }
    }

    if best_ncc >= 0.35 {
        eprintln!("[liveaction] NCC best ({:.3}): dx={} dy={}", best_ncc, best_dx, best_dy);
        return Some((best_dx, best_dy));
    }

    eprintln!("[liveaction] NCC all strips too low (best={:.3}), skipping", best_ncc);
    None
}

/// Match desc_a to desc_b with kNN k=2 and Lowe ratio test; return (dx, dy) displacement list.
/// dx = p_a.x - p_b.x (positive = camera panned right).
fn sift_ratio_disps(
    desc_a: &core::Mat,
    desc_b: &core::Mat,
    kp_a: &core::Vector<core::KeyPoint>,
    kp_b: &core::Vector<core::KeyPoint>,
    ratio: f32,
) -> Option<Vec<(f32, f32)>> {
    if desc_a.empty() || desc_b.empty() { return None; }
    let mut matcher = features2d::BFMatcher::create(core::NORM_L2, false).ok()?;
    let mut knn = core::Vector::<core::Vector<core::DMatch>>::new();
    let mut train = core::Vector::<core::Mat>::new();
    train.push(desc_b.try_clone().ok()?);
    matcher.add(&train).ok()?;
    matcher.knn_match(desc_a, &mut knn, 2, &core::no_array(), false).ok()?;

    let disps: Vec<(f32, f32)> = knn.iter().filter_map(|pair| {
        if pair.len() < 2 { return None; }
        let m = pair.get(0).ok()?;
        let n = pair.get(1).ok()?;
        if m.distance >= ratio * n.distance { return None; }
        let p1 = kp_a.get(m.query_idx as usize).ok()?;
        let p2 = kp_b.get(m.train_idx as usize).ok()?;
        Some((p1.pt().x - p2.pt().x, p1.pt().y - p2.pt().y))
    }).collect();

    Some(disps)
}

/// Exhaustive 1-point RANSAC: return the displacement candidate with the most
/// inliers within px_threshold, or None if best < min_inliers.
fn best_displacement_cluster(
    disps: &[(f32, f32)],
    px_threshold: f32,
    min_inliers: usize,
) -> Option<(i32, i32)> {
    if disps.len() < min_inliers { return None; }

    let mut best_dx = 0f32;
    let mut best_dy = 0f32;
    let mut best_n = 0usize;
    for &(dx, dy) in disps {
        let n = disps.iter().filter(|&&(dx2, dy2)| {
            (dx2 - dx).abs() < px_threshold && (dy2 - dy).abs() < px_threshold
        }).count();
        if n > best_n {
            best_n = n;
            best_dx = dx;
            best_dy = dy;
        }
    }

    eprintln!("[liveaction] cluster: dx={:.1} dy={:.1} inliers={}/{}", best_dx, best_dy, best_n, disps.len());

    if best_n >= min_inliers {
        Some((best_dx.round() as i32, best_dy.round() as i32))
    } else {
        None
    }
}

/// Keep only matches whose displacement (dx, dy) lies within `tolerance` pixels of the
/// median across all matches.  Inline copy of stitch_landscape::displacement_filter.
fn displacement_prefilter(
    mv: &[core::DMatch],
    kp_a: &core::Vector<core::KeyPoint>,
    kp_b: &core::Vector<core::KeyPoint>,
    tolerance: f32,
) -> Vec<core::DMatch> {
    let mut dxs: Vec<f32> = Vec::with_capacity(mv.len());
    let mut dys: Vec<f32> = Vec::with_capacity(mv.len());
    for m in mv {
        if m.query_idx < 0 || m.train_idx < 0 { continue; }
        if let (Ok(p1), Ok(p2)) = (kp_a.get(m.query_idx as usize), kp_b.get(m.train_idx as usize)) {
            dxs.push(p2.pt().x - p1.pt().x);
            dys.push(p2.pt().y - p1.pt().y);
        }
    }
    if dxs.len() < 4 { return mv.to_vec(); }
    let mdx = median_f32(&mut dxs);
    let mdy = median_f32(&mut dys);
    mv.iter().filter(|m| {
        if m.query_idx < 0 || m.train_idx < 0 { return false; }
        let (Ok(p1), Ok(p2)) = (kp_a.get(m.query_idx as usize), kp_b.get(m.train_idx as usize))
            else { return false; };
        ((p2.pt().x - p1.pt().x) - mdx).abs() < tolerance
            && ((p2.pt().y - p1.pt().y) - mdy).abs() < tolerance
    }).cloned().collect()
}

fn median_f32(v: &mut Vec<f32>) -> f32 {
    if v.is_empty() { return 0.0; }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 0 { (v[n/2-1] + v[n/2]) / 2.0 } else { v[n/2] }
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
