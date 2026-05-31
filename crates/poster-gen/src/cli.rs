use clap::{Args, Parser, Subcommand};

pub const BRANDING_DEFAULT: &str = "Jellyfin Suite";

/// Jellyfin Suite poster sheet generator
#[derive(Parser, Debug)]
#[command(name = "poster-gen", version, about)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,

    /// Flatten generate args at top level (default subcommand)
    #[command(flatten)]
    pub generate: GenerateArgs,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Generate a poster sheet from a video file (default)
    Generate(GenerateArgs),
    /// Fast preview without ffmpeg
    Preview(PreviewArgs),
}

#[derive(Args, Debug, Clone, Default)]
pub struct GenerateArgs {
    /// Path to ffmpeg executable
    #[arg(long, default_value = "ffmpeg")]
    pub ffmpeg_path: String,

    /// Input video file
    #[arg(long)]
    pub input: Option<String>,

    /// Output JPEG path
    #[arg(long)]
    pub output: Option<String>,

    /// Number of rows (1-10)
    #[arg(long, default_value_t = 6)]
    pub rows: u32,

    /// Number of columns (1-12)
    #[arg(long, default_value_t = 8)]
    pub cols: u32,

    /// Hex seed string for random mode
    #[arg(long)]
    pub seed: Option<String>,

    /// Generation mode: deterministic (default) or random
    #[arg(long, default_value = "deterministic")]
    pub mode: String,

    /// Optional path to TTF font for info text
    #[arg(long)]
    pub font_path: Option<String>,

    /// Optional TTF font for branding label Latin characters
    #[arg(long)]
    pub branding_latin_font_path: Option<String>,

    /// Optional TTF font for branding label CJK characters (falls back to branding_latin_font_path)
    #[arg(long)]
    pub branding_cjk_font_path: Option<String>,

    /// Optional monospace TTF font for timestamp badges (falls back to font_path)
    #[arg(long)]
    pub timestamp_font_path: Option<String>,

    /// Thumbnail width in pixels
    #[arg(long, default_value_t = 320)]
    pub thumb_width: u32,

    /// Color theme: classic|dark|light|cinematic|minimal
    #[arg(long, default_value = "classic")]
    pub color_theme: String,

    /// Show per-frame HH:MM:SS badge
    #[arg(long)]
    pub show_timestamp: bool,

    /// Branding label
    #[arg(long, default_value = BRANDING_DEFAULT)]
    pub branding_text: String,

    /// Disable branding label
    #[arg(long)]
    pub no_branding: bool,

    /// Disable entire top-left info block
    #[arg(long)]
    pub no_video_info: bool,

    /// Disable file size display
    #[arg(long)]
    pub no_file_size: bool,

    /// Disable resolution and FPS display
    #[arg(long)]
    pub no_resolution_fps: bool,

    /// Disable video encoding info
    #[arg(long)]
    pub no_video_encoding: bool,

    /// Disable audio encoding info
    #[arg(long)]
    pub no_audio_encoding: bool,

    /// Disable duration display
    #[arg(long)]
    pub no_duration: bool,

    /// Disable subtitle count display
    #[arg(long)]
    pub no_subtitles: bool,

    /// Overlay label language: en|zh|ja
    #[arg(long, default_value = "en")]
    pub lang: String,

    /// Timestamp badge position
    #[arg(long, default_value_t = crate::image_stitcher::TimestampPosition::InsideBottomLeft)]
    pub timestamp_position: crate::image_stitcher::TimestampPosition,

    /// Disable timestamp badge background rectangle
    #[arg(long)]
    pub no_timestamp_bg: bool,

    /// Add text shadow/outline effect to timestamp badge
    #[arg(long)]
    pub timestamp_shadow: bool,

    /// Scale factor for timestamp badge font size (default 1.0; use ~1.3 for old-style fonts)
    #[arg(long, default_value_t = 1.0)]
    pub timestamp_font_scale: f32,

    /// Skip time segments when sampling frames (repeatable, format: START_MS:END_MS)
    #[arg(long, value_name = "START_MS:END_MS")]
    pub skip_segment: Vec<String>,
}

#[derive(Args, Debug, Clone, Default)]
pub struct PreviewArgs {
    /// Output JPEG path
    #[arg(long, default_value = "preview.jpg")]
    pub output: String,

    /// Color theme: classic|dark|light|cinematic|minimal
    #[arg(long, default_value = "classic")]
    pub color_theme: String,

    /// Optional path to TTF font for info text
    #[arg(long)]
    pub font_path: Option<String>,

    /// Optional TTF font for branding label Latin characters
    #[arg(long)]
    pub branding_latin_font_path: Option<String>,

    /// Optional TTF font for branding label CJK characters (falls back to branding_latin_font_path)
    #[arg(long)]
    pub branding_cjk_font_path: Option<String>,

    /// Optional monospace TTF font for timestamp badges (falls back to font_path)
    #[arg(long)]
    pub timestamp_font_path: Option<String>,

    /// Branding label
    #[arg(long, default_value = BRANDING_DEFAULT)]
    pub branding_text: String,

    /// Disable branding label
    #[arg(long)]
    pub no_branding: bool,

    /// Disable entire top-left info block
    #[arg(long)]
    pub no_video_info: bool,

    /// Disable file size display
    #[arg(long)]
    pub no_file_size: bool,

    /// Disable resolution and FPS display
    #[arg(long)]
    pub no_resolution_fps: bool,

    /// Disable video encoding info
    #[arg(long)]
    pub no_video_encoding: bool,

    /// Disable audio encoding info
    #[arg(long)]
    pub no_audio_encoding: bool,

    /// Disable duration display
    #[arg(long)]
    pub no_duration: bool,

    /// Disable subtitle count display
    #[arg(long)]
    pub no_subtitles: bool,

    /// Show per-frame HH:MM:SS badge
    #[arg(long)]
    pub show_timestamp: bool,

    /// Disable timestamp badge background rectangle
    #[arg(long)]
    pub no_timestamp_bg: bool,

    /// Add text shadow/outline effect to timestamp badge
    #[arg(long)]
    pub timestamp_shadow: bool,

    /// Scale factor for timestamp badge font size (default 1.0; use ~1.3 for old-style fonts)
    #[arg(long, default_value_t = 1.0)]
    pub timestamp_font_scale: f32,

    /// Thumbnail cell width in pixels (same meaning as the main generate command)
    #[arg(long, default_value_t = 320)]
    pub thumb_width: u32,

    /// Number of rows (1-10)
    #[arg(long, default_value_t = 3)]
    pub rows: u32,

    /// Number of columns (1-12)
    #[arg(long, default_value_t = 2)]
    pub cols: u32,

    /// Overlay label language: en|zh|ja
    #[arg(long, default_value = "en")]
    pub lang: String,

    /// Timestamp badge position
    #[arg(long, default_value_t = crate::image_stitcher::TimestampPosition::InsideBottomLeft)]
    pub timestamp_position: crate::image_stitcher::TimestampPosition,
}
