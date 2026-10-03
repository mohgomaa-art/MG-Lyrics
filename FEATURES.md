# Features

> Comprehensive feature catalog for MG Lyrics Player, grouped by category with implementation details and maturity levels.

---

## Maturity Legend

| Level | Meaning |
|-------|---------|
| **Stable** | Fully implemented, tested, handles edge cases |
| **Functional** | Works for primary use cases, may lack polish |
| **Experimental** | Implemented but not battle-tested |
| **Planned** | Not yet implemented |

---

## 1. Audio Playback

### 1.1 YouTube Audio Streaming

| | |
|---|---|
| **Purpose** | Stream audio from YouTube without downloading |
| **Maturity** | Functional |

**User Workflow:**
1. Select a track from the library or imported playlist
2. The app resolves a direct audio stream URL via yt-dlp
3. Audio plays through the HTML5 Audio API

**Implementation:**
- `get_preview_info` Tauri command runs yt-dlp with `--dump-json` to extract stream metadata
- For search queries, uses `ytsearch1:{title} {artist}` format
- Extracts the direct stream URL from JSON output, preferring audio-only formats
- Falls back through the format list to find the best audio codec

**Dependencies:** yt-dlp (system binary)

---

### 1.2 Local File Playback

| | |
|---|---|
| **Purpose** | Play audio files stored on disk |
| **Maturity** | Stable |

**User Workflow:**
1. Download tracks via the app, or place audio files in `~/Downloads/MG-Lyrics/`
2. Tracks appear automatically in the Downloads view
3. Click to play — audio loads via the Tauri asset protocol

**Implementation:**
- `scan_local_tracks` reads directory entries and filters by audio extension
- Supports: MP3, FLAC, OGG, WAV, AAC, M4A, Opus
- Filename convention `Artist - Title.mp3` is parsed for metadata
- Paths are converted to `file:///` URLs via Tauri's `convertFileSrc()`
- Auto-scan runs on app startup via `useEffect` in App.tsx

**Dependencies:** None (uses std::fs and Tauri asset protocol)

---

### 1.3 Audio Download

| | |
|---|---|
| **Purpose** | Download tracks as MP3 for offline playback |
| **Maturity** | Functional |

**User Workflow:**
1. Navigate to the Downloads view
2. Paste a YouTube or Spotify URL
3. Click "Download" — progress is shown inline
4. Downloaded files appear in the local library

**Implementation:**
- `download_audio` Tauri command orchestrates the download:
  - **YouTube URLs:** `yt-dlp -x --audio-format mp3 --audio-quality 0 --embed-metadata`
  - **Spotify single tracks:** Resolves via oembed API, then YouTube search
  - **Spotify playlists:** Falls back to spotdl
- Output directory: `~/Downloads/MG-Lyrics/`
- After download, triggers `scan_local_tracks` to refresh the library

**Dependencies:** yt-dlp (required), spotdl (optional for Spotify), ffmpeg (recommended for conversion)

---

### 1.4 Stream URL Recovery

| | |
|---|---|
| **Purpose** | Automatically retry when YouTube stream URLs expire |
| **Maturity** | Functional |

**User Workflow:** Transparent — if audio fails during playback, the app re-resolves the stream URL once.

**Implementation:**
- `handleAudioError` in App.tsx intercepts HTML5 `<audio>` error events
- For non-local tracks, calls `resolveStreamUrl()` to get a fresh URL
- Maximum 1 retry per track (prevents infinite loops on genuinely unavailable content)
- Displays user-visible error message if retry fails

---

### 1.5 Playback Controls

| | |
|---|---|
| **Purpose** | Standard media player controls |
| **Maturity** | Stable |

**Features:**
- Play/pause with animated button state
- Previous/next track navigation
- Click-to-seek on progress bar
- Volume slider (0–100%) with mute toggle
- Volume persisted to localStorage
- Auto-advance to next track on completion
- Duration auto-corrected from actual audio metadata

---

## 2. Lyrics

### 2.1 Synced Lyrics Fetching

| | |
|---|---|
| **Purpose** | Retrieve timestamped lyrics matched to the current track |
| **Maturity** | Stable |

