//! Newline-delimited stdout protocol consumed by `PosterSheetJobService.cs`
//! (`process.StandardOutput.ReadLineAsync()` matching on these exact prefixes).
//! This is wire format, not logging — never route it through `log`/`env_logger`,
//! and never add anything else to stdout outside these functions.

pub fn emit_progress(done: usize, total: usize) {
    println!("PROGRESS {done}/{total}");
}

pub fn emit_media_info(info_json: &str) {
    println!("MEDIA_INFO {info_json}");
}

pub fn emit_done(path: &std::path::Path) {
    println!("DONE {}", path.display());
}
