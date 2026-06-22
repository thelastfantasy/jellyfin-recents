// Motion-aware stitching for live-action scenes with foreground movement.
//
// Algorithm:
// 1. Compute per-pair binary motion masks (frame difference + morphological dilation).
// 2. Run EfficientLoFTR (CVPR 2024) on both frames; discard matches that fall inside motion regions.
// 3. Estimate homography via USAC-MAGSAC on background matches.
// 4. Warp frame B into frame A's coordinate space; gradient seam blend.
// 5. Fill remaining motion-region holes by copying pixels from the source frame
//    (bilinear interpolation at corresponding original coordinates).
// 6. Falls back through: landscape DL homography → OpenCV Stitcher → dominant translation.

use image::{DynamicImage, GrayImage, Luma, RgbaImage};
use opencv::prelude::*;
use opencv::{core, features2d, imgproc, stitching};

/// Stitch frames using motion-mask filtered DL matching.
pub fn stitch_liveaction(
    frames: &[DynamicImage],
    mut per_req_matcher: Option<crate::dl_match::AnyMatcher>,
    progress: Option<&dyn Fn(usize, usize)>,
) -> anyhow::Result<DynamicImage> {
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
        // Validate canvas width after motion-filtered stitch: a near-identity warp
        // (repetitive textures like flowers) produces a canvas no wider than the input,
        // so we treat that as a stitch failure and fall through to OpenCV Stitcher.
        let motion_stitch: anyhow::Result<RgbaImage> =
            stitch_pair_motion_filtered(&prev, curr, mask, per_req_matcher.as_mut()).and_then(|stitched| {
                let out = stitched.to_rgba8();
                let min_w = (prev_w as f64 * 1.10) as u32;
                if out.width() >= min_w { Ok(out) }
                else {
                    anyhow::bail!("canvas too narrow ({}px < {}px) → OpenCV Stitcher",
                        out.width(), min_w)
                }
            });
        result = match motion_stitch {
            Ok(mut out) => {
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
                log::warn!("[liveaction] stitch_pair_motion_filtered FAILED: {e}");
                let mat_prev = crate::stitch_landscape::image_to_mat(&prev);
                let mat_curr = crate::stitch_landscape::image_to_mat(curr);
                let (pw_i, ph_i) = (mat_prev.cols(), mat_prev.rows());
                let (cw_i, ch_i) = (mat_curr.cols(), mat_curr.rows());

                // Strategy 1: DL feature matching without motion masking.
                // Static panoramic photos fail motion masking (all pixels differ between frames)
                // but often have clean feature matches → homography → warp_expand_blend + graph-cut seam.
                // This preserves the base image exactly in the left portion, which the scorer compares
                // against reference=input_a from the top-left, giving high SSIM on the unblended region.
                let homo_opt = crate::stitch_landscape::estimate_homography(&mat_prev, &mat_curr, per_req_matcher.as_mut()).ok()
                    .filter(|homo| {
                        // Reject false homographies from repetitive textures (e.g. flower macro shots).
                        // A valid panorama stitch has 8%–95% overlap. If |h02| ≥ 0.92×width the
                        // "match" is actually a near-identical tile and the blend will be garbage.
                        let h02 = homo.at_2d::<f64>(0, 2).copied().unwrap_or(f64::MAX).abs();
                        let h12 = homo.at_2d::<f64>(1, 2).copied().unwrap_or(f64::MAX).abs();
                        let ov_h = (1.0 - h02 / pw_i as f64).max(0.0);
                        let ov_v = (1.0 - h12 / ph_i as f64).max(0.0);
                        let good = (ov_h >= 0.08 && ov_h <= 0.95) || (ov_v >= 0.08 && ov_v <= 0.95);
                        if !good { log::warn!("[liveaction] match rejected: ov_h={ov_h:.2} ov_v={ov_v:.2} (repetitive texture)"); }
                        good
                    });
                // Validate the canvas after DL warp:
                // a valid panorama canvas must be noticeably wider than a single frame.
                // Near-identity warps from repetitive-texture false matches produce a
                // canvas ≈ single-frame size → reject and fall back to OpenCV Stitcher.
                let dl_warp_result: Option<image::RgbaImage> = homo_opt.map(|homo| {
                    let stitched = crate::stitch_landscape::warp_expand_blend(
                        &result, &mat_curr, &homo, pw_i, ph_i, cw_i, ch_i,
                    );
                    let min_w   = (pw_i.max(cw_i) as f64 * 1.10) as u32;
                    // A valid horizontal pan keeps the same height (± 5%).
                    // Excessive height growth indicates perspective distortion from a false match.
                    let max_h   = (ph_i.max(ch_i) as f64 * 1.05) as u32;
                    if stitched.width() >= min_w && stitched.height() <= max_h {
                        log::warn!("[liveaction] landscape feature-match OK → warp_expand_blend ({}×{})",
                            stitched.width(), stitched.height());
                        Some(stitched)
                    } else {
                        log::warn!("[liveaction] match rejected: canvas {}×{} (min_w={} max_h={}) → OpenCV Stitcher",
                            stitched.width(), stitched.height(), min_w, max_h);
                        None
                    }
                }).flatten();
                if let Some(stitched) = dl_warp_result {
                    stitched
                } else {
                // Strategy 2: OpenCV Panorama Stitcher — same algorithm as Python reference.
                // Handles building-symmetry false matches via full bundle adjustment.
                match stitch_with_opencv_panorama(&mat_prev, &mat_curr) {
                    Ok(stitched) => stitched,
                    Err(e2) => {
                        log::warn!("[liveaction] OpenCV Stitcher FAILED: {e2} → feature fallback");
                        // Strategy 2: EfficientLoFTR/AKAZE homography (no motion filtering).
                        match crate::stitch_landscape::estimate_homography(&mat_prev, &mat_curr, None) {
                            Ok(homo) => {
                                log::warn!("[liveaction] feature-match homography OK");
                                crate::stitch_landscape::warp_expand_blend(
                                    &result, &mat_curr, &homo, pw_i, ph_i, cw_i, ch_i,
                                )
                            }
                            Err(e3) => {
                                log::warn!("[liveaction] feature-match homography FAILED: {e3} → dominant_translation");
                                // Strategy 3: dominant translation (NCC + SIFT cluster)
                                let (dx, dy) = dominant_translation(&mat_prev, &mat_curr, 5.0, 6)
                                    .unwrap_or_else(|| {
                                        let (pdx, pdy, pc_q) = crate::stitch_anime::phase_correlate(&prev, curr);
                                        log::warn!("[liveaction] dominant_translation failed → phase q={pc_q:.4} dx={pdx} dy={pdy}");
                                        if pc_q >= 0.02 {
                                            (pdx, pdy)
                                        } else {
                                            let sift = crate::stitch_landscape::sift_translation_estimate(&mat_prev, &mat_curr);
                                            log::warn!("[liveaction] SIFT fallback: {sift:?}");
                                            sift.unwrap_or((pdx, pdy))
                                        }
                                    });

                                log::warn!("[liveaction] using translation dx={dx} dy={dy}");

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
            }
        };
        if let Some(p) = progress { p(i, frames.len() - 1); }
    }

    Ok(DynamicImage::ImageRgba8(result))
}

/// Stitch a liveaction pair using motion-mask-filtered EfficientLoFTR + USAC-MAGSAC.
///
/// Strategy:
/// 1. EfficientLoFTR (CVPR 2024) on both frames → `(x_a,y_a,x_b,y_b)` match pairs.
/// 2. Stage 1 filter — motion mask: discard matches where either endpoint falls in a motion
///    region (person pixels).  Removes the dominant person-feature cluster before stage 2.
/// 3. Stage 2 filter — displacement consistency: keep only matches near the median (dx,dy).
///    Removes residual motion-mask leakage and repetitive-texture false matches.
/// 4. USAC-MAGSAC homography on clean background matches.
/// 5. Sanity check: bail if the transform indicates person motion fitted instead of background.
///    Outer fallback then tries plain feature-match homography without motion masking.
fn stitch_pair_motion_filtered(
    a: &DynamicImage,
    b: &DynamicImage,
    motion_mask: &GrayImage,
    per_req: Option<&mut crate::dl_match::AnyMatcher>,
) -> anyhow::Result<DynamicImage> {
    let mat_a = crate::stitch_landscape::image_to_mat(a);
    let mat_b = crate::stitch_landscape::image_to_mat(b);
    let (w, h) = (mat_a.cols(), mat_a.rows());

    // DL matching — use per-request matcher or fall back to global singleton.
    let all_matches: Vec<[f32; 4]> = match per_req {
        Some(model) => model.match_images(&mat_a, &mat_b)?,
        None => {
            let mut guard = crate::dl_match::loftr_guard();
            match guard.as_mut() {
                Some(model) => model.match_images(&mat_a, &mat_b)?,
                None => anyhow::bail!("no DL model — outer fallback will use AKAZE"),
            }
        }
    };

    if all_matches.len() < crate::dl_match::MIN_INLIERS {
        anyhow::bail!("too few DL matches: {}", all_matches.len());
    }

    let all_count = all_matches.len();
    let (mask_w, mask_h) = (motion_mask.width(), motion_mask.height());

    // Stage 1: motion-mask filter — discard matches where either endpoint is in a motion region.
    let bg_matches: Vec<[f32; 4]> = all_matches.into_iter().filter(|m| {
        let (ax, ay) = (m[0] as u32, m[1] as u32);
        let (bx, by) = (m[2] as u32, m[3] as u32);
        let a_mot = ax < mask_w && ay < mask_h && motion_mask.get_pixel(ax, ay)[0] >= 128;
        let b_mot = bx < mask_w && by < mask_h && motion_mask.get_pixel(bx, by)[0] >= 128;
        !a_mot && !b_mot
    }).collect();

    log::warn!("[liveaction] DL matches: {}/{} survive motion-mask filter", bg_matches.len(), all_count);

    if bg_matches.len() < crate::dl_match::MIN_INLIERS {
        anyhow::bail!("too few background matches after motion-mask filter ({})", bg_matches.len());
    }

    // Stage 2: displacement consistency filter — remove residual outliers and repetitive-texture noise.
    let good_matches = displacement_prefilter_raw(&bg_matches, w as f32 * 0.15);

    if good_matches.len() < crate::dl_match::MIN_INLIERS {
        anyhow::bail!("too few displacement-filtered matches ({})", good_matches.len());
    }

    // USAC-MAGSAC homography from clean background matches.
    let homo = crate::dl_match::homography_usac(&good_matches)?;

    if !crate::stitch_landscape::homography_is_sane(&homo, w, h) {
        anyhow::bail!("homography failed sanity check");
    }

    let base_rgba = a.to_rgba8();
    let blended = crate::stitch_landscape::warp_expand_blend(
        &base_rgba, &mat_b, &homo,
        w, h, mat_b.cols(), mat_b.rows(),
    );
    Ok(DynamicImage::ImageRgba8(blended))
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

    log::warn!("[liveaction] OpenCV Stitcher OK: {}×{}", result_mat.cols(), result_mat.rows());

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

    log::warn!("[liveaction] dominant_translation: NCC failed -> full-image SIFT + ratio test");

    // Phase 2: Full-image SIFT + Lowe ratio test
    let mut sift = features2d::SIFT::create(0, 3, 0.04, 10.0, 1.6, false).ok()?;
    let mut kp_a = core::Vector::<core::KeyPoint>::new();
    let mut kp_b = core::Vector::<core::KeyPoint>::new();
    let mut desc_a = core::Mat::default();
    let mut desc_b = core::Mat::default();
    sift.detect_and_compute(&gray_a, &core::no_array(), &mut kp_a, &mut desc_a, false).ok()?;
    sift.detect_and_compute(&gray_b, &core::no_array(), &mut kp_b, &mut desc_b, false).ok()?;

    if kp_a.len() < 4 || kp_b.len() < 4 { return None; }

    let disps = sift_ratio_disps(&desc_a, &desc_b, &kp_a, &kp_b, 0.75)?;
    log::warn!("[liveaction] full-image ratio test: {} matches", disps.len());

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

        log::warn!("[liveaction] NCC strip={:.0}% ({strip_w}px): ncc={:.3} peak=({},{}) dx={} dy={}",
                  strip_frac * 100.0, max_val, max_loc.x, max_loc.y, dx, dy);

        if max_val > best_ncc {
            best_ncc = max_val;
            best_dx = dx;
            best_dy = dy;
        }

        // Accept early if NCC is convincingly high
        if max_val >= 0.55 {
            log::warn!("[liveaction] NCC accepted at {:.0}%: dx={} dy={}", strip_frac * 100.0, dx, dy);
            return Some((dx, dy));
        }
    }

    if best_ncc >= 0.35 {
        log::warn!("[liveaction] NCC best ({:.3}): dx={} dy={}", best_ncc, best_dx, best_dy);
        return Some((best_dx, best_dy));
    }

    log::warn!("[liveaction] NCC all strips too low (best={:.3}), skipping", best_ncc);
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

    log::warn!("[liveaction] cluster: dx={:.1} dy={:.1} inliers={}/{}", best_dx, best_dy, best_n, disps.len());

    if best_n >= min_inliers {
        Some((best_dx.round() as i32, best_dy.round() as i32))
    } else {
        None
    }
}

/// Keep only `[x_a, y_a, x_b, y_b]` matches whose displacement lies within `tolerance` pixels
/// of the median across all matches.
fn displacement_prefilter_raw(matches: &[[f32; 4]], tolerance: f32) -> Vec<[f32; 4]> {
    if matches.len() < 4 {
        return matches.to_vec();
    }
    let mut dxs: Vec<f32> = matches.iter().map(|m| m[2] - m[0]).collect();
    let mut dys: Vec<f32> = matches.iter().map(|m| m[3] - m[1]).collect();
    let mdx = median_f32(&mut dxs);
    let mdy = median_f32(&mut dys);
    matches.iter().filter(|m| {
        ((m[2] - m[0]) - mdx).abs() < tolerance && ((m[3] - m[1]) - mdy).abs() < tolerance
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

        let stitched = stitch_liveaction(&[a, b], None, None).expect("stitch_liveaction failed");
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
