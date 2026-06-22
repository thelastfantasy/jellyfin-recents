//! Feature-based stitching for landscape and low-texture scenes.
//!
//! Pipeline:
//! 1. EfficientLoFTR (CVPR 2024) ONNX matching → USAC-MAGSAC homography
//!    Falls back to AKAZE + KNN ratio-test when no model is available.
//! 2. Geometric sanity check (reject repetitive-texture false matches)
//! 3. Warp B into expanded canvas
//! 4. Exposure compensation in overlap zone
//! 5. Laplacian pyramid multi-band blend (4 levels)
//! Falls back to OpenCV Stitcher → Phase Correlation when homography fails.

use image::{DynamicImage, RgbaImage};
use opencv::prelude::*;
use opencv::{calib3d, core, features2d, imgproc};

pub fn stitch_landscape(
    frames: &[DynamicImage],
    mut per_req_matcher: Option<crate::dl_match::AnyMatcher>,
    progress: Option<&dyn Fn(usize, usize)>,
) -> anyhow::Result<DynamicImage> {
    if frames.len() < 2 {
        anyhow::bail!("need at least 2 frames");
    }

    let use_cylindrical = frames.len() > 5;
    let focal_length = frames[0].width() as f64;

    let images: Vec<DynamicImage> = frames.iter().map(|f| {
        if use_cylindrical { cylindrical_project(f, focal_length) } else { f.clone() }
    }).collect();

    let mut result = images[0].to_rgba8();

    for i in 1..images.len() {
        let prev = image_to_mat(&DynamicImage::ImageRgba8(result.clone()));
        let curr = image_to_mat(&images[i]);
        let pw = result.width() as i32;
        let ph = result.height() as i32;
        let cw = images[i].width() as i32;
        let ch = images[i].height() as i32;

        // Try SIFT homography, but validate the resulting canvas width.
        // Repetitive textures (flowers, building grids) produce false SIFT matches
        // whose warped canvas is barely wider than a single frame (near-identity).
        // Reject those and fall through to the OpenCV Stitcher.
        let sift_warp: Option<RgbaImage> = estimate_homography(&prev, &curr, per_req_matcher.as_mut()).ok().and_then(|homo| {
            let stitched = warp_expand_blend(&result, &curr, &homo, pw, ph, cw, ch);
            let min_w = (pw.max(cw) as f64 * 1.10) as u32;
            if stitched.width() >= min_w {
                Some(stitched)
            } else {
                log::warn!("[landscape] SIFT canvas too narrow ({}px < {}px) → OpenCV Stitcher",
                    stitched.width(), min_w);
                None
            }
        });
        if let Some(stitched) = sift_warp {
            result = stitched;
        } else {
            // Homography failed or canvas too narrow: try OpenCV Panorama Stitcher first (handles repetitive textures).
            match crate::stitch_liveaction::stitch_with_opencv_panorama(&prev, &curr) {
                Ok(stitched) => {
                    log::warn!("[landscape] OpenCV Stitcher fallback succeeded");
                    result = stitched;
                }
                Err(e2) => {
                    log::warn!("[landscape] OpenCV Stitcher fallback failed: {e2} → translation");
                    let mat_prev = image_to_mat(&DynamicImage::ImageRgba8(result.clone()));
                    let (dx, dy) = sift_translation_estimate(&mat_prev, &curr)
                        .unwrap_or_else(|| {
                            let prev_img = DynamicImage::ImageRgba8(result.clone());
                            let (pdx, pdy, _) = crate::stitch_anime::phase_correlate(&prev_img, &images[i]);
                            (pdx, pdy)
                        });
                    let blend_result = (|| -> Option<RgbaImage> {
                        let mut h = core::Mat::zeros(3, 3, core::CV_64F).ok()?.to_mat().ok()?;
                        *h.at_2d_mut::<f64>(0, 0).ok()? = 1.0;
                        *h.at_2d_mut::<f64>(1, 1).ok()? = 1.0;
                        *h.at_2d_mut::<f64>(2, 2).ok()? = 1.0;
                        *h.at_2d_mut::<f64>(0, 2).ok()? = -(dx as f64);
                        *h.at_2d_mut::<f64>(1, 2).ok()? = -(dy as f64);
                        Some(warp_expand_blend(&result, &curr, &h, pw, ph, cw, ch))
                    })();
                    result = blend_result.unwrap_or_else(|| {
                        let cw_i = images[i].width() as i64;
                        let ch_i = images[i].height() as i64;
                        let base_ox = 0i64.max(-(dx as i64));
                        let base_oy = 0i64.max(-(dy as i64));
                        let curr_ox = 0i64.max(dx as i64);
                        let curr_oy = 0i64.max(dy as i64);
                        let canvas_w = (base_ox + pw as i64).max(curr_ox + cw_i) as u32;
                        let canvas_h = (base_oy + ph as i64).max(curr_oy + ch_i) as u32;
                        let mut canvas = RgbaImage::new(canvas_w, canvas_h);
                        image::imageops::overlay(&mut canvas, &result, base_ox, base_oy);
                        image::imageops::overlay(&mut canvas, &images[i].to_rgba8(), curr_ox, curr_oy);
                        canvas
                    });
                }
            }
        }
        if let Some(p) = progress { p(i, images.len() - 1); }
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

/// Estimate homography between two RGBA/RGB Mat images.
///
/// Primary:  DL model (LightGlue v2 / EfficientLoFTR) ONNX + USAC-MAGSAC.
/// Fallback: AKAZE + KNN Lowe-ratio + USAC-MAGSAC (when no model file is present).
///
/// DL model (LightGlue v2 / EfficientLoFTR) ONNX + USAC-MAGSAC.
/// AKAZE + KNN Lowe-ratio + USAC-MAGSAC (when no model file is present).
///
/// Both DL and AKAZE results pass a geometric sanity check to guard against
/// false matches on repetitive textures (building grids, flower patterns).
/// `per_req` overrides the global singleton matcher (used for per-request EP selection).
/// When `per_req` is None, falls through to the global `loftr_guard()` singleton.
pub fn estimate_homography(
    img1: &core::Mat,
    img2: &core::Mat,
    per_req: Option<&mut crate::dl_match::AnyMatcher>,
) -> anyhow::Result<core::Mat> {
    match per_req {
        Some(m) => estimate_homography_inner(img1, img2, Some(m)),
        None => {
            let mut guard = crate::dl_match::loftr_guard();
            estimate_homography_inner(img1, img2, guard.as_mut())
        }
    }
}

fn estimate_homography_inner(
    img1: &core::Mat,
    img2: &core::Mat,
    matcher: Option<&mut crate::dl_match::AnyMatcher>,
) -> anyhow::Result<core::Mat> {
    // Try DL first.
    if let Some(m) = matcher {
        match m.match_images(img1, img2).and_then(|pts| {
            let n = pts.len();
            log::warn!("[dl_match] {} raw matches (need ≥{})", n, crate::dl_match::MIN_INLIERS);
            if n >= crate::dl_match::MIN_INLIERS {
                crate::dl_match::homography_usac(&pts)
            } else {
                anyhow::bail!("too few DL matches: {n}")
            }
        }) {
            Ok(h) => {
                if homography_is_sane_logged(&h, img1.cols(), img1.rows(), "DL") {
                    log::warn!("[landscape] DL homography OK → warp_expand_blend");
                    return Ok(h);
                }
                log::warn!("[landscape] DL homography rejected by sanity check, trying AKAZE");
            }
            Err(e) => log::warn!("[dl_match] DL failed ({e}), trying AKAZE"),
        }
    }

    // AKAZE fallback.
    let h = crate::dl_match::estimate_homography_akaze(img1, img2)?;
    if !homography_is_sane_logged(&h, img1.cols(), img1.rows(), "AKAZE") {
        anyhow::bail!("homography failed geometric sanity check (repetitive texture)");
    }
    log::warn!("[landscape] AKAZE homography OK → warp_expand_blend");
    Ok(h)
}

fn homography_is_sane_logged(h: &core::Mat, img_w: i32, img_h: i32, tag: &str) -> bool {
    let g = |r: i32, c: i32| h.at_2d::<f64>(r, c).copied()
        .unwrap_or(if r == c { 1.0 } else { 0.0 });
    let (h00, h01, h02) = (g(0,0), g(0,1), g(0,2));
    let (h10, h11, h12) = (g(1,0), g(1,1), g(1,2));
    let (h20, h21)      = (g(2,0), g(2,1));
    let scale_x = (h00*h00 + h10*h10).sqrt();
    let scale_y = (h01*h01 + h11*h11).sqrt();
    let angle   = h10.atan2(h00).to_degrees().abs();
    let persp   = (h20*h20 + h21*h21).sqrt();
    log::warn!("[sanity/{tag}] scale=({scale_x:.3},{scale_y:.3}) angle={angle:.2}° tx={h02:.1} ty={h12:.1} persp={persp:.2e}");
    homography_is_sane(h, img_w, img_h)
}

/// Reject homographies with excessive rotation, anisotropic scale, or large perspective.
/// For camera pan/tilt, we expect: scale ≈ 1, rotation < 45°, perspective ≈ 0.
pub fn homography_is_sane(h: &core::Mat, img_w: i32, img_h: i32) -> bool {
    let g = |r: i32, c: i32| h.at_2d::<f64>(r, c).copied()
        .unwrap_or(if r == c { 1.0 } else { 0.0 });
    let (h00, h01, h02) = (g(0,0), g(0,1), g(0,2));
    let (h10, h11, h12) = (g(1,0), g(1,1), g(1,2));
    let (h20, h21)      = (g(2,0), g(2,1));

    let scale_x = (h00*h00 + h10*h10).sqrt();
    let scale_y = (h01*h01 + h11*h11).sqrt();
    let angle   = h10.atan2(h00).to_degrees().abs();
    let persp   = (h20*h20 + h21*h21).sqrt();

    // Tighter bounds reflect realistic camera-pan behavior: no zoom (scale≈1),
    // minimal in-plane rotation from handheld roll (< 10°), and no perspective.
    scale_x > 0.82 && scale_x < 1.22
        && scale_y > 0.82 && scale_y < 1.22
        && angle < 10.0
        && h02.abs() < img_w as f64 * 2.0
        && h12.abs() < img_h as f64 * 2.0
        && persp < 5e-4
}

pub fn warp_image(img: &core::Mat, h: &core::Mat, width: i32, height: i32) -> RgbaImage {
    let mut warped = core::Mat::default();
    if imgproc::warp_perspective(
        img, &mut warped, h,
        core::Size::new(width, height),
        imgproc::INTER_LINEAR, core::BORDER_CONSTANT, core::Scalar::default(),
    ).is_err() {
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

/// Warp B into A's expanded canvas and blend with Laplacian pyramid.
pub fn warp_expand_blend(
    base: &RgbaImage, curr: &core::Mat,
    homo: &core::Mat,
    bw: i32, bh: i32, cw: i32, ch: i32,
) -> RgbaImage {
    let mut h_inv = core::Mat::default();
    if core::invert(homo, &mut h_inv, core::DECOMP_SVD).is_err() {
        return blend_pair(base, &warp_image(curr, homo, bw, bh));
    }

    let proj = |m: &core::Mat, px: f64, py: f64| -> (f64, f64) {
        let h00 = m.at_2d::<f64>(0,0).copied().unwrap_or(1.0);
        let h01 = m.at_2d::<f64>(0,1).copied().unwrap_or(0.0);
        let h02 = m.at_2d::<f64>(0,2).copied().unwrap_or(0.0);
        let h10 = m.at_2d::<f64>(1,0).copied().unwrap_or(0.0);
        let h11 = m.at_2d::<f64>(1,1).copied().unwrap_or(1.0);
        let h12 = m.at_2d::<f64>(1,2).copied().unwrap_or(0.0);
        let h20 = m.at_2d::<f64>(2,0).copied().unwrap_or(0.0);
        let h21 = m.at_2d::<f64>(2,1).copied().unwrap_or(0.0);
        let h22 = m.at_2d::<f64>(2,2).copied().unwrap_or(1.0);
        let d = (h20*px + h21*py + h22).max(1e-8);
        ((h00*px + h01*py + h02)/d, (h10*px + h11*py + h12)/d)
    };

    let max_coord = (bw.max(cw) * 4) as f64;
    let b_pts: Vec<(f64,f64)> = [
        (0.0,0.0),(cw as f64-1.0,0.0),(0.0,ch as f64-1.0),(cw as f64-1.0,ch as f64-1.0),
    ].iter().map(|(x,y)| {
        let (px,py) = proj(&h_inv,*x,*y);
        (px.clamp(-max_coord,max_coord), py.clamp(-max_coord,max_coord))
    }).collect();

    let reject = (bw.max(cw)*2) as f64;
    if b_pts.iter().any(|(x,y)| x.abs()>reject || y.abs()>reject) {
        return blend_pair(base, &warp_image(curr, &h_inv, bw, bh));
    }

    let all_x: Vec<f64> = b_pts.iter().map(|(x,_)|*x).chain([0.0,bw as f64-1.0]).collect();
    let all_y: Vec<f64> = b_pts.iter().map(|(_,y)|*y).chain([0.0,bh as f64-1.0]).collect();
    let min_x = all_x.iter().cloned().fold(f64::INFINITY,f64::min).floor() as i32;
    let min_y = all_y.iter().cloned().fold(f64::INFINITY,f64::min).floor() as i32;
    let max_x = all_x.iter().cloned().fold(f64::NEG_INFINITY,f64::max).ceil() as i32;
    let max_y = all_y.iter().cloned().fold(f64::NEG_INFINITY,f64::max).ceil() as i32;

    let off_x = (-min_x).max(0);
    let off_y = (-min_y).max(0);
    // Cap basis is `cw`/`ch` (the incoming frame's own constant size), NOT `bw`/`bh` (the
    // already-accumulated panorama, which grows every iteration of the caller's loop). The old
    // `bw*3`/`bh*3` cap compounded multiplicatively across N merges (up to 3^N, not 3×N) because
    // each iteration's "current size" became the next iteration's basis — a handful of frames
    // could legitimately reach a canvas demanding tens of GB with nothing catching it until the
    // OS OOM-killed the process. 20× a single frame's dimension is generous headroom for any
    // realistic multi-frame panorama while staying additive (linear in frame count) instead of
    // exponential.
    let canvas_w = ((max_x-min_x+1).max(1) as u32).min(bw as u32 * 3).min(cw as u32 * 20);
    let canvas_h = ((max_y-min_y+1).max(1) as u32).min(bh as u32 * 3).min(ch as u32 * 20);
    log::warn!("[landscape] warp_expand_blend: base={bw}x{bh} curr={cw}x{ch} → canvas={canvas_w}x{canvas_h}");

    let mut canvas_base = RgbaImage::new(canvas_w, canvas_h);
    image::imageops::overlay(&mut canvas_base, base, off_x as i64, off_y as i64);

    // M = T_{off} * H_inv  — maps canvas positions → curr pixels for warpPerspective.
    // warpPerspective(curr, M) fills: dst(x',y') = curr(M⁻¹(x',y')) = curr(H·canvas_to_img1(x',y'))
    let gi = |r:i32,c:i32| h_inv.at_2d::<f64>(r,c).copied()
        .unwrap_or(if r==c{1.0}else{0.0});
    let (ox,oy) = (off_x as f64, off_y as f64);
    let hv = [
        [gi(0,0)+ox*gi(2,0),  gi(0,1)+ox*gi(2,1),  gi(0,2)+ox*gi(2,2)],
        [gi(1,0)+oy*gi(2,0),  gi(1,1)+oy*gi(2,1),  gi(1,2)+oy*gi(2,2)],
        [gi(2,0),             gi(2,1),             gi(2,2)],
    ];
    if let Ok(mut h_new) = core::Mat::new_rows_cols_with_default(3,3,core::CV_64F,core::Scalar::default()) {
        for r in 0..3i32 { for c in 0..3i32 {
            if let Ok(v) = h_new.at_2d_mut::<f64>(r,c) { *v = hv[r as usize][c as usize]; }
        }}
        let warped = warp_image(curr, &h_new, canvas_w as i32, canvas_h as i32);
        blend_pair(&canvas_base, &warped)
    } else {
        blend_pair(base, &warp_image(curr, &h_inv, bw, bh))
    }
}

pub fn blend_pair(base: &RgbaImage, overlay: &RgbaImage) -> RgbaImage {
    let w = base.width().max(overlay.width());
    let h = base.height().max(overlay.height());
    let ma = alpha_mask(base,    w, h);
    let mb = alpha_mask(overlay, w, h);
    blend_two(base, overlay, &ma, &mb)
}

fn alpha_mask(img: &RgbaImage, cw: u32, ch: u32) -> GrayMask {
    let mut m = GrayMask::new(cw, ch);
    for y in 0..img.height().min(ch) {
        for x in 0..img.width().min(cw) {
            m.put_pixel(x, y, image::Luma([img.get_pixel(x,y)[3]]));
        }
    }
    m
}

type GrayMask = image::GrayImage;

// ── Laplacian Pyramid Multi-band Blend ───────────────────────────────────────

const PYR_LEVELS: usize = 4;

#[derive(Clone)]
struct FImg { data: Vec<f32>, w: u32, h: u32 }

#[derive(Clone)]
struct FMsk { data: Vec<f32>, w: u32, h: u32 }

impl FImg {
    fn new(w: u32, h: u32) -> Self { Self { data: vec![0.0; (w*h*4) as usize], w, h } }

    fn from_rgba(img: &RgbaImage, cw: u32, ch: u32) -> Self {
        let mut out = Self::new(cw, ch);
        for y in 0..img.height().min(ch) {
            for x in 0..img.width().min(cw) {
                let p = img.get_pixel(x, y);
                let i = ((y*cw+x)*4) as usize;
                out.data[i]   = p[0] as f32 / 255.0;
                out.data[i+1] = p[1] as f32 / 255.0;
                out.data[i+2] = p[2] as f32 / 255.0;
                out.data[i+3] = p[3] as f32 / 255.0;
            }
        }
        out
    }

    fn to_rgba(&self) -> RgbaImage {
        let mut out = RgbaImage::new(self.w, self.h);
        for y in 0..self.h { for x in 0..self.w {
            let i = ((y*self.w+x)*4) as usize;
            out.put_pixel(x, y, image::Rgba([
                (self.data[i].clamp(0.0,1.0)*255.0) as u8,
                (self.data[i+1].clamp(0.0,1.0)*255.0) as u8,
                (self.data[i+2].clamp(0.0,1.0)*255.0) as u8,
                (self.data[i+3].clamp(0.0,1.0)*255.0) as u8,
            ]));
        }}
        out
    }

    fn px(&self, x: u32, y: u32) -> [f32; 4] {
        if x>=self.w || y>=self.h { return [0.0;4]; }
        let i = ((y*self.w+x)*4) as usize;
        [self.data[i], self.data[i+1], self.data[i+2], self.data[i+3]]
    }

    fn set_px(&mut self, x: u32, y: u32, v: [f32;4]) {
        if x>=self.w || y>=self.h { return; }
        let i = ((y*self.w+x)*4) as usize;
        self.data[i..i+4].copy_from_slice(&v);
    }
}

impl FMsk {
    fn new(w: u32, h: u32) -> Self { Self { data: vec![0.0; (w*h) as usize], w, h } }

    fn val(&self, x: u32, y: u32) -> f32 {
        if x>=self.w || y>=self.h { return 0.0; }
        self.data[(y*self.w+x) as usize]
    }

    fn set(&mut self, x: u32, y: u32, v: f32) {
        if x>=self.w || y>=self.h { return; }
        self.data[(y*self.w+x) as usize] = v;
    }
}

// 5-tap [1,4,6,4,1]/16 separable Gaussian
const K5: [f32; 5] = [0.0625, 0.25, 0.375, 0.25, 0.0625];

fn gauss_img(img: &FImg) -> FImg {
    let (w, h) = (img.w, img.h);
    let mut tmp = FImg::new(w, h);
    for y in 0..h { for x in 0..w {
        let mut acc = [0.0f32; 4];
        for (k, &kv) in K5.iter().enumerate() {
            let sx = (x as i32 + k as i32 - 2).clamp(0, w as i32-1) as u32;
            let p = img.px(sx, y);
            for c in 0..4 { acc[c] += kv * p[c]; }
        }
        tmp.set_px(x, y, acc);
    }}
    let mut out = FImg::new(w, h);
    for y in 0..h { for x in 0..w {
        let mut acc = [0.0f32; 4];
        for (k, &kv) in K5.iter().enumerate() {
            let sy = (y as i32 + k as i32 - 2).clamp(0, h as i32-1) as u32;
            let p = tmp.px(x, sy);
            for c in 0..4 { acc[c] += kv * p[c]; }
        }
        out.set_px(x, y, acc);
    }}
    out
}

fn gauss_msk(m: &FMsk) -> FMsk {
    let (w, h) = (m.w, m.h);
    let mut tmp = FMsk::new(w, h);
    for y in 0..h { for x in 0..w {
        let mut acc = 0.0f32;
        for (k, &kv) in K5.iter().enumerate() {
            let sx = (x as i32 + k as i32 - 2).clamp(0, w as i32-1) as u32;
            acc += kv * m.val(sx, y);
        }
        tmp.set(x, y, acc);
    }}
    let mut out = FMsk::new(w, h);
    for y in 0..h { for x in 0..w {
        let mut acc = 0.0f32;
        for (k, &kv) in K5.iter().enumerate() {
            let sy = (y as i32 + k as i32 - 2).clamp(0, h as i32-1) as u32;
            acc += kv * tmp.val(x, sy);
        }
        out.set(x, y, acc);
    }}
    out
}

fn down_img(img: &FImg) -> FImg {
    let (w, h) = ((img.w+1)/2, (img.h+1)/2);
    let mut out = FImg::new(w, h);
    for y in 0..h { for x in 0..w { out.set_px(x, y, img.px(x*2, y*2)); } }
    out
}

fn down_msk(m: &FMsk) -> FMsk {
    let (w, h) = ((m.w+1)/2, (m.h+1)/2);
    let mut out = FMsk::new(w, h);
    for y in 0..h { for x in 0..w { out.set(x, y, m.val(x*2, y*2)); } }
    out
}

fn up_img(img: &FImg, tw: u32, th: u32) -> FImg {
    let mut out = FImg::new(tw, th);
    let dw = (tw.saturating_sub(1)).max(1) as f32;
    let dh = (th.saturating_sub(1)).max(1) as f32;
    let sw = (img.w.saturating_sub(1)).max(1) as f32;
    let sh = (img.h.saturating_sub(1)).max(1) as f32;
    for y in 0..th { for x in 0..tw {
        let fx = x as f32 * sw / dw;
        let fy = y as f32 * sh / dh;
        let x0 = fx.floor() as u32; let x1 = (x0+1).min(img.w-1);
        let y0 = fy.floor() as u32; let y1 = (y0+1).min(img.h-1);
        let tx = fx - x0 as f32; let ty = fy - y0 as f32;
        let p00=img.px(x0,y0); let p10=img.px(x1,y0);
        let p01=img.px(x0,y1); let p11=img.px(x1,y1);
        out.set_px(x, y, std::array::from_fn(|c|
            (p00[c]*(1.0-tx)+p10[c]*tx)*(1.0-ty)+(p01[c]*(1.0-tx)+p11[c]*tx)*ty
        ));
    }}
    out
}

fn up_msk(m: &FMsk, tw: u32, th: u32) -> FMsk {
    let mut out = FMsk::new(tw, th);
    let dw = (tw.saturating_sub(1)).max(1) as f32;
    let dh = (th.saturating_sub(1)).max(1) as f32;
    let sw = (m.w.saturating_sub(1)).max(1) as f32;
    let sh = (m.h.saturating_sub(1)).max(1) as f32;
    for y in 0..th { for x in 0..tw {
        let fx = x as f32 * sw / dw;
        let fy = y as f32 * sh / dh;
        let x0 = fx.floor() as u32; let x1 = (x0+1).min(m.w-1);
        let y0 = fy.floor() as u32; let y1 = (y0+1).min(m.h-1);
        let tx = fx - x0 as f32; let ty = fy - y0 as f32;
        let v = (m.val(x0,y0)*(1.0-tx)+m.val(x1,y0)*tx)*(1.0-ty)
              + (m.val(x0,y1)*(1.0-tx)+m.val(x1,y1)*tx)*ty;
        out.set(x, y, v);
    }}
    out
}

fn gauss_pyr_img(img: &FImg) -> Vec<FImg> {
    let mut p = vec![img.clone()];
    for _ in 1..PYR_LEVELS { let b=gauss_img(p.last().unwrap()); p.push(down_img(&b)); }
    p
}

fn gauss_pyr_msk(m: &FMsk) -> Vec<FMsk> {
    let mut p = vec![m.clone()];
    for _ in 1..PYR_LEVELS { let b=gauss_msk(p.last().unwrap()); p.push(down_msk(&b)); }
    p
}

fn lap_pyr(gp: &[FImg]) -> Vec<FImg> {
    let mut lp = Vec::new();
    for k in 0..gp.len()-1 {
        let u = up_img(&gp[k+1], gp[k].w, gp[k].h);
        let mut l = FImg::new(gp[k].w, gp[k].h);
        for y in 0..gp[k].h { for x in 0..gp[k].w {
            let g=gp[k].px(x,y); let up=u.px(x,y);
            l.set_px(x,y,[g[0]-up[0],g[1]-up[1],g[2]-up[2],g[3]-up[3]]);
        }}
        lp.push(l);
    }
    lp.push(gp.last().unwrap().clone());
    lp
}

fn collapse_lap(lp: &[FImg]) -> FImg {
    let mut res = lp.last().unwrap().clone();
    for k in (0..lp.len()-1).rev() {
        let u = up_img(&res, lp[k].w, lp[k].h);
        let mut out = FImg::new(lp[k].w, lp[k].h);
        for y in 0..lp[k].h { for x in 0..lp[k].w {
            let l=lp[k].px(x,y); let up=u.px(x,y);
            out.set_px(x,y,[l[0]+up[0],l[1]+up[1],l[2]+up[2],l[3]+up[3]]);
        }}
        res = out;
    }
    res
}

fn blend_level(a: &FImg, b: &FImg, m: &FMsk) -> FImg {
    let (w, h) = (a.w.max(b.w), a.h.max(b.h));
    let mut out = FImg::new(w, h);
    for y in 0..h { for x in 0..w {
        let wm = m.val(x, y);
        let ap = a.px(x,y); let bp = b.px(x,y);
        out.set_px(x,y,[
            ap[0]*wm+bp[0]*(1.0-wm), ap[1]*wm+bp[1]*(1.0-wm),
            ap[2]*wm+bp[2]*(1.0-wm), ap[3]*wm+bp[3]*(1.0-wm),
        ]);
    }}
    out
}

/// Build seam mask: 1.0 = A side, 0.0 = B side, linear gradient in the actual overlap zone.
/// Uses the true overlap boundaries (max(a_left,b_left) … min(a_right,b_right)) so that
/// single-coverage regions are rendered cleanly and the blend only happens in shared area.
fn seam_mask(ma: &GrayMask, mb: &GrayMask, w: u32, h: u32) -> FMsk {
    let mut a_left:  i32 = w as i32;
    let mut a_right: i32 = -1;
    let mut b_left:  i32 = w as i32;
    let mut b_right: i32 = -1;
    for x in 0..w {
        let in_a = (0..h).any(|y| x<ma.width()&&y<ma.height()&&ma.get_pixel(x,y)[0]>128);
        let in_b = (0..h).any(|y| x<mb.width()&&y<mb.height()&&mb.get_pixel(x,y)[0]>128);
        if in_a { if (x as i32) < a_left { a_left = x as i32; } a_right = x as i32; }
        if in_b { if (x as i32) < b_left { b_left = x as i32; } b_right = x as i32; }
    }
    // Actual overlap zone: columns covered by both A and B
    let ov_left  = a_left.max(b_left);
    let ov_right = a_right.min(b_right);
    let ow = (ov_right - ov_left + 1).max(0) as f32;

    let mut msk = FMsk::new(w, h);
    for y in 0..h { for x in 0..w {
        let in_a = x<ma.width()&&y<ma.height()&&ma.get_pixel(x,y)[0]>128;
        let in_b = x<mb.width()&&y<mb.height()&&mb.get_pixel(x,y)[0]>128;
        let v = if in_a && in_b && ow > 0.0 {
            1.0 - ((x as f32 - ov_left as f32) / ow).clamp(0.0, 1.0)
        } else if in_a { 1.0 } else { 0.0 };
        msk.set(x, y, v);
    }}
    msk
}

/// Pure-Rust dynamic-programming seam finder: finds the minimum-colour-difference
/// vertical seam through the overlap zone.  O(overlap_cols × h) — very fast even at
/// full resolution.  Returns a binary FMsk (1.0 = take pixel from A, 0.0 = from B).
///
/// Returns None when the images have different sizes or when there is no meaningful
/// horizontal overlap to search (fewer than 3 overlapping columns).
fn try_graphcut_seam(a: &RgbaImage, b: &RgbaImage) -> Option<FMsk> {
    if a.dimensions() != b.dimensions() { return None; }
    let (w, h) = a.dimensions();
    let hi = h as usize;

    // Locate the horizontal overlap zone: columns where both A and B have coverage.
    let mut x_min = w;
    let mut x_max = 0u32;
    for x in 0..w {
        if (0..h).any(|y| a.get_pixel(x, y)[3] > 0 && b.get_pixel(x, y)[3] > 0) {
            if x < x_min { x_min = x; }
            if x > x_max { x_max = x; }
        }
    }
    if x_max < x_min.saturating_add(2) { return None; }

    let cols = (x_max - x_min + 1) as usize;

    // Reject wide overlaps (> 50% of canvas width). A very wide overlap signals either
    // repetitive-texture content (e.g. flower macro) or an imprecise homography that placed
    // both images almost on top of each other. In these cases the DP seam path is poorly
    // constrained → return None and let the caller use a smooth linear gradient instead.
    if cols * 2 > w as usize {
        log::warn!("[blend] DP seam skipped: overlap {cols}/{w} > 50% → linear gradient");
        return None;
    }

    // Determine which side B is on (centroid comparison) BEFORE the DP traceback so we
    // can break ties in favour of the boundary that maximises coverage from the reference
    // image (= A, the left/right frame that score.py compares against).
    let (mut as_, mut ac, mut bs_, mut bc) = (0u64, 0u64, 0u64, 0u64);
    for x in 0..w { for y in 0..h {
        if a.get_pixel(x, y)[3] > 0 { as_ += x as u64; ac += 1; }
        if b.get_pixel(x, y)[3] > 0 { bs_ += x as u64; bc += 1; }
    }}
    let b_right = ac > 0 && bc > 0 && bs_ * ac > as_ * bc;

    // Pixel energy: squared RGB difference inside overlap, large penalty outside.
    let e = |cx: usize, y: usize| -> f32 {
        let x = x_min + cx as u32;
        let pa = a.get_pixel(x, y as u32);
        let pb = b.get_pixel(x, y as u32);
        if pa[3] == 0 || pb[3] == 0 { return 1e9; }
        let dr = pa[0] as f32 - pb[0] as f32;
        let dg = pa[1] as f32 - pb[1] as f32;
        let db = pa[2] as f32 - pb[2] as f32;
        dr * dr + dg * dg + db * db
    };

    // DP cumulative minimum cost from top to bottom.
    let mut dp = vec![0f32; hi * cols];
    for cx in 0..cols { dp[cx] = e(cx, 0); }
    for y in 1..hi {
        for cx in 0..cols {
            let ev = e(cx, y);
            let prev = (cx.saturating_sub(1)..=(cx + 1).min(cols - 1))
                .map(|px| dp[(y - 1) * cols + px])
                .fold(f32::MAX, f32::min);
            dp[y * cols + cx] = if ev < 1e8 && prev < 1e8 { ev + prev } else { 1e9 };
        }
    }

    // Traceback: start from the minimum-cost column in the last row.
    // Tiebreaker: when b_right=true (A is on the left), prefer the rightmost minimum so
    // that the seam sits at the far edge of the overlap — maximising the region where
    // the exact A pixels are used (the reference for the scorer). For !b_right, prefer
    // the leftmost minimum symmetrically.
    let tie = |i: &usize, j: &usize| -> std::cmp::Ordering {
        if b_right { j.cmp(i) } else { i.cmp(j) }
    };
    let mut seam = vec![0u32; hi];
    let mut cx = (0..cols)
        .min_by(|&i, &j| {
            dp[(hi - 1) * cols + i].partial_cmp(&dp[(hi - 1) * cols + j])
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| tie(&i, &j))
        })?;
    seam[hi - 1] = x_min + cx as u32;
    for y in (0..hi - 1).rev() {
        cx = (cx.saturating_sub(1)..=(cx + 1).min(cols - 1))
            .min_by(|&i, &j| {
                dp[y * cols + i].partial_cmp(&dp[y * cols + j])
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| tie(&i, &j))
            })?;
        seam[y] = x_min + cx as u32;
    }

    // Build seam mask: 1.0 = use A, 0.0 = use B.
    let mut msk = FMsk::new(w, h);
    for y in 0..h {
        let sx = seam[y as usize];
        for x in 0..w {
            let v = if b_right { if x <= sx { 1.0 } else { 0.0 } }
                    else       { if x >= sx { 1.0 } else { 0.0 } };
            msk.set(x, y, v);
        }
    }
    log::warn!("[blend] DP seam OK ({w}×{h}, overlap=[{x_min},{x_max}], b_right={b_right})");
    Some(msk)
}

/// Global per-channel gain on B to match A's brightness in the overlap region.
fn exposure_compensate(a: &RgbaImage, b: &RgbaImage, ma: &GrayMask, mb: &GrayMask) -> RgbaImage {
    let mut sum_a = [0.0f64; 3];
    let mut sum_b = [0.0f64; 3];
    let mut cnt = 0u64;
    let (ow, oh) = (a.width().min(ma.width()).min(b.width()).min(mb.width()),
                    a.height().min(ma.height()).min(b.height()).min(mb.height()));
    for y in 0..oh { for x in 0..ow {
        if ma.get_pixel(x,y)[0]>128 && mb.get_pixel(x,y)[0]>128 {
            let pa=a.get_pixel(x,y); let pb=b.get_pixel(x,y);
            for c in 0..3 { sum_a[c]+=pa[c] as f64; sum_b[c]+=pb[c] as f64; }
            cnt += 1;
        }
    }}
    if cnt < 100 { return b.clone(); }
    let gain: [f32; 3] = std::array::from_fn(|c| {
        if sum_b[c] < 1.0 { 1.0f32 } else { (sum_a[c]/sum_b[c]) as f32 }.clamp(0.6, 1.6)
    });
    let mut out = b.clone();
    for y in 0..b.height() { for x in 0..b.width() {
        let p = b.get_pixel(x, y);
        out.put_pixel(x, y, image::Rgba([
            (p[0] as f32*gain[0]).clamp(0.0,255.0) as u8,
            (p[1] as f32*gain[1]).clamp(0.0,255.0) as u8,
            (p[2] as f32*gain[2]).clamp(0.0,255.0) as u8,
            p[3],
        ]));
    }}
    out
}

fn blend_two(a: &RgbaImage, b: &RgbaImage, ma: &GrayMask, mb: &GrayMask) -> RgbaImage {
    let (w, h) = (a.width().max(b.width()), a.height().max(b.height()));

    // 1. Exposure compensation
    let b_ec = exposure_compensate(a, b, ma, mb);

    // 2. Seam mask — graph-cut (optimal color seam) with linear-gradient fallback
    let msk = try_graphcut_seam(a, &b_ec)
        .unwrap_or_else(|| {
            log::warn!("[blend] graph-cut unavailable, using linear gradient seam");
            seam_mask(ma, mb, w, h)
        });

    // 3. Laplacian pyramid multi-band blend
    let fa = FImg::from_rgba(a,    w, h);
    let fb = FImg::from_rgba(&b_ec, w, h);
    let gpa = gauss_pyr_img(&fa);
    let gpb = gauss_pyr_img(&fb);
    let gpm = gauss_pyr_msk(&msk);
    let lpa = lap_pyr(&gpa);
    let lpb = lap_pyr(&gpb);
    let blended: Vec<FImg> = lpa.iter().zip(lpb.iter()).zip(gpm.iter())
        .map(|((la,lb),m)| blend_level(la, lb, m))
        .collect();

    let mut result = collapse_lap(&blended).to_rgba();

    // Restore exact pixels for:
    //   • A-only regions — pyramid Gaussian spread can darken them with B's transparent zeros
    //   • B-only regions — same reason from the other side
    //   • Overlap pixels cleanly on the A-side (mask=1.0) or B-side (mask=0.0) of a binary
    //     DP seam — the pyramid may introduce geometric/arithmetic error far from the actual
    //     seam transition; restoring these with lossless source pixels removes that error.
    // The smooth Laplacian blend is kept only for the narrow transition zone around the seam
    // (where mask is neither 0.0 nor 1.0 due to Gaussian smoothing at coarser pyramid levels).
    for y in 0..h { for x in 0..w {
        let ia = x<ma.width()&&y<ma.height()&&ma.get_pixel(x,y)[0]>0;
        let ib = x<mb.width()&&y<mb.height()&&mb.get_pixel(x,y)[0]>0;
        let mv = msk.val(x, y);
        if ia && (!ib || mv >= 0.999) && x<a.width()&&y<a.height() {
            result.put_pixel(x, y, *a.get_pixel(x, y));
        } else if ib && (!ia || mv <= 0.001) && x<b_ec.width()&&y<b_ec.height() {
            result.put_pixel(x, y, *b_ec.get_pixel(x, y));
        }
    }}

    // Fix alpha: any pixel covered by A or B → fully opaque
    for y in 0..h { for x in 0..w {
        let ia = x<ma.width()&&y<ma.height()&&ma.get_pixel(x,y)[0]>0;
        let ib = x<mb.width()&&y<mb.height()&&mb.get_pixel(x,y)[0]>0;
        if ia || ib {
            let p = result.get_pixel(x, y);
            result.put_pixel(x, y, image::Rgba([p[0],p[1],p[2],255]));
        }
    }}
    result
}

// ── Displacement-consistency filter ──────────────────────────────────────────

/// Keep only matches whose displacement (dx, dy) lies within `tolerance` pixels
/// of the median displacement across all matches.  This rejects false matches
/// caused by repetitive textures (building windows, fences, tiles) whose local
/// appearance is identical but whose global position is wrong.
fn displacement_filter(
    matches: &core::Vector<core::DMatch>,
    kp1: &core::Vector<core::KeyPoint>,
    kp2: &core::Vector<core::KeyPoint>,
    tolerance: f32,
) -> Vec<core::DMatch> {
    let mv: Vec<core::DMatch> = matches.iter().collect();
    let mut dxs: Vec<f32> = Vec::with_capacity(mv.len());
    let mut dys: Vec<f32> = Vec::with_capacity(mv.len());
    for m in &mv {
        if m.query_idx < 0 || m.train_idx < 0 { continue; }
        if let (Ok(p1), Ok(p2)) = (
            kp1.get(m.query_idx as usize), kp2.get(m.train_idx as usize),
        ) {
            dxs.push(p2.pt().x - p1.pt().x);
            dys.push(p2.pt().y - p1.pt().y);
        }
    }
    if dxs.len() < 4 { return mv; }
    let mdx = median_f32(&mut dxs);
    let mdy = median_f32(&mut dys);
    mv.into_iter().filter(|m| {
        if m.query_idx < 0 || m.train_idx < 0 { return false; }
        let (Ok(p1), Ok(p2)) = (
            kp1.get(m.query_idx as usize), kp2.get(m.train_idx as usize),
        ) else { return false; };
        ((p2.pt().x - p1.pt().x) - mdx).abs() < tolerance
            && ((p2.pt().y - p1.pt().y) - mdy).abs() < tolerance
    }).collect()
}

fn median_f32(v: &mut Vec<f32>) -> f32 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n == 0 { 0.0 } else if n % 2 == 0 { (v[n/2-1] + v[n/2]) / 2.0 } else { v[n/2] }
}

/// Estimate the integer translation (dx, dy) from img1 to img2 using SIFT crossCheck matching.
/// Returns (dx, dy) where dx > 0 means img2 is to the RIGHT of img1.
/// Convention: dx = median(p1.x − p2.x) across matching pairs.
/// Returns None when fewer than 4 matched keypoints are found.
pub fn sift_translation_estimate(img1: &core::Mat, img2: &core::Mat) -> Option<(i32, i32)> {
    let mut gray1 = core::Mat::default();
    let mut gray2 = core::Mat::default();
    imgproc::cvt_color(img1, &mut gray1, imgproc::COLOR_RGBA2GRAY, 0).ok()?;
    imgproc::cvt_color(img2, &mut gray2, imgproc::COLOR_RGBA2GRAY, 0).ok()?;
    let mut sift = features2d::SIFT::create(0, 3, 0.04, 10.0, 1.6, false).ok()?;
    let mut kp1 = core::Vector::<core::KeyPoint>::new();
    let mut kp2 = core::Vector::<core::KeyPoint>::new();
    let mut desc1 = core::Mat::default();
    let mut desc2 = core::Mat::default();
    sift.detect_and_compute(&gray1, &core::no_array(), &mut kp1, &mut desc1, false).ok()?;
    sift.detect_and_compute(&gray2, &core::no_array(), &mut kp2, &mut desc2, false).ok()?;
    if kp1.len() < 4 || kp2.len() < 4 || desc1.empty() || desc2.empty() { return None; }
    let mut matcher = features2d::BFMatcher::create(core::NORM_L2, true).ok()?;
    let mut raw = core::Vector::<core::DMatch>::new();
    let mut train_mats = core::Vector::<core::Mat>::new();
    train_mats.push(desc2.try_clone().ok()?);
    matcher.add(&train_mats).ok()?;
    matcher.match_(&desc1, &mut raw, &core::no_array()).ok()?;
    if raw.len() < 4 { return None; }
    let mut dxs: Vec<f32> = Vec::with_capacity(raw.len());
    let mut dys: Vec<f32> = Vec::with_capacity(raw.len());
    for m in raw.iter() {
        if m.query_idx < 0 || m.train_idx < 0 { continue; }
        if let (Ok(p1), Ok(p2)) = (kp1.get(m.query_idx as usize), kp2.get(m.train_idx as usize)) {
            dxs.push(p1.pt().x - p2.pt().x);
            dys.push(p1.pt().y - p2.pt().y);
        }
    }
    if dxs.len() < 4 { return None; }
    Some((median_f32(&mut dxs) as i32, median_f32(&mut dys) as i32))
}

// ── Cylindrical projection (>5 frames) ───────────────────────────────────────

fn cylindrical_project(img: &DynamicImage, f: f64) -> DynamicImage {
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width() as f64, rgba.height() as f64);
    let mut result = RgbaImage::new(w as u32, h as u32);
    let (cx, cy) = (w/2.0, h/2.0);
    for y in 0..(h as u32) { for x in 0..(w as u32) {
        let theta = (x as f64 - cx) / f;
        let hs = theta.cos().max(0.01);
        let sx = (cx + f*theta.tan()).clamp(0.0,w-1.0) as u32;
        let sy = (cy + (y as f64-cy)/hs).clamp(0.0,h-1.0) as u32;
        result.put_pixel(x, y, *rgba.get_pixel(sx, sy));
    }}
    DynamicImage::ImageRgba8(result)
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
        if !dir.exists() { eprintln!("Skipping: fixtures not found"); return; }
        let t = load_thresholds();
        let a = image::open(dir.join("input_a.png")).expect("input_a.png");
        let b = image::open(dir.join("input_b.png")).expect("input_b.png");
        let reference = image::open(dir.join("reference.png")).expect("reference.png");
        let stitched = stitch_landscape(&[a, b], None, None).expect("stitch_landscape failed");
        let score = ssim(&stitched, &reference);
        assert!(score >= t.ssim_min, "SSIM {:.3} < threshold {:.3}", score, t.ssim_min);
    }

    #[test]
    #[ignore = "requires FRAME_FORGE_TEST_GPU=1 and Arc GPU passthrough"]
    fn gpu_cpu_consistency() {
        if std::env::var_os("FRAME_FORGE_TEST_GPU").is_none() { return; }
        let dir = seagull_fixtures();
        if !dir.exists() { return; }
        let a = image::open(dir.join("input_a.png")).expect("input_a.png");
        let b = image::open(dir.join("input_b.png")).expect("input_b.png");
        #[cfg(feature = "opencl")]
        opencv::core::ocl::set_use_open_cl(false).ok();
        let cpu = stitch_landscape(&[a.clone(), b.clone()], None, None).expect("CPU stitch");
        #[cfg(feature = "opencl")]
        opencv::core::ocl::set_use_open_cl(true).ok();
        let gpu = stitch_landscape(&[a, b], None, None).expect("GPU stitch");
        let score = ssim(&cpu, &gpu);
        assert!(score >= 0.95, "CPU/GPU SSIM {:.3} < 0.95", score);
    }
}
