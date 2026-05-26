// Phase Correlation based panorama stitching for anime/line-art content.
use image::DynamicImage;
use rustfft::{FftPlanner, num_complex::Complex};

/// Phase Correlation based image alignment for anime/line-art scenes.
/// Returns (dx, dy) pixel offset from image B relative to image A.
/// Uses 2D FFT via row-column decomposition.
pub fn phase_correlate(a: &DynamicImage, b: &DynamicImage) -> (i32, i32) {
    let ga = a.to_luma8();
    let gb = b.to_luma8();
    let (w, h) = ga.dimensions();
    let w = w as usize;
    let h = h as usize;

    let ham_a = apply_hamming(&ga);
    let ham_b = apply_hamming(&gb);

    let mut fa: Vec<Complex<f64>> = ham_a.iter().map(|&v| Complex { re: v, im: 0.0 }).collect();
    let mut fb: Vec<Complex<f64>> = ham_b.iter().map(|&v| Complex { re: v, im: 0.0 }).collect();

    fft2d(&mut fa, w, h);
    fft2d(&mut fb, w, h);

    // Normalized cross-power spectrum
    let mut r = vec![Complex { re: 0.0, im: 0.0 }; w * h];
    for i in 0..(w * h) {
        let num = fa[i] * fb[i].conj();
        let mag = num.norm();
        r[i] = if mag > 1e-10 { num / mag } else { Complex { re: 0.0, im: 0.0 } };
    }

    ifft2d(&mut r, w, h);

    // Find peak
    let mut max_val = 0.0f64;
    let mut peak_x = 0i32;
    let mut peak_y = 0i32;
    for y in 0..h {
        for x in 0..w {
            let v = r[y * w + x].re;
            if v > max_val { max_val = v; peak_x = x as i32; peak_y = y as i32; }
        }
    }

    // Sub-pixel refinement via parabola fitting
    let px = peak_x as usize;
    let py = peak_y as usize;
    let left = r[py * w + ((px + w - 1) % w)].re;
    let right = r[py * w + ((px + 1) % w)].re;
    let up = r[((py + h - 1) % h) * w + px].re;
    let down = r[((py + 1) % h) * w + px].re;
    let sub_x = parabola_refine(left, max_val, right);
    let sub_y = parabola_refine(up, max_val, down);

    let dx_f = peak_x as f64 + sub_x;
    let dy_f = peak_y as f64 + sub_y;

    let half_w = w as f64 / 2.0;
    let half_h = h as f64 / 2.0;
    let dx = if dx_f > half_w { dx_f - w as f64 } else { dx_f };
    let dy = if dy_f > half_h { dy_f - h as f64 } else { dy_f };

    (dx.round() as i32, dy.round() as i32)
}

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
            let wx = 0.53836 - 0.46164 * (2.0 * std::f64::consts::PI * x as f64 / (w as f64 - 1.0)).cos();
            let wy = 0.53836 - 0.46164 * (2.0 * std::f64::consts::PI * y as f64 / (h as f64 - 1.0)).cos();
            result[y * w + x] = p * wx * wy;
        }
    }
    result
}

fn fft2d(data: &mut [Complex<f64>], w: usize, h: usize) {
    let mut planner = FftPlanner::new();
    let fft_row_plan = planner.plan_fft_forward(w);
    let fft_col_plan = planner.plan_fft_forward(h);
    let row_pad = fft_row_plan.len();
    let col_pad = fft_col_plan.len();

    // FFT each row
    let mut row_buf = vec![Complex::new(0.0, 0.0); row_pad];
    for y in 0..h {
        for (i, v) in data[y * w..(y + 1) * w].iter().enumerate() { row_buf[i] = *v; }
        for i in w..row_pad { row_buf[i] = Complex::new(0.0, 0.0); }
        fft_row_plan.process(&mut row_buf);
        for (i, v) in row_buf[..w].iter().enumerate() { data[y * w + i] = *v; }
    }
    // FFT each column
    let mut col_buf = vec![Complex::new(0.0, 0.0); col_pad];
    for x in 0..w {
        for y in 0..h { col_buf[y] = data[y * w + x]; }
        for i in h..col_pad { col_buf[i] = Complex::new(0.0, 0.0); }
        fft_col_plan.process(&mut col_buf);
        for y in 0..h { data[y * w + x] = col_buf[y]; }
    }
}

fn ifft2d(data: &mut [Complex<f64>], w: usize, h: usize) {
    let mut planner = FftPlanner::new();
    let ifft_col_plan = planner.plan_fft_inverse(h);
    let ifft_row_plan = planner.plan_fft_inverse(w);
    let col_pad = ifft_col_plan.len();
    let row_pad = ifft_row_plan.len();

    // IFFT each column
    let mut col_buf = vec![Complex::new(0.0, 0.0); col_pad];
    for x in 0..w {
        for y in 0..h { col_buf[y] = data[y * w + x]; }
        for i in h..col_pad { col_buf[i] = Complex::new(0.0, 0.0); }
        ifft_col_plan.process(&mut col_buf);
        for y in 0..h { data[y * w + x] = col_buf[y]; }
    }
    // IFFT each row
    let mut row_buf = vec![Complex::new(0.0, 0.0); row_pad];
    for y in 0..h {
        for (i, v) in data[y * w..(y + 1) * w].iter().enumerate() { row_buf[i] = *v; }
        for i in w..row_pad { row_buf[i] = Complex::new(0.0, 0.0); }
        ifft_row_plan.process(&mut row_buf);
        for (i, v) in row_buf[..w].iter().enumerate() { data[y * w + i] = *v; }
    }
    // Normalize
    let scale = 1.0 / (w * h) as f64;
    for v in data.iter_mut() { v.re *= scale; v.im *= scale; }
}

/// Stitch frames using Phase Correlation.
/// Accumulates offsets relative to the first frame and stitches side-by-side.
pub fn stitch_anime(frames: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    if frames.len() < 2 { anyhow::bail!("need at least 2 frames"); }

    let first = &frames[0];
    let (fw, fh) = (first.width() as i32, first.height() as i32);

    let mut offsets: Vec<(i32, i32)> = vec![(0, 0)];
    for i in 1..frames.len() {
        let (dx, dy) = phase_correlate(&frames[i - 1], &frames[i]);
        let prev = offsets[i - 1];
        offsets.push((prev.0 + dx, prev.1 + dy));
    }

    let min_x = offsets.iter().map(|o| o.0).min().unwrap_or(0);
    let max_x = offsets.iter().map(|o| o.0 + fw).max().unwrap_or(fw);
    let min_y = offsets.iter().map(|o| o.1).min().unwrap_or(0);
    let max_y = offsets.iter().map(|o| o.1 + fh).max().unwrap_or(fh);

    let mut canvas = image::RgbaImage::new((max_x - min_x) as u32, (max_y - min_y) as u32);

    for (i, frame) in frames.iter().enumerate() {
        let (ox, oy) = offsets[i];
        let dst_x = (ox - min_x) as i64;
        let dst_y = (oy - min_y) as i64;
        image::imageops::overlay(&mut canvas, &frame.to_rgba8(), dst_x, dst_y);
    }

    Ok(DynamicImage::ImageRgba8(canvas))
}
