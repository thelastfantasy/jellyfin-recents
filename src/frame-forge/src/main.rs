mod decoder;
mod protocol;
mod quality;
mod resources;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let sock_path = args.get(1).cloned().unwrap_or_else(|| {
        eprintln!("Usage: frame-forge <socket-path>");
        std::process::exit(1);
    });

    ffmpeg_next::init()?;

    let _ = std::fs::remove_file(&sock_path);
    let listener = std::os::unix::net::UnixListener::bind(&sock_path)?;
    eprintln!("[frame-forge] listening on {sock_path}");

    let gpu_available = opencv::core::ocl::have_opencl().unwrap_or(false);
    eprintln!("[frame-forge] OpenCL GPU acceleration: {}", if gpu_available { "enabled" } else { "unavailable (CPU fallback)" });

    // placeholder: tokio runtime + accept loop will be added in T015/T041/T077
    for stream in listener.incoming() {
        match stream {
            Ok(_stream) => {
                eprintln!("[frame-forge] connection accepted (stub)");
            }
            Err(e) => eprintln!("[frame-forge] accept error: {e}"),
        }
    }

    Ok(())
}