**User Workflow:** Automatic — lyrics are fetched whenever a new track starts playing.

**Implementation:**
- Rust `fetch_lyrics` command queries lrclib.net via 4-step fallback:
  1. Direct GET with title + artist + duration (most precise)
  2. Direct GET with title + artist (no duration constraint)
  3. Fuzzy search with `"{artist} {title}"` query
  4. Fuzzy search with title only
- Query cleaning removes: bracketed content `(Official Video)`, feat. clauses, suffix labels
- Each candidate is scored using Levenshtein-based confidence (0–100 scale)
- Acceptance threshold: 65 points
- Prefers synced (LRC) lyrics over plain text at equal confidence
- Handles instrumental tracks (returns `"✦ Instrumental ✦"`)

**Dependencies:** lrclib.net API (free, no API key), reqwest HTTP client

---

### 2.2 LRC Parsing

| | |
|---|---|
| **Purpose** | Parse LRC timestamp format into timed lyric lines |
| **Maturity** | Stable |

**Implementation:**
- Parses `[mm:ss.xx]` timestamp tags from LRC text
- Supports multiple timestamps per line (e.g., `[01:23.45][02:34.56] Repeated line`)
- Skips metadata tags (`[ar:Artist]`, `[ti:Title]`)
- Sorts output by timestamp
- Falls back to `parse_plain()` for unsynced lyrics (distributes lines evenly across duration)

---

### 2.3 Floating Lyrics Overlay

| | |
|---|---|
| **Purpose** | Always-on-top lyrics display that doesn't interfere with other apps |
| **Maturity** | Stable |

**User Workflow:**
1. Click the lyrics button in PlayerBar
2. A transparent, borderless window appears on top of all other windows
3. Lyrics scroll automatically, highlighting the current word
4. In pinned mode, clicks pass through to the window below

**Implementation:**
- Spawns a Tauri `WebviewWindow` with URL `index.html#lyrics`
- Window properties: `transparent: true`, `decorations: false`, `alwaysOnTop: true`, `skipTaskbar: true`, `focus: false`
- Receives playback state via Tauri events (throttled to ~3/sec)
- Saves/restores window position to localStorage

---

### 2.4 Word-by-Word Karaoke Highlighting

| | |
|---|---|
| **Purpose** | Highlight individual words as they are sung |
| **Maturity** | Stable |

**Implementation:**
- Calculates time per word: `lineDuration / wordCount`
- Determines active word index: `Math.floor(elapsed / wordDuration)`
- Active word receives: theme-specific color, glow shadow, scale transform, CSS animation
- Previous words: dimmed to inactive color
- Upcoming words: displayed at inactive color
- Smooth transitions via CSS `transition` properties

---

### 2.5 Lyrics Themes

| | |
|---|---|
| **Purpose** | Visual customization of the lyrics overlay |
| **Maturity** | Stable |

**5 themes available:**

| Theme | Font | Active Color | Animation Style |
|-------|------|-------------|----------------|
| **Nebula** | Outfit | `#C084FC` (purple) | Pulse + scale + brightness |
| **Cyberpunk** | Orbitron | `#00F0FF` (cyan) | Glitch skew |
| **Terminal** | Courier New | `#FFB000` (amber) | Underline blink |
| **Elegant** | Playfair Display | `#F472B6` (pink) | Gentle float |
| **Minimal** | Inter | `#FFFFFF` (white) | Clean scale |

Each theme defines: `fontFamily`, `activeColor`, `inactiveColor`, `outline`, `glowShadow`, `animationClass`, `background`, `borderColor`.

---

### 2.6 Font Size Control

| | |
|---|---|
| **Purpose** | Adjust lyrics readability |
| **Maturity** | Stable |

**Controls:**
- Ctrl+Scroll: Adjust in 2px increments
- A-/A+ buttons in drag mode toolbar
- Range: 14–60px
- Persisted to localStorage

---

### 2.7 Pin / Drag Mode Toggle

| | |
|---|---|
| **Purpose** | Switch between click-through overlay and interactive window |
| **Maturity** | Stable |

