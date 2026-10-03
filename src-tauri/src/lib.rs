// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::process::Command;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::Manager;


#[derive(Serialize, Deserialize, Clone)]
pub struct LocalTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub file_path: String,
    pub file_url: String,
    pub duration: f64,
}

fn is_command_valid(cmd_name: &str, args: &[&str]) -> bool {
    let mut cmd = Command::new(cmd_name);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    if let Ok(out) = cmd.output() {
        out.status.success() && !String::from_utf8_lossy(&out.stdout).trim().is_empty()
    } else {
        false
    }
}

/// Discovers an executable binary across multiple paths:
/// 1. Current executable directory (and bin/, resources/ subdirectories)
/// 2. User LocalAppData installation directory
/// 3. Current working directory
/// 4. System PATH
fn find_binary_path(name: &str) -> Option<String> {
    let exe_name = format!("{}.exe", name);

    // 1. Check directory of the running executable
    if let Ok(cur_exe) = std::env::current_exe() {
        if let Some(parent) = cur_exe.parent() {
            let direct = parent.join(&exe_name);
            if direct.exists() && is_command_valid(direct.to_str().unwrap_or(""), &["--version"]) {
                return Some(direct.to_string_lossy().to_string());
            }
            let in_bin = parent.join("bin").join(&exe_name);
            if in_bin.exists() && is_command_valid(in_bin.to_str().unwrap_or(""), &["--version"]) {
                return Some(in_bin.to_string_lossy().to_string());
            }
            let in_resources = parent.join("resources").join("bin").join(&exe_name);
            if in_resources.exists() && is_command_valid(in_resources.to_str().unwrap_or(""), &["--version"]) {
                return Some(in_resources.to_string_lossy().to_string());
            }
            let in_res_direct = parent.join("resources").join(&exe_name);
            if in_res_direct.exists() && is_command_valid(in_res_direct.to_str().unwrap_or(""), &["--version"]) {
                return Some(in_res_direct.to_string_lossy().to_string());
            }
        }
    }

    // 2. Check LocalAppData directory
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        let app_bin = PathBuf::from(&local_appdata).join("MG Lyrics Player").join("bin").join(&exe_name);
        if app_bin.exists() && is_command_valid(app_bin.to_str().unwrap_or(""), &["--version"]) {
            return Some(app_bin.to_string_lossy().to_string());
        }
        let app_dir = PathBuf::from(&local_appdata).join("MG Lyrics Player").join(&exe_name);
        if app_dir.exists() && is_command_valid(app_dir.to_str().unwrap_or(""), &["--version"]) {
            return Some(app_dir.to_string_lossy().to_string());
        }
        let winget_link = PathBuf::from(&local_appdata).join("Microsoft").join("WinGet").join("Links").join(&exe_name);
        if winget_link.exists() && is_command_valid(winget_link.to_str().unwrap_or(""), &["--version"]) {
            return Some(winget_link.to_string_lossy().to_string());
        }
    }

    // 3. Check current working directory
    if let Ok(cur_dir) = std::env::current_dir() {
        let direct = cur_dir.join(&exe_name);
        if direct.exists() && is_command_valid(direct.to_str().unwrap_or(""), &["--version"]) {
            return Some(direct.to_string_lossy().to_string());
        }
        let in_bin = cur_dir.join("bin").join(&exe_name);
        if in_bin.exists() && is_command_valid(in_bin.to_str().unwrap_or(""), &["--version"]) {
            return Some(in_bin.to_string_lossy().to_string());
        }
        let in_src_tauri_bin = cur_dir.join("src-tauri").join("bin").join(&exe_name);
        if in_src_tauri_bin.exists() && is_command_valid(in_src_tauri_bin.to_str().unwrap_or(""), &["--version"]) {
            return Some(in_src_tauri_bin.to_string_lossy().to_string());
        }
    }

    // 4. Check system PATH
    if is_command_valid(name, &["--version"]) {
        return Some(name.to_string());
    }
    if is_command_valid(&exe_name, &["--version"]) {
        return Some(exe_name);
    }

    None
}

#[derive(Clone, Debug)]
pub struct StructuredCommand {
    pub program: String,
    pub prefix_args: Vec<String>,
}

fn get_ytdlp_cmd() -> Result<StructuredCommand, String> {
    let mut js_args = vec![];
    if let Some(node_path) = find_binary_path("node") {
        js_args.push("--js-runtimes".to_string());
        js_args.push(format!("node:{}", node_path));
    } else if is_command_valid("node", &["--version"]) {
        js_args.push("--js-runtimes".to_string());
        js_args.push("node".to_string());
    }

    for prog in &["yt-dlp", "yt-dl", "youtube-dl"] {
        if let Some(path) = find_binary_path(prog) {
            return Ok(StructuredCommand {
                program: path,
                prefix_args: js_args,
            });
        }
    }

    for py in &["python", "py", "python3"] {
        if is_command_valid(py, &["-m", "yt_dlp", "--version"]) {
            let mut prefix = vec!["-m".to_string(), "yt_dlp".to_string()];
            prefix.extend(js_args);
            return Ok(StructuredCommand {
                program: py.to_string(),
                prefix_args: prefix,
            });
        }
    }
    Err("yt-dlp not found".to_string())
}

async fn run_ytdlp_args(sc: &StructuredCommand, args: Vec<String>, timeout_secs: u64) -> Result<std::process::Output, String> {
    let sc_clone = sc.clone();
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        tokio::task::spawn_blocking(move || {
            let mut cmd = Command::new(&sc_clone.program);
            cmd.args(&sc_clone.prefix_args);
            cmd.args(&args);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            cmd.output()
        })
    ).await
    .map_err(|_| format!("yt-dlp command timed out after {timeout_secs}s"))?
    .map_err(|e| format!("Task execution error: {e}"))?
    .map_err(|e| format!("Failed to spawn yt-dlp: {e}"))?;

    Ok(res)
}

