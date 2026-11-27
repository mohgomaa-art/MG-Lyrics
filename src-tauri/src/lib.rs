// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::process::Command;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::Manager;

mod config;


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
        let app_bin = PathBuf::from(&local_appdata).join(config::APP_DIR_NAME).join("bin").join(&exe_name);
        if app_bin.exists() && is_command_valid(app_bin.to_str().unwrap_or(""), &["--version"]) {
            return Some(app_bin.to_string_lossy().to_string());
        }
        let app_dir = PathBuf::from(&local_appdata).join(config::APP_DIR_NAME).join(&exe_name);
        if app_dir.exists() && is_command_valid(app_dir.to_str().unwrap_or(""), &["--version"]) {
            return Some(app_dir.to_string_lossy().to_string());
        }
        let winget_link = PathBuf::from(&local_appdata).join("Microsoft").join("WinGet").join("Links").join(&exe_name);
        if winget_link.exists() && is_command_valid(winget_link.to_str().unwrap_or(""), &["--version"]) {
            return Some(winget_link.to_string_lossy().to_string());
        }
    }

    // (cwd lookup removed: a malicious yt-dlp.exe dropped in the working directory would be executed)

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

static YTDLP_CMD_CACHE: std::sync::OnceLock<StructuredCommand> = std::sync::OnceLock::new();

/// Resolve yt-dlp once per process. Discovery spawns several child processes
/// (`node --version`, `yt-dlp --version`, python probes), so doing it on every
/// preview/search/playlist call added hundreds of ms each time. Only successful
/// lookups are cached, so installing yt-dlp while the app runs still works.
fn get_ytdlp_cmd() -> Result<StructuredCommand, String> {
    if let Some(sc) = YTDLP_CMD_CACHE.get() {
        return Ok(sc.clone());
    }
    let sc = resolve_ytdlp_cmd()?;
    let _ = YTDLP_CMD_CACHE.set(sc.clone());
    Ok(sc)
}

fn resolve_ytdlp_cmd() -> Result<StructuredCommand, String> {
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
    // tokio::process with kill_on_drop: when the timeout fires the future is dropped and the
    // yt-dlp child is killed (the old spawn_blocking version leaked the process on timeout).
    let mut cmd = tokio::process::Command::new(&sc.program);
    cmd.args(&sc.prefix_args);
    cmd.args(&args);
    cmd.stdin(std::process::Stdio::null());
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| format!("yt-dlp command timed out after {timeout_secs}s"))?
        .map_err(|e| format!("Failed to spawn yt-dlp: {e}"))
}

/// Detect YouTube's anti-bot / rate-limit wall in yt-dlp stderr.
fn is_youtube_bot_wall(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    s.contains("sign in to confirm")
        || s.contains("not a bot")
        || s.contains("http error 429")
        || s.contains("too many requests")
}

const BOT_WALL_HINT: &str = "YouTube blocked the request with a bot check. Fix: update yt-dlp (yt-dlp -U) or export browser cookies to a cookies.txt file and set the MG_LYRICS_YT_COOKIES environment variable to its path.";

/// Optional cookies file for YouTube extraction.
/// Set MG_LYRICS_YT_COOKIES to the path of a Netscape-format cookies.txt.
fn ytdlp_cookie_args() -> Vec<String> {
    if let Ok(p) = std::env::var("MG_LYRICS_YT_COOKIES") {
        let p = p.trim().to_string();
        if !p.is_empty() && PathBuf::from(&p).exists() {
            return vec!["--cookies".to_string(), p];
        }
    }
    Vec::new()
}

/// Parse the first JSON object line from yt-dlp stdout.
/// On failure, produce an actionable error instead of a bare parse failure.
fn parse_ytdlp_json_output(output: &std::process::Output, context: &str) -> Result<serde_json::Value, String> {
    let stdout_str = String::from_utf8_lossy(&output.stdout);
    if let Some(v) = stdout_str
        .lines()
        .filter(|l| l.trim_start().starts_with('{'))
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
    {
        return Ok(v);
    }
    let stderr_str = String::from_utf8_lossy(&output.stderr);
    let stderr_trim = stderr_str.trim();
    if is_youtube_bot_wall(stderr_trim) {
        return Err(format!("{BOT_WALL_HINT}\nDetails: {}", stderr_trim.lines().last().unwrap_or("")));
    }
    if !output.status.success() {
        return Err(format!("yt-dlp failed while {context}: {stderr_trim}"));
    }
    Err(format!("Could not read yt-dlp result while {context}: {stderr_trim}"))
}

