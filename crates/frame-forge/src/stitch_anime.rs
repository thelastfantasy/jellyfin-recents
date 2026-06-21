// Phase Correlation based panorama stitching for anime/line-art content.
// Graph cut (optimal seam via DP) in overlap zones — zero blur, zero hard seams.
use image::DynamicImage;
use rustfft::{FftPlanner, num_complex::Complex};

// Empirically, real adjacent-frame motion in this app's actual usage scores 0.47-0.83
// peak-correlation quality; near-duplicate/near-static frame pairs (no real motion at all —
// the case this threshold exists to catch) score 0.01-0.025, a noise floor with zero overlap
// with the real-motion range (see production incident logs, 36-sample distribution). The
// previous value of 0.02 sat *inside* that noise floor instead of above it, so several
// noise-level pairs (q=0.0215-0.0233) were accepted as real motion purely by chance, silently
// corrupting the panorama's coordinate system for every frame after them. 0.15 sits with large
// margin on both sides of the observed gap.
const QUALITY_THRESHOLD: f64 = 0.15;

/// Returns (dx, dy, peak_quality). quality < QUALITY_THRESHOLD → scene cut.
pub fn phase_correlate(a: &DynamicImage, b: &DynamicImage) -> (i32, i32, f64) {
    let ga = a.to_luma8();
    let gb = b.to_luma8();
    // Use min of both dimensions: handles slight size differences between frames.
    let w = (ga.width().min(gb.width())) as usize;
    let h = (ga.height().min(gb.height())) as usize;

    let ham_a = apply_hamming_region(&ga, w, h);
    let ham_b = apply_hamming_region(&gb, w, h);

    let mut fa: Vec<Complex<f64>> = ham_a.iter().map(|&v| Complex { re: v, im: 0.0 }).collect();
    let mut fb: Vec<Complex<f64>> = ham_b.iter().map(|&v| Complex { re: v, im: 0.0 }).collect();

    fft2d(&mut fa, w, h);
    fft2d(&mut fb, w, h);

    let mut r = vec![Complex { re: 0.0, im: 0.0 }; w * h];
    for i in 0..(w * h) {
        let num = fa[i] * fb[i].conj();
        let mag = num.norm();
        r[i] = if mag > 1e-10 { num / mag } else { Complex { re: 0.0, im: 0.0 } };
    }

    ifft2d(&mut r, w, h);

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

    let px = peak_x as usize;
    let py = peak_y as usize;
    let left  = r[py * w + ((px + w - 1) % w)].re;
    let right = r[py * w + ((px + 1) % w)].re;
    let up    = r[((py + h - 1) % h) * w + px].re;
    let down  = r[((py + 1) % h) * w + px].re;
    let sub_x = parabola_refine(left, max_val, right);
    let sub_y = parabola_refine(up, max_val, down);

    let dx_f = peak_x as f64 + sub_x;
    let dy_f = peak_y as f64 + sub_y;
    let half_w = w as f64 / 2.0;
    let half_h = h as f64 / 2.0;
    let dx = if dx_f > half_w { dx_f - w as f64 } else { dx_f };
    let dy = if dy_f > half_h { dy_f - h as f64 } else { dy_f };

    (dx.round() as i32, dy.round() as i32, max_val)
}

fn parabola_refine(left: f64, center: f64, right: f64) -> f64 {
    let denom = 2.0 * (2.0 * center - left - right);
    if denom.abs() < 1e-10 { return 0.0; }
    (right - left) / denom
}