**Modes:**
- **Pinned (default):** `setIgnoreCursorEvents(true)` — fully click-through, no visible UI chrome, lyrics scroll automatically
- **Drag Mode:** Shows toolbar with theme selector, font controls, lock button. Window is draggable and interactive.

---

## 3. Library Management

### 3.1 Spotify Playlist Import

| | |
|---|---|
| **Purpose** | Import track metadata from Spotify public playlists |
| **Maturity** | Functional |

**User Workflow:**
1. Navigate to Discover or use the import modal
2. Paste a Spotify playlist URL
3. The app fetches all track metadata (title, artist, album, artwork, duration)
4. Tracks are added to the library and a playlist is created

**Implementation:**
- Python sidecar `POST /import/spotify` endpoint
- Uses Spotify Web API with Client Credentials OAuth2
- Handles pagination (100 tracks per page)
- Extracts: playlist name, description, cover art, track list with full metadata
- No Spotify Premium required — only public playlists accessible

**Dependencies:** Spotify Client ID + Secret (via .env), requests library

---

### 3.2 YouTube Playlist Import

| | |
|---|---|
| **Purpose** | Import video metadata from YouTube playlists |
| **Maturity** | Functional |

**User Workflow:**
1. Navigate to the Discover view
2. Paste a YouTube playlist URL or select a curated suggestion
3. The app extracts all video metadata
4. Preview individual tracks, download them, or import the entire playlist

**Implementation:**
- Rust `get_playlist_info` command runs yt-dlp with `--dump-single-json --flat-playlist`
- Python sidecar `GET /playlists/youtube` provides an alternative path
- Extracts: playlist title, description, thumbnail, uploader, and per-track metadata
- Reconstructs video URLs from IDs when missing

**Dependencies:** yt-dlp

---

### 3.3 Custom Playlist Creation

| | |
|---|---|
| **Purpose** | Organize tracks into user-defined playlists |
| **Maturity** | Functional |

**User Workflow:**
1. Click "Create Playlist" in ContentArea
2. Enter a name and select a source type
3. Check/uncheck tracks to include
4. Playlist appears in the sidebar

**Implementation:**
- Playlists stored as `Playlist[]` in App.tsx state
- Persisted to `localStorage("mg_playlists")`
- Each playlist has: `id`, `name`, `source`, `count`, `color`, `trackIds`
- Color-coded in sidebar by source (green for Spotify, red for YouTube)

---

### 3.4 Full-Text Search

| | |
|---|---|
| **Purpose** | Find tracks by title, artist, or album |
| **Maturity** | Functional |

**Implementation:**
- Client-side filter in ContentArea
- Case-insensitive substring match across `title`, `artist`, `album`
- Results update live as the user types
- No server-side indexing — operates over the in-memory track array

---

### 3.5 Auto-Scan on Startup

| | |
|---|---|
| **Purpose** | Detect new downloaded files without manual refresh |
| **Maturity** | Stable |

**Implementation:**
- `useEffect` in App.tsx runs on mount
- Calls `get_download_dir` → `scan_local_tracks`
- Maps results to Track objects with generated cover art
- Deduplicates against existing tracks by `audioUrl`

---

## 4. System Integration

### 4.1 Tool Detection Dashboard

| | |
|---|---|
| **Purpose** | Show availability status of required system tools |
| **Maturity** | Stable |

**User Workflow:** Navigate to Downloads view — the right panel shows green/red status for yt-dlp, spotdl, and ffmpeg.

**Implementation:**
- Three Tauri commands: `check_ytdlp`, `check_spotdl`, `check_ffmpeg`
- Each tries multiple detection strategies (direct binary, Python module)
- Returns version string on success, error message on failure
- Lazy-loaded: only checked when Downloads view is active

---

### 4.2 Cross-Platform Download Directory

| | |
|---|---|
| **Purpose** | Consistent download location across operating systems |
| **Maturity** | Stable |

**Implementation:**
- Resolves via `$USERPROFILE` (Windows) or `$HOME` (Unix)
- Creates `~/Downloads/MG-Lyrics/` directory if missing
- Returns normalized forward-slash paths
- Used by both download and scan operations

---

### 4.3 URL Preview

| | |
|---|---|
| **Purpose** | Preview track metadata before downloading |
| **Maturity** | Functional |