/// Run `<program> --version` and return the trimmed version line, if any.
fn version_of(program: &str) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() { None } else { Some(v) }
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


/// Reject anything that could be parsed as a yt-dlp/spotdl option (e.g. "--exec=...")
/// or that is not an http(s) URL, spotify URI, or ytsearch/scsearch query.
fn validate_media_target(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("Empty input".to_string());
    }
    if t.starts_with('-') || t.chars().any(|c| c == '\n' || c == '\r' || c == '\0') {
        return Err("Invalid input".to_string());
    }
    let ok = t.starts_with("http://")
        || t.starts_with("https://")
        || t.starts_with("spotify:")
        || t.starts_with("ytsearch")
        || t.starts_with("scsearch")
        || t.starts_with("sc:");
    if !ok {
        return Err("Unsupported input: expected an http(s) URL or spotify: URI".to_string());
    }
    Ok(t.to_string())
}

/// The only folder the frontend may download into / scan.
fn allowed_download_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot resolve home directory".to_string())?;
    let dir = PathBuf::from(home).join("Downloads").join("MG-Lyrics");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create download folder: {e}"))?;
    dir.canonicalize().map_err(|e| format!("Bad download folder: {e}"))
}

/// Canonicalize `dir` and make sure it is the download folder or inside it (blocks ../ and symlink escapes).
fn confine_to_download_dir(dir: &str) -> Result<PathBuf, String> {
    let base = allowed_download_dir()?;
    let canon = PathBuf::from(dir)
        .canonicalize()
        .map_err(|e| format!("Invalid directory: {e}"))?;
    if canon.starts_with(&base) {
        Ok(canon)
    } else {
        Err("Directory is outside the MG-Lyrics downloads folder".to_string())
    }
}

/// Check whether yt-dlp is installed on the system
#[tauri::command]
async fn check_ytdlp() -> Result<String, String> {
    tokio::task::spawn_blocking(check_ytdlp_blocking)
        .await
        .map_err(|e| format!("Task error: {e}"))?
}