fn apply_hamming_region(gray: &image::GrayImage, w: usize, h: usize) -> Vec<f64> {
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
    let fft_row = planner.plan_fft_forward(w);
    let fft_col = planner.plan_fft_forward(h);
    let mut row_buf = vec![Complex::new(0.0, 0.0); fft_row.len()];
    for y in 0..h {
        for (i, v) in data[y * w..(y + 1) * w].iter().enumerate() { row_buf[i] = *v; }
        for i in w..fft_row.len() { row_buf[i] = Complex::new(0.0, 0.0); }
        fft_row.process(&mut row_buf);
        for (i, v) in row_buf[..w].iter().enumerate() { data[y * w + i] = *v; }
    }
    let mut col_buf = vec![Complex::new(0.0, 0.0); fft_col.len()];
    for x in 0..w {
        for y in 0..h { col_buf[y] = data[y * w + x]; }
        for i in h..fft_col.len() { col_buf[i] = Complex::new(0.0, 0.0); }
        fft_col.process(&mut col_buf);
        for y in 0..h { data[y * w + x] = col_buf[y]; }
    }
}

fn ifft2d(data: &mut [Complex<f64>], w: usize, h: usize) {
    let mut planner = FftPlanner::new();
    let ifft_col = planner.plan_fft_inverse(h);
    let ifft_row = planner.plan_fft_inverse(w);
    let mut col_buf = vec![Complex::new(0.0, 0.0); ifft_col.len()];
    for x in 0..w {
        for y in 0..h { col_buf[y] = data[y * w + x]; }
        for i in h..ifft_col.len() { col_buf[i] = Complex::new(0.0, 0.0); }
        ifft_col.process(&mut col_buf);
        for y in 0..h { data[y * w + x] = col_buf[y]; }
    }
    let mut row_buf = vec![Complex::new(0.0, 0.0); ifft_row.len()];
    for y in 0..h {
        for (i, v) in data[y * w..(y + 1) * w].iter().enumerate() { row_buf[i] = *v; }
        for i in w..ifft_row.len() { row_buf[i] = Complex::new(0.0, 0.0); }
        ifft_row.process(&mut row_buf);
        for (i, v) in row_buf[..w].iter().enumerate() { data[y * w + i] = *v; }
    }
    let scale = 1.0 / (w * h) as f64;
    for v in data.iter_mut() { v.re *= scale; v.im *= scale; }
}

/// DP seam: sweeps left→right, seam[x] = y-cut in overlap-local coords.
/// Below/at seam → new frame; above → existing canvas.
fn find_horizontal_seam(
    canvas: &image::RgbImage, cx0: i32, cy0: i32,
    frame: &image::RgbImage, fx0: i32, fy0: i32,
    ow: u32, oh: u32,
) -> Vec<u32> {
    let wu = ow as usize;
    let hu = oh as usize;
    let cw = canvas.width() as i32;
    let ch = canvas.height() as i32;
    let fw = frame.width() as i32;
    let fh = frame.height() as i32;

    let mut cost = vec![0f32; wu * hu];
    for y in 0..hu {
        for x in 0..wu {
            let cx = cx0 + x as i32; let cy = cy0 + y as i32;
            let fx = fx0 + x as i32; let fy = fy0 + y as i32;
            if cx < 0 || cy < 0 || cx >= cw || cy >= ch { continue; }
            if fx < 0 || fy < 0 || fx >= fw || fy >= fh { continue; }
            let ca = canvas.get_pixel(cx as u32, cy as u32);
            let fb = frame.get_pixel(fx as u32, fy as u32);
            let dr = ca[0] as f32 - fb[0] as f32;
            let dg = ca[1] as f32 - fb[1] as f32;
            let db = ca[2] as f32 - fb[2] as f32;
            cost[y * wu + x] = (dr * dr + dg * dg + db * db).sqrt();
        }
    }

    let mut dp = vec![f32::MAX; wu * hu];
    for y in 0..hu { dp[y * wu] = cost[y * wu]; }
    for x in 1..wu {
        for y in 0..hu {
            let p = x - 1;
            let mut best = dp[y * wu + p];
            if y > 0     { best = best.min(dp[(y - 1) * wu + p]); }
            if y + 1 < hu { best = best.min(dp[(y + 1) * wu + p]); }
            dp[y * wu + x] = cost[y * wu + x] + best;
        }
    }

    let mut seam = vec![0u32; wu];
    let lx = wu - 1;
    let mut cy_s = (0..hu).min_by(|&a, &b| dp[a * wu + lx].partial_cmp(&dp[b * wu + lx]).unwrap()).unwrap_or(0);
    seam[lx] = cy_s as u32;
    for x in (0..lx).rev() {
        let lo = if cy_s > 0 { cy_s - 1 } else { 0 };
        let hi = (cy_s + 1).min(hu - 1);
        cy_s = (lo..=hi).min_by(|&a, &b| dp[a * wu + x].partial_cmp(&dp[b * wu + x]).unwrap()).unwrap_or(cy_s);
        seam[x] = cy_s as u32;
    }
    seam
}

