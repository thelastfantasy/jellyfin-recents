use image::{DynamicImage, RgbaImage};
use opencv::prelude::*;
use opencv::{calib3d, core, features2d, imgproc, types};

/// AKAZE feature-based stitching for landscape/low-texture scenes.
/// Falls back to Phase Correlation when feature matching fails.
pub fn stitch_landscape(frames: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    if frames.len() < 2 {
        anyhow::bail!("need at least 2 frames");
    }

    let mut result = frames[0].to_rgba8();
    let (w, h) = (result.width() as i32, result.height() as i32);

    for i in 1..frames.len() {
        let prev = image_to_mat(&DynamicImage::ImageRgba8(result.clone()));
        let curr = image_to_mat(&frames[i]);

        // Try AKAZE feature matching
        if let Ok(h) = estimate_homography_akaze(&prev, &curr) {
            // Warp current frame into prev coordinate system
            let warped = warp_image(&curr, &h, w, h);
            result = blend_pair(&result, &warped);
        } else {
            // Fallback to Phase Correlation
            let prev_img = DynamicImage::ImageRgba8(result.clone());
            let (dx, dy) = crate::stitch_anime::phase_correlate(&prev_img, &frames[i]);
            let dst_x = dx.max(0) as u32;
            let dst_y = dy.max(0) as u32;
            let mut new_canvas = RgbaImage::new(
                (w + dx.unsigned_abs()).max(w as u32),
                (h + dy.unsigned_abs()).max(h as u32),
            );
            image::imageops::overlay(&mut new_canvas, &result, 0, 0);
            let rgba = frames[i].to_rgba8();
            image::imageops::overlay(&mut new_canvas, &rgba, dst_x as i64, dst_y as i64);
            result = new_canvas;
        }
    }

    Ok(DynamicImage::ImageRgba8(result))
}

fn image_to_mat(img: &DynamicImage) -> core::Mat {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let data = rgba.into_raw();
    unsafe {
        core::Mat::new_rows_cols_with_data(
            h as i32, w as i32,
            core::CV_8UC4,
            data.as_ptr() as *mut _,
            core::Mat_AUTO_STEP,
        ).unwrap()
    }
}

fn estimate_homography_akaze(img1: &core::Mat, img2: &core::Mat) -> anyhow::Result<core::Mat> {
    // Convert to grayscale
    let mut gray1 = core::Mat::default();
    let mut gray2 = core::Mat::default();
    imgproc::cvt_color(img1, &mut gray1, imgproc::COLOR_RGBA2GRAY, 0)?;
    imgproc::cvt_color(img2, &mut gray2, imgproc::COLOR_RGBA2GRAY, 0)?;

    // AKAZE detector + descriptor
    let akaze = features2d::AKAZE::create(
        features2d::AKAZE_DESCRIPTOR_MLDB, 0, 3, 0.001f32, 4, 4,
        opencv::core::KAZE_DIFF_PM_G2,
    )?;

    let mut kp1 = types::VectorOfKeyPoint::new();
    let mut kp2 = types::VectorOfKeyPoint::new();
    let mut desc1 = core::Mat::default();
    let mut desc2 = core::Mat::default();
    akaze.detect_and_compute(&gray1, &core::no_array()?, &mut kp1, &mut desc1, false)?;
    akaze.detect_and_compute(&gray2, &core::no_array()?, &mut kp2, &mut desc2, false)?;

    if kp1.len() < 4 || kp2.len() < 4 {
        anyhow::bail!("not enough keypoints ({}/{})", kp1.len(), kp2.len());
    }

    // BFMatcher
    let matcher = features2d::BFMatcher::create(core::NORM_HAMMING, false)?;
    let mut matches = types::VectorOfDMatch::new();
    matcher.r#match(&desc1, &desc2, &mut matches, &core::no_array()?)?;

    // Sort by distance and keep top 30%
    let mut match_vec: Vec<features2d::DMatch> = matches.iter().collect();
    match_vec.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap());
    let n = (match_vec.len() as f64 * 0.3).max(4.0) as usize;
    match_vec.truncate(n);

    if match_vec.len() < 4 {
        anyhow::bail!("not enough good matches");
    }

    // Extract matched point coordinates
    let mut pts1 = core::Mat::new_rows_cols_with_default(match_vec.len() as i32, 1, core::CV_32FC2, core::Scalar::default())?;
    let mut pts2 = core::Mat::new_rows_cols_with_default(match_vec.len() as i32, 1, core::CV_32FC2, core::Scalar::default())?;

    for (i, m) in match_vec.iter().enumerate() {
        let p1 = kp1.get(m.query_idx as usize)?.pt;
        let p2 = kp2.get(m.train_idx as usize)?.pt;
        *pts1.at_2d::<core::Vec2f>(i as i32, 0)? = core::Vec2f::from([p1.x, p1.y]);
        *pts2.at_2d::<core::Vec2f>(i as i32, 0)? = core::Vec2f::from([p2.x, p2.y]);
    }

    // RANSAC homography
    let mask = core::Mat::default();
    let h = calib3d::find_homography(&pts1, &pts2, &mut mask.const_clone()?, calib3d::RANSAC, 3.0)?;

    Ok(h)
}

fn warp_image(img: &core::Mat, h: &core::Mat, width: i32, height: i32) -> RgbaImage {
    let mut warped = core::Mat::default();
    if let Err(e) = imgproc::warp_perspective(
        img, &mut warped, h,
        core::Size::new(width, height),
        imgproc::INTER_LINEAR, core::BORDER_CONSTANT, core::Scalar::default(),
    ) {
        eprintln!("[frame-forge] warp failed: {:?}", e);
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

fn blend_pair(base: &RgbaImage, overlay: &RgbaImage) -> RgbaImage {
    let w = base.width().max(overlay.width());
    let h = base.height().max(overlay.height());
    let mut result = RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let bp = base.get_pixel_checked(x, y);
            let op = overlay.get_pixel_checked(x, y);
            match (bp, op) {
                (Some(b), Some(o)) if o[3] > 0 => {
                    // Simple alpha blending in overlap region
                    let alpha = 0.5;
                    result.put_pixel(x, y, image::Rgba([
                        (b[0] as f64 * (1.0 - alpha) + o[0] as f64 * alpha) as u8,
                        (b[1] as f64 * (1.0 - alpha) + o[1] as f64 * alpha) as u8,
                        (b[2] as f64 * (1.0 - alpha) + o[2] as f64 * alpha) as u8,
                        255,
                    ]));
                }
                (Some(b), _) => { result.put_pixel(x, y, *b); }
                (_, Some(o)) => { result.put_pixel(x, y, *o); }
                _ => {}
            }
        }
    }
    result
}
