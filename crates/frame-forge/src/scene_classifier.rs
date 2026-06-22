use image::DynamicImage;

/// Scene classification result.
#[derive(Debug, Clone, PartialEq)]
pub enum SceneCategory { Anime, Landscape, LiveAction }

#[derive(Debug, Clone)]
pub enum MotionType { Pan, Zoom, Rotation, Static }

#[derive(Debug, Clone)]
pub struct SceneClass {
    pub category: SceneCategory,
    pub motion: MotionType,
    pub edge_density: f64,
    pub color_entropy: f64,
    pub flat_region_ratio: f64,
}

/// Classify scene from a sequence of frames using heuristic rules.
pub fn classify(frames: &[DynamicImage]) -> SceneClass {
    if frames.is_empty() {
        return SceneClass {
            category: SceneCategory::Landscape,
            motion: MotionType::Static,
            edge_density: 0.0,
            color_entropy: 0.0,
            flat_region_ratio: 0.0,
        };
    }

    let first = &frames[0];
    let edge_density = compute_edge_density(first);
    let color_entropy = compute_color_entropy(first);
    let flat_region_ratio = compute_flat_region_ratio(first);
    let motion_score = if frames.len() >= 2 {
        compute_motion_score(&frames[0], &frames[1])
    } else {
        0.0
    };

    // flat_region_ratio replaces the old `edge_density > 0.15 && color_entropy < 3.5` gate —
    // that combination targets flat cel-shaded line art specifically and misses anime with
    // detailed/gradient shading or painted backgrounds (observed in production: a real anime
    // frame measured edge=0.112, entropy=5.9, both outside those bounds, and got routed into the
    // OpenCV-Stitcher-heavy Landscape path instead of the much lighter stitch_anime). Cel-shading's
    // actual defining visual trait is large areas of perfectly uniform fill color bounded by hard
    // edges — color_entropy (a histogram-spread measure) only approximates that indirectly and
    // conflates "uses many colors" with "uses gradients/texture", which a richly-colored but still
    // flat-filled anime style defeats. flat_region_ratio measures the trait directly: the fraction
    // of pixels whose 3×3 neighborhood varies by less than a small tolerance — true photographic
    // content keeps some sensor/material micro-texture even in "flat-looking" areas (sky, walls),
    // while cel-shaded fills are exactly uniform. No labeled corpus was available to fit this
    // threshold precisely; 0.35 is a deliberately conservative pick (anime fills are typically
    // well above it, real photos well below) to avoid misrouting real landscape content.
    let category = if flat_region_ratio > 0.35 {
        SceneCategory::Anime
    } else if edge_density < 0.08 {
        SceneCategory::Landscape
    } else if frames.len() >= 2 {
        // For high-edge scenes, use phase correlation coherence to distinguish
        // panoramic panning (globally coherent shift) from live-action (chaotic motion).
        // Down-sample to 128×128 for speed; phase_correlate handles arbitrary sizes.
        let a = frames[0].resize(128, 128, image::imageops::FilterType::Triangle);
        let b = frames[1].resize(128, 128, image::imageops::FilterType::Triangle);
        let (_, _, pc_quality) = crate::stitch_anime::phase_correlate(&a, &b);
        log::warn!("[classify] edge={edge_density:.3} entropy={color_entropy:.1} flat={flat_region_ratio:.3} \
            motion={motion_score:.3} pc_quality={pc_quality:.4}");
        // High pc_quality → one dominant translation peak → panoramic panning → Landscape.
        // Low pc_quality → diffuse / multi-modal motion → LiveAction.
        if pc_quality > 0.04 {
            SceneCategory::Landscape
        } else {
            SceneCategory::LiveAction
        }
    } else {
        SceneCategory::LiveAction
    };

    let motion = classify_motion(motion_score);

    SceneClass { category, motion, edge_density, color_entropy, flat_region_ratio }
}

/// Fraction of pixels whose 3×3 grayscale neighborhood varies by at most `FLAT_TOLERANCE` —
/// the defining visual trait of cel-shaded/flat-fill art (large uniform-color regions bounded by
/// hard edges). Real photographic content keeps some sensor/material micro-texture even in areas
/// that look flat to the eye (sky, walls), so this stays low for photos/live-action even when
/// they contain large smooth gradients. Tolerance is small enough to reject genuine photographic
/// texture but large enough to absorb video-codec quantization/banding noise in otherwise-flat
/// anime fills.
const FLAT_TOLERANCE: u8 = 6;

fn compute_flat_region_ratio(img: &DynamicImage) -> f64 {
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();
    let w = w as i32;
    let h = h as i32;
    if w < 3 || h < 3 { return 0.0; }

    let mut flat_count = 0u64;
    let total = ((w - 2) as u64) * ((h - 2) as u64);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let mut min_v = 255u8;
            let mut max_v = 0u8;
            for ky in -1i32..=1 {
                for kx in -1i32..=1 {
                    let v = gray.get_pixel((x + kx) as u32, (y + ky) as u32)[0];
                    if v < min_v { min_v = v; }
                    if v > max_v { max_v = v; }
                }
            }
            if max_v - min_v <= FLAT_TOLERANCE {
                flat_count += 1;
            }
        }
    }
    flat_count as f64 / total as f64
}

fn compute_edge_density(img: &DynamicImage) -> f64 {
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();
    let w = w as i32;
    let h = h as i32;
    let sobel_x: [[i16; 3]; 3] = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
    let sobel_y: [[i16; 3]; 3] = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];

    let mut edge_count = 0u64;
    let total = (w as u64) * (h as u64);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let mut gx_v = 0i16;
            let mut gy_v = 0i16;
            for ky in 0..3 {
                for kx in 0..3 {
                    let px = gray.get_pixel((x + kx - 1) as u32, (y + ky - 1) as u32)[0] as i16;
                    gx_v += px * sobel_x[ky as usize][kx as usize];
                    gy_v += px * sobel_y[ky as usize][kx as usize];
                }
            }
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