/// DP seam: sweeps top→bottom, seam[y] = x-cut in overlap-local coords.
/// Right-of/at seam → new frame; left → existing canvas.
fn find_vertical_seam(
    canvas: &image::RgbImage, cx0: i32, cy0: i32,
    frame: &image::RgbImage, fx0: i32, fy0: i32,
    ow: u32, oh: u32,
) -> Vec<u32> {
    let wu = ow as usize;
    let hu = oh as usize;
    let cw = canvas.width() as i32;
    let ch = canvas.height() as i32;
    let fw = frame.width() as i32;
    let fh = frame.height() as i32;

    let mut cost = vec![0f32; wu * hu];
    for y in 0..hu {
        for x in 0..wu {
            let cx = cx0 + x as i32; let cy = cy0 + y as i32;
            let fx = fx0 + x as i32; let fy = fy0 + y as i32;
            if cx < 0 || cy < 0 || cx >= cw || cy >= ch { continue; }
            if fx < 0 || fy < 0 || fx >= fw || fy >= fh { continue; }
            let ca = canvas.get_pixel(cx as u32, cy as u32);
            let fb = frame.get_pixel(fx as u32, fy as u32);
            let dr = ca[0] as f32 - fb[0] as f32;
            let dg = ca[1] as f32 - fb[1] as f32;
            let db = ca[2] as f32 - fb[2] as f32;
            cost[y * wu + x] = (dr * dr + dg * dg + db * db).sqrt();
        }
    }

    let mut dp = vec![f32::MAX; wu * hu];
    for x in 0..wu { dp[x] = cost[x]; }
    for y in 1..hu {
        for x in 0..wu {
            let p = y - 1;
            let mut best = dp[p * wu + x];
            if x > 0     { best = best.min(dp[p * wu + (x - 1)]); }
            if x + 1 < wu { best = best.min(dp[p * wu + (x + 1)]); }
            dp[y * wu + x] = cost[y * wu + x] + best;
        }
    }

    let mut seam = vec![0u32; hu];
    let ly = hu - 1;
    let mut cx_s = (0..wu).min_by(|&a, &b| dp[ly * wu + a].partial_cmp(&dp[ly * wu + b]).unwrap()).unwrap_or(0);
    seam[ly] = cx_s as u32;
    for y in (0..ly).rev() {
        let lo = if cx_s > 0 { cx_s - 1 } else { 0 };
        let hi = (cx_s + 1).min(wu - 1);
        cx_s = (lo..=hi).min_by(|&a, &b| dp[y * wu + a].partial_cmp(&dp[y * wu + b]).unwrap()).unwrap_or(cx_s);
        seam[y] = cx_s as u32;
    }
    seam
}