fn check_ytdlp_blocking() -> Result<String, String> {
    for prog in &["yt-dlp", "yt-dl", "youtube-dl"] {
        if let Some(path) = find_binary_path(prog) {
            // Include the installed version so stale yt-dlp installs
            // (the #1 cause of sudden YouTube failures) are visible.
            return Ok(match version_of(&path) {
                Some(v) => format!("{path} (yt-dlp {v})"),
                None => path,
            });
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
async fn check_spotdl() -> Result<String, String> {
    tokio::task::spawn_blocking(check_spotdl_blocking)
        .await
        .map_err(|e| format!("Task error: {e}"))?
}

fn check_spotdl_blocking() -> Result<String, String> {
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
async fn check_ffmpeg() -> Result<String, String> {
    tokio::task::spawn_blocking(check_ffmpeg_blocking)
        .await
        .map_err(|e| format!("Task error: {e}"))?
}

fn check_ffmpeg_blocking() -> Result<String, String> {
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

// ─────────────────────────────────────────────────────────────────────────────
// Downloads pipeline (round 2)
// ─────────────────────────────────────────────────────────────────────────────

/// Bumping this value cancels every in-flight download (each runner polls it).
static DL_CANCEL_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// At most 2 downloads run at once; the rest wait in a FIFO queue.
static DL_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[tauri::command]
fn cancel_downloads() -> Result<String, String> {
    DL_CANCEL_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Ok("cancelled".to_string())
}

/// `%` is special in yt-dlp output templates: escape it in user/remote supplied text.
fn tmpl_escape(s: &str) -> String {
    s.replace('%', "%%")
}

/// Pick the most useful line out of yt-dlp / spotdl stderr for the UI.
fn summarize_dl_error(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty()
            && !l.starts_with("Permission error")
            && !l.starts_with("Deprecated Feature")
            && !l.starts_with("WARNING:"))
        .collect();
    let picked = lines
        .iter()
        .rev()
        .find(|l| l.starts_with("ERROR:"))
        .or_else(|| lines.last())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "download failed (no error output)".to_string());
    let lower = picked.to_lowercase();
    if lower.contains("no space left") || lower.contains("disk full") || lower.contains("not enough space") {
        return format!("Disk is full - free some space and retry. ({picked})");
    }
    if lower.contains("sign in to confirm") {
        return format!("YouTube blocked this IP (bot check). Update yt-dlp or provide cookies. ({picked})");
    }
    picked
}

struct DlOutcome {
    saved: usize,
    stdout_tail: String,
}

/// Run a yt-dlp/spotdl process without blocking the async runtime.
/// - streams `MGLP|bytes|total|percent` progress lines as `mg-download-progress` events
/// - kills the child on cancel, idle timeout, or if this future is dropped (kill_on_drop)
/// - returns Err(summary) on any non-zero exit
async fn run_dl(
    app: &tauri::AppHandle,
    sc: &StructuredCommand,
    args: Vec<String>,
    job: &str,
    label: &str,
    idle_secs: u64,
) -> Result<DlOutcome, String> {
    use std::sync::atomic::Ordering;
    use tauri::Emitter;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    let gen = DL_CANCEL_GEN.load(Ordering::SeqCst);
    let mut cmd = tokio::process::Command::new(&sc.program);
    cmd.args(&sc.prefix_args)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start {}: {e}", sc.program))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr_pipe = child.stderr.take().ok_or("no stderr")?;
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr_pipe.read_to_string(&mut s).await;
        s
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut tail: Vec<String> = Vec::new();
    let mut saved = 0usize;
    let mut last_activity = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);

    loop {
        if DL_CANCEL_GEN.load(Ordering::SeqCst) != gen {
            let _ = child.kill().await;
            err_task.abort();
            return Err("Download cancelled".to_string());
        }
        if last_activity.elapsed().as_secs() > idle_secs {
            let _ = child.kill().await;
            err_task.abort();
            return Err(format!("Download stalled: no progress for {idle_secs}s (killed)"));
        }
        tokio::select! {
            l = lines.next_line() => {
                match l {
                    Ok(Some(line)) => {
                        last_activity = std::time::Instant::now();
                        if let Some(rest) = line.strip_prefix("MGLP|") {
                            let parts: Vec<&str> = rest.split('|').collect();
                            let pct = parts.get(2)
                                .map(|p| p.trim().trim_end_matches('%').trim())
                                .and_then(|p| p.parse::<f64>().ok());
                            if let Some(p) = pct {
                                if last_emit.elapsed().as_millis() >= 150 || p >= 100.0 {
                                    last_emit = std::time::Instant::now();
                                    let _ = app.emit("mg-download-progress", serde_json::json!({
                                        "job": job, "label": label, "percent": p, "phase": "download"
                                    }));
                                }
                            }
                        } else {
                            if line.starts_with("[ExtractAudio]") {
                                let _ = app.emit("mg-download-progress", serde_json::json!({
                                    "job": job, "label": label, "percent": 100.0, "phase": "convert"
                                }));
                            }
                            if line.starts_with("[Metadata] Adding metadata")
                                || line.contains("has already been downloaded") {
                                saved += 1;
                            }
                            tail.push(line);
                            if tail.len() > 20 { tail.remove(0); }
                        }
                    }
                    _ => break,
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {}
        }
    }

    let status = child.wait().await.map_err(|e| format!("Failed waiting for process: {e}"))?;
    let stderr = err_task.await.unwrap_or_default();
    if status.success() {
        Ok(DlOutcome { saved, stdout_tail: tail.join("\n") })
    } else if saved > 0 {
        // Playlist with some failed items: keep the good ones, report the rest.
        Err(format!("Partial: {saved} saved, some items failed - {}", summarize_dl_error(&stderr)))
    } else {
        Err(summarize_dl_error(&stderr))
    }
}

/// Shared yt-dlp flags for audio downloads.
fn dl_base_args(ffmpeg: &str, output_dir: &str, template: &str) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-x".into(),
        "--audio-format".into(), "mp3".into(),
        "--audio-quality".into(), "0".into(),
        "--embed-metadata".into(),
        "--embed-thumbnail".into(),
        "--convert-thumbnails".into(), "jpg".into(),
        "--no-overwrites".into(),
        "--windows-filenames".into(),
        "--trim-filenames".into(), "150".into(),
        "--retries".into(), "5".into(),
        "--fragment-retries".into(), "5".into(),
        "--newline".into(),
        "--no-warnings".into(),
        "--progress-template".into(),
        "download:MGLP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress._percent_str)s".into(),
        "--ffmpeg-location".into(), ffmpeg.to_string(),
        // finished files go to output_dir; partial fragments live in a hidden subfolder
        // so a failed run never leaves half files that the library scan would list.
        "-P".into(), output_dir.to_string(),
        "-P".into(), format!("temp:{output_dir}/.mgl-partial"),
        "-o".into(), template.to_string(),
    ];
    a.extend(ytdlp_cookie_args()); // MG_LYRICS_YT_COOKIES support (from 09)
    a.shrink_to_fit();
    a
}

#[allow(dead_code)]
fn is_http_url(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    (l.starts_with("http://") || l.starts_with("https://")) && !u.contains(char::is_whitespace)
}

/// Download a single YouTube video OR an entire playlist as MP3 using yt-dlp.
/// For Spotify URLs, spotdl is used instead (when installed), else yt-dlp search per track.
#[tauri::command]
async fn download_audio(
    app: tauri::AppHandle,
    url: String,
    output_dir: String,
    job_id: Option<String>,
    single: Option<bool>,
) -> Result<String, String> {
    let url = validate_media_target(&url)?;
    let job = job_id.unwrap_or_else(|| "main".to_string());
    let single = single.unwrap_or(false);

    // validate_media_target rejects anything starting with "-"; "--" is also placed before every target below.
    let is_spotify = url.contains("spotify.com") || url.starts_with("spotify:");

    // Path confinement (10): never create or write outside ~/Downloads/MG-Lyrics.
    let base = allowed_download_dir()?;
    if !std::path::Path::new(&output_dir).exists()
        && !std::path::Path::new(&output_dir.replace('\\', "/")).starts_with(&base)
    {
        return Err("Directory is outside the MG-Lyrics downloads folder".to_string());
    }
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Cannot create download folder {output_dir}: {e}"))?;
    confine_to_download_dir(&output_dir)?; // validation only; keep the caller's path form
    let output_dir = output_dir.replace('\\', "/").trim_end_matches('/').to_string();

    let ffmpeg = find_binary_path("ffmpeg").ok_or_else(|| {
        "ffmpeg is not installed. It is required to convert audio to MP3 and embed cover art. Install it (winget install ffmpeg) and retry.".to_string()
    })?;

    // Queue: wait for a free slot (max 2 concurrent downloads).
    let _slot = DL_SLOTS.acquire().await.map_err(|_| "download queue closed".to_string())?;

    let sc = get_ytdlp_cmd().map_err(|_| {
        "yt-dlp is not installed.\nDownload it from: https://github.com/yt-dlp/yt-dlp/releases".to_string()
    })?;

    if is_spotify {
        return download_spotify(&app, &sc, &ffmpeg, &url, &output_dir, &job).await;
    }

    let template = "%(uploader|Unknown)s - %(title)s.%(ext)s";
    let mut args = dl_base_args(&ffmpeg, &output_dir, template);
    args.push(if single { "--no-playlist".into() } else { "--yes-playlist".into() });
    args.push("--".into());
    args.push(url.clone());
    let out = run_dl(&app, &sc, args, &job, &url, 180).await?;
    if out.saved == 0 {
        // exit 0 but nothing written: be honest about it
        return Ok(format!("Nothing new to download (already in {output_dir}?)\n{}", out.stdout_tail.lines().last().unwrap_or("")));
    }
    Ok(format!("Downloaded {} track(s) to: {output_dir}", out.saved))
}

async fn spotify_search_dl(
    app: &tauri::AppHandle,
    sc: &StructuredCommand,
    ffmpeg: &str,
    output_dir: &str,
    job: &str,
    artist: &str,
    title: &str,
) -> Result<DlOutcome, String> {
    let safe = tmpl_escape(&format!("{} - {}", sanitize_filename(artist), sanitize_filename(title)));
    let template = format!("{safe}.%(ext)s");
    let mut args = dl_base_args(ffmpeg, output_dir, &template);
    args.push("--no-playlist".into());
    args.push("--".into());
    args.push(format!("ytsearch1:{artist} {title} Official Audio"));
    run_dl(app, sc, args, job, &format!("{artist} - {title}"), 180).await
}

async fn download_spotify(
    app: &tauri::AppHandle,
    sc: &StructuredCommand,
    ffmpeg: &str,
    url: &str,
    output_dir: &str,
    job: &str,
) -> Result<String, String> {
    let is_track = url.contains("/track/") || url.starts_with("spotify:track:");
    if is_track {
        if let Ok(info) = get_preview_info(url.to_string(), None, None, None).await {
            spotify_search_dl(app, sc, ffmpeg, output_dir, job, &info.artist, &info.title).await?;
            return Ok(format!("Downloaded Spotify track to: {output_dir}"));
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
    if let Some(spot) = spotdl_cmd {
        let args = vec![
            "download".to_string(),
            url.to_string(),
            "--output".to_string(),
            format!("{output_dir}/{{artist}} - {{title}}.{{output-ext}}"),
        ];
        match run_dl(app, &spot, args, job, url, 300).await {
            Ok(_) => return Ok("Spotify collection downloaded ✓".to_string()),
            Err(e) if e == "Download cancelled" => return Err(e),
            Err(_) => { /* fall through to the yt-dlp search fallback */ }
        }
    }

    // Fallback: parse the Spotify collection and download each track via yt-dlp search
    let info = fetch_spotify_playlist_info(url).await?;
    let total = info.tracks.len();
    let mut ok = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for t in &info.tracks {
        match spotify_search_dl(app, sc, ffmpeg, output_dir, job, &t.artist, &t.title).await {
            Ok(_) => ok += 1,
            Err(e) if e == "Download cancelled" => {
                return Err(format!("Cancelled after {ok}/{total} tracks"));
            }
            Err(e) => failed.push(format!("{} - {}: {}", t.artist, t.title, e)),
        }
    }
    if ok == 0 {
        return Err(format!(
            "0/{total} tracks downloaded. First error: {}",
            failed.first().cloned().unwrap_or_default()
        ));
    }
    let mut msg = format!("Downloaded {ok}/{total} tracks from Spotify collection to: {output_dir}");
    if !failed.is_empty() {
        msg.push_str(&format!("\n{} failed, e.g. {}", failed.len(), failed[0]));
    }
    Ok(msg)
}

/// Scan the download folder and return all audio files as LocalTrack structs
#[tauri::command]
async fn scan_local_tracks(dir: String) -> Result<Vec<LocalTrack>, String> {
    tokio::task::spawn_blocking(move || scan_local_tracks_blocking(dir))
        .await
        .map_err(|e| format!("Task error: {e}"))?
}

fn scan_local_tracks_blocking(dir: String) -> Result<Vec<LocalTrack>, String> {
    confine_to_download_dir(&dir)?; // validation only; keep the caller's path form (no \\?\ prefix)
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
        // skip hidden / in-progress files
        if p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false) {
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
        // ASCII-only lowercase keeps byte offsets identical to `out` (Unicode to_lowercase can
        // change byte lengths and make truncate() panic on a non-char-boundary).
        if let Some(p) = out.to_ascii_lowercase().find(pat) { out.truncate(p); break; }
    }
    let suffixes = [" - official", " - lyric", " - audio", " - video", " - hd", " - live"];
    let lower = out.to_ascii_lowercase();
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
    let t_words: Vec<String> = t_lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_string())
        .collect();
    let has_word = |w: &str| t_words.iter().any(|x| x == w);
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
    if has_word("movie") || has_word("film") || has_word("teaser") {
        score -= 50.0;
    }
    if has_word("live") || has_word("concert") || has_word("tour") {
        score -= 35.0;
    }
    if has_word("remix") {
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
    let input_owned = if input.trim_start().starts_with("http") || input.trim_start().starts_with("spotify:") || input.trim_start().starts_with('-') {
        validate_media_target(&input)?
    } else {
        input.trim().to_string()
    };
    let input = input_owned.as_str();
    if input.is_empty() {
        return Err("Empty input".to_string());
    }
    if input.starts_with('-') {
        return Err("Invalid input".to_string());
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
        let mut direct_args = vec![
            "--dump-json".to_string(),
            "-f".to_string(), "ba[ext=m4a][protocol^=http]/ba[protocol^=http]/ba[abr<=128]/ba".to_string(),
            "--no-playlist".to_string(),
            "--force-ipv4".to_string(),
            "--no-warnings".to_string(),
        ];
        direct_args.extend(ytdlp_cookie_args());
        direct_args.push("--".to_string());
        direct_args.push(input.to_string());
        let output = run_ytdlp_args(&sc, direct_args, 60).await?;

        let v = parse_ytdlp_json_output(&output, "resolving the stream")?;

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
            let embed_url = format!("{}/embed/track/{track_id}", config::spotify_base());
            let client = reqwest::Client::builder()
                .timeout(config::embed_timeout())
                .user_agent(config::browser_user_agent())
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
                .timeout(config::http_timeout())
                .user_agent(config::api_user_agent())
                .build()
                .map_err(|e| format!("HTTP client error: {e}"))?;
            let encoded_input = urlencoding::encode(input);
            let url = format!("{}/oembed?url={}", config::spotify_base(), encoded_input);
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
        ], 45).await;

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
            chosen_url = format!("{}/watch?v={}", config::youtube_base(), best.1);
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
    args.extend(ytdlp_cookie_args());
    if chosen_url.starts_with("ytsearch") || chosen_url.starts_with("scsearch") {
        args.push("--playlist-items".to_string());
        args.push("1".to_string());
    } else {
        args.push("--no-playlist".to_string());
    }
    args.push("--".to_string());
    args.push(chosen_url.clone());

    let output = run_ytdlp_args(&sc, args, 60).await?;

    let v = parse_ytdlp_json_output(&output, "extracting the audio stream")?;

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
    /// true when `time` is an even-spacing estimate (plain, unsynced lyrics), not a real timestamp
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub est: bool,
}

/// Strip enhanced-LRC inline word timestamps such as `<00:12.34>` from a lyric line.
fn strip_word_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        match rest[open..].find('>') {
            Some(rel) if parse_timestamp(&rest[open + 1..open + rel]).is_some() => {
                out.push_str(&rest[..open]);
                rest = &rest[open + rel + 1..];
            }
            _ => {
                out.push_str(&rest[..open + 1]);
                rest = &rest[open + 1..];
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parse LRC timed lyrics into LyricLine vec.
/// Handles multiple timestamps per line, `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss:xx]`,
/// the `[offset:+/-ms]` header, enhanced word tags, and keeps blank timestamped
/// lines as an instrumental-gap marker so the previous line does not linger.
fn parse_lrc(lrc: &str) -> Vec<LyricLine> {
    let mut lines: Vec<LyricLine> = Vec::new();
    // LRC spec: positive offset = lyrics appear EARLIER (shift timestamps by -offset).
    let mut offset_sec = 0.0_f64;
    for raw in lrc.lines() {
        let raw = raw.trim().trim_start_matches('\u{feff}');
        if raw.is_empty() { continue; }
        let mut times: Vec<f64> = Vec::new();
        let mut rest = raw;
        while rest.starts_with('[') {
            if let Some(close) = rest.find(']') {
                let tag = &rest[1..close];
                if let Some(t) = parse_timestamp(tag) {
                    times.push(t);
                } else {
                    if let Some(v) = tag.strip_prefix("offset:") {
                        if let Ok(ms) = v.trim().parse::<f64>() { offset_sec = ms / 1000.0; }
                    }
                    break; // metadata tag, stop
                }
                rest = &rest[close + 1..];
            } else {
                break;
            }
        }
        if times.is_empty() { continue; }
        let text = strip_word_tags(rest.trim());
        let text = if text.is_empty() { String::new() } else { text };
        for t in times {
            lines.push(LyricLine { time: t, text: text.clone(), est: false });
        }
    }
    for l in lines.iter_mut() {
        l.time = (l.time - offset_sec).max(0.0);
    }
    lines.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    // Blank lines become an instrumental marker; a trailing blank is dropped.
    while lines.last().map_or(false, |l| l.text.is_empty()) { lines.pop(); }
    for l in lines.iter_mut() {
        if l.text.is_empty() { l.text = "♪".to_string(); }
    }
    // Collapse consecutive identical markers.
    lines.dedup_by(|b, a| a.text == "♪" && b.text == "♪");
    lines
}

/// Accepts `mm:ss`, `mm:ss.xx`, `mm:ss:xx` (colon used as fraction separator).
fn parse_timestamp(s: &str) -> Option<f64> {
    let s = s.trim();
    let colon = s.find(':')?;
    let mins_str = &s[..colon];
    if mins_str.is_empty() || !mins_str.bytes().all(|b| b.is_ascii_digit()) { return None; }
    let mins: f64 = mins_str.parse().ok()?;
    let mut sec_str = s[colon + 1..].to_string();
    if let Some(c2) = sec_str.find(':') {
        sec_str.replace_range(c2..c2 + 1, ".");
    }
    if sec_str.is_empty() || !sec_str.bytes().all(|b| b.is_ascii_digit() || b == b'.') { return None; }
    let secs: f64 = sec_str.parse().ok()?;
    if !mins.is_finite() || !secs.is_finite() { return None; }
    Some(mins * 60.0 + secs)
}

fn parse_plain(plain: &str, duration_sec: f64) -> Vec<LyricLine> {
    let lines: Vec<&str> = plain.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() { return vec![]; }
    let step = if duration_sec > 0.0 { duration_sec / lines.len() as f64 } else { 5.0 };
    lines.iter().enumerate()
        .map(|(i, &text)| LyricLine { time: i as f64 * step, text: text.to_string(), est: true })
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
        return Some(vec![LyricLine { time: 0.0, text: "✦ Instrumental ✦".to_string(), est: true }]);
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

    if score >= config::match_threshold() { score } else { 0.0 }
}

/// Pick the best-scoring result from a lrclib search array.
/// Returns the lyrics from the highest-confidence match above the match threshold, preferring synced lyrics.
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
        .filter(|(score, _, _)| *score >= config::match_threshold())
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
        .timeout(config::http_timeout())
        .user_agent(config::api_user_agent())
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
                "{}/get?track_name={}&artist_name={}&album_name={}",
                config::lrclib_api(),
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
                            if score >= config::match_threshold() {
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
            "{}/get?track_name={}&artist_name={}",
            config::lrclib_api(),
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
                        if score >= config::match_threshold() {
                            if let Some(lyrics) = extract_lyrics_from_json(&data, duration_sec) {
                                eprintln!("[lyrics] STEP1_HIT: Direct GET matched with score={:.1}, {} lines", score, lyrics.len());
                                return Ok(lyrics);
                            }
                        } else {
                            eprintln!("[lyrics] STEP1_REJECTED: Direct GET result score={:.1} below threshold {:.0}", score, config::match_threshold());
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
            "{}/get?track_name={}&artist_name={}",
            config::lrclib_api(),
            urlencoding::encode(&ct),
            urlencoding::encode(art)
        );
        eprintln!("[lyrics] STEP2: Direct GET without duration for artist=\"{}\"", art);
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if !data.is_null() {
                        let score = score_match(&data, &ct, &ca, alb_opt, duration_sec);
                        if score >= config::match_threshold() {
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
        let url = format!("{}/search?q={}", config::lrclib_api(), urlencoding::encode(&q));
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
        let url = format!("{}/search?q={}", config::lrclib_api(), urlencoding::encode(&ct));
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

    let embed_url = format!("{}/embed/{entity_type}/{id}", config::spotify_base());
    let client = reqwest::Client::builder()
        .timeout(config::playlist_timeout())
        .user_agent(config::browser_user_agent())
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
        let video_url = format!("{}/track/{id}", config::spotify_base());

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

            let video_url = format!("{}/track/{t_id}", config::spotify_base());

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
        let oembed_url = format!("{}/oembed?url={}", config::spotify_base(), encoded_url);
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

/// Max entries fetched per playlist (was a silent 50 cap).
const PLAYLIST_MAX_ENTRIES: u32 = 200;
/// Large playlists need more than the old 12s; yt-dlp flat extraction of 200 items can take 20-40s.
const PLAYLIST_FETCH_TIMEOUT_SECS: u64 = 60;

#[tauri::command]
async fn get_playlist_info(url: String) -> Result<PlaylistInfo, String> {
    let url_owned = if url.trim_start().starts_with('-') || url.trim_start().starts_with("http") || url.trim_start().starts_with("spotify:") {
        validate_media_target(&url)?
    } else {
        url.trim().to_string()
    };
    let url_trimmed = url_owned.as_str();
    if url_trimmed.starts_with('-') || url_trimmed.contains('\n') {
        return Err("Invalid input".to_string());
    }
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
    let mut pl_args = vec![
        "--dump-single-json".to_string(),
        "--flat-playlist".to_string(),
        "--playlist-end".to_string(), PLAYLIST_MAX_ENTRIES.to_string(),
        "--ignore-errors".to_string(),
        "--force-ipv4".to_string(),
        "--no-warnings".to_string(),
        "--quiet".to_string(),
    ];
    pl_args.extend(ytdlp_cookie_args());
    pl_args.push("--".to_string());
    pl_args.push(search_target);
    let output = run_ytdlp_args(&sc, pl_args, PLAYLIST_FETCH_TIMEOUT_SECS).await?;

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let stderr_str = String::from_utf8_lossy(&output.stderr);

    // yt-dlp can exit non-zero when a few playlist entries are unavailable
    // while still emitting valid JSON for the rest; only fail if nothing usable came back.
    if stdout_str.trim().is_empty() {
        if is_youtube_bot_wall(&stderr_str) {
            return Err(BOT_WALL_HINT.to_string());
        }
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
    // A single-video / single-track URL has no "entries": treat the root object as one entry
    // instead of returning an empty (apparently failed) playlist.
    let single_entry: Vec<serde_json::Value> = if !v["entries"].is_array() && v["id"].is_string() {
        vec![v.clone()]
    } else {
        Vec::new()
    };
    let entries: &[serde_json::Value] = v["entries"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(single_entry.as_slice());
    {
        for entry in entries {
            let id = entry["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() { continue; }
            let raw_title = entry["title"].as_str().unwrap_or("Unknown Song");
            if raw_title == "[Private video]" || raw_title == "[Deleted video]" { continue; }
            let t_title = raw_title.to_string();
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
                format!("{}/watch?v={id}", config::youtube_base())
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
    let output = run_ytdlp_args(&sc, vec![
        "--dump-single-json".to_string(),
        "--flat-playlist".to_string(),
        "--playlist-end".to_string(), "15".to_string(),
        "--force-ipv4".to_string(),
        "--no-warnings".to_string(),
        "--quiet".to_string(),
        search_target,
    ], 45).await.map_err(|e| {
        eprintln!("[search_online_tracks] search failed or timed out: {e}");
        format!("Search failed: {e}")
    })?;

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || stdout_str.trim().is_empty() {
        let stderr_str = String::from_utf8_lossy(&output.stderr);
        if is_youtube_bot_wall(&stderr_str) {
            return Err(BOT_WALL_HINT.to_string());
        }
        return Err(format!("Search failed: {}", stderr_str.trim()));
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
                    format!("{}/{id}", config::soundcloud_base())
                } else {
                    format!("{}/watch?v={id}", config::youtube_base())
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
            let search_url = format!("{}/results?search_query={}&sp=EgIQAw%3D%3D", config::youtube_base(), encoded_q);

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
                                    format!("{}/playlist?list={id}", config::youtube_base())
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
                                        format!("{}/watch?v={id}", config::youtube_base())
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

/// Destroys every window except `main` (currently just the floating lyrics overlay).
///
/// Tauri only terminates the process once the *last* window is gone. The lyrics overlay
/// is a second top-level window, so closing the main window used to leave a live process
/// behind holding an always-on-top, click-through, taskbar-less window on screen that the
/// user had no way to dismiss short of Task Manager.
fn destroy_aux_windows<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if label != "main" {
            let _ = window.destroy();
        }
    }
}

/// Lets the overlay window shut itself down (watchdog or its own close button) without
/// needing window-destroy permissions in the webview ACL.
#[tauri::command]
fn close_overlay_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        return Err("close_overlay_window refuses to close the main window".to_string());
    }
    window.destroy().map_err(|e| e.to_string())
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
        // Window lifecycle: the main window owns the process. When it is closed or
        // destroyed, take the overlay down with it so no orphan window survives.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    destroy_aux_windows(window.app_handle());
                }
                tauri::WindowEvent::Destroyed => {
                    destroy_aux_windows(window.app_handle());
                    // If anything is still alive, force the process down instead of
                    // leaving a window with no owner and no taskbar entry.
                    if !window.app_handle().webview_windows().is_empty() {
                        window.app_handle().exit(0);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            close_overlay_window,
            check_ytdlp,
            check_spotdl,
            check_ffmpeg,
            get_download_dir,
            download_audio,
            cancel_downloads,
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




#[cfg(test)]
mod lrc_tests {
    use super::*;

    #[test]
    fn basic_and_multi_timestamp() {
        let l = parse_lrc("[00:10.50]Hello\n[00:20.00][01:00.25]World");
        let t: Vec<(f64, &str)> = l.iter().map(|x| (x.time, x.text.as_str())).collect();
        assert_eq!(t, vec![(10.5, "Hello"), (20.0, "World"), (60.25, "World")]);
    }

    #[test]
    fn colon_fraction_and_three_digit_ms() {
        assert_eq!(parse_timestamp("01:02:50"), Some(62.5));
        assert_eq!(parse_timestamp("00:01.234"), Some(1.234));
        assert_eq!(parse_timestamp("ar:Artist"), None);
        assert_eq!(parse_timestamp("offset:+500"), None);
    }

    #[test]
    fn offset_tag_applied() {
        let l = parse_lrc("[offset:+500]\n[00:10.00]A\n[00:20.00]B");
        assert!((l[0].time - 9.5).abs() < 1e-9);
        assert!((l[1].time - 19.5).abs() < 1e-9);
        let l = parse_lrc("[offset:-250]\n[00:10.00]A");
        assert!((l[0].time - 10.25).abs() < 1e-9);
    }

    #[test]
    fn enhanced_word_tags_stripped() {
        let l = parse_lrc("[00:05.00]<00:05.00>Hel<00:05.40>lo <00:06.00>there");
        assert_eq!(l[0].text, "Hello there");
    }

    #[test]
    fn blank_line_becomes_gap_marker_trailing_dropped() {
        let l = parse_lrc("[00:05.00]A\n[00:15.00]\n[00:30.00]B\n[00:40.00]");
        let t: Vec<&str> = l.iter().map(|x| x.text.as_str()).collect();
        assert_eq!(t, vec!["A", "♪", "B"]);
    }
}
