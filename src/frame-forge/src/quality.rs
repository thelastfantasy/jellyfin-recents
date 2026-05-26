/// Frame quality metadata computed from a decoded image.
#[derive(Debug, Clone)]
pub struct QualityFlags {
    pub is_junk: bool,
    pub junk_reason: Option<String>,
    pub brightness_var: f64,
    pub laplacian_var: f64,
    pub frame_diff: f64,
}

impl QualityFlags {
    pub fn to_bitmask(&self) -> u16 {
        let mut mask = 0u16;
        if self.brightness_var < 5.0 { mask |= 0x01; }    // black frame
        if self.brightness_var > 250.0 { mask |= 0x02; }   // white frame
        if self.laplacian_var < 10.0 { mask |= 0x04; }     // blur frame
        mask
    }
}

/// Detect junk frames: black, white, or blurry.
/// `prev_img` is optional (for frame-diff against previous frame).
pub fn detect_quality(
    img: &image::DynamicImage,
    prev_img: Option<&image::DynamicImage>,
) -> QualityFlags {
    let gray = img.to_luma8();
    let mut total_brightness = 0f64;
    let pixel_count = (gray.width() * gray.height()) as f64;

    for p in gray.pixels() {
        total_brightness += p[0] as f64;
    }
    let mean = total_brightness / pixel_count;

    let mut brightness_var = 0f64;
    for p in gray.pixels() {
        let diff = p[0] as f64 - mean;
        brightness_var += diff * diff;
    }
    brightness_var /= pixel_count;

    // Laplacian variance (blur detection) — simplified 3x3 kernel
    let laplacian = compute_laplacian_variance(&gray);

    // Frame diff against previous frame
    let frame_diff = if let Some(prev) = prev_img {
        let prev_gray = prev.to_luma8();
        compute_frame_diff(&gray, &prev_gray)
    } else {
        0.0
    };

    let is_junk = brightness_var < 5.0
        || brightness_var > 250.0
        || laplacian < 10.0
        || frame_diff > 0.9;

    let junk_reason = if is_junk {
        Some(if brightness_var < 5.0 {
            "black_frame".to_string()
        } else if brightness_var > 250.0 {
            "white_frame".to_string()
        } else if laplacian < 10.0 {
            "blur_frame".to_string()
        } else if frame_diff > 0.9 {
            "scene_cut".to_string()
        } else {
            "unknown".to_string()
        })
    } else {
        None
    };

    QualityFlags { is_junk, junk_reason, brightness_var, laplacian_var: laplacian, frame_diff }
}

fn compute_laplacian_variance(gray: &image::GrayImage) -> f64 {
    let (w, h) = gray.dimensions();
    let w = w as usize;
    let h = h as usize;
    let kernel: [[i32; 3]; 3] = [[0, 1, 0], [1, -4, 1], [0, 1, 0]];

    let mut sum = 0f64;
    let mut count = 0u64;
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let mut val = 0i32;
            for ky in 0..3 {
                for kx in 0..3 {
                    let px = gray.get_pixel((x + kx - 1) as u32, (y + ky - 1) as u32)[0] as i32;
                    val += px * kernel[ky][kx];
                }
            }
            sum += (val as f64) * (val as f64);
            count += 1;
        }
    }
    if count == 0 { 0.0 } else { sum / count as f64 }
}

fn compute_frame_diff(a: &image::GrayImage, b: &image::GrayImage) -> f64 {
    let (aw, ah) = a.dimensions();
    let (bw, bh) = b.dimensions();
    if aw != bw || ah != bh {
        return 1.0; // different sizes → treat as scene cut
    }
    let mut diff_sum = 0u64;
    let total = (aw * ah) as f64;
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        let d = (pa[0] as i16 - pb[0] as i16).unsigned_abs() as u64;
        diff_sum += d;
    }
    diff_sum as f64 / (total * 255.0)
}
