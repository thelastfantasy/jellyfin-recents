// Jellyfin logo SVG renderer for poster sheet watermark
// SVG source: https://commons.wikimedia.org/wiki/File:Jellyfin_-_icon-transparent.svg (CC BY-SA 4.0)

use image::RgbaImage;

const LOGO_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="110.25" y1="213.3" x2="496.14" y2="436.09">
      <stop offset="0" stop-color="#AA5CC3"/>
      <stop offset="1" stop-color="#00A4DC"/>
    </linearGradient>
  </defs>
  <path d="M256,201.6c-20.4,0-86.2,119.3-76.2,139.4s142.5,19.9,152.4,0S276.5,201.6,256,201.6z" fill="url(#g)"/>
  <path d="M256,23.3c-61.6,0-259.8,359.4-229.6,420.1s429.3,60,459.2,0S317.6,23.3,256,23.3z M406.5,390.8c-19.6,39.3-281.1,39.8-300.9,0s110.1-275.3,150.4-275.3S426.1,351.4,406.5,390.8z" fill="url(#g)"/>
</svg>"##;

/// Render the Jellyfin logo at an exact position and size (for header branding).
pub fn render_logo_at(canvas: &mut RgbaImage, x: u32, y: u32, size: u32, opacity: f32) {
    if size == 0 { return; }
    let opt = resvg::usvg::Options::default();
    let tree = match resvg::usvg::Tree::from_str(LOGO_SVG, &opt) {
        Ok(t) => t,
        Err(e) => { eprintln!("WARNING: logo SVG parse failed: {e}"); return; }
    };
    let svg_size = tree.size();
    let logo_w = size;
    let logo_h = (size as f64 * svg_size.height() as f64 / svg_size.width() as f64) as u32;
    let mut pixmap = tiny_skia::Pixmap::new(logo_w.max(1), logo_h.max(1)).unwrap();
    let transform = tiny_skia::Transform::from_scale(
        logo_w as f32 / svg_size.width() as f32,
        logo_h as f32 / svg_size.height() as f32,
    );
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let canvas_w = canvas.width();
    let canvas_h = canvas.height();
    for py in 0..logo_h {
        for px in 0..logo_w {
            let cx = x + px;
            let cy = y + py;
            if cx >= canvas_w || cy >= canvas_h { continue; }
            let rgba = pixmap.pixel(px, py).unwrap_or(tiny_skia::PremultipliedColorU8::TRANSPARENT);
            let src_alpha = rgba.alpha() as f32 / 255.0;
            if src_alpha <= 0.01 { continue; }
            let blend = src_alpha * opacity;
            let pixel = canvas.get_pixel_mut(cx, cy);
            let ch = pixel.0.as_mut_slice();
            ch[0] = (ch[0] as f32 * (1.0 - blend) + rgba.red()   as f32 * blend) as u8;
            ch[1] = (ch[1] as f32 * (1.0 - blend) + rgba.green() as f32 * blend) as u8;
            ch[2] = (ch[2] as f32 * (1.0 - blend) + rgba.blue()  as f32 * blend) as u8;
            ch[3] = ((1.0 - blend) * ch[3] as f32 + blend * 255.0) as u8;
        }
    }
}

/// Render the Jellyfin logo tinted to a solid `color`, preserving SVG alpha as the blend mask.
/// Used for the QR center badge where the logo should match the gradient color.
pub fn render_logo_tinted(canvas: &mut RgbaImage, x: u32, y: u32, size: u32, color: [u8; 3]) {
    if size == 0 { return; }
    let opt = resvg::usvg::Options::default();
    let tree = match resvg::usvg::Tree::from_str(LOGO_SVG, &opt) {
        Ok(t) => t,
        Err(_) => return,
    };
    let svg_size = tree.size();
    let logo_w = size;
    let logo_h = (size as f64 * svg_size.height() as f64 / svg_size.width() as f64) as u32;
    let mut pixmap = tiny_skia::Pixmap::new(logo_w.max(1), logo_h.max(1)).unwrap();
    let transform = tiny_skia::Transform::from_scale(
        logo_w as f32 / svg_size.width() as f32,
        logo_h as f32 / svg_size.height() as f32,
    );
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let canvas_w = canvas.width();
    let canvas_h = canvas.height();
    for py in 0..logo_h {
        for px in 0..logo_w {
            let cx = x + px;
            let cy = y + py;
            if cx >= canvas_w || cy >= canvas_h { continue; }
            let rgba = pixmap.pixel(px, py).unwrap_or(tiny_skia::PremultipliedColorU8::TRANSPARENT);
            let a = rgba.alpha() as f32 / 255.0;
            if a <= 0.01 { continue; }
            let pixel = canvas.get_pixel_mut(cx, cy);
            let ch = pixel.0.as_mut_slice();
            ch[0] = (ch[0] as f32 * (1.0 - a) + color[0] as f32 * a).round() as u8;
            ch[1] = (ch[1] as f32 * (1.0 - a) + color[1] as f32 * a).round() as u8;
            ch[2] = (ch[2] as f32 * (1.0 - a) + color[2] as f32 * a).round() as u8;
            ch[3] = 255;
        }
    }
}

pub fn render_logo(canvas: &mut RgbaImage, canvas_w: u32, canvas_h: u32) {
    let logo_w = canvas_w * 2 / 3;
    if logo_w == 0 { return; }

    let opt = resvg::usvg::Options::default();
    let tree = match resvg::usvg::Tree::from_str(LOGO_SVG, &opt) {
        Ok(t) => t,
        Err(e) => { eprintln!("WARNING: logo SVG parse failed: {e}"); return; }
    };

    let svg_size = tree.size();
    let logo_h = (logo_w as f64 * svg_size.height() as f64 / svg_size.width() as f64) as u32;

    let mut pixmap = tiny_skia::Pixmap::new(logo_w, logo_h)
        .unwrap_or_else(|| {
            tiny_skia::Pixmap::new(logo_w.max(1), logo_h.max(1)).unwrap()
        });

    let transform = tiny_skia::Transform::from_scale(
        logo_w as f32 / svg_size.width() as f32,
        logo_h as f32 / svg_size.height() as f32,
    );

    resvg::render(&tree, transform, &mut pixmap.as_mut());

    let opacity = 0.20f32;

    let logo_x = canvas_w.saturating_sub(logo_w);
    let logo_y = 0u32;

    for py in 0..logo_h {
        for px in 0..logo_w {
            let cx = logo_x + px;
            let cy = logo_y + py;
            if cx >= canvas_w || cy >= canvas_h { continue; }

            let rgba = pixmap.pixel(px, py).unwrap_or(tiny_skia::PremultipliedColorU8::TRANSPARENT);
            let src_alpha = rgba.alpha() as f32 / 255.0;
            if src_alpha <= 0.01 { continue; }

            let blend_alpha = src_alpha * opacity;
            let pixel = canvas.get_pixel_mut(cx, cy);
            let ch = pixel.0.as_mut_slice();
            let bg = [ch[0] as f32, ch[1] as f32, ch[2] as f32];
            ch[0] = (bg[0] * (1.0 - blend_alpha) + rgba.red() as f32 * blend_alpha) as u8;
            ch[1] = (bg[1] * (1.0 - blend_alpha) + rgba.green() as f32 * blend_alpha) as u8;
            ch[2] = (bg[2] * (1.0 - blend_alpha) + rgba.blue() as f32 * blend_alpha) as u8;
        }
    }
}
