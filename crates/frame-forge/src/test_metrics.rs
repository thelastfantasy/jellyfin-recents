// Shared quality metrics used across stitch unit tests.
// Only compiled in test builds.

use image::DynamicImage;
use std::path::PathBuf;

pub struct Thresholds {
    pub ssim_min: f32,
    pub seam_grad_max: f32,
    pub color_de_max: f32,
    pub ransac_inlier_min: f32,
    pub rmse_max: f32,
}

/// Loads the "proxy" threshold set — all three Rust unit tests that call this
/// (landscape/seagull, liveaction, anime) compare a stitch against a reference that is
/// itself (or close to) one of the inputs, not a true ground-truth panorama, matching
/// score.py's `proxy` mode (see thresholds.json: `{"gt": {...}, "proxy": {...}}`).
pub fn load_thresholds() -> Thresholds {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/stitch-eval/thresholds.json");
    let s = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("thresholds.json not found at {:?}", path));
    let v: serde_json::Value = serde_json::from_str(&s).expect("invalid thresholds.json");
    let v = &v["proxy"];
    Thresholds {
        ssim_min:          v["ssim_min"].as_f64().unwrap() as f32,
        seam_grad_max:     v["seam_grad_max"].as_f64().unwrap() as f32,
        color_de_max:      v["color_de_max"].as_f64().unwrap() as f32,
        ransac_inlier_min: v["ransac_inlier_min"].as_f64().unwrap() as f32,
        rmse_max:          v["rmse_max"].as_f64().unwrap() as f32,
    }
}

pub fn fixtures_scene_a() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/stitch-eval/fixtures/scene_a")
}

/// SSIM based on global luminance mean/variance/covariance (simplified, single-window).
pub fn ssim(img_a: &DynamicImage, img_b: &DynamicImage) -> f32 {
    let a = img_a.to_luma8();
    let b = img_b.to_luma8();
    let (w, h) = (a.width().min(b.width()), a.height().min(b.height()));
    let n = (w * h) as f64;

    let (mut sa, mut sb, mut saa, mut sbb, mut sab) =
        (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for y in 0..h {
        for x in 0..w {
            let va = a.get_pixel(x, y)[0] as f64;
            let vb = b.get_pixel(x, y)[0] as f64;
            sa += va; sb += vb;
            saa += va * va; sbb += vb * vb; sab += va * vb;
        }
    }
    let mu_a = sa / n;
    let mu_b = sb / n;
    let var_a  = saa / n - mu_a * mu_a;
    let var_b  = sbb / n - mu_b * mu_b;
    let cov_ab = sab / n - mu_a * mu_b;

    let c1 = (0.01 * 255.0f64).powi(2);
    let c2 = (0.03 * 255.0f64).powi(2);
    let num = (2.0 * mu_a * mu_b + c1) * (2.0 * cov_ab + c2);
    let den = (mu_a * mu_a + mu_b * mu_b + c1) * (var_a + var_b + c2);
    (num / den) as f32
}

/// Mean absolute gradient-magnitude difference across a vertical seam (±5px window).
pub fn seam_grad_jump(stitched: &DynamicImage, seam_x: u32) -> f32 {
    let g = stitched.to_luma8();
    let (w, h) = g.dimensions();
    let margin = 5u32;

    let grad = |x: u32, y: u32| -> f64 {
        if x == 0 || x + 1 >= w || y == 0 || y + 1 >= h { return 0.0; }
        let gx = g.get_pixel(x + 1, y)[0] as f64 - g.get_pixel(x - 1, y)[0] as f64;
        let gy = g.get_pixel(x, y + 1)[0] as f64 - g.get_pixel(x, y - 1)[0] as f64;
        (gx * gx + gy * gy).sqrt()
    };

    let (mut left, mut right, mut n) = (0.0f64, 0.0f64, 0u64);
    for y in 0..h {
        for d in 1..=margin {
            if seam_x >= d      { left  += grad(seam_x - d, y); n += 1; }
            if seam_x + d < w   { right += grad(seam_x + d, y); }
        }
    }
    if n == 0 { return 0.0; }
    ((right - left).abs() / n as f64) as f32
}

/// Mean ΔE (CIE76) color difference, sRGB → L*a*b*.
pub fn color_de_mean(img_a: &DynamicImage, img_b: &DynamicImage) -> f32 {
    let a = img_a.to_rgb8();
    let b = img_b.to_rgb8();
    let (w, h) = (a.width().min(b.width()), a.height().min(b.height()));

    let to_lab = |r: u8, g: u8, b: u8| -> (f64, f64, f64) {
        let lin = |c: u8| -> f64 {
            let v = c as f64 / 255.0;
            if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
        };
        let (rl, gl, bl) = (lin(r), lin(g), lin(b));
        let x = rl * 0.4124 + gl * 0.3576 + bl * 0.1805;
        let y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
        let z = rl * 0.0193 + gl * 0.1192 + bl * 0.9505;
        let f = |t: f64| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
        let (fx, fy, fz) = (f(x / 0.9505), f(y), f(z / 1.0888));
        (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))
    };

    let mut sum = 0.0f64;
    for y in 0..h {
        for x in 0..w {
            let pa = a.get_pixel(x, y);
            let pb = b.get_pixel(x, y);
            let (l1, a1, b1) = to_lab(pa[0], pa[1], pa[2]);
            let (l2, a2, b2) = to_lab(pb[0], pb[1], pb[2]);
            let dl = l1 - l2; let da = a1 - a2; let db = b1 - b2;
            sum += (dl * dl + da * da + db * db).sqrt();
        }
    }
    (sum / (w * h) as f64) as f32
}

/// RANSAC inlier rate: inliers / total_matches.
pub fn ransac_inlier_rate(total_matches: usize, inliers: usize) -> f32 {
    if total_matches == 0 { return 0.0; }
    inliers as f32 / total_matches as f32
}

/// Reprojection RMSE: apply homography H (3×3 row-major) to src points, compare with dst.
pub fn reprojection_rmse(
    pts_src: &[(f32, f32)],
    pts_dst: &[(f32, f32)],
    h: &[f64; 9],
) -> f32 {
    if pts_src.is_empty() { return 0.0; }
    let mut sum_sq = 0.0f64;
    for (&(sx, sy), &(dx, dy)) in pts_src.iter().zip(pts_dst.iter()) {
        let (sx, sy) = (sx as f64, sy as f64);
        let w = h[6] * sx + h[7] * sy + h[8];
        let px = (h[0] * sx + h[1] * sy + h[2]) / w;
        let py = (h[3] * sx + h[4] * sy + h[5]) / w;
        let ex = px - dx as f64;
        let ey = py - dy as f64;
        sum_sq += ex * ex + ey * ey;
    }
    (sum_sq / pts_src.len() as f64).sqrt() as f32
}
