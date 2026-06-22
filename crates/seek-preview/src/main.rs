mod protocol;
mod server;

use anyhow::{Context, Result};
use jfs_common::DiskCache;
use tokio::net::UnixListener;

fn main() -> Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(3) // 1 FETCH + 2 concurrent PREFETCH decodes
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> Result<()> {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("seek_preview=info,jfs_common=warn"),
    )
    .init();
    jfs_common::init();

    let args: Vec<String> = std::env::args().collect();
    let sock_path = args.get(1).context("Usage: seek-preview <socket-path>")?;

    let _ = std::fs::remove_file(sock_path);
    let listener = UnixListener::bind(sock_path)?;
    log::info!("[jellyfin-suite-seek-preview] listening on {sock_path}");

    let disk = DiskCache::new("jellyfin-suite-seek-preview");
    let state = server::State::new(disk);

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(server::handle_conn(stream, state.clone()));
            }
            Err(e) => log::error!("[jellyfin-suite-seek-preview] accept error: {e}"),
        }
    }
}