/// Preserves Unicode alphabets (Arabic, Cyrillic, CJK, accented Latin)
/// while stripping only illegal filesystem characters.
fn sanitize_filename(s: &str) -> String {
    let reserved = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let sanitized: String = s
        .chars()
        .map(|c| if reserved.contains(&c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = sanitized.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        trimmed
    }
}

/// Check whether yt-dlp is installed on the system
#[tauri::command]
fn check_ytdlp() -> Result<String, String> {
    for prog in &["yt-dlp", "yt-dl", "youtube-dl"] {
        if let Some(path) = find_binary_path(prog) {
            return Ok(path);
        }
    }

    // Fallback: check if we can run via python module
    if is_command_valid("python", &["-m", "yt_dlp", "--version"]) {
        return Ok("python -m yt_dlp".to_string());
    }
    if is_command_valid("py", &["-m", "yt_dlp", "--version"]) {
        return Ok("py -m yt_dlp".to_string());
    }
    if is_command_valid("python3", &["-m", "yt_dlp", "--version"]) {
        return Ok("python3 -m yt_dlp".to_string());
    }

    Err("yt-dlp not found".to_string())
}

/// Check whether spotdl is installed on the system
#[tauri::command]
fn check_spotdl() -> Result<String, String> {
    if let Some(path) = find_binary_path("spotdl") {
        return Ok(path);
    }
    for py in &["python", "py", "python3"] {
        if is_command_valid(py, &["-m", "spotdl", "--version"]) {
            return Ok(format!("{} -m spotdl", py));
        }
    }
    Err("spotdl not found".to_string())
}

/// Check whether ffmpeg is installed on the system
#[tauri::command]
fn check_ffmpeg() -> Result<String, String> {
    if let Some(path) = find_binary_path("ffmpeg") {
        let mut cmd = Command::new(&path);
        cmd.args(["-version"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        if let Ok(out) = cmd.output() {
            let ver = String::from_utf8_lossy(&out.stdout);
            let first_line = ver.lines().next().unwrap_or("ffmpeg");
            return Ok(first_line.to_string());
        }
        return Ok(path);
    }
    Err("ffmpeg not found".to_string())
}

/// Return (and auto-create) the local downloads folder
#[tauri::command]
fn get_download_dir() -> Result<String, String> {
    // Try Windows USERPROFILE first, then Unix HOME
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot resolve home directory".to_string())?;

    let dir = PathBuf::from(&home).join("Downloads").join("MG-Lyrics");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create download folder: {e}"))?;

    // Return with forward slashes (works on Windows too)
    Ok(dir.to_string_lossy().replace('\\', "/"))
}

/// Download a single YouTube video OR an entire playlist as MP3 using yt-dlp.
/// For Spotify URLs, spotdl is used instead.
#[tauri::command]
async fn download_audio(url: String, output_dir: String) -> Result<String, String> {
    let is_spotify = url.contains("spotify.com") || url.starts_with("spotify:");

    if is_spotify {
        let is_track = url.contains("/track/") || url.starts_with("spotify:track:");
        if is_track {
            if let Ok(info) = get_preview_info(url.clone(), None, None, None).await {
                let safe_artist = sanitize_filename(&info.artist);
                let safe_title = sanitize_filename(&info.title);
                let out_tmpl = format!("{output_dir}/{safe_artist} - {safe_title}.%(ext)s");
                let sc = get_ytdlp_cmd().map_err(|_| "yt-dlp not found".to_string())?;
                let mut cmd = Command::new(&sc.program);
                cmd.args(&sc.prefix_args);
                let yt_query = format!("ytsearch1:{} {} Official Audio", info.artist, info.title);
                let result = cmd
                    .args([
                        "-x",
                        "--audio-format", "mp3",
                        "--audio-quality", "0",
                        "--embed-metadata",
                        "-o", &out_tmpl,
                        &yt_query,
                    ])
                    .output()
                    .map_err(|e| format!("Download execution failed: {e}"))?;
                if result.status.success() {
                    return Ok(format!("Downloaded Spotify track to: {output_dir}"));
                } else {
                    let stderr = String::from_utf8_lossy(&result.stderr);
                    return Err(format!("Download failed: {stderr}"));
                }
            }
        }

        // Try spotdl if installed
        let mut spotdl_cmd: Option<StructuredCommand> = None;
        if is_command_valid("spotdl", &["--version"]) {
            spotdl_cmd = Some(StructuredCommand { program: "spotdl".to_string(), prefix_args: vec![] });
        } else {
            for py in &["python", "py", "python3"] {
                if is_command_valid(py, &["-m", "spotdl", "--version"]) {
                    spotdl_cmd = Some(StructuredCommand { program: py.to_string(), prefix_args: vec!["-m".to_string(), "spotdl".to_string()] });
                    break;
                }
            }
        }

        if let Some(sc) = spotdl_cmd {
            let mut cmd = Command::new(&sc.program);
            cmd.args(&sc.prefix_args);
            let res = cmd
                .args(["download", &url, "--output", &format!("{output_dir}/{{title}}.{{output-ext}}")])
                .current_dir(&output_dir)
                .output();
            if let Ok(out) = res {
                if out.status.success() {
                    return Ok("Spotify collection downloaded ✓".to_string());
                }
            }
        }

        // Seamless fallback: Parse Spotify collection and download each track via yt-dlp search
        let info = fetch_spotify_playlist_info(&url).await?;
        let sc = get_ytdlp_cmd().map_err(|_| "yt-dlp not found".to_string())?;
        let mut downloaded_count = 0;
        for t in &info.tracks {
            let safe_artist = sanitize_filename(&t.artist);
            let safe_title = sanitize_filename(&t.title);
            let out_tmpl = format!("{output_dir}/{safe_artist} - {safe_title}.%(ext)s");
            let mut cmd = Command::new(&sc.program);
            cmd.args(&sc.prefix_args);
            let yt_query = format!("ytsearch1:{} {} Official Audio", t.artist, t.title);
            let res = cmd
                .args([
                    "-x",
                    "--audio-format", "mp3",
                    "--audio-quality", "0",
                    "--embed-metadata",
                    "-o", &out_tmpl,
                    &yt_query,
                ])
                .output();
            if let Ok(out) = res {
                if out.status.success() {
                    downloaded_count += 1;
                }
            }
        }
        return Ok(format!("Downloaded {downloaded_count}/{} tracks from Spotify collection to: {output_dir}", info.tracks.len()));
    }

    // YouTube / generic URL — use yt-dlp
    let sc = get_ytdlp_cmd().map_err(|_| {
        "yt-dlp is not installed.\nDownload it from: https://github.com/yt-dlp/yt-dlp/releases".to_string()
    })?;

    let out_tmpl = format!("{output_dir}/%(uploader)s - %(title)s.%(ext)s");

    let mut cmd = Command::new(&sc.program);
    cmd.args(&sc.prefix_args);

    let result = cmd
        .args([
            "-x",                      // extract audio only
            "--audio-format", "mp3",
            "--audio-quality", "0",    // best quality
            "--embed-metadata",
            "-o", &out_tmpl,
            "--yes-playlist",          // download full playlist if URL is one
            "--no-warnings",
            &url,
        ])
        .output()
        .map_err(|e| format!("Failed to run {}: {e}", sc.program))?;

    if result.status.success() {
        Ok(format!("Downloaded to: {output_dir}"))
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr);
        // yt-dlp returns exit 1 on partial success sometimes — treat non-empty stdout as ok
        let stdout = String::from_utf8_lossy(&result.stdout);
        if !stdout.is_empty() {
            Ok(format!("Downloaded (with warnings) to: {output_dir}"))
        } else {
            Err(stderr.to_string())
        }
    }
}

/// Scan the download folder and return all audio files as LocalTrack structs
#[tauri::command]
fn scan_local_tracks(dir: String) -> Result<Vec<LocalTrack>, String> {
    let path = PathBuf::from(&dir);
    let mut tracks: Vec<LocalTrack> = Vec::new();

    let entries = std::fs::read_dir(&path)
        .map_err(|e| format!("Cannot read directory {dir}: {e}"))?;

    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        if !["mp3", "flac", "ogg", "wav", "aac", "m4a", "opus"].contains(&ext.as_str()) {
            continue;
        }

        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        // Split "Artist - Title" convention
        let (artist, title) = if let Some(pos) = stem.find(" - ") {
            let a = stem[..pos].trim().to_string();
            let t = stem[pos + 3..].trim().to_string();
            (a, t)
        } else {
            ("Unknown Artist".to_string(), stem.clone())
        };

        // Convert OS path to file:/// URL (cross-platform)
        let raw = p.to_string_lossy().replace('\\', "/");
        let file_url = format!("file:///{}", raw.trim_start_matches('/'));

        let id = format!("local-{}", stem);
        tracks.push(LocalTrack {
            id,
            title,
            artist,
            file_path: raw.clone(),
            file_url,
            duration: 0.0, // browser will load real duration
        });
    }

    tracks.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(tracks)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PreviewInfo {
    pub title: String,
    pub artist: String,
    pub thumbnail: String,
    pub stream_url: String,
    pub video_url: String,
    pub is_playable: bool,
    pub provider: String,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub album: Option<String>,
}

/// Clean a track name for matching.
/// Removes: (Official Video), [Lyrics], feat. X, - Official Audio, etc.
fn clean_query(s: &str) -> String {
    let mut out = s.to_string();
    let open_chars  = ['(', '[', '{'];
    let close_chars = [')', ']', '}'];
    loop {
        if let Some(o) = out.find(|c| open_chars.contains(&c)) {
            if let Some(rel) = out[o..].find(|c| close_chars.contains(&c)) {
                let c = o + rel;
                out.replace_range(o..=c, "");
                continue;
            }
        }
        break;
    }
    for pat in &["feat.", " ft.", " ft "] {
        if let Some(p) = out.to_lowercase().find(pat) { out.truncate(p); break; }
    }
    let suffixes = [" - official", " - lyric", " - audio", " - video", " - hd", " - live"];
    let lower = out.to_lowercase();
    for suf in &suffixes {
        if let Some(p) = lower.find(suf) { out.truncate(p); break; }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Normalize a string for matching: lowercase, strip punctuation, collapse whitespace.
fn normalize_for_match(s: &str) -> String {
    let lower = s.to_lowercase();
    let cleaned: String = lower.chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' { c } else { ' ' })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Levenshtein distance between two strings.
fn levenshtein(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let m = a_chars.len();
    let n = b_chars.len();
    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in 0..=m { dp[i][0] = i; }
    for j in 0..=n { dp[0][j] = j; }
    for i in 1..=m {
        for j in 1..=n {
            let cost = if a_chars[i - 1] == b_chars[j - 1] { 0 } else { 1 };
            dp[i][j] = (dp[i - 1][j] + 1)
                .min(dp[i][j - 1] + 1)
                .min(dp[i - 1][j - 1] + cost);
        }
    }
    dp[m][n]
}

/// Returns 0.0–1.0 similarity using normalized Levenshtein distance.
fn string_similarity(a: &str, b: &str) -> f64 {
    let na = normalize_for_match(a);
    let nb = normalize_for_match(b);
    if na.is_empty() && nb.is_empty() { return 1.0; }
    if na.is_empty() || nb.is_empty() { return 0.0; }
    let max_len = na.len().max(nb.len());
    let dist = levenshtein(&na, &nb);
    1.0 - (dist as f64 / max_len as f64)
}

/// Extract the primary artist name when multiple artists or features are present
fn get_primary_artist(artist: &str) -> String {
    let mut a = artist.to_string();
    for delim in &[",", "&", " feat.", " ft.", " feat ", " ft ", "/", ";"] {
        if let Some(pos) = a.to_lowercase().find(delim) {
            a.truncate(pos);
            break;
        }
    }
    a.trim().to_string()
}

/// Score an audio candidate from YouTube to pick the clean studio cut matching track & lyrics.
fn score_audio_candidate(
    title: &str,
    channel: &str,
    uploader: &str,
    cand_duration: f64,
    expected_duration: Option<f64>,
    expected_artist: Option<&str>,
    expected_album: Option<&str>,
) -> f64 {
    let mut score = 50.0;
    let t_lower = title.to_lowercase();
    let c_lower = channel.to_lowercase();
    let u_lower = uploader.to_lowercase();

    // 1. Duration check — essential to prevent music video dialogues / movie scenes / extended cuts
    if let Some(exp_dur) = expected_duration {
        if exp_dur > 15.0 && cand_duration > 0.0 {
            let diff = (cand_duration - exp_dur).abs();
            if diff <= 2.5 {
                score += 50.0; // Near exact match to studio release
            } else if diff <= 6.0 {
                score += 25.0;
            } else if diff <= 12.0 {
                score += 10.0;
            } else if diff <= 25.0 {
                score -= 20.0;
            } else if diff <= 45.0 {
                score -= 60.0;
            } else {
                score -= 100.0; // Fatal penalty: music video with dialogue intro!
            }
        }
    }

    // 2. Official audio / topic channel bonus
    if c_lower.ends_with("- topic") || u_lower.ends_with("- topic") {
        score += 40.0; // YouTube Music studio cut
    }
    if t_lower.contains("official audio") || t_lower.contains("(audio)") || t_lower.contains(" - audio") {
        score += 30.0;
    }
    if t_lower.contains("lyrics") || t_lower.contains("lyric video") {
        score += 15.0; // Lyric videos virtually always use the studio master
    }

    // 3. Negative penalties for music videos / movies / dialogues
    if t_lower.contains("official music video") || t_lower.contains("official video") || t_lower.contains("music video") {
        score -= 45.0; // Dialogue scenes, sirens, prolonged video intros
    }
    if t_lower.contains("movie") || t_lower.contains("film") || t_lower.contains("teaser") {
        score -= 50.0;
    }
    if t_lower.contains("live") || t_lower.contains("concert") || t_lower.contains("tour") {
        score -= 35.0;
    }
    if t_lower.contains("remix") {
        score -= 25.0;
    }

    // 4. Artist match
    if let Some(artist) = expected_artist {
        let a_norm = normalize_for_match(artist);
        if !a_norm.is_empty() {
            let prim = normalize_for_match(&get_primary_artist(artist));
            if c_lower.contains(&a_norm) || u_lower.contains(&a_norm) || t_lower.contains(&a_norm) {
                score += 20.0;
            } else if !prim.is_empty() && (c_lower.contains(&prim) || u_lower.contains(&prim) || t_lower.contains(&prim)) {
                score += 15.0;
            }
        }
    }

    // 5. Album match
    if let Some(album) = expected_album {
        let alb_norm = normalize_for_match(album);
        if !alb_norm.is_empty() && alb_norm.len() > 3 && !["online", "single", "local download", "online discovery"].contains(&alb_norm.as_str()) {
            if t_lower.contains(&alb_norm) || c_lower.contains(&alb_norm) || u_lower.contains(&alb_norm) {
                score += 15.0;
            }
        }
    }

    score
}

fn is_playable_http_audio(url: &str) -> bool {
    !url.is_empty() && !url.contains(".m3u8") && !url.contains("manifest")
}

/// Helper to extract audio stream URL from yt-dlp JSON value
fn extract_stream_url_from_json(v: &serde_json::Value) -> String {
    if let Some(u) = v["url"].as_str() {
        if is_playable_http_audio(u) {
            return u.to_string();
        }
    }

    if let Some(fmts) = v["requested_formats"].as_array() {
        if let Some(u) = fmts.iter()
            .filter(|f| f["acodec"].as_str().unwrap_or("none") != "none")
            .filter_map(|f| f["url"].as_str())
            .filter(|u| is_playable_http_audio(u))
            .last() {
            return u.to_string();
        }
    }

    if let Some(fmts) = v["formats"].as_array() {
        if let Some(u) = fmts.iter()
            .filter(|f| f["acodec"].as_str().unwrap_or("none") != "none" && f["vcodec"].as_str().unwrap_or("none") == "none")
            .filter_map(|f| f["url"].as_str())
            .filter(|u| is_playable_http_audio(u))
            .last() {
            return u.to_string();
        }
        if let Some(u) = fmts.iter()
            .filter(|f| f["acodec"].as_str().unwrap_or("none") != "none")
            .filter_map(|f| f["url"].as_str())
            .filter(|u| is_playable_http_audio(u))
            .last() {
            return u.to_string();
        }
    }

    v["url"].as_str().unwrap_or_default().to_string()
}

#[tauri::command]
async fn get_preview_info(
    input: String,
    expected_duration: Option<f64>,
    expected_artist: Option<String>,
    expected_album: Option<String>,
) -> Result<PreviewInfo, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Empty input".to_string());
    }

    // Direct audio file or direct CDN preview stream
    if input.contains("p.scdn.co/mp3-preview") || input.ends_with(".mp3") || input.ends_with(".m4a") || input.ends_with(".opus") {
        return Ok(PreviewInfo {
            title: "Audio Stream".to_string(),
            artist: "Direct Audio".to_string(),
            thumbnail: "".to_string(),
            stream_url: input.to_string(),
            video_url: input.to_string(),
            is_playable: true,
            provider: if input.contains("p.scdn.co") { "spotify".to_string() } else { "youtube".to_string() },
            duration: None,
            album: None,
        });
    }

    let is_spotify = (input.contains("spotify.com") && input.contains("/track/")) || input.starts_with("spotify:track:");
    let is_soundcloud = input.contains("soundcloud.com/");
    let is_direct_youtube = (input.contains("youtube.com/watch") || input.contains("youtu.be/")) && !input.starts_with("ytsearch");
    let is_sc_search = input.starts_with("sc:");

    let provider = if is_spotify {
        "spotify".to_string()
    } else if is_soundcloud || is_sc_search {
        "soundcloud".to_string()
    } else {
        "youtube".to_string()
    };

    let sc = get_ytdlp_cmd().map_err(|_| "yt-dlp is not installed".to_string())?;

    // Direct YouTube or SoundCloud URL
    if is_direct_youtube || is_soundcloud {
        let output = run_ytdlp_args(&sc, vec![
            "--dump-json".to_string(),
            "-f".to_string(), "ba[ext=m4a]/ba[abr<=128]/ba".to_string(),
            "--force-ipv4".to_string(),
            "--no-warnings".to_string(),
            input.to_string(),
        ], 10).await?;

        let stdout_str = String::from_utf8_lossy(&output.stdout);
        let v: serde_json::Value = stdout_str
            .lines()
            .filter(|l| l.trim_start().starts_with('{'))
            .find_map(|l| serde_json::from_str(l).ok())
            .ok_or_else(|| "Failed to parse stream metadata from yt-dlp".to_string())?;

        let title = v["title"].as_str().unwrap_or("Unknown").to_string();
        let artist = v["uploader"].as_str()
            .or_else(|| v["artist"].as_str())
            .or_else(|| v["channel"].as_str())
            .unwrap_or("Unknown Artist")
            .to_string();
        let thumbnail = v["thumbnail"].as_str().unwrap_or("").to_string();
        let video_url = v["webpage_url"].as_str().unwrap_or(input).to_string();
        let stream_url = extract_stream_url_from_json(&v);
        let duration = v["duration"].as_f64();

        return Ok(PreviewInfo {
            title,
            artist,
            thumbnail,
            stream_url: stream_url.clone(),
            video_url,
            is_playable: !stream_url.is_empty(),
            provider,
            duration,
            album: None,
        });
    }

    let mut target_query = String::new();
    let mut effective_expected_duration = expected_duration;
    let mut effective_expected_artist = expected_artist;
    let mut effective_expected_album = expected_album;
    let mut spotify_title = String::new();
    let mut spotify_artist = String::new();
    let mut spotify_thumbnail = String::new();
    let mut spotify_album = String::new();

    if is_spotify {
        let track_id = if let Some(pos) = input.find("track/") {
            let rest = &input[pos + 6..];
            rest.split(['?', '&', '/', '#']).next().unwrap_or("")
        } else if let Some(pos) = input.find("track:") {
            let rest = &input[pos + 6..];
            rest.split(['?', '&', '/', '#']).next().unwrap_or("")
        } else {
            ""
        };

        if !track_id.is_empty() {
            let embed_url = format!("https://open.spotify.com/embed/track/{track_id}");
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(8))
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                .build()
                .map_err(|e| format!("HTTP client error: {e}"))?;

            if let Ok(resp) = client.get(&embed_url).send().await {
                if resp.status().is_success() {
                    if let Ok(html) = resp.text().await {
                        let marker = "<script id=\"__NEXT_DATA__\" type=\"application/json\">";
                        if let Some(start_idx) = html.find(marker) {
                            let json_start = start_idx + marker.len();
                            if let Some(end_rel) = html[json_start..].find("</script>") {
                                let json_str = &html[json_start..json_start + end_rel];
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                                    let entity = &v["props"]["pageProps"]["state"]["data"]["entity"];
                                    spotify_title = entity["name"].as_str().unwrap_or("").to_string();
                                    spotify_artist = entity["artists"]
                                        .as_array()
                                        .and_then(|a| a.first())
                                        .and_then(|art| art["name"].as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    spotify_album = entity["album"]["name"].as_str().unwrap_or("").to_string();
                                    let dur_ms = entity["duration"].as_f64().unwrap_or(0.0);
                                    if dur_ms > 0.0 {
                                        effective_expected_duration = Some(dur_ms / 1000.0);
                                    }
                                    if !spotify_artist.is_empty() {
                                        effective_expected_artist = Some(spotify_artist.clone());
                                    }
                                    if !spotify_album.is_empty() {
                                        effective_expected_album = Some(spotify_album.clone());
                                    }
                                    spotify_thumbnail = entity["visualIdentity"]["image"]
                                        .as_array()
                                        .and_then(|arr| arr.last())
                                        .and_then(|img| img["url"].as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    if !spotify_title.is_empty() {
                                        target_query = format!("{} - {} Official Audio", spotify_artist, spotify_title).trim().to_string();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if target_query.is_empty() {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .user_agent("MG-Lyrics/1.0")
                .build()
                .map_err(|e| format!("HTTP client error: {e}"))?;
            let encoded_input = urlencoding::encode(input);
            let url = format!("https://open.spotify.com/oembed?url={}", encoded_input);
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    if let Ok(v) = resp.json::<serde_json::Value>().await {
                        spotify_title = v["title"].as_str().unwrap_or("").to_string();
                        spotify_artist = v["author_name"].as_str().unwrap_or("").to_string();
                        if !spotify_artist.is_empty() {
                            effective_expected_artist = Some(spotify_artist.clone());
                        }
                        target_query = format!("{} - {} Official Audio", spotify_artist, spotify_title).trim().to_string();
                    }
                }
            }
        }
    } else if is_sc_search {
        target_query = format!("scsearch1:{}", input.trim_start_matches("sc:").trim());
    } else {
        let clean = clean_query(input);
        if clean.to_lowercase().contains("audio") || clean.to_lowercase().contains("video") {
            target_query = clean;
        } else {
            target_query = format!("{} Official Audio", clean);
        }
    }

    if target_query.is_empty() {
        target_query = input.to_string();
    }

    let mut chosen_url = String::new();
    let mut candidate_entries: Vec<serde_json::Value> = Vec::new();

    if !is_sc_search {
        let search_res = run_ytdlp_args(&sc, vec![
            "--dump-single-json".to_string(),
            "--flat-playlist".to_string(),
            "--playlist-end".to_string(), "5".to_string(),
            "--force-ipv4".to_string(),
            "--no-warnings".to_string(),
            "--quiet".to_string(),
            format!("ytsearch5:{}", target_query),
        ], 12).await;

        if let Ok(search_out) = search_res {
            let stdout_str = String::from_utf8_lossy(&search_out.stdout);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout_str) {
                if let Some(entries) = v["entries"].as_array() {
                    candidate_entries = entries.clone();
                }
            }
        }
    }

    if !candidate_entries.is_empty() {
        let mut scored: Vec<(f64, String, String, f64, String)> = candidate_entries.iter().filter_map(|e| {
            let id = e["id"].as_str()?;
            let title = e["title"].as_str().unwrap_or("");
            let channel = e["channel"].as_str().or_else(|| e["uploader"].as_str()).unwrap_or("");
            let uploader = e["uploader"].as_str().unwrap_or("");
            let duration = e["duration"].as_f64().unwrap_or(0.0);
            let thumb = e["thumbnail"].as_str().unwrap_or("").to_string();

            let score = score_audio_candidate(
                title,
                channel,
                uploader,
                duration,
                effective_expected_duration,
                effective_expected_artist.as_deref(),
                effective_expected_album.as_deref(),
            );

            eprintln!("[audio_ranker] CANDIDATE: score={:.1} dur={:.0}s title=\"{}\" channel=\"{}\" id={}",
                score, duration, title, channel, id);

            Some((score, id.to_string(), title.to_string(), duration, thumb))
        }).collect();

        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        if let Some(best) = scored.first() {
            eprintln!("[audio_ranker] WINNER: score={:.1} id={} title=\"{}\"", best.0, best.1, best.2);
            chosen_url = format!("https://www.youtube.com/watch?v={}", best.1);
        }
    }

    if chosen_url.is_empty() {
        chosen_url = format!("ytsearch1:{}", target_query);
    }

    let mut args: Vec<String> = vec![
        "--dump-json".to_string(),
        "-f".to_string(),
        "ba[ext=m4a][protocol^=http]/ba[protocol^=http]/ba[abr<=128]/ba".to_string(),
        "--force-ipv4".to_string(),
        "--no-warnings".to_string(),
    ];
    if chosen_url.starts_with("ytsearch") || chosen_url.starts_with("scsearch") {
        args.push("--playlist-items".to_string());
        args.push("1".to_string());
    } else {
        args.push("--no-playlist".to_string());
    }
    args.push(chosen_url.clone());

    let output = run_ytdlp_args(&sc, args, 15).await?;

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let stderr_str = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() && stdout_str.trim().is_empty() {
        return Err(format!("yt-dlp failed: {}", stderr_str.trim()));
    }

    let v: serde_json::Value = stdout_str
        .lines()
        .filter(|l| l.trim_start().starts_with('{'))
        .find_map(|l| serde_json::from_str(l).ok())
        .ok_or_else(|| format!("No valid JSON in yt-dlp output: {}", stderr_str.trim()))?;

    let stream_url = extract_stream_url_from_json(&v);
    let duration = v["duration"].as_f64().or(effective_expected_duration);

    let title = if !spotify_title.is_empty() {
        spotify_title
    } else {
        v["title"].as_str().unwrap_or("Unknown").to_string()
    };

    let artist = if !spotify_artist.is_empty() {
        spotify_artist
    } else {
        v["uploader"]
            .as_str()
            .or_else(|| v["artist"].as_str())
            .or_else(|| v["channel"].as_str())
            .unwrap_or("Unknown Artist")
            .to_string()
    };

    let thumbnail = if !spotify_thumbnail.is_empty() {
        spotify_thumbnail
    } else {
        v["thumbnail"].as_str().unwrap_or("").to_string()
    };

    let video_url = v["webpage_url"].as_str().unwrap_or(&chosen_url).to_string();

    Ok(PreviewInfo {
        title,
        artist,
        thumbnail,
        stream_url: stream_url.clone(),
        video_url,
        is_playable: !stream_url.is_empty(),
        provider,
        duration,
        album: if !spotify_album.is_empty() { Some(spotify_album) } else { effective_expected_album },
    })
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LyricLine {
    pub time: f64,
    pub text: String,
}

/// Parse LRC timed lyrics into LyricLine vec
fn parse_lrc(lrc: &str) -> Vec<LyricLine> {
    let mut lines: Vec<LyricLine> = Vec::new();
    for raw in lrc.lines() {
        let raw = raw.trim();
        if raw.is_empty() { continue; }
        // Extract all timestamps like [mm:ss.xx]
        let mut times: Vec<f64> = Vec::new();
        let mut rest = raw;
        while rest.starts_with('[') {
            if let Some(close) = rest.find(']') {
                let tag = &rest[1..close];
                // only parse if it looks like a timestamp
                if let Some(t) = parse_timestamp(tag) {
                    times.push(t);
                } else {
                    break; // metadata tag, stop
                }
                rest = &rest[close + 1..];
            } else {
                break;
            }
        }
        let text = rest.trim().to_string();
        if text.is_empty() || times.is_empty() { continue; }
        for t in times {
            lines.push(LyricLine { time: t, text: text.clone() });
        }
    }
    lines.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    lines
}

fn parse_timestamp(s: &str) -> Option<f64> {
    // mm:ss.xx or mm:ss
    let colon = s.find(':')?;
    let mins: f64 = s[..colon].parse().ok()?;
    let secs: f64 = s[colon + 1..].parse().ok()?;
    Some(mins * 60.0 + secs)
}

fn parse_plain(plain: &str, duration_sec: f64) -> Vec<LyricLine> {
    let lines: Vec<&str> = plain.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() { return vec![]; }
    let step = if duration_sec > 0.0 { duration_sec / lines.len() as f64 } else { 5.0 };
    lines.iter().enumerate()
        .map(|(i, &text)| LyricLine { time: i as f64 * step, text: text.to_string() })
        .collect()
}

fn extract_lyrics_from_json(data: &serde_json::Value, duration_sec: f64) -> Option<Vec<LyricLine>> {
    if let Some(synced) = data["syncedLyrics"].as_str() {
        if !synced.is_empty() {
            let lines = parse_lrc(synced);
            if !lines.is_empty() { return Some(lines); }
        }
    }
    if let Some(plain) = data["plainLyrics"].as_str() {
        if !plain.is_empty() {
            let dur = data["duration"].as_f64().unwrap_or(duration_sec);
            let lines = parse_plain(plain, dur);
            if !lines.is_empty() { return Some(lines); }
        }
    }
    if data["instrumental"].as_bool().unwrap_or(false) {
        return Some(vec![LyricLine { time: 0.0, text: "✦ Instrumental ✦".to_string() }]);
    }
    None
}

/// Clean a track name for lrclib matching.
/// Compute a confidence score (0–100) for a lyrics match.
fn match_confidence(
    result_title: &str,
    result_artist: &str,
    result_album: Option<&str>,
    result_duration: Option<f64>,
    query_title: &str,
    query_artist: &str,
    query_album: Option<&str>,
    query_duration: f64,
) -> f64 {
    let query_t = normalize_for_match(query_title);
    let result_t = normalize_for_match(result_title);
    let title_sim = if query_t == result_t {
        1.0
    } else if !query_t.is_empty() && !result_t.is_empty() && (query_t.contains(&result_t) || result_t.contains(&query_t)) {
        0.90
    } else {
        string_similarity(query_title, result_title)
    };

    let query_a = normalize_for_match(query_artist);
    let result_a = normalize_for_match(result_artist);
    let prim_q = normalize_for_match(&get_primary_artist(query_artist));
    let prim_r = normalize_for_match(&get_primary_artist(result_artist));

    let artist_sim = if query_a == result_a || (!prim_q.is_empty() && prim_q == prim_r) {
        1.0
    } else if !query_a.is_empty() && !result_a.is_empty() && (query_a.contains(&result_a) || result_a.contains(&query_a)) {
        0.94
    } else if !prim_q.is_empty() && (query_a.contains(&prim_r) || result_a.contains(&prim_q)) {
        0.90
    } else {
        string_similarity(query_artist, result_artist)
    };

    let title_score = title_sim * 45.0;
    let artist_score = artist_sim * 35.0;

    let album_score = if let (Some(qa), Some(ra)) = (query_album, result_album) {
        let nqa = normalize_for_match(qa);
        let nra = normalize_for_match(ra);
        if !nqa.is_empty() && !nra.is_empty() && !["online", "single", "local download", "online discovery"].contains(&nqa.as_str()) {
            if nqa == nra {
                20.0
            } else if nqa.contains(&nra) || nra.contains(&nqa) {
                12.0
            } else {
                -5.0
            }
        } else {
            0.0
        }
    } else {
        0.0
    };

    let duration_score = if query_duration > 15.0 {
        if let Some(res_dur) = result_duration {
            let diff = (res_dur - query_duration).abs();
            if diff <= 2.5 {
                25.0
            } else if diff <= 6.0 {
                15.0
            } else if diff <= 15.0 {
                5.0
            } else if diff <= 30.0 {
                -20.0
            } else if diff <= 45.0 {
                -50.0 // Heavy penalty: likely different edit or remix
            } else {
                -100.0 // Fatal penalty: music video intro/outro or completely wrong track!
            }
        } else {
            0.0
        }
    } else {
        0.0
    };

    title_score + artist_score + album_score + duration_score
}

const MATCH_THRESHOLD: f64 = 65.0;

/// Check whether a lrclib result is a plausible match for the requested title/artist/album.
/// Returns the confidence score (0-100) or 0 if below threshold.
fn score_match(
    item: &serde_json::Value,
    clean_title: &str,
    clean_artist: &str,
    clean_album: Option<&str>,
    duration_sec: f64,
) -> f64 {
    let res_title  = item["trackName"].as_str()
        .or_else(|| item["title"].as_str()).unwrap_or("");
    let res_artist = item["artistName"].as_str()
        .or_else(|| item["artist"].as_str()).unwrap_or("");
    let res_album = item["albumName"].as_str()
        .or_else(|| item["album"].as_str());
    let res_duration = item["duration"].as_f64();

    let score = match_confidence(res_title, res_artist, res_album, res_duration, clean_title, clean_artist, clean_album, duration_sec);

    eprintln!("[lyrics] SCORE: {:.1} | query=\"{} - {} (alb: {:?})\" result=\"{} - {} (alb: {:?})\" dur_q={:.0} dur_r={:?}",
        score, clean_artist, clean_title, clean_album, res_artist, res_title, res_album, duration_sec,
        res_duration.map(|d| format!("{:.0}", d)).unwrap_or_else(|| "?".to_string()));

    if score >= MATCH_THRESHOLD { score } else { 0.0 }
}

/// Pick the best-scoring result from a lrclib search array.
/// Returns the lyrics from the highest-confidence match above MATCH_THRESHOLD, preferring synced lyrics.
fn pick_best_match(
    arr: &[serde_json::Value],
    clean_title: &str,
    clean_artist: &str,
    clean_album: Option<&str>,
    duration_sec: f64,
) -> Option<Vec<LyricLine>> {
    let mut scored: Vec<(f64, usize, bool)> = arr.iter().enumerate()
        .map(|(i, item)| {
            let raw_score = score_match(item, clean_title, clean_artist, clean_album, duration_sec);
            let has_synced = item["syncedLyrics"].as_str().map_or(false, |s| !s.trim().is_empty());
            let final_score = if has_synced { raw_score + 20.0 } else { raw_score };
            (final_score, i, has_synced)
        })
        .filter(|(score, _, _)| *score >= MATCH_THRESHOLD)
        .collect();

    // Sort: highest score first, prefer synced at same score
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.2.cmp(&a.2))
    });

    for (score, idx, _) in &scored {
        let item = &arr[*idx];
        let res_title = item["trackName"].as_str()
            .or_else(|| item["title"].as_str()).unwrap_or("?");
        let res_artist = item["artistName"].as_str()
            .or_else(|| item["artist"].as_str()).unwrap_or("?");

        if let Some(lyrics) = extract_lyrics_from_json(item, duration_sec) {
            eprintln!("[lyrics] SELECTED_RESULT: score={:.1} \"{}\" by \"{}\" ({} lines)",
                score, res_title, res_artist, lyrics.len());
            return Some(lyrics);
        }
    }

    if !scored.is_empty() {
        eprintln!("[lyrics] REJECTED_RESULT: {} candidates above threshold but none had extractable lyrics", scored.len());
    }

    None
}

/// Fetch synced lyrics from lrclib.net with multi-detail verification (title, artist, album, duration).
#[tauri::command]
async fn fetch_lyrics(
    title: String,
    artist: String,
    duration_sec: f64,
    album: Option<String>,
) -> Result<Vec<LyricLine>, String> {
    eprintln!("[lyrics] SEARCH_STARTED: title=\"{}\" artist=\"{}\" album={:?} duration={:.0}s", title, artist, album, duration_sec);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("MG-Lyrics/1.0")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let ct = clean_query(&title);
    let ca = clean_query(&artist);
    let pa = clean_query(&get_primary_artist(&artist));
    let calb = album.as_deref().map(clean_query).unwrap_or_default();
    let alb_opt = if !calb.is_empty() && !["online", "single", "local download", "online discovery"].contains(&normalize_for_match(&calb).as_str()) {
        Some(calb.as_str())
    } else {
        None
    };

    eprintln!("[lyrics] CLEANED: title=\"{}\" artist=\"{}\" primary_artist=\"{}\" album={:?}", ct, ca, pa, alb_opt);

    // ── Step 0: Direct GET with Album & Duration (Highest Precision Studio Match) ──
    if let Some(alb) = alb_opt {
        for art in [&ca, &pa] {
            if art.is_empty() { continue; }
            let mut url = format!(
                "https://lrclib.net/api/get?track_name={}&artist_name={}&album_name={}",
                urlencoding::encode(&ct),
                urlencoding::encode(art),
                urlencoding::encode(alb)
            );
            if duration_sec > 0.0 {
                url.push_str(&format!("&duration={}", duration_sec as u64));
            }
            eprintln!("[lyrics] STEP0: Album GET for artist=\"{}\" album=\"{}\"", art, alb);
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    if let Ok(data) = resp.json::<serde_json::Value>().await {
                        if !data.is_null() {
                            let score = score_match(&data, &ct, &ca, alb_opt, duration_sec);
                            if score >= MATCH_THRESHOLD {
                                if let Some(lyrics) = extract_lyrics_from_json(&data, duration_sec) {
                                    eprintln!("[lyrics] STEP0_ALBUM_HIT: matched score={:.1}, {} lines", score, lyrics.len());
                                    return Ok(lyrics);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Step 1: Direct GET with duration (Accurate standard track) ──
    for art in [&ca, &pa] {
        if art.is_empty() { continue; }
        let mut url = format!(
            "https://lrclib.net/api/get?track_name={}&artist_name={}",
            urlencoding::encode(&ct),
            urlencoding::encode(art)
        );
        if duration_sec > 0.0 {
            url.push_str(&format!("&duration={}", duration_sec as u64));
        }
        eprintln!("[lyrics] STEP1: Direct GET with duration for artist=\"{}\"", art);
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if !data.is_null() {
                        let score = score_match(&data, &ct, &ca, alb_opt, duration_sec);
                        if score >= MATCH_THRESHOLD {
                            if let Some(lyrics) = extract_lyrics_from_json(&data, duration_sec) {
                                eprintln!("[lyrics] STEP1_HIT: Direct GET matched with score={:.1}, {} lines", score, lyrics.len());
                                return Ok(lyrics);
                            }
                        } else {
                            eprintln!("[lyrics] STEP1_REJECTED: Direct GET result score={:.1} below threshold {:.0}", score, MATCH_THRESHOLD);
                        }
                    }
                }
            }
        }
    }

    // ── Step 2: Direct GET without duration (lenient) ──
    for art in [&ca, &pa] {
        if art.is_empty() { continue; }
        let url = format!(
            "https://lrclib.net/api/get?track_name={}&artist_name={}",
            urlencoding::encode(&ct),
            urlencoding::encode(art)
        );
        eprintln!("[lyrics] STEP2: Direct GET without duration for artist=\"{}\"", art);
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if !data.is_null() {
                        let score = score_match(&data, &ct, &ca, alb_opt, duration_sec);
                        if score >= MATCH_THRESHOLD {
                            if let Some(lyrics) = extract_lyrics_from_json(&data, duration_sec) {
                                eprintln!("[lyrics] STEP2_HIT: Direct GET (no dur) matched with score={:.1}, {} lines", score, lyrics.len());
                                return Ok(lyrics);
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Step 3: Fuzzy search with album, artist and title ──
    let mut search_queries = Vec::new();
    if let Some(alb) = alb_opt {
        search_queries.push(format!("{} {} {}", ca, ct, alb));
    }
    search_queries.push(format!("{} {}", ca, ct));
    if !pa.is_empty() && pa != ca {
        search_queries.push(format!("{} {}", pa, ct));
    }
    for q in search_queries {
        let url = format!("https://lrclib.net/api/search?q={}", urlencoding::encode(&q));
        eprintln!("[lyrics] STEP3: Fuzzy search q=\"{}\"", q);
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if let Some(arr) = data.as_array() {
                        eprintln!("[lyrics] STEP3: {} results returned for \"{}\"", arr.len(), q);
                        if let Some(lyrics) = pick_best_match(arr, &ct, &ca, alb_opt, duration_sec) {
                            return Ok(lyrics);
                        }
                    }
                }
            }
        }
    }

    // ── Step 4: Fuzzy search title only — pick best scored match ──
    {
        let url = format!("https://lrclib.net/api/search?q={}", urlencoding::encode(&ct));
        eprintln!("[lyrics] STEP4: Title-only search q=\"{}\"", ct);
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if let Some(arr) = data.as_array() {
                        eprintln!("[lyrics] STEP4: {} results returned", arr.len());
                        if let Some(lyrics) = pick_best_match(arr, &ct, &ca, alb_opt, duration_sec) {
                            return Ok(lyrics);
                        }
                    }
                }
            }
        }
    }

    eprintln!("[lyrics] NO_MATCH: No reliable lyrics found for \"{}\" by \"{}\"", title, artist);
    Err("Lyrics not found".to_string())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlaylistTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration: f64,
    pub video_url: String,
    #[serde(default)]
    pub stream_url: Option<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlaylistInfo {
    pub title: String,
    pub description: String,
    pub thumbnail: String,
    pub uploader: String,
    #[serde(default)]
    pub source: String,
    pub tracks: Vec<PlaylistTrack>,
}

async fn fetch_spotify_playlist_info(url: &str) -> Result<PlaylistInfo, String> {
    let clean_url = url.trim().trim_matches(|c| c == '\'' || c == '"' || c == '`' || c == '<' || c == '>' || c == ' ');
    let (entity_type, raw_id) = if let Some(pos) = clean_url.find("playlist/") {
        let rest = &clean_url[pos + 9..];
        let id = rest.split(['?', '&', '/', '#']).next().unwrap_or("");
        ("playlist", id)
    } else if let Some(pos) = clean_url.find("playlist:") {
        let rest = &clean_url[pos + 9..];
        let id = rest.split(['?', '&', '/', '#']).next().unwrap_or("");
        ("playlist", id)
    } else if let Some(pos) = clean_url.find("album/") {
        let rest = &clean_url[pos + 6..];
        let id = rest.split(['?', '&', '/', '#']).next().unwrap_or("");
        ("album", id)
    } else if let Some(pos) = clean_url.find("album:") {
        let rest = &clean_url[pos + 6..];
        let id = rest.split(['?', '&', '/', '#']).next().unwrap_or("");
        ("album", id)
    } else if let Some(pos) = clean_url.find("artist/") {
        let rest = &clean_url[pos + 7..];
        let id = rest.split(['?', '&', '/', '#']).next().unwrap_or("");
        ("artist", id)
    } else if let Some(pos) = clean_url.find("artist:") {
        let rest = &clean_url[pos + 7..];
        let id = rest.split(['?', '&', '/', '#']).next().unwrap_or("");
        ("artist", id)
    } else if let Some(pos) = clean_url.find("track/") {
        let rest = &clean_url[pos + 6..];
        let id = rest.split(['?', '&', '/', '#']).next().unwrap_or("");
        ("track", id)
    } else if let Some(pos) = clean_url.find("track:") {
        let rest = &clean_url[pos + 6..];
        let id = rest.split(['?', '&', '/', '#']).next().unwrap_or("");
        ("track", id)
    } else {
        return Err("Please enter a valid Spotify playlist, album, artist, or track URL".to_string());
    };

    let id: String = raw_id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if id.is_empty() {
        return Err("Invalid Spotify URL: missing ID".to_string());
    }

    let embed_url = format!("https://open.spotify.com/embed/{entity_type}/{id}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client.get(&embed_url).send().await
        .map_err(|e| format!("Failed to reach Spotify embed service: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Spotify returned error status: {}", resp.status()));
    }

    let html = resp.text().await
        .map_err(|e| format!("Failed to read Spotify response: {e}"))?;

    let marker = "<script id=\"__NEXT_DATA__\" type=\"application/json\">";
    let start_idx = html.find(marker)
        .ok_or_else(|| "Could not parse Spotify page structure".to_string())?
        + marker.len();

    let end_idx = html[start_idx..].find("</script>")
        .ok_or_else(|| "Malformed Spotify metadata".to_string())?
        + start_idx;

    let json_str = &html[start_idx..end_idx];
    let v: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("Failed to parse Spotify JSON metadata: {e}"))?;

    let entity = &v["props"]["pageProps"]["state"]["data"]["entity"];

    let title = entity["name"]
        .as_str()
        .or_else(|| v["props"]["pageProps"]["title"].as_str())
        .unwrap_or(if entity_type == "artist" { "Spotify Artist" } else { "Spotify Collection" })
        .to_string();

    let description = entity["description"]
        .as_str()
        .or_else(|| v["props"]["pageProps"]["description"].as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if entity_type == "artist" {
                format!("Top Tracks by {title}")
            } else {
                String::new()
            }
        });

    let thumbnail = entity["visualIdentity"]["image"]
        .as_array()
        .and_then(|arr| arr.last())
        .and_then(|img| img["url"].as_str())
        .or_else(|| v["props"]["pageProps"]["links"]["images"].as_array().and_then(|arr| arr.last()).and_then(|img| img["href"].as_str()))
        .unwrap_or("")
        .to_string();

    let uploader = if entity_type == "artist" {
        title.clone()
    } else {
        "Spotify".to_string()
    };

    let album_from_entity = if entity_type == "album" {
        Some(title.clone())
    } else {
        entity["album"]["name"].as_str().map(|s| s.to_string())
    };

    let release_date = entity["release_date"]
        .as_str()
        .or_else(|| entity["album"]["release_date"].as_str())
        .map(|s| s.to_string());

    let mut tracks = Vec::new();

    if entity_type == "track" {
        let t_title = entity["name"].as_str().unwrap_or("Spotify Track").to_string();
        let t_artist = entity["artists"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|art| art["name"].as_str())
            .unwrap_or("Unknown Artist")
            .to_string();
        let duration_ms = entity["duration"].as_f64().unwrap_or(0.0);
        let video_url = format!("https://open.spotify.com/track/{id}");

        tracks.push(PlaylistTrack {
            id: id.to_string(),
            title: t_title,
            artist: t_artist,
            duration: duration_ms / 1000.0,
            video_url,
            stream_url: None,
            thumbnail: if thumbnail.is_empty() { None } else { Some(thumbnail.clone()) },
            source: Some("spotify".to_string()),
            album: album_from_entity.clone(),
            release_date: release_date.clone(),
        });
    } else if let Some(track_list) = entity["trackList"].as_array() {
        for t in track_list {
            let t_title = t["title"].as_str().unwrap_or("").to_string();
            if t_title.is_empty() { continue; }
            let t_artist = t["subtitle"].as_str().unwrap_or(if entity_type == "artist" { &title } else { "Unknown Artist" }).to_string();
            let uri = t["uri"].as_str().unwrap_or("");
            let t_id = uri.replace("spotify:track:", "");
            let duration_ms = t["duration"].as_f64().unwrap_or(0.0);
            let duration = duration_ms / 1000.0;
            let track_album = t["album"]["name"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| album_from_entity.clone());

            let video_url = format!("https://open.spotify.com/track/{t_id}");

            tracks.push(PlaylistTrack {
                id: if !t_id.is_empty() { t_id } else { t_title.clone() },
                title: t_title,
                artist: t_artist,
                duration,
                video_url,
                stream_url: None,
                thumbnail: if thumbnail.is_empty() { None } else { Some(thumbnail.clone()) },
                source: Some("spotify".to_string()),
                album: track_album,
                release_date: release_date.clone(),
            });
        }
    }

    if tracks.is_empty() {
        // Fallback 1: Query Spotify oEmbed to discover playlist/artist/album name
        let encoded_url = urlencoding::encode(clean_url);
        let oembed_url = format!("https://open.spotify.com/oembed?url={}", encoded_url);
        if let Ok(oembed_resp) = client.get(&oembed_url).send().await {
            if oembed_resp.status().is_success() {
                if let Ok(oembed_val) = oembed_resp.json::<serde_json::Value>().await {
                    let fallback_title = oembed_val["title"].as_str().unwrap_or("").to_string();
                    let fallback_uploader = oembed_val["author_name"].as_str().unwrap_or("Spotify").to_string();
                    let fallback_thumb = oembed_val["thumbnail_url"].as_str().unwrap_or("").to_string();

                    if !fallback_title.is_empty() {
                        let query = format!("{} Playlist", fallback_title);
                        if let Ok(searched) = search_online_tracks(query, "youtube".to_string()).await {
                            if !searched.is_empty() {
                                return Ok(PlaylistInfo {
                                    title: fallback_title,
                                    description: format!("Curated collection by {}", fallback_uploader),
                                    thumbnail: fallback_thumb,
                                    uploader: fallback_uploader,
                                    source: "spotify".to_string(),
                                    tracks: searched,
                                });
                            }
                        }
                    }
                }
            }
        }

        return Err("No tracks found in Spotify collection. Try searching by playlist name above.".to_string());
    }

    Ok(PlaylistInfo {
        title,
        description,
        thumbnail,
        uploader,
        source: "spotify".to_string(),
        tracks,
    })
}

#[tauri::command]
async fn get_playlist_info(url: String) -> Result<PlaylistInfo, String> {
    let url_trimmed = url.trim();
    if url_trimmed.contains("spotify.com") || url_trimmed.starts_with("spotify:") {
        return fetch_spotify_playlist_info(url_trimmed).await;
    }

    let is_url = url_trimmed.starts_with("http://") || url_trimmed.starts_with("https://");
    let search_target = if is_url {
        url_trimmed.to_string()
    } else {
        format!("ytsearch30:{}", url_trimmed)
    };

    let sc = get_ytdlp_cmd().map_err(|_| "yt-dlp not found".to_string())?;
    let output = run_ytdlp_args(&sc, vec![
        "--dump-single-json".to_string(),
        "--flat-playlist".to_string(),
        "--playlist-end".to_string(), "50".to_string(),
        "--force-ipv4".to_string(),
        "--no-warnings".to_string(),
        "--quiet".to_string(),
        search_target,
    ], 12).await?;

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let stderr_str = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() || stdout_str.trim().is_empty() {
        return Err(format!(
            "Failed to fetch playlist info.\nstderr: {}",
            stderr_str.trim()
        ));
    }

    let v: serde_json::Value = serde_json::from_str(&stdout_str)
        .map_err(|e| format!("Failed to parse playlist JSON: {e}"))?;

    let default_title = if !is_url { format!("Search: {}", url_trimmed) } else { "Unknown Playlist".to_string() };
    let title = v["title"].as_str().unwrap_or(&default_title).to_string();
    let description = v["description"].as_str().unwrap_or("").to_string();
    
    // Extract playlist thumbnail
    let mut thumbnail = String::new();
    if let Some(thumb_arr) = v["thumbnails"].as_array() {
        if let Some(last_thumb) = thumb_arr.last() {
            thumbnail = last_thumb["url"].as_str().unwrap_or("").to_string();
        }
    }

    let uploader = v["uploader"].as_str()
        .or_else(|| v["channel"].as_str())
        .unwrap_or(if !is_url { "Online Search" } else { "Unknown Curator" })
        .to_string();

    let mut tracks = Vec::new();
    if let Some(entries) = v["entries"].as_array() {
        for entry in entries {
            let id = entry["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() { continue; }
            let t_title = entry["title"].as_str().unwrap_or("Unknown Song").to_string();
            let t_artist = entry["uploader"].as_str()
                .or_else(|| entry["channel"].as_str())
                .unwrap_or("Unknown Artist")
                .to_string();
            let duration = entry["duration"].as_f64().unwrap_or(0.0);
            let video_url = entry["url"].as_str()
                .or_else(|| entry["webpage_url"].as_str())
                .unwrap_or("")
                .to_string();
            
            // If webpage_url/url is missing, build it from id
            let video_url = if video_url.is_empty() {
                format!("https://www.youtube.com/watch?v={id}")
            } else {
                video_url
            };

            let mut entry_thumb = entry["thumbnail"].as_str().unwrap_or("").to_string();
            if entry_thumb.is_empty() {
                if let Some(tarr) = entry["thumbnails"].as_array() {
                    if let Some(last) = tarr.last() {
                        entry_thumb = last["url"].as_str().unwrap_or("").to_string();
                    }
                }
            }

            tracks.push(PlaylistTrack {
                id,
                title: t_title,
                artist: t_artist,
                duration,
                video_url,
                stream_url: None,
                thumbnail: if entry_thumb.is_empty() { None } else { Some(entry_thumb) },
                source: Some(if url_trimmed.contains("soundcloud.com") { "soundcloud".to_string() } else { "youtube".to_string() }),
                album: None,
                release_date: None,
            });
        }
    }

    let source = if url_trimmed.contains("soundcloud.com") {
        "soundcloud".to_string()
    } else {
        "youtube".to_string()
    };

    Ok(PlaylistInfo {
        title,
        description,
        thumbnail,
        uploader,
        source,
        tracks,
    })
}

#[tauri::command]
async fn search_online_tracks(query: String, provider: String) -> Result<Vec<PlaylistTrack>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let p = provider.to_lowercase();
    let is_sc = p == "soundcloud" || q.starts_with("sc:");
    let is_spotify = p == "spotify";

    let search_target = if is_sc {
        let clean_q = q.trim_start_matches("sc:").trim();
        format!("scsearch10:{}", clean_q)
    } else {
        format!("ytsearch10:{}", q)
    };

    let sc = get_ytdlp_cmd().map_err(|_| "yt-dlp not found".to_string())?;
    let output = match run_ytdlp_args(&sc, vec![
        "--dump-single-json".to_string(),
        "--flat-playlist".to_string(),
        "--playlist-end".to_string(), "15".to_string(),
        "--force-ipv4".to_string(),
        "--no-warnings".to_string(),
        "--quiet".to_string(),
        search_target,
    ], 10).await {
        Ok(out) => out,
        Err(e) => {
            eprintln!("[search_online_tracks] search failed or timed out: {e}");
            return Ok(Vec::new());
        }
    };

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || stdout_str.trim().is_empty() {
        return Ok(Vec::new());
    }

    let v: serde_json::Value = serde_json::from_str(&stdout_str)
        .map_err(|e| format!("Failed to parse search JSON: {e}"))?;

    let mut tracks = Vec::new();
    if let Some(entries) = v["entries"].as_array() {
        for entry in entries {
            let id = entry["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() { continue; }
            let t_title = entry["title"].as_str().unwrap_or("Unknown Song").to_string();
            let t_artist = entry["uploader"].as_str()
                .or_else(|| entry["channel"].as_str())
                .unwrap_or("Unknown Artist")
                .to_string();
            let duration = entry["duration"].as_f64().unwrap_or(0.0);
            let video_url = entry["url"].as_str()
                .or_else(|| entry["webpage_url"].as_str())
                .unwrap_or("")
                .to_string();
            let video_url = if video_url.is_empty() {
                if is_sc {
                    format!("https://soundcloud.com/{id}")
                } else {
                    format!("https://www.youtube.com/watch?v={id}")
                }
            } else {
                video_url
            };

            let mut entry_thumb = entry["thumbnail"].as_str().unwrap_or("").to_string();
            if entry_thumb.is_empty() {
                if let Some(tarr) = entry["thumbnails"].as_array() {
                    if let Some(last) = tarr.last() {
                        entry_thumb = last["url"].as_str().unwrap_or("").to_string();
                    }
                }
            }

            let source_str = if is_sc {
                "soundcloud"
            } else if is_spotify {
                "spotify"
            } else {
                "youtube"
            }.to_string();

            tracks.push(PlaylistTrack {
                id,
                title: t_title,
                artist: t_artist,
                duration,
                video_url,
                stream_url: None,
                thumbnail: if entry_thumb.is_empty() { None } else { Some(entry_thumb) },
                source: Some(source_str),
                album: None,
                release_date: None,
            });
        }
    }

    Ok(tracks)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OnlinePlaylistResult {
    pub id: String,
    pub title: String,
    pub description: String,
    pub thumbnail: String,
    pub uploader: String,
    pub url: String,
    pub track_count: Option<u64>,
    pub source: String,
}

struct CuratedPlaylistMeta {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    thumbnail: &'static str,
    uploader: &'static str,
    url: &'static str,
    source: &'static str,
    keywords: &'static [&'static str],
}

const TOP_SPOTIFY_PLAYLISTS: &[CuratedPlaylistMeta] = &[
    CuratedPlaylistMeta {
        id: "37i9dQZF1DXcBWIGoYBM5M",
        title: "Today's Top Hits",
        description: "The biggest songs worldwide across pop and global charts.",
        thumbnail: "https://i.scdn.co/image/ab67706f0000000216f4ad21096ddf6377755c3c",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
        source: "spotify",
        keywords: &["top", "hits", "today", "pop", "chart", "charts", "global", "trending"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZEVXbMDoHDwVN2tF",
        title: "Top 50 - Global",
        description: "Your daily update of the most played tracks right now - Global.",
        thumbnail: "https://charts-images.scdn.co/assets/locale_en/regional/daily/region_global_default.jpg",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZEVXbMDoHDwVN2tF",
        source: "spotify",
        keywords: &["top 50", "global", "charts", "world", "most played", "hot"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZEVXbLRQDuF5jeBp",
        title: "Top 50 - USA",
        description: "Your daily update of the most played tracks right now - USA.",
        thumbnail: "https://charts-images.scdn.co/assets/locale_en/regional/daily/region_us_default.jpg",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZEVXbLRQDuF5jeBp",
        source: "spotify",
        keywords: &["top 50", "usa", "us", "america", "charts", "billboard"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZEVXbLnolsZ8PSNw",
        title: "Top 50 - United Kingdom",
        description: "Your daily update of the most played tracks right now - UK.",
        thumbnail: "https://charts-images.scdn.co/assets/locale_en/regional/daily/region_gb_default.jpg",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZEVXbLnolsZ8PSNw",
        source: "spotify",
        keywords: &["top 50", "uk", "united kingdom", "charts", "brit"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZEVXbLiRSasKsNU9",
        title: "Viral 50 - Global",
        description: "Your daily update of the most viral tracks right now - Global.",
        thumbnail: "https://charts-images.scdn.co/assets/locale_en/viral/daily/region_global_default.jpg",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZEVXbLiRSasKsNU9",
        source: "spotify",
        keywords: &["viral", "tiktok", "trending", "global", "50", "viral 50"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZF1DX0XUsuxWHRQd",
        title: "RapCaviar",
        description: "Music from Kendrick Lamar, Drake, Travis Scott, Future and more.",
        thumbnail: "https://i.scdn.co/image/ab67706f0000000216f4ad21096ddf6377755c3c",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd",
        source: "spotify",
        keywords: &["rap", "hip hop", "raps", "trap", "drake", "kendrick", "future", "caviar"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZF1DWXRqgorJj26U",
        title: "Rock Classics",
        description: "Rock legends & epic songs that continue to inspire generations.",
        thumbnail: "https://i.scdn.co/image/ab67706f0000000216f4ad21096ddf6377755c3c",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZF1DWXRqgorJj26U",
        source: "spotify",
        keywords: &["rock", "classics", "classic rock", "guitar", "metal", "queen", "acdc", "legend"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZF1DWUa8ZRTfalHk",
        title: "Pop Rising",
        description: "The next generation of pop superstars and fresh melodies.",
        thumbnail: "https://i.scdn.co/image/ab67706f0000000216f4ad21096ddf6377755c3c",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZF1DWUa8ZRTfalHk",
        source: "spotify",
        keywords: &["pop", "rising", "fresh", "superstar", "hits"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZF1DX4dyzvuaRJ0n",
        title: "mint - EDM Hits",
        description: "The world's biggest dance & EDM anthems.",
        thumbnail: "https://i.scdn.co/image/ab67706f0000000216f4ad21096ddf6377755c3c",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZF1DX4dyzvuaRJ0n",
        source: "spotify",
        keywords: &["edm", "dance", "mint", "electronic", "house", "techno", "festival"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZF1DWZeKCadgRdKQ",
        title: "Deep Focus",
        description: "Keep calm and focus with ambient and post-rock music.",
        thumbnail: "https://i.scdn.co/image/ab67706f0000000216f4ad21096ddf6377755c3c",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZF1DWZeKCadgRdKQ",
        source: "spotify",
        keywords: &["focus", "study", "ambient", "work", "coding", "chill", "calm"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZF1DXdLEN7aqioXM",
        title: "Lo-Fi Cafe",
        description: "Chill beats, cozy rhythms and instrumental lo-fi.",
        thumbnail: "https://i.scdn.co/image/ab67706f0000000216f4ad21096ddf6377755c3c",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZF1DXdLEN7aqioXM",
        source: "spotify",
        keywords: &["lofi", "lo-fi", "chill", "relax", "cafe", "beats", "study"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZF1DX10zKzsJ2jva",
        title: "Viva Latino",
        description: "Today's top Latin hits, reggaeton, and tropical rhythms.",
        thumbnail: "https://i.scdn.co/image/ab67706f0000000216f4ad21096ddf6377755c3c",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZF1DX10zKzsJ2jva",
        source: "spotify",
        keywords: &["latin", "latino", "reggaeton", "viva", "spanish", "bad bunny"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZF1DX4UtSsGT1Sbe",
        title: "All Out 80s",
        description: "The biggest hits of the 1980s.",
        thumbnail: "https://i.scdn.co/image/ab67706f0000000216f4ad21096ddf6377755c3c",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZF1DX4UtSsGT1Sbe",
        source: "spotify",
        keywords: &["80s", "1980s", "eighties", "retro", "nostalgia", "synth"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZF1DXbTxeAdrVG2l",
        title: "All Out 90s",
        description: "The biggest songs of the 1990s.",
        thumbnail: "https://i.scdn.co/image/ab67706f0000000216f4ad21096ddf6377755c3c",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZF1DXbTxeAdrVG2l",
        source: "spotify",
        keywords: &["90s", "1990s", "nineties", "nostalgia"],
    },
    CuratedPlaylistMeta {
        id: "37i9dQZF1DX4o1oenSJRJd",
        title: "All Out 2000s",
        description: "The defining songs of the 2000s.",
        thumbnail: "https://i.scdn.co/image/ab67706f0000000216f4ad21096ddf6377755c3c",
        uploader: "Spotify",
        url: "https://open.spotify.com/playlist/37i9dQZF1DX4o1oenSJRJd",
        source: "spotify",
        keywords: &["2000s", "00s", "nostalgia", "y2k"],
    },
];

#[tauri::command]
async fn search_online_playlists(query: String, provider: String) -> Result<Vec<OnlinePlaylistResult>, String> {
    let q = query.trim();
    let q_lower = q.to_lowercase();
    let p = provider.to_lowercase();
    let mut results = Vec::new();

    // 1. Check curated Spotify playlists
    if p == "spotify" || p == "all" {
        let q_tokens: Vec<&str> = q_lower.split_whitespace().collect();
        for pl in TOP_SPOTIFY_PLAYLISTS {
            let pl_title_lower = pl.title.to_lowercase();
            let pl_desc_lower = pl.description.to_lowercase();
            let matched = q.is_empty()
                || pl_title_lower.contains(&q_lower)
                || pl_desc_lower.contains(&q_lower)
                || pl.keywords.iter().any(|k| q_lower.contains(k) || k.contains(&q_lower))
                || (!q_tokens.is_empty() && q_tokens.iter().any(|token| {
                    pl_title_lower.contains(token) || pl.keywords.iter().any(|k| k.contains(token))
                }));
            if matched {
                results.push(OnlinePlaylistResult {
                    id: pl.id.to_string(),
                    title: pl.title.to_string(),
                    description: pl.description.to_string(),
                    thumbnail: pl.thumbnail.to_string(),
                    uploader: pl.uploader.to_string(),
                    url: pl.url.to_string(),
                    track_count: Some(50),
                    source: pl.source.to_string(),
                });
            }
        }
    }

    // 2. Query YouTube live playlists via yt-dlp (async & non-blocking)
    if (p == "youtube" || p == "all") && !q.is_empty() {
        if let Ok(sc) = get_ytdlp_cmd() {
            let encoded_q = urlencoding::encode(q);
            // sp=EgIQAw%3D%3D is the canonical YouTube playlist search filter
            let search_url = format!("https://www.youtube.com/results?search_query={}&sp=EgIQAw%3D%3D", encoded_q);

            let primary_res = run_ytdlp_args(&sc, vec![
                "--dump-single-json".to_string(),
                "--flat-playlist".to_string(),
                "--playlist-end".to_string(), "12".to_string(),
                "--force-ipv4".to_string(),
                "--no-warnings".to_string(),
                "--quiet".to_string(),
                search_url,
            ], 9).await;

            if let Ok(output) = primary_res {
                if output.status.success() {
                    let stdout_str = String::from_utf8_lossy(&output.stdout);
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout_str) {
                        if let Some(entries) = v["entries"].as_array() {
                            for entry in entries.iter().take(12) {
                                let id = entry["id"].as_str().unwrap_or("").to_string();
                                if id.is_empty() { continue; }
                                let title = entry["title"].as_str().unwrap_or("YouTube Playlist").to_string();
                                let uploader = entry["uploader"].as_str()
                                    .or_else(|| entry["channel"].as_str())
                                    .unwrap_or("YouTube")
                                    .to_string();
                                let description = entry["description"].as_str().unwrap_or("").to_string();
                                let mut thumb = entry["thumbnail"].as_str().unwrap_or("").to_string();
                                if thumb.is_empty() {
                                    if let Some(tarr) = entry["thumbnails"].as_array() {
                                        if let Some(last) = tarr.last() {
                                            thumb = last["url"].as_str().unwrap_or("").to_string();
                                        }
                                    }
                                }
                                let url = entry["url"].as_str()
                                    .or_else(|| entry["webpage_url"].as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let url = if url.is_empty() {
                                    format!("https://www.youtube.com/playlist?list={id}")
                                } else {
                                    url
                                };

                                let track_count = entry["playlist_count"].as_u64()
                                    .or_else(|| entry["n_entries"].as_u64());

                                results.push(OnlinePlaylistResult {
                                    id,
                                    title,
                                    description,
                                    thumbnail: thumb,
                                    uploader,
                                    url,
                                    track_count,
                                    source: "youtube".to_string(),
                                });
                            }
                        }
                    }
                }
            }

            // Fallback query if YouTube filter returned zero items
            let yt_count = results.iter().filter(|r| r.source == "youtube").count();
            if yt_count == 0 {
                let fallback_target = format!("ytsearch10:{} playlist", q);
                let fallback_res = run_ytdlp_args(&sc, vec![
                    "--dump-single-json".to_string(),
                    "--flat-playlist".to_string(),
                    "--playlist-end".to_string(), "8".to_string(),
                    "--force-ipv4".to_string(),
                    "--no-warnings".to_string(),
                    "--quiet".to_string(),
                    fallback_target,
                ], 7).await;

                if let Ok(output2) = fallback_res {
                    if output2.status.success() {
                        let stdout_str = String::from_utf8_lossy(&output2.stdout);
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout_str) {
                            if let Some(entries) = v["entries"].as_array() {
                                for entry in entries.iter().take(8) {
                                    let id = entry["id"].as_str().unwrap_or("").to_string();
                                    if id.is_empty() { continue; }
                                    let title = entry["title"].as_str().unwrap_or("YouTube Playlist").to_string();
                                    let uploader = entry["uploader"].as_str()
                                        .or_else(|| entry["channel"].as_str())
                                        .unwrap_or("YouTube")
                                        .to_string();
                                    let mut thumb = entry["thumbnail"].as_str().unwrap_or("").to_string();
                                    if thumb.is_empty() {
                                        if let Some(tarr) = entry["thumbnails"].as_array() {
                                            if let Some(last) = tarr.last() {
                                                thumb = last["url"].as_str().unwrap_or("").to_string();
                                            }
                                        }
                                    }
                                    let raw_url = entry["url"].as_str()
                                        .or_else(|| entry["webpage_url"].as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let url = if raw_url.is_empty() {
                                        format!("https://www.youtube.com/watch?v={id}")
                                    } else {
                                        raw_url
                                    };
                                    results.push(OnlinePlaylistResult {
                                        id: id.clone(),
                                        title,
                                        description: format!("Curated by {}", uploader),
                                        thumbnail: thumb,
                                        uploader,
                                        url,
                                        track_count: None,
                                        source: "youtube".to_string(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(results)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let main_win = app.get_webview_window("main")
                .expect("main window not found");
            let icon_bytes = include_bytes!("../icons/icon.png");
            let img = tauri::image::Image::from_bytes(icon_bytes)
                .expect("failed to decode icon");
            main_win.set_icon(img).ok();
            main_win.show().ok();
            main_win.set_focus().ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_ytdlp,
            check_spotdl,
            check_ffmpeg,
            get_download_dir,
            download_audio,
            scan_local_tracks,
            get_preview_info,
            fetch_lyrics,
            get_playlist_info,
            search_online_tracks,
            search_online_playlists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod live_tests {
    use super::*;

    #[tokio::test]
    async fn test_live_spotify_playlist() {
        let url = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M";
        let res = get_playlist_info(url.to_string()).await;
        assert!(res.is_ok(), "Expected Spotify playlist to load successfully, got: {:?}", res.err());
        let info = res.unwrap();
        println!("[TEST] Playlist title: {}", info.title);
        println!("[TEST] Track count: {}", info.tracks.len());
        println!("[TEST] Source: {}", info.source);
        assert!(!info.title.is_empty());
        assert!(!info.tracks.is_empty(), "Expected tracks in playlist");
        assert_eq!(info.source, "spotify");
        let first = &info.tracks[0];
        println!("[TEST] First track: {} - {} (stream_url: {:?})", first.title, first.artist, first.stream_url);
        assert!(!first.title.is_empty());
        assert!(!first.artist.is_empty());
    }

    #[tokio::test]
    async fn test_live_spotify_artist_url() {
        let url = "https://open.spotify.com/intl-ar/artist/6OAJ8w6gz3xjktqQvOd9xg?si=enmBIEqxQXCGcs9lcqvTYQ";
        let res = get_playlist_info(url.to_string()).await;
        assert!(res.is_ok(), "Expected Spotify artist URL to load, got: {:?}", res.err());
        let info = res.unwrap();
        println!("[TEST] Artist name: {}", info.title);
        println!("[TEST] Artist track count: {}", info.tracks.len());
        assert!(!info.tracks.is_empty());
    }

    #[tokio::test]
    async fn test_live_spotify_track_preview() {
        let url = "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT";
        let res = get_preview_info(url.to_string(), None, None, None).await;
        assert!(res.is_ok(), "Expected Spotify track preview to succeed, got: {:?}", res.err());
        let info = res.unwrap();
        println!("[TEST] Track: {} by {}", info.title, info.artist);
        println!("[TEST] Playable: {}, Stream: {}", info.is_playable, info.stream_url);
        assert!(info.title.contains("Never Gonna Give You Up"));
        assert!(info.artist.contains("Rick Astley"));
        assert!(info.is_playable);
        assert!(!info.stream_url.is_empty());
    }

    #[tokio::test]
    async fn test_live_lyrics() {
        let res = fetch_lyrics("Never Gonna Give You Up".to_string(), "Rick Astley".to_string(), 213.0, None).await;
        assert!(res.is_ok(), "Expected lyrics to resolve from LRCLIB, got: {:?}", res.err());
        let lines = res.unwrap();
        println!("[TEST] Lyrics line count: {}", lines.len());
        assert!(!lines.is_empty(), "Expected non-empty lyrics");
        println!("[TEST] First line: [{}] {}", lines[0].time, lines[0].text);
    }

    #[tokio::test]
    async fn test_live_search_tracks() {
        let tracks = search_online_tracks("Coldplay Yellow".to_string(), "youtube".to_string()).await.unwrap();
        assert!(!tracks.is_empty(), "Expected search results for Coldplay Yellow");
        println!("[TEST] Found {} tracks for Coldplay Yellow", tracks.len());
        println!("[TEST] Top track: {} - {} (thumb: {:?})", tracks[0].title, tracks[0].artist, tracks[0].thumbnail);
        assert!(tracks[0].title.to_lowercase().contains("yellow") || tracks[0].artist.to_lowercase().contains("coldplay"));
    }

    #[tokio::test]
    async fn test_live_youtube_preview() {
        let url = "https://www.youtube.com/watch?v=TQHI68nl4uE";
        let res = get_preview_info(url.to_string(), None, None, None).await;
        println!("[TEST] YouTube preview result: {:?}", res);
        assert!(res.is_ok());
    }

    #[tokio::test]
    async fn test_live_telephone_lyrics() {
        let res = fetch_lyrics("Telephone".to_string(), "Lady Gaga, Beyoncé".to_string(), 221.0, Some("The Fame Monster".to_string())).await;
        assert!(res.is_ok(), "Expected Telephone lyrics to resolve: {:?}", res.err());
        let lines = res.unwrap();
        println!("[TEST] Telephone lines: {}", lines.len());
        assert!(lines.len() > 10);
        println!("[TEST] Telephone first line: [{}] {}", lines[0].time, lines[0].text);
        assert!(lines[0].time < 30.0, "Expected first line in first 30 seconds, got {}", lines[0].time);
    }

    #[tokio::test]
    async fn test_live_studio_audio_matching() {
        let res = get_preview_info(
            "Lady Gaga - Telephone".to_string(),
            Some(221.0),
            Some("Lady Gaga".to_string()),
            Some("The Fame Monster".to_string()),
        ).await;
        assert!(res.is_ok(), "Expected Telephone studio preview: {:?}", res.err());
        let info = res.unwrap();
        println!("[TEST] Studio audio: \"{}\" by \"{}\" dur: {:?} playable: {}", info.title, info.artist, info.duration, info.is_playable);
        assert!(info.is_playable);
        assert!(!info.stream_url.is_empty());
        if let Some(d) = info.duration {
            assert!((d - 221.0).abs() < 15.0, "Expected duration ~221s, got {}", d);
        }
    }

    #[tokio::test]
    async fn test_live_search_playlists() {
        let res = search_online_playlists("Top Hits".to_string(), "all".to_string()).await;
        assert!(res.is_ok(), "Expected playlist search to succeed, got: {:?}", res.err());
        let lists = res.unwrap();
        println!("[TEST] Found {} playlists for 'Top Hits'", lists.len());
        assert!(!lists.is_empty(), "Expected at least 1 playlist result");
        for (i, p) in lists.iter().take(3).enumerate() {
            println!("[TEST] #{}: [{}] {} by {} ({})", i + 1, p.source, p.title, p.uploader, p.url);
        }
    }
}