**User Workflow:**
1. Paste a URL in the Downloads view
2. Click "Preview" — the app fetches and displays: title, artist, thumbnail
3. Optionally play a stream preview or open the YouTube page

**Implementation:**
- `get_preview_info` Tauri command resolves metadata via yt-dlp or Spotify oembed
- Returns `PreviewInfo { title, artist, thumbnail, stream_url, video_url, is_playable }`
- Preview audio plays via a separate `<audio>` element in ContentArea

---

## 5. UI & Design

### 5.1 Glassmorphic Design System

| | |
|---|---|
| **Purpose** | Modern, polished visual aesthetic |
| **Maturity** | Stable |

**Implementation:**
- CSS custom properties define the color system (13 variables)
- Glass panels: `backdrop-filter: blur(24px) saturate(160%)`
- Dark base: `#08080C` with semi-transparent surfaces
- Accent color: `#8A2BE2` (neon purple) with glow effects
- Custom scrollbar (5px width, rounded)

---

### 5.2 Vinyl Hero Card

| | |
|---|---|
| **Purpose** | Visual centerpiece showing the current track |
| **Maturity** | Stable |

**Implementation:**
- SVG-rendered spinning vinyl record with groove rings
- Animated tone arm that moves when playing
- Gradient background matching the album color
- "Play Now" button with hover effects
- CSS `spin-slow` animation (12s rotation)

---

### 5.3 Generated Cover Art

| | |
|---|---|
| **Purpose** | Placeholder artwork for tracks without album covers |
| **Maturity** | Stable |

**Implementation:**
- `makeCover()` generates inline SVG with:
  - Two-color linear gradient background (8 gradient presets)
  - Large initial letter of the track title
  - 200x200px at rounded rectangle
- Encoded as `data:image/svg+xml` URI — no network request needed

---

### 5.4 EQ Bars Animation

| | |
|---|---|
| **Purpose** | Visual indicator for the currently playing track |
| **Maturity** | Stable |

**Implementation:**
- CSS `@keyframes eq-bar` animates height between 4px and 18px
- Three bars with staggered delays (0s, 0.2s, 0.4s) for organic feel
- Applied to track rows and album art overlay

---

### 5.5 URL History

| | |
|---|---|
| **Purpose** | Quick access to previously used download URLs |
| **Maturity** | Functional |

**Implementation:**
- Stores last 10 URLs in `localStorage("mg_url_history")`
- Deduplicates entries, newest first
- Click to restore URL to input field
- "Clear" button to remove all history

---

## 6. Curated Content

### 6.1 Demo Tracks

| | |
|---|---|
| **Purpose** | Provide out-of-the-box content for first-time users |
| **Maturity** | Stable |

8 hardcoded demo tracks with SoundHelix audio:
- Midnight City (M83), Blinding Lights (The Weeknd), Electric Feel (MGMT), Take On Me (a-ha), Starboy (The Weeknd), Levitating (Dua Lipa), Bohemian Rhapsody (Queen), Dreams (Fleetwood Mac)

Each has generated gradient cover art.

---

### 6.2 Curated YouTube Playlists

| | |
|---|---|
| **Purpose** | Quick-start content discovery |
| **Maturity** | Functional |

Three pre-linked playlists in the Discover view:
- Lofi Beats
- Chill Vibes
- Coding Focus

One click loads the playlist metadata for preview and import.

---

## 7. Legacy / Inactive Features

### 7.1 LyricsOverlay (Modal)

| | |
|---|---|
| **Purpose** | In-app lyrics overlay (replaced by floating window) |
| **Maturity** | Deprecated |

A 327-line component (`LyricsOverlay.tsx`) that renders lyrics as a modal within the main window. Replaced by `LyricsWindow.tsx` which uses a separate Tauri webview for true always-on-top behavior. The file remains in the codebase but is not rendered.

### 7.2 TrackList Component

| | |
|---|---|
| **Purpose** | Reusable track list with EQ indicators |
| **Maturity** | Deprecated |

A 115-line component (`TrackList.tsx`) that was replaced by inline track list rendering in ContentArea. Imported but not used.
