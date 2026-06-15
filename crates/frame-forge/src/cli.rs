// frame-forge CLI — stitch & animate without ffmpeg/opencv deps.
// Usage:
//   forge stitch --input img1.webp img2.webp ... --output result.png
//   forge stitch-landscape --input a.png b.png --output result.png   (requires opencv feature)
//   forge stitch-liveaction --input a.png b.png --output result.png  (requires opencv feature)
//   forge animate --input img1.webp img2.webp ... --output result.webp --height 200 --fps 5

mod animate;
mod scene_classifier;
mod stitch_anime;
#[cfg(feature = "opencv")]
mod stitch_landscape;
#[cfg(feature = "opencv")]
mod stitch_liveaction;
#[cfg(test)]
mod test_metrics;

use anyhow::Context;
use image::DynamicImage;
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("stitch") => cmd_stitch(&args[2..]),
        Some("stitch-landscape") => cmd_stitch_opencv(&args[2..], "landscape"),
        Some("stitch-liveaction") => cmd_stitch_opencv(&args[2..], "liveaction"),
        Some("animate") => cmd_animate(&args[2..]),
        _ => {
            eprintln!("Usage:");
            eprintln!("  forge stitch --input file1.png file2.png ... --output out.png");
            eprintln!("  forge stitch-landscape --input a.png b.png --output out.png  (opencv feature required)");
            eprintln!("  forge stitch-liveaction --input a.png b.png --output out.png (opencv feature required)");
            eprintln!("  forge animate --json frames.json");
            eprintln!("  forge animate --input f1.webp f2.webp ... --output out.gif --height 200 [--fps 5] [--timestamps ms1 ms2 ...]");
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

    let result = stitch_routed(&class, &images)?;
    result.save(output)?;
    eprintln!("Saved: {output} ({}x{})", result.width(), result.height());
    Ok(())
}

#[cfg(feature = "opencv")]
fn stitch_routed(class: &scene_classifier::SceneClass, images: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    use scene_classifier::SceneCategory;
    match class.category {
        SceneCategory::LiveAction => {
            eprintln!("Auto-routing: liveaction (OpenCV Stitcher)");
            stitch_liveaction::stitch_liveaction(images)
        }
        SceneCategory::Landscape => {
            eprintln!("Auto-routing: landscape (SIFT + Laplacian)");
            stitch_landscape::stitch_landscape(images)
        }
        SceneCategory::Anime => {
            eprintln!("Auto-routing: anime (Phase Correlation)");
            stitch_anime::stitch_anime(images)
        }
    }
}

#[cfg(not(feature = "opencv"))]
fn stitch_routed(_class: &scene_classifier::SceneClass, images: &[DynamicImage]) -> anyhow::Result<DynamicImage> {
    eprintln!("Auto-routing: Phase Correlation (opencv unavailable)");
    stitch_anime::stitch_anime(images)
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

    let uniform_delay_ms = (1000u32 / fps.max(1) as u32).max(10);
    let uniform_delays: Vec<u32> = vec![uniform_delay_ms; scaled.len()];

    let encoded = if output.ends_with(".gif") {
        if !timestamps.is_empty() {
            animate::encode_gif_timed(&scaled, timestamps, 0)?
        } else {
            animate::encode_gif(&scaled, &uniform_delays, 0)?
        }
    } else {
        if !timestamps.is_empty() {
            animate::encode_webp_timed(&scaled, timestamps, 0)?
        } else {
            animate::encode_webp_anim(&scaled, &uniform_delays, 0)?
        }
    };
    std::fs::write(output, &encoded)?;
    eprintln!("Saved: {output} ({} bytes)", encoded.len());
    Ok(())
}

fn cmd_stitch_opencv(args: &[String], mode: &str) -> anyhow::Result<()> {
    #[cfg(not(feature = "opencv"))]
    {
        anyhow::bail!("stitch-{mode} requires --features opencv (not compiled into this binary)");
    }
    #[cfg(feature = "opencv")]
    {
        let kv = parse_kv(args);
        let input: Vec<&str> = kv.iter().find(|(k,_)| *k == "input").map(|(_,v)| v.as_slice()).unwrap_or(&[]).to_vec();
        let output = kv.iter().find(|(k,_)| *k == "output").and_then(|(_,v)| v.first()).map(|s| *s).unwrap_or("stitched.png");
        if input.len() < 2 {
            anyhow::bail!("stitch-{mode} requires at least 2 --input images");
        }
        let images = load_images(&input)?;
        eprintln!("Stitching {} frames with {mode} algorithm...", images.len());
        let result = match mode {
            "liveaction" => stitch_liveaction::stitch_liveaction(&images)?,
            _ => stitch_landscape::stitch_landscape(&images)?,
        };
        result.save(output)?;
        eprintln!("Saved: {output} ({}x{})", result.width(), result.height());
        Ok(())
    }
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
