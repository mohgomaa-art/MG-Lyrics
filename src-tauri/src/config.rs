//! Central configuration for endpoints, user agents, timeouts and matching
//! thresholds. Every value has a default and can be overridden with an
//! environment variable, so nothing network-facing is baked into lib.rs.

use std::time::Duration;

fn env_or(key: &str, default: &str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.trim().trim_end_matches('/').to_string(),
        _ => default.to_string(),
    }
}

fn env_secs(key: &str, default: u64) -> Duration {
    let secs = std::env::var(key)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(default);
    Duration::from_secs(secs)
}

/// Product folder name under %LOCALAPPDATA% (must match the installer).
pub const APP_DIR_NAME: &str = "MG Lyrics Player";

/// Browser-like user agent for Spotify embed pages. Override: MG_LYRICS_BROWSER_UA.
pub fn browser_user_agent() -> String {
    env_or(
        "MG_LYRICS_BROWSER_UA",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    )
}

/// API user agent. Override: MG_LYRICS_API_UA.
pub fn api_user_agent() -> String {
    env_or("MG_LYRICS_API_UA", concat!("MG-Lyrics/", env!("CARGO_PKG_VERSION")))
}

/// lrclib API base, no trailing slash. Override: MG_LYRICS_LRCLIB_URL.
pub fn lrclib_api() -> String {
    env_or("MG_LYRICS_LRCLIB_URL", "https://lrclib.net/api")
}

/// Spotify web base. Override: MG_LYRICS_SPOTIFY_URL.
pub fn spotify_base() -> String {
    env_or("MG_LYRICS_SPOTIFY_URL", "https://open.spotify.com")
}

/// YouTube web base. Override: MG_LYRICS_YOUTUBE_URL.
pub fn youtube_base() -> String {
    env_or("MG_LYRICS_YOUTUBE_URL", "https://www.youtube.com")
}

/// SoundCloud web base. Override: MG_LYRICS_SOUNDCLOUD_URL.
pub fn soundcloud_base() -> String {
    env_or("MG_LYRICS_SOUNDCLOUD_URL", "https://soundcloud.com")
}

/// Timeouts. Overrides: MG_LYRICS_EMBED_TIMEOUT_SECS, MG_LYRICS_HTTP_TIMEOUT_SECS,
/// MG_LYRICS_PLAYLIST_TIMEOUT_SECS.
pub fn embed_timeout() -> Duration { env_secs("MG_LYRICS_EMBED_TIMEOUT_SECS", 8) }
pub fn http_timeout() -> Duration { env_secs("MG_LYRICS_HTTP_TIMEOUT_SECS", 10) }
pub fn playlist_timeout() -> Duration { env_secs("MG_LYRICS_PLAYLIST_TIMEOUT_SECS", 12) }

/// Minimum lrclib confidence score (0-100). Override: MG_LYRICS_MATCH_THRESHOLD.
pub fn match_threshold() -> f64 {
    std::env::var("MG_LYRICS_MATCH_THRESHOLD")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| (0.0..=100.0).contains(v))
        .unwrap_or(65.0)
}
