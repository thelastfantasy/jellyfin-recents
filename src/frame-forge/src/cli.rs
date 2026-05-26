// frame-forge CLI — stitch & animate without ffmpeg/opencv deps.
// Usage:
//   forge stitch --input img1.webp img2.webp ... --output result.png
//   forge animate --input img1.webp img2.webp ... --output result.webp --height 200 --fps 5

mod animate;
mod scene_classifier;
mod stitch_anime;

use anyhow::Context;
use image::DynamicImage;
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("stitch") => cmd_stitch(&args[2..]),
        Some("animate") => cmd_animate(&args[2..]),
        _ => {
            eprintln!("Usage: forge stitch|animate --input ... --output ...");
            Ok(())
        }
    }
}

fn parse_kv(args: &[String]) -> Vec<(&str, Vec<&str>)> {
    let mut result = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i].starts_with("--") {
            let key = &args[i][2..];
            let mut vals = Vec::new();
            i += 1;
            while i < args.len() && !args[i].starts_with("--") {
                vals.push(args[i].as_str());
                i += 1;
            }
            result.push((key, vals));
        } else {
            i += 1;
        }
    }
    result
}

fn load_images(paths: &[&str]) -> anyhow::Result<Vec<DynamicImage>> {
    paths.iter().map(|p| {
        eprintln!("  Loading: {p}");
        image::open(p).with_context(|| format!("failed to open {p}"))
    }).collect()
}

fn cmd_stitch(args: &[String]) -> anyhow::Result<()> {
    let kv = parse_kv(args);
    let input: Vec<&str> = kv.iter().find(|(k,_)| *k == "input").map(|(_,v)| v.as_slice()).unwrap_or(&[]).to_vec();
    let output = kv.iter().find(|(k,_)| *k == "output").and_then(|(_,v)| v.first()).map(|s| *s).unwrap_or("stitched.png");

    let images = load_images(&input)?;
    eprintln!("Classifying scene...");
    let class = scene_classifier::classify(&images);
    eprintln!("Scene: {:?}  Edge: {:.3}  Entropy: {:.1}",
        class.category, class.edge_density, class.color_entropy);

    eprintln!("Stitching with Phase Correlation...");
    let result = stitch_anime::stitch_anime(&images)?;
    result.save(output)?;
    eprintln!("Saved: {output} ({}x{})", result.width(), result.height());
    Ok(())
}

fn cmd_animate(args: &[String]) -> anyhow::Result<()> {
    let kv = parse_kv(args);
    let input: Vec<&str> = kv.iter().find(|(k,_)| *k == "input").map(|(_,v)| v.as_slice()).unwrap_or(&[]).to_vec();
    let output = kv.iter().find(|(k,_)| *k == "output").and_then(|(_,v)| v.first()).map(|s| *s).unwrap_or("output.webp");
    let target_h: u32 = kv.iter().find(|(k,_)| *k == "height").and_then(|(_,v)| v.first()?.parse().ok()).unwrap_or(200);
    let fps: u16 = kv.iter().find(|(k,_)| *k == "fps").and_then(|(_,v)| v.first()?.parse().ok()).unwrap_or(5);

    let images = load_images(&input)?;
    eprintln!("Scaling to {target_h}px height, {fps}fps...");
    let scaled: Vec<DynamicImage> = images.iter().map(|img| {
        let ratio = target_h as f64 / img.height() as f64;
        let w = (img.width() as f64 * ratio).max(1.0) as u32;
        img.resize_exact(w, target_h, image::imageops::FilterType::Lanczos3)
    }).collect();

    let encoded = if output.ends_with(".gif") {
        animate::encode_gif(&scaled, fps, 0)?
    } else {
        animate::encode_webp_anim(&scaled, fps, 0)?
    };
    std::fs::write(output, &encoded)?;
    eprintln!("Saved: {output} ({} bytes)", encoded.len());
    Ok(())
}