/// Stitch frames via Phase Correlation + graph cut seam blending.
/// Low-quality pairs (scene cuts) are detected and handled gracefully.
pub fn stitch_anime(frames: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    if frames.len() < 2 { anyhow::bail!("need at least 2 frames"); }

    let (fw, fh) = (frames[0].width() as i32, frames[0].height() as i32);
    eprintln!("[stitch] stitch_anime: {} frames, {fw}x{fh}", frames.len());

    // Compute offsets; low-quality pairs don't extend the canvas.
    //
    // A weak correlation against the *immediately preceding* frame doesn't mean frame i has
    // no usable relationship to the sequence — it's frequently just that frame i-1 happens to
    // be a near-duplicate/near-static frame with nothing reliable to lock onto. Giving up at
    // that point (the old behavior) silently shrinks the panorama's true extent: maximizing
    // how much of the real footage the final canvas covers is the whole point of this
    // algorithm, so before writing a frame off as a scene cut, back off to i-2, i-3, ... and
    // try those instead. Only if *none* of the prior frames correlate is it a genuine cut.
    let mut offsets: Vec<(i32, i32)> = vec![(0, 0)];
    let mut pair_quality: Vec<f64> = vec![];
    for i in 1..frames.len() {
        let mut accepted: Option<(usize, i32, i32, f64)> = None;
        let mut best_q = 0.0f64;
        for k in 1..=i {
            let ref_idx = i - k;
            let (dx, dy, q) = phase_correlate(&frames[ref_idx], &frames[i]);
            eprintln!(
                "[stitch] pair {ref_idx}-{i}: dx={dx} dy={dy} q={q:.4}{}",
                if k > 1 { " (backtrack)" } else { "" }
            );
            best_q = best_q.max(q);
            if q >= QUALITY_THRESHOLD {
                accepted = Some((ref_idx, dx, dy, q));
                break;
            }
        }
        pair_quality.push(best_q);
        match accepted {
            Some((ref_idx, dx, dy, q)) => {
                let base = offsets[ref_idx];
                offsets.push((base.0 + dx, base.1 + dy));
                if ref_idx != i - 1 {
                    eprintln!("[stitch] frame {i}: recovered via backtrack to frame {ref_idx} (q={q:.4})");
                }
            }
            None => {
                eprintln!(
                    "[stitch] frame {i}: scene cut (best q={best_q:.4} < {QUALITY_THRESHOLD} against all {i} prior frames)"
                );
                offsets.push(offsets[i - 1]);
            }
        }
    }

    let min_x = offsets.iter().map(|o| o.0).min().unwrap_or(0);
    let max_x = offsets.iter().map(|o| o.0 + fw).max().unwrap_or(fw);
    let min_y = offsets.iter().map(|o| o.1).min().unwrap_or(0);
    let max_y = offsets.iter().map(|o| o.1 + fh).max().unwrap_or(fh);
    let cw = (max_x - min_x) as u32;
    let ch = (max_y - min_y) as u32;
    eprintln!("[stitch] canvas {cw}x{ch} (offsets span x=[{min_x},{max_x}] y=[{min_y},{max_y}])");

    // Sanity cap: each pair contributes at most half a frame dimension (phase_correlate's
    // wraparound correction bounds |dx|,|dy| <= w/2, h/2 — see its doc comment), so N frames
    // can never *legitimately* need a canvas larger than roughly N times the source frame size.
    // No bound existed here before — a single anomalous-but-passing-quality pair (plausible on
    // flat-color/repetitive anime backgrounds, where FFT phase correlation can lock onto a
    // spurious-but-strong peak) had nothing stopping its offset from compounding into a canvas
    // demanding tens of GB, with zero log output before the OS OOM-killed the process.
    let max_dim = fw.max(fh).max(1) as u64;
    let cap = (frames.len() as u64 + 1) * max_dim * 2;
    if cw as u64 > cap || ch as u64 > cap {
        anyhow::bail!(
            "stitch_anime: computed canvas {cw}x{ch} exceeds sanity cap {cap}px \
             (likely a spurious phase-correlation offset) — aborting instead of allocating"
        );
    }

    let mut canvas = image::RgbImage::new(cw, ch);

    // Paint frame 0 directly.
    {
        let rgb = frames[0].to_rgb8();
        let (x0, y0) = (offsets[0].0 - min_x, offsets[0].1 - min_y);
        for fy in 0..fh as u32 {
            for fx in 0..fw as u32 {
                let cx = x0 + fx as i32;
                let cy = y0 + fy as i32;
                if cx >= 0 && cy >= 0 && (cx as u32) < cw && (cy as u32) < ch {
                    canvas.put_pixel(cx as u32, cy as u32, *rgb.get_pixel(fx, fy));
                }
            }
        }
    }

    // Paint frames 1..N with graph cut seams.
    for i in 1..frames.len() {
        let q = pair_quality[i - 1];
        let (ox, oy) = offsets[i];
        let (ox_prev, oy_prev) = offsets[i - 1];
        let cxs = ox - min_x;       // canvas x start for frame i
        let cys = oy - min_y;       // canvas y start for frame i
        let cxp = ox_prev - min_x;  // canvas x start for frame i-1
        let cyp = oy_prev - min_y;  // canvas y start for frame i-1

        let rgb = frames[i].to_rgb8();

        // Overlap zone in canvas coordinates.
        let ov_l = cxs.max(cxp);
        let ov_r = (cxs + fw).min(cxp + fw);
        let ov_t = cys.max(cyp);
        let ov_b = (cys + fh).min(cyp + fh);
        let ov_w = (ov_r - ov_l).max(0) as u32;
        let ov_h = (ov_b - ov_t).max(0) as u32;

        let pan_dy = oy - oy_prev;
        let pan_dx = ox - ox_prev;
        let vertical = pan_dy.abs() >= pan_dx.abs();
        let has_seam = ov_w > 4 && ov_h > 4 && q >= QUALITY_THRESHOLD;

        // Frame coords of the overlap's top-left corner.
        let fx0 = ov_l - cxs;
        let fy0 = ov_t - cys;

        let seam: Option<Vec<u32>> = if has_seam {
            if vertical {
                Some(find_horizontal_seam(&canvas, ov_l, ov_t, &rgb, fx0, fy0, ov_w, ov_h))
            } else {
                Some(find_vertical_seam(&canvas, ov_l, ov_t, &rgb, fx0, fy0, ov_w, ov_h))
            }
        } else {
            None
        };

        for fy in 0..fh as u32 {
            for fx in 0..fw as u32 {
                let cx = cxs + fx as i32;
                let cy = cys + fy as i32;
                if cx < 0 || cy < 0 || (cx as u32) >= cw || (cy as u32) >= ch { continue; }

                let in_ov = cx >= ov_l && cx < ov_r && cy >= ov_t && cy < ov_b;

                let paint = if in_ov {
                    match &seam {
                        Some(s) => {
                            let ox_rel = (cx - ov_l) as u32;
                            let oy_rel = (cy - ov_t) as u32;
                            // Paint new frame on the "incoming" side of the seam.
                            if vertical {
                                if pan_dy >= 0 { oy_rel >= s[ox_rel as usize] }
                                else           { oy_rel <  s[ox_rel as usize] }
                            } else {
                                if pan_dx >= 0 { ox_rel >= s[oy_rel as usize] }
                                else           { ox_rel <  s[oy_rel as usize] }
                            }
                        }
                        None => true, // scene cut: overwrite entirely
                    }
                } else {
                    true // non-overlap: always paint
                };

                if paint {
                    canvas.put_pixel(cx as u32, cy as u32, *rgb.get_pixel(fx, fy));
                }
            }
        }
    }

    Ok(DynamicImage::ImageRgb8(canvas))
}

