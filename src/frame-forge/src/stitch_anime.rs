// Phase Correlation based panorama stitching for anime/line-art content.
//!
//! Unlike feature-based methods (ORB/SIFT/AKAZE), Phase Correlation works in
//! the frequency domain via FFT and does not require texture keypoints. This
//! makes it uniquely effective for anime scenes dominated by flat color regions
//! and sharp ink lines.
//!
//! # Algorithm (per frame pair)
//! 1. Grayscale + Hamming window (suppress FFT boundary artifacts)
//! 2. Forward 2D FFT on both images
//! 3. Normalized cross-power spectrum: R = F1路conj(F2) / |F1路conj(F2)|
//! 4. Inverse FFT 鈫?correlation surface
//! 5. Peak detection with parabola sub-pixel refinement (卤0.1px)
//! 6. Wrapped-to-real offset conversion
//!
//! # Caveats
//! - Only handles translation; rotation or scale changes cause misalignment
//! - Effective for panning camera shots; fails on zoom/rotation shots
//! - Hamming window reduces effective resolution at frame edges
//! - FFT size must be power of 2 for optimal performance (rustfft handles
//!   non-power-of-2 sizes via Bluestein's algorithm, slower)

use image::DynamicImage;
use rustfft::{FftPlanner, num_complex::Complex};

/// Phase Correlation based image alignment for anime/line-art scenes.
/// Returns (dx, dy) pixel offset from image B relative to image A.
pub fn phase_correlate(a: &DynamicImage, b: &DynamicImage) -> (i32, i32) {
    let ga = a.to_luma8();
    let gb = b.to_luma8();
    let (w, h) = ga.dimensions();
    let w = w as usize;
    let h = h as usize;

    // Convert to float with Hamming window
    let ham_a = apply_hamming(&ga);
    let ham_b = apply_hamming(&gb);

    // Forward FFT
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward((w * h));
    let inv = planner.plan_fft_inverse((w * h));

    let mut fa: Vec<Complex<f64>> = ham_a.iter().map(|&v| Complex { re: v, im: 0.0 }).collect();
    let mut fb: Vec<Complex<f64>> = ham_b.iter().map(|&v| Complex { re: v, im: 0.0 }).collect();

    fft.process(&mut fa);
    fft.process(&mut fb);

    // Normalized cross-power spectrum: R = F1 路 conj(F2) / |F1 路 conj(F2)|
    let mut r = vec![Complex { re: 0.0, im: 0.0 }; w * h];
    let mut max_mag = 0.0f64;
    for i in 0..(w * h) {
        let num = fa[i] * fb[i].conj();
        let mag = num.norm();
        r[i] = if mag > 1e-10 { num / mag } else { Complex { re: 0.0, im: 0.0 } };
        if mag > max_mag { max_mag = mag; }
    }

    // Inverse FFT to get correlation surface
    inv.process(&mut r);
    for v in r.iter_mut() {
        *v = Complex { re: v.re / (w * h) as f64, im: v.im / (w * h) as f64 };
    }

    // Find peak with sub-pixel refinement via parabola interpolation
    let mut max_val = 0.0f64;
    let mut peak_x = 0i32;
    let mut peak_y = 0i32;
    for y in 0..h {
        for x in 0..w {
            let v = r[y * w + x].re;
            if v > max_val {
                max_val = v;
                peak_x = x as i32;
                peak_y = y as i32;
            }
        }
    }

    // Sub-pixel refinement: fit 1D parabola to peak + neighbors
    let sub_x = parabola_refine(
        r[(peak_y as usize * w + ((peak_x - 1 + w as i32) as usize % w))].re,
        max_val,
        r[(peak_y as usize * w + ((peak_x + 1) as usize % w))].re,
    );
    let sub_y = parabola_refine(
        r[(((peak_y - 1 + h as i32) as usize % h) * w + peak_x as usize)].re,
        max_val,
        r[(((peak_y + 1) as usize % h) * w + peak_x as usize)].re,
    );

    let dx_f = peak_x as f64 + sub_x;
    let dy_f = peak_y as f64 + sub_y;

    // Convert wrapped offset to real offset (sub-pixel)
    let half_w = w as f64 / 2.0;
    let half_h = h as f64 / 2.0;
    let dx = if dx_f > half_w { dx_f - w as f64 } else { dx_f };
    let dy = if dy_f > half_h { dy_f - h as f64 } else { dy_f };

    (dx.round() as i32, dy.round() as i32)
}

/// Parabolic interpolation for sub-pixel refinement.
/// Given values at x-1, x, x+1, returns the sub-pixel offset from the peak.
fn parabola_refine(left: f64, center: f64, right: f64) -> f64 {
    let denom = 2.0 * (2.0 * center - left - right);
    if denom.abs() < 1e-10 { return 0.0; }
    (right - left) / denom
}

fn apply_hamming(gray: &image::GrayImage) -> Vec<f64> {
    let (w, h) = gray.dimensions();
    let w = w as usize;
    let h = h as usize;
    let mut result = vec![0.0; w * h];
    for y in 0..h {
        for x in 0..w {
            let p = gray.get_pixel(x as u32, y as u32)[0] as f64 / 255.0;
            let wx = 0.54 - 0.46 * (2.0 * std::f64::consts::PI * x as f64 / (w as f64 - 1.0)).cos();
            let wy = 0.54 - 0.46 * (2.0 * std::f64::consts::PI * y as f64 / (h as f64 - 1.0)).cos();
            result[y * w + x] = p * wx * wy;
        }
    }
    result
}

/// Stitch frames using Phase Correlation.
/// Accumulates offsets relative to the first frame and stitches side-by-side.
pub fn stitch_anime(frames: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    if frames.len() < 2 {
        anyhow::bail!("need at least 2 frames");
    }

    let first = &frames[0];
    let (fw, fh) = (first.width() as i32, first.height() as i32);

    // Accumulate absolute offsets relative to first frame
    let mut offsets: Vec<(i32, i32)> = vec![(0, 0)];
    for i in 1..frames.len() {
        let (dx, dy) = phase_correlate(&frames[i - 1], &frames[i]);
        let prev = offsets[i - 1];
        offsets.push((prev.0 + dx, prev.1 + dy));
    }

    // Compute canvas size
    let min_x = offsets.iter().map(|o| o.0).min().unwrap_or(0);
    let max_x = offsets.iter().map(|o| o.0 + fw).max().unwrap_or(fw);
    let min_y = offsets.iter().map(|o| o.1).min().unwrap_or(0);
    let max_y = offsets.iter().map(|o| o.1 + fh).max().unwrap_or(fh);

    let canvas_w = (max_x - min_x) as u32;
    let canvas_h = (max_y - min_y) as u32;

    let mut canvas = image::RgbaImage::from_pixel(canvas_w, canvas_h, image::Rgba([0, 0, 0, 0]));

    for (i, frame) in frames.iter().enumerate() {
        let (ox, oy) = offsets[i];
        let dst_x = (ox - min_x) as u32;
        let dst_y = (oy - min_y) as u32;
        image::imageops::overlay(&mut canvas, &frame.to_rgba8(), dst_x as i64, dst_y as i64);
    }

    Ok(DynamicImage::ImageRgba8(canvas))
}
