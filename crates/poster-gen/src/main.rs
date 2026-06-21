mod cli;
mod frame_extractor;
mod image_stitcher;
mod logo;
mod media_info;
mod preview;
mod qr;
mod run;
mod sampling;
mod text_renderer;

use clap::Parser;

fn main() {
    let cli = cli::Cli::parse();

    let result = match cli.command {
        Some(cli::Commands::Generate(args)) => run::run_generate(args),
        Some(cli::Commands::Preview(args)) => run::run_preview_cmd(args),
        None => run::run_generate(cli.generate),
    };

    if let Err(msg) = result {
        eprintln!("ERROR {msg}");
        std::process::exit(1);
    }
}