#[cfg(test)]
mod quality_tests {
    use super::*;
    use crate::test_metrics::*;

    /// Reproduces the production incident: a low-quality pair against the immediately
    /// preceding frame must not freeze/corrupt the offset chain when an earlier frame still
    /// correlates well. Frame 1 here is unrelated noise (simulating a near-duplicate/blurry
    /// frame that just happens to score near the noise floor against its neighbors); frame 2
    /// is a real, known vertical pan *relative to frame 0*. Without backtracking, frame 2
    /// would be frozen at frame 1's position (a scene cut) and the true pan would be lost.
    #[test]
    fn low_quality_adjacent_pair_recovers_via_backtrack() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/stitch-eval/fixtures/flower_landscape/reference.png");
        let reference = image::open(&path).expect("reference.png missing");
        let (w, h) = (reference.width(), reference.height());

        let true_dy = 195u32;
        let frame0 = reference.crop_imm(0, 0, w, 600);
        let frame2 = reference.crop_imm(0, true_dy, w, h - true_dy);
        // Deterministic pseudo-random noise, unrelated to either real frame.
        let frame1 = DynamicImage::ImageRgb8(image::RgbImage::from_fn(w, 600, |x, y| {
            let v = (x.wrapping_mul(2654435761).wrapping_add(y.wrapping_mul(40503))) as u8;
            image::Rgb([v, v.wrapping_add(85), v.wrapping_add(170)])
        }));

