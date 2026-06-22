mod cli;
mod frame_extractor;
mod image_stitcher;
mod ipc;
mod logo;
mod media_info;
mod preview;
mod qr;
mod run;
mod sampling;
mod text_renderer;

use clap::Parser;

fn main() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("poster_gen=warn"),
    )
    .init();

    let cli = cli::Cli::parse();

    let result = match cli.command {
        Some(cli::Commands::Generate(args)) => run::run_generate(args),
        Some(cli::Commands::Preview(args)) => run::run_preview_cmd(args),
        None => run::run_generate(cli.generate),
    };

    if let Err(msg) = result {
        log::error!("[jellyfin-suite-poster-gen] {msg}");
        std::process::exit(1);
    }
}
