// Extracts a .tar.xz archive — invoked as a one-shot CLI subcommand
// (`frame-forge <socket-path-or-extract-tar-xz> ...`) by CudaRuntimeAcquisitionService (C#),
// which has no XZ/LZMA decompression of its own: the .NET BCL only ships Brotli/GZip/Deflate,
// and Jellyfin's plugin loader doesn't reliably resolve extra managed dependency DLLs the host
// doesn't already provide (unlike Microsoft.Data.Sqlite, which Jellyfin server itself ships).
// Rust already has a proven, statically-linked liblzma binding via xz2/lzma-sys, so extraction
// happens here instead of adding a new native interop surface to the C# side.
use anyhow::Context;
use std::fs::File;
use std::path::Path;

pub fn extract(archive_path: &str, dest_dir: &str) -> anyhow::Result<()> {
    let file = File::open(archive_path).with_context(|| format!("failed to open {archive_path}"))?;
    let xz = xz2::read::XzDecoder::new(file);
    let mut archive = tar::Archive::new(xz);
    archive
        .unpack(Path::new(dest_dir))
        .with_context(|| format!("failed to extract {archive_path} to {dest_dir}"))?;
    Ok(())
}