        let (_, _, q_noise) = phase_correlate(&frame0, &frame1);
        assert!(q_noise < QUALITY_THRESHOLD, "noise frame must score below threshold (got {q_noise:.4})");

        let stitched = stitch_anime(&[frame0, frame1, frame2]).expect("stitch_anime failed");
        assert_eq!(stitched.height(), h, "frame 2's true offset from frame 0 must still be recovered \
            via backtrack — canvas should cover the full vertical extent, not collapse to frame 1's position");
    }

    #[test]
    fn ssim_identical_images() {
        let img = DynamicImage::new_rgb8(64, 64);
        assert!((ssim(&img, &img) - 1.0).abs() < 0.001, "SSIM of identical images must be ~1.0");
    }

    #[test]
    fn ssim_different_images() {
        let black = DynamicImage::new_rgb8(64, 64);
        let white = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(64, 64, image::Rgb([255, 255, 255])));
        assert!(ssim(&black, &white) < 0.5, "SSIM of black vs white must be low");
    }

    /// gen_synthetic.sh / phase_corr_ssim_on_synthetic_fixtures only ever exercise
    /// *horizontal* pans — there was no regression coverage at all for vertical panning
    /// (the kind a top/bottom-cropped panorama report would implicate) until this test.
    /// Crops two vertically-overlapping windows out of a real photo with a known true
    /// offset and checks stitch_anime reconstructs the original exactly.
    #[test]
    fn vertical_pan_reconstructs_without_cropping() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/stitch-eval/fixtures/flower_landscape/reference.png");
        let reference = image::open(&path).expect("reference.png missing");
        let (w, h) = (reference.width(), reference.height());

        let true_dy = 195u32;
        let top = reference.crop_imm(0, 0, w, 600);
        let bottom = reference.crop_imm(0, true_dy, w, h - true_dy);

        let (dx, dy, q) = phase_correlate(&top, &bottom);
        assert_eq!(dx, 0, "pure vertical pan must not report horizontal motion");
        assert_eq!(dy, true_dy as i32, "phase_correlate dy must match the true vertical offset");
        assert!(q >= QUALITY_THRESHOLD, "quality {q:.4} too low for a clean synthetic pair");

        let stitched = stitch_anime(&[top, bottom]).expect("stitch_anime failed");
        assert_eq!((stitched.width(), stitched.height()), (w, h),
            "canvas must cover the full vertical extent, not just one input frame's height");
        assert_eq!(stitched.to_rgb8().into_raw(), reference.to_rgb8().into_raw(),
            "vertical stitch must reconstruct the source exactly — no row should be dropped at either edge");
    }

    #[test]
    fn phase_corr_ssim_on_synthetic_fixtures() {
        let dir = fixtures_scene_a();
        if !dir.exists() {
            eprintln!("Skipping: run tests/stitch-eval/gen_synthetic.sh to generate fixtures");
            return;
        }
        let t = load_thresholds();
        let a = image::open(dir.join("frame_0.png")).expect("frame_0.png missing");
        let b = image::open(dir.join("frame_1.png")).expect("frame_1.png missing");
        let stitched = stitch_anime(&[a.clone(), b]).expect("stitch_anime failed");
        let score = ssim(&stitched, &a);
        assert!(score >= t.ssim_min, "SSIM {:.3} < threshold {:.3}", score, t.ssim_min);
    }
}
