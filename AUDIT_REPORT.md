# MG Lyrics Player — Critical Audit Report

**Date:** 2026-06-17
**Auditor:** Claude Opus 4.6
**Scope:** Full codebase — frontend, Rust backend, Python sidecar

---

## Architecture Map

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND (React)                      │
│                                                         │
│  main.tsx ─┬─> App.tsx (main window)                    │
│            └─> LyricsWindow.tsx (floating overlay)       │
│                                                         │
│  App.tsx                                                │
│    ├── Sidebar.tsx                                       │
│    ├── ContentArea.tsx (home/search/downloads/discover)  │
│    ├── PlayerBar.tsx (controls + volume + lyrics toggle) │
│    ├── <audio> element (HTML5 playback)                  │
│    └── State: currentLyrics, currentTrack, isPlaying     │
│                                                         │
│  LyricsOverlay.tsx  ← DEAD COMPONENT (not rendered)     │
│  utils/lyrics.ts    ← DEAD CODE (never called)          │
├─────────────────────────────────────────────────────────┤
│                BACKEND (Rust/Tauri)                       │
│                                                         │
│  lib.rs                                                 │
│    ├── fetch_lyrics()       → lrclib.net API            │
│    ├── get_preview_info()   → yt-dlp (stream URL)       │
│    ├── download_audio()     → yt-dlp/spotdl             │
│    ├── scan_local_tracks()  → filesystem scan            │
│    ├── get_playlist_info()  → yt-dlp playlist extract    │
│    ├── check_ytdlp()        → binary detection          │
│    └── get_download_dir()   → ~/Downloads/MG-Lyrics     │
├─────────────────────────────────────────────────────────┤
│              SIDECAR (Python/FastAPI)                     │
│                                                         │
│  main.py                                                │
│    ├── routes/spotify.py  → import Spotify playlists     │
│    ├── routes/youtube.py  → import YouTube playlists     │
│    ├── services/spotify_service.py → Client Credentials  │
│    └── services/youtube_service.py → yt-dlp extraction   │
└─────────────────────────────────────────────────────────┘
```

### Data Flow: Lyrics

```
App.tsx                              LyricsWindow.tsx
  │                                       │
  ├── invoke("fetch_lyrics")              │
  │     └── Rust backend                  │
  │          └── lrclib.net API           │
  │               └── returns Vec<LyricLine>
  │                                       │
  ├── setCurrentLyrics(lyrics)            │
  │                                       │
  ├── emit("lyrics-update", {lyrics})  ──>│ listen("lyrics-update")
  │                                       ├── setLyricsList(lyrics)
  │                                       └── renders word-by-word
```

### Data Flow: Audio Playback

```
Track selected
  │
  ├── YouTube source?
  │     └── invoke("get_preview_info") → yt-dlp → stream URL
  │
  ├── Spotify source?
  │     └── oEmbed API → title → ytsearch1:title → yt-dlp → stream URL
  │
  ├── Local source?
  │     └── convertFileSrc(path) → file:// URL
  │
  └── <audio>.src = streamUrl
       └── HTML5 Audio playback
