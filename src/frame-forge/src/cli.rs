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
            eprintln!("Usage:");
            eprintln!("  forge stitch --input file1.webp file2.webp ... --output out.png");
            eprintln!("  forge animate --json frames.json");
            eprintln!("  forge animate --input f1.webp f2.webp ... --output out.gif --height 200 [--fps 5] [--timestamps ms1 ms2 ...]");
            eprintln!();
            eprintln!("  --json exclusively controls all params:");
            eprintln!("  {{");
            eprintln!("    \"frames\": [{{\"path\":\"frame.webp\",\"duration_ms\":200}}, ...],");
            eprintln!("    \"output\": \"out.webp\",");
            eprintln!("    \"height\": 200,");
            eprintln!("    \"fps\": 5");
            eprintln!("  }}");
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

    if let Some(manifest_path) = kv.iter().find(|(k,_)| *k == "json").and_then(|(_,v)| v.first()) {
        // JSON manifest — all-in-one
        let json = std::fs::read_to_string(manifest_path)?;
        let m: Manifest = serde_json::from_str(&json)?;
        let paths: Vec<&str> = m.frames.iter().map(|f| f.path.as_str()).collect();
        // Accumulate durations into timestamps for internal use
        let mut ts = 0u64;
        let timestamps: Vec<u64> = m.frames.iter().map(|f| { ts += f.duration_ms; ts }).collect();
        let output = m.output.as_deref().unwrap_or("output.webp");
        let height = m.height.unwrap_or(200);
        let fps = m.fps.unwrap_or(5);
        eprintln!("Loading {} frames from manifest...", paths.len());
        let images = load_images(&paths)?;
        encode_and_save(&images, &timestamps, output, height, fps)
    } else {
        // CLI mode — --input + optional --timestamps / --fps / --height / --output
        let input: Vec<&str> = kv.iter().find(|(k,_)| *k == "input").map(|(_,v)| v.as_slice()).unwrap_or(&[]).to_vec();
        let output = kv.iter().find(|(k,_)| *k == "output").and_then(|(_,v)| v.first()).map(|s| s.to_string()).unwrap_or_else(|| "output.webp".into());
        let height: u32 = kv.iter().find(|(k,_)| *k == "height").and_then(|(_,v)| v.first()?.parse().ok()).unwrap_or(200);
        let fps: u16 = kv.iter().find(|(k,_)| *k == "fps").and_then(|(_,v)| v.first()?.parse().ok()).unwrap_or(5);
        let timestamps: Vec<u64> = kv.iter().find(|(k,_)| *k == "timestamps")
            .map(|(_,v)| v.iter().filter_map(|s| s.parse().ok()).collect())
            .unwrap_or_default();
        let images = load_images(&input)?;
        encode_and_save(&images, &timestamps, &output, height, fps)
    }
}

fn encode_and_save(images: &[DynamicImage], timestamps: &[u64], output: &str, height: u32, fps: u16) -> anyhow::Result<()> {
    eprintln!("Scaling to {height}px height...");
    let scaled: Vec<DynamicImage> = images.iter().map(|img| {
        let ratio = height as f64 / img.height() as f64;
        let w = (img.width() as f64 * ratio).max(1.0) as u32;
        img.resize_exact(w, height, image::imageops::FilterType::Lanczos3)
    }).collect();

    let encoded = if output.ends_with(".gif") {
        if !timestamps.is_empty() {
            animate::encode_gif_timed(&scaled, timestamps, 0)?
        } else {
            animate::encode_gif(&scaled, fps, 0)?
        }
    } else {
        if !timestamps.is_empty() {
            animate::encode_webp_timed(&scaled, timestamps, 0)?
        } else {
            animate::encode_webp_anim(&scaled, fps, 0)?
        }
    };
    std::fs::write(output, &encoded)?;
    eprintln!("Saved: {output} ({} bytes)", encoded.len());
    Ok(())
}

#[derive(serde::Deserialize)]
struct ManifestFrame {
    path: String,
    /// Per-frame display duration in ms (user-facing), accumulated into timestamps internally
    duration_ms: u64,
}

#[derive(serde::Deserialize)]
struct Manifest {
    frames: Vec<ManifestFrame>,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    fps: Option<u16>,
}
