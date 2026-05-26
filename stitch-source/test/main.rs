use image::DynamicImage;
use std::fs;
use std::path::Path;

#[path = "../../src/frame-forge/src/scene_classifier.rs"]
mod scene_classifier;
#[path = "../../src/frame-forge/src/stitch_anime.rs"]
mod stitch_anime;

fn main() -> anyhow::Result<()> {
    let dir = Path::new("..");
    let mut images: Vec<DynamicImage> = Vec::new();

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().map_or(false, |e| e == "webp") {
            eprintln!("Loading: {}", path.file_name().unwrap().to_string_lossy());
            let img = image::open(&path)?;
            images.push(img);
        }
    }

    if images.len() < 2 {
        anyhow::bail!("Need at least 2 images, found {}", images.len());
    }

    eprintln!("\n{} images loaded", images.len());
    eprintln!("Classifying scene...");
    let class = scene_classifier::classify(&images);
    eprintln!("Scene: {:?}  Edge: {:.3}  Entropy: {:.1}  Motion: {:.3}",
        class.category, class.edge_density, class.color_entropy, class.motion_score);

    eprintln!("Stitching with Phase Correlation...");
    let result = stitch_anime::stitch_anime(&images)?;

    let out_path = dir.join("result.png");
    result.save(&out_path)?;
    eprintln!("Saved: {}", out_path.display());
    eprintln!("Size: {}x{}", result.width(), result.height());

    Ok(())
}
