// Frame quality metadata computed from a decoded image.
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

    // Laplacian variance (blur detection) 鈥?simplified 3x3 kernel
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

/// Border crop: scans 25% of each edge inward. A column/row is considered
/// "border" when its pixel variance is below `threshold` (default 5.0).
/// Stops at the first column/row exceeding threshold. Safety: always keeps
/// at least 80% of original width and height.
///
/// This handles player chrome, letterboxing, and static UI elements that
/// would otherwise create misaligned stitch seams.
pub fn detect_border_crop(img: &image::DynamicImage, threshold: f64) -> (u32, u32, u32, u32) {
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();
    let mut left = 0u32;
    let mut right = w - 1;
    let mut top = 0u32;
    let mut bottom = h - 1;

    // Scan from left
    for x in 0..(w / 4) {
        if column_variance(&gray, x, h) > threshold { left = x; break; }
    }
    // Scan from right
    for x in (0..(w / 4)).rev() {
        let rx = w - 1 - x;
        if column_variance(&gray, rx, h) > threshold { right = rx; break; }
    }
    // Scan from top
    for y in 0..(h / 4) {
        if row_variance(&gray, y, w) > threshold { top = y; break; }
    }
    // Scan from bottom
    for y in (0..(h / 4)).rev() {
        let by = h - 1 - y;
        if row_variance(&gray, by, w) > threshold { bottom = by; break; }
    }

    // Ensure at least 80% of image remains
    let crop_w = right.saturating_sub(left).max(w * 8 / 10);
    let crop_h = bottom.saturating_sub(top).max(h * 8 / 10);

    // Re-center if we cropped too much
    let right = (left + crop_w).min(w - 1);
    let bottom = (top + crop_h).min(h - 1);

    (left, top, right, bottom)
}

/// Crop an image to the given rectangle.
pub fn crop_image(img: &image::DynamicImage, rect: (u32, u32, u32, u32)) -> image::DynamicImage {
    let (left, top, right, bottom) = rect;
    let w = right.saturating_sub(left).max(1);
    let h = bottom.saturating_sub(top).max(1);
    img.crop_imm(left, top, w, h)
}

fn column_variance(gray: &image::GrayImage, x: u32, height: u32) -> f64 {
    let mut sum = 0f64;
    for y in 0..height {
        sum += gray.get_pixel(x, y)[0] as f64;
    }
    let mean = sum / height as f64;
    let mut var = 0f64;
    for y in 0..height {
        let diff = gray.get_pixel(x, y)[0] as f64 - mean;
        var += diff * diff;
    }
    var / height as f64
}

fn row_variance(gray: &image::GrayImage, y: u32, width: u32) -> f64 {
    let mut sum = 0f64;
    for x in 0..width {
        sum += gray.get_pixel(x, y)[0] as f64;
    }
    let mean = sum / width as f64;
    let mut var = 0f64;
    for x in 0..width {
        let diff = gray.get_pixel(x, y)[0] as f64 - mean;
        var += diff * diff;
    }
    var / width as f64
}

fn compute_frame_diff(a: &image::GrayImage, b: &image::GrayImage) -> f64 {
    let (aw, ah) = a.dimensions();
    let (bw, bh) = b.dimensions();
    if aw != bw || ah != bh {
        return 1.0; // different sizes 鈫?treat as scene cut
    }
    let mut diff_sum = 0u64;
    let total = (aw * ah) as f64;
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        let d = (pa[0] as i16 - pb[0] as i16).unsigned_abs() as u64;
        diff_sum += d;
    }
    diff_sum as f64 / (total * 255.0)
}