```

---

## Discovered Bugs

### P0 — Critical

#### BUG-001: LyricsOverlay uses hardcoded LYRICS_DATABASE, ignores real lyrics
- **File:** `src/components/LyricsOverlay.tsx`, line 143
- **Code:** `const activeLyrics = track ? (LYRICS_DATABASE[track.id] || DEFAULT_LYRICS) : DEFAULT_LYRICS;`
- **Root Cause:** Component has its own duplicate `LYRICS_DATABASE` (lines 10-108) identical to demo tracks. Falls back to fake `DEFAULT_LYRICS` (lines 110-115) for any non-demo track. Does NOT accept lyrics as a prop.
- **Impact:** Any user of this component sees wrong or fake lyrics 100% of the time for non-demo tracks.
- **Evidence:** Component prop interface has no `lyrics` parameter. Only receives `track`, `isPlaying`, `progress`.

#### BUG-002: STATIC_LYRICS_DB duplicated and dead
- **File:** `src/utils/lyrics.ts`, lines 6-104
- **Root Cause:** Entire `STATIC_LYRICS_DB` object and `fetchLyrics()` function are exported but never imported or called anywhere.
- **Impact:** Dead code creating confusion about where lyrics come from. Two copies of the same hardcoded data exist (lyrics.ts and LyricsOverlay.tsx).
- **Evidence:** `grep -r "STATIC_LYRICS_DB"` finds only the definition. `grep -r "fetchLyrics"` finds only the definition. App.tsx uses `invoke("fetch_lyrics")` (Rust backend).

#### BUG-003: Frontend lyrics.ts fetchLyrics has reversed condition
- **File:** `src/utils/lyrics.ts`, line 233
- **Code:** `if (cleanArtist && cleanArtist.toLowerCase() !== "unknown artist")`
- **Root Cause:** This condition runs title-only search when the artist IS valid, which is backwards — title-only search should only run when artist is unknown/missing.
- **Impact:** Dead code, but if ever re-enabled would cause wrong lyrics for tracks with valid artist metadata.
- **Evidence:** Logic should be `=== "unknown artist"` not `!== "unknown artist"`.

### P1 — High

#### BUG-004: Rust lyrics matching has weak confidence scoring
- **File:** `src-tauri/src/lib.rs`, lines 506-546
- **Root Cause:** `similarity()` function uses simple word overlap (Jaccard) which fails on short titles. `is_good_match()` uses low thresholds: title >= 0.6 OR (title >= 0.4 AND artist >= 0.4). No combined confidence score.
- **Impact:** Returns wrong lyrics for songs with common words in titles. "Take On Me" could match "Take Me Home". "Love" would match anything with "Love" in the title.
- **Evidence:** `similarity("take on me", "take me home tonight")` = 2/5 = 0.4, which passes the combined threshold.

#### BUG-005: Duration tolerance is 180 seconds (3 minutes)
- **File:** `src-tauri/src/lib.rs`, line 529
- **Code:** `if (res_dur - duration_sec).abs() > 180.0`
- **Root Cause:** 180-second tolerance means a 3-minute pop song could match a 6-minute live version or a completely different song.
- **Impact:** Wrong lyrics returned when title/artist match is borderline and duration is the only differentiator.
- **Evidence:** Line 529 uses 180.0 as the threshold.

#### BUG-006: spotdl status hardcoded as "Available"
- **File:** `src/components/ContentArea.tsx`, lines 1078-1085
- **Root Cause:** The dashboard always shows spotdl as available with a green indicator. No actual check is performed via Tauri command.
- **Impact:** User thinks spotdl is working when it may not be installed, leading to confusing download failures.
- **Evidence:** No `invoke("check_spotdl")` call exists. The status is hardcoded HTML.

#### BUG-007: No ffmpeg availability check
- **File:** `src-tauri/src/lib.rs`
- **Root Cause:** yt-dlp requires ffmpeg for audio format conversion (`-x --audio-format mp3`). No check exists for ffmpeg availability.
- **Impact:** Downloads fail with cryptic yt-dlp error messages when ffmpeg is missing.
- **Evidence:** No `check_ffmpeg` command exists anywhere in the codebase.

#### BUG-008: Stream URLs expire with no refresh mechanism
- **File:** `src/App.tsx`, lines 241-285
- **Root Cause:** YouTube stream URLs from googlevideo.com expire after ~6 hours. Once set as `<audio>.src`, there's no mechanism to detect expiration and re-resolve. The only URL resolution happens in `resolveAndPlay` on track change.
- **Impact:** Playback fails silently if user returns to app after hours. Pause-then-play on same track uses expired URL.
- **Evidence:** `audioRef.current.src = src` is set once per track selection. No `onerror` handler refreshes the URL.

### P2 — Medium

#### BUG-009: Silent error swallowing throughout audio code
- **File:** `src/App.tsx`, multiple locations
- **Root Cause:** `.catch(() => {})` on play(), emit(), and stream resolution. Errors disappear without user feedback.
- **Impact:** User sees no indication of why audio isn't playing.
- **Evidence:** Lines 210, 259, 268, 277, 282, 298, 317, 339, 381-382.

#### BUG-010: Arabic character bypass in lyrics matching
- **File:** `src-tauri/src/lib.rs`, lines 536-542
- **Root Cause:** When title contains Arabic characters and `duration_sec > 0`, the match is accepted unconditionally regardless of title/artist similarity.
- **Impact:** Wrong lyrics for Arabic songs that happen to share similar durations.
- **Evidence:** `if is_arabic { if duration_sec > 0.0 { return true; } }`.

#### BUG-011: Frontend lyrics search runs in Step 3 with valid artist
- **File:** `src/utils/lyrics.ts`, line 233
- **Root Cause:** Already documented as BUG-003. Dead code but the reversed condition `!== "unknown artist"` runs title-only search when artist is valid.
- **Impact:** None currently (dead code), but a trap if re-enabled.

#### BUG-012: No structured logging for lyrics or playback
- **File:** All files
- **Root Cause:** No structured logging system. Only `console.warn` and `console.error` with inconsistent formats.
- **Impact:** Debugging lyrics accuracy or playback issues requires code inspection, not log analysis.

---

## Architecture Issues

### ARCH-001: Two competing lyrics data paths
- `src/utils/lyrics.ts` — Frontend LRCLIB client (DEAD CODE)
- `src-tauri/src/lib.rs` — Rust backend LRCLIB client (ACTIVE)
- Only one should exist. The frontend version exists because it was the original implementation before the Rust backend was added.

### ARCH-002: LyricsOverlay is dead component with wrong architecture
- Component exists with full rendering logic but is never rendered
- Contains its own hardcoded lyrics database
- Does not accept lyrics as a prop
- If restored, would show wrong lyrics

### ARCH-003: Spotify uses metadata-only flow (correct design)
- Client Credentials flow → public metadata only
- No audio streaming from Spotify (correct — not possible via Web API)
- Audio resolved via YouTube search of Spotify metadata
- This is architecturally sound but undocumented

---

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| P0       | 3     | Hardcoded lyrics, dead code, reversed logic |
| P1       | 5     | Weak matching, no ffmpeg check, expired URLs, hardcoded status |
| P2       | 4     | Silent errors, Arabic bypass, no logging |
| ARCH     | 3     | Competing data paths, dead component, undocumented design |
