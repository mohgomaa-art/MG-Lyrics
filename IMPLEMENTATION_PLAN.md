# MG Lyrics Player — Implementation Plan

**Date:** 2026-06-17

---

## Fix 1: Lyrics Accuracy (BUG-004, BUG-005, BUG-010)

### Problem
Rust backend `is_good_match()` uses weak word-overlap similarity with low thresholds (0.4-0.6). Duration tolerance is 180 seconds. Arabic bypass accepts any match.

### Root Cause
`similarity()` is a naive Jaccard word-overlap metric. No normalization of feat./remix/remaster/live labels. No combined confidence score. No minimum acceptance threshold.

### Fix
Replace `similarity()` and `is_good_match()` with a proper confidence scoring system:

1. **Normalize** both query and result: lowercase, strip feat./ft./featuring, strip (remix)/(remaster)/(live)/(deluxe), strip punctuation
2. **Title score** (0-50): Use Levenshtein-based similarity on normalized titles, scaled to 50 points
3. **Artist score** (0-40): Use Levenshtein-based similarity on normalized artists, scaled to 40 points  
4. **Duration score** (0-10): Full points within ±5s, linear decay to 0 at ±30s
5. **Combined threshold**: Require score >= 65 to accept. Below threshold → "Lyrics not found"
6. **Remove Arabic bypass**: Apply same scoring universally

### Files Changed
- `src-tauri/src/lib.rs` — Replace `similarity()`, `is_good_match()`, update `fetch_lyrics()`

### Risks
- Stricter matching may miss some valid lyrics that previously matched
- Mitigated by multi-step search (direct GET → fuzzy search → title-only search)

### Validation
- Test with: Bohemian Rhapsody/Queen, Shape of You/Ed Sheeran, Blinding Lights/The Weeknd
- Verify wrong matches are rejected (e.g., search "Take On Me" should not return "Take Me Home Tonight")

---

## Fix 2: LyricsOverlay Single Source of Truth (BUG-001, BUG-002, BUG-003)

### Problem
`LyricsOverlay.tsx` contains its own `LYRICS_DATABASE` and `DEFAULT_LYRICS`. `utils/lyrics.ts` contains dead `STATIC_LYRICS_DB` and dead `fetchLyrics()`. Two files with identical hardcoded data. Component doesn't accept lyrics as a prop.

### Root Cause
Original architecture used frontend LRCLIB fetching. When Rust backend was added, old code was left in place and never cleaned up.

### Fix
1. **`LyricsOverlay.tsx`**: Delete `LYRICS_DATABASE`, delete `DEFAULT_LYRICS`. Add `lyrics: LyricLine[] | null` prop. Use prop directly.
2. **`utils/lyrics.ts`**: Delete `STATIC_LYRICS_DB`, delete `fetchLyrics()`. Keep only `LyricLine` interface, `parseLrc()`, `parsePlainLyrics()` (may be used in future).
3. **Single flow**: `fetch_lyrics` (Rust) → `currentLyrics` (App state) → prop to any lyrics consumer

### Files Changed
- `src/components/LyricsOverlay.tsx` — Remove hardcoded data, add lyrics prop
- `src/utils/lyrics.ts` — Remove dead exports

### Risks
- None — LyricsOverlay is currently dead (not rendered). Changes prepare it for correct future use.

### Validation
- Verify `LyricsOverlay` renders real lyrics when passed as prop
- Verify `LyricsWindow.tsx` continues to work (no changes needed — already uses event-based lyrics)

---

## Fix 3: Spotify Architecture + Diagnostics (BUG-006)

### Problem
Dashboard hardcodes spotdl as "Available". No actual check is performed.

### Root Cause
Missing Tauri commands for spotdl and ffmpeg detection.

### Fix
1. **Add `check_spotdl` Tauri command** — mirrors `check_ytdlp` pattern
2. **Add `check_ffmpeg` Tauri command** — verifies ffmpeg is available
3. **Update ContentArea.tsx** — call both checks on init, display real status

### Files Changed
- `src-tauri/src/lib.rs` — Add `check_spotdl`, `check_ffmpeg` commands
- `src/components/ContentArea.tsx` — Replace hardcoded status with real checks

### Risks
- Minimal — additive change

### Validation
- Test with ffmpeg/spotdl installed and uninstalled
- Verify dashboard shows correct status

---

## Fix 4: YouTube Playback Reliability (BUG-007, BUG-008, BUG-009)

### Problem
Stream URLs expire after ~6 hours. No refresh mechanism. No ffmpeg check. Errors silently swallowed.

### Root Cause
`<audio>.src` is set once per track selection. No `onerror` handler. No retry logic.

### Fix
1. **Stream refresh on error**: Add `onerror` handler to `<audio>` that re-invokes `get_preview_info` and retries playback once
2. **User-visible error state**: Add `playbackError` state, show in PlayerBar when audio fails
3. **ffmpeg check at startup**: Use new `check_ffmpeg` command, show in diagnostics

### Files Changed
- `src/App.tsx` — Add onerror handler with retry, add error state
- `src/components/PlayerBar.tsx` — Show playback error indicator

### Risks
- Retry loop must be bounded (max 1 retry) to avoid infinite refresh loops
- User sees brief interruption during re-resolve

### Validation
- Wait for stream URL to expire, verify auto-refresh on play
- Verify error message appears for truly unplayable tracks

---

## Fix 5: Structured Logging (BUG-012)

### Problem
No structured logging. Debug output is inconsistent console.warn/error.

### Fix
Add `[lyrics]` and `[playback]` prefixed structured log messages in the Rust backend for key events.

### Files Changed
- `src-tauri/src/lib.rs` — Add println! with structured tags for lyrics search events

### Risks
- None — additive, debug-only

### Validation
- Run app, observe structured log output in terminal

---

## Fix 6: Clean Dead Code

### Problem
Dead frontend lyrics code, dead LyricsOverlay database, unused exports.

### Fix
Remove all dead code identified in the audit.

### Files Changed
- `src/utils/lyrics.ts` — Remove STATIC_LYRICS_DB, fetchLyrics
- `src/components/LyricsOverlay.tsx` — Remove LYRICS_DATABASE, DEFAULT_LYRICS

### Risks
- None — verified dead code

### Validation
- `npm run build` succeeds
- No runtime errors
