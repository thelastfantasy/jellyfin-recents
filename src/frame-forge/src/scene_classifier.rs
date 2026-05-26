use image::{DynamicImage, GrayImage, Luma};

//! Heuristic scene classifier for panorama stitching algorithm routing.
//!
//! Three signals determine the category:
//!   edge_density > 0.15 && color_entropy < 3.5 鈫?Anime (Phase Correlation)
//!   edge_density < 0.08                      鈫?Landscape (AKAZE + fallback)
//!   otherwise                                鈫?LiveAction (motion-masked AKAZE)
//!
//! # Why these thresholds
//! Anime frames have dense ink lines (high Canny edge density) but large flat
//! color regions (low histogram entropy). Landscape shots (sky, water) have
//! very few edges. Live-action has moderate edge density and high entropy
//! from skin textures, clothing patterns, etc.
//!
//! # Caveats
//! - Edge density uses Sobel magnitude > 30 threshold 鈥?may miss soft-edged anime
//! - Color entropy is computed on grayscale histogram, not RGB 鈥?faster but
//!   cannot distinguish colorful anime from desaturated live-action
//! - Motion classification only uses first two frames; long pans may start slow
//! - pHash uses 8脳8 thumbnail 鈥?collisions possible for very similar frames
#[derive(Debug, Clone, PartialEq)]
pub enum SceneCategory { Anime, Landscape, LiveAction }

#[derive(Debug, Clone)]
pub enum MotionType { Pan, Zoom, Rotation, Static }

#[derive(Debug, Clone)]
pub struct SceneClass {
    pub category: SceneCategory,
    pub motion: MotionType,
    pub direction: Direction,
    pub edge_density: f64,
    pub color_entropy: f64,
    pub motion_score: f64,
}

#[derive(Debug, Clone)]
pub enum Direction { Horizontal, Vertical }

/// Classify scene from a sequence of frames using heuristic rules.
pub fn classify(frames: &[DynamicImage]) -> SceneClass {
    if frames.is_empty() {
        return SceneClass {
            category: SceneCategory::Landscape,
            motion: MotionType::Static,
            direction: Direction::Horizontal,
            edge_density: 0.0,
            color_entropy: 0.0,
            motion_score: 0.0,
        };
    }

    let first = &frames[0];
    let edge_density = compute_edge_density(first);
    let color_entropy = compute_color_entropy(first);
    let motion_score = if frames.len() >= 2 {
        compute_motion_score(&frames[0], &frames[1])
    } else {
        0.0
    };

    let category = if edge_density > 0.15 && color_entropy < 3.5 {
        SceneCategory::Anime
    } else if edge_density < 0.08 {
        SceneCategory::Landscape
    } else {
        SceneCategory::LiveAction
    };

    let motion = classify_motion(motion_score);
    let direction = detect_direction(first);

    SceneClass { category, motion, direction, edge_density, color_entropy, motion_score }
}

fn compute_edge_density(img: &DynamicImage) -> f64 {
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();
    let gx = imageproc::filter::sobel_gx(&gray);
    let gy = imageproc::filter::sobel_gy(&gray);

    let mut edge_count = 0u64;
    let total = (w * h) as u64;
    for y in 0..h {
        for x in 0..w {
            let gx_v = gx.get_pixel(x, y)[0] as i16;
            let gy_v = gy.get_pixel(x, y)[0] as i16;
            let mag = ((gx_v * gx_v + gy_v * gy_v) as f64).sqrt();
            if mag > 30.0 { edge_count += 1; }
        }
    }
    edge_count as f64 / total as f64
}

fn compute_color_entropy(img: &DynamicImage) -> f64 {
    let gray = img.to_luma8();
    let mut hist = [0u32; 256];
    for p in gray.pixels() {
        hist[p[0] as usize] += 1;
    }
    let total = (gray.width() * gray.height()) as f64;
    let mut entropy = 0.0;
    for &count in &hist {
        if count > 0 {
            let p = count as f64 / total;
            entropy -= p * p.log2();
        }
    }
    entropy
}

fn compute_motion_score(a: &DynamicImage, b: &DynamicImage) -> f64 {
    let ga = a.to_luma8();
    let gb = b.to_luma8();
    let (w, h) = ga.dimensions();
    let mut diff_sum = 0u64;
    for y in 0..h.min(gb.height()) {
        for x in 0..w.min(gb.width()) {
            let da = ga.get_pixel(x, y)[0] as i16;
            let db = gb.get_pixel(x, y)[0] as i16;
            diff_sum += (da - db).unsigned_abs() as u64;
        }
    }
    let total = (w.min(gb.width()) * h.min(gb.height())) as f64;
    diff_sum as f64 / (total * 255.0)
}

fn classify_motion(score: f64) -> MotionType {
    if score < 0.02 { MotionType::Static }
    else if score < 0.10 { MotionType::Pan }
    else if score < 0.25 { MotionType::Rotation }
    else { MotionType::Zoom }
}

fn detect_direction(img: &DynamicImage) -> Direction {
    if img.width() < img.height() { Direction::Vertical } else { Direction::Horizontal }
}

/// Compute perceptual hash (pHash) for near-duplicate detection.
pub fn phash(img: &DynamicImage) -> u64 {
    let thumb = img.resize_exact(8, 8, image::imageops::FilterType::Lanczos3).to_luma8();
    let mut pixels = [0f64; 64];
    let mut sum = 0.0;
    for (i, p) in thumb.pixels().enumerate() {
        pixels[i] = p[0] as f64;
        sum += pixels[i];
    }
    let avg = sum / 64.0;
    let mut hash = 0u64;
    for (i, &p) in pixels.iter().enumerate() {
        if p > avg { hash |= 1 << i; }
    }
    hash
}

/// Hamming distance between two pHash values.
pub fn phash_dist(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}
