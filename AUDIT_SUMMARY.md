# Audit Summary

> Honest assessment of MG Lyrics Player's engineering quality, technical debt, and production readiness.

---

## Strengths

### Architecture
- **Clean three-layer separation** — Frontend, Rust backend, and Python sidecar each have clear responsibilities with no leaky abstractions between them.
- **Tauri v2 ACL security model** — Explicit capability declarations prevent the webview from accessing system resources directly. All privileged operations route through typed Rust commands.
- **Multi-window IPC** — The floating lyrics window uses Tauri's native event system with proper throttling, avoiding the fragility of shared mutable state across processes.

### Engineering Quality
- **Levenshtein matching engine** — A well-designed fuzzy matching system with weighted multi-factor scoring, query normalization, and cascading fallback. This is production-grade string matching built without external NLP dependencies.
- **Subprocess safety** — All external tool invocations use `Command::new()` with argument arrays, eliminating command injection vectors by design.
- **Structured logging** — Tagged, grep-filterable diagnostic output (`[lyrics]`, `[playback]`) across the Rust backend. Every decision point in the lyrics pipeline is logged.
- **Ref-mirroring pattern** — Disciplined approach to React closure stale-state problems, with 6 values consistently mirrored via useEffect.

### Code Hygiene
- **Post-audit cleanup** — 250+ lines of dead code removed after a structured audit process. All 12 identified bugs were documented and resolved.
- **Zero build errors** — TypeScript strict mode and Rust compilation both pass cleanly.
- **Cross-platform path handling** — Consistent forward-slash normalization and file URL construction work across Windows, macOS, and Linux.

### User Experience
- **Five polished lyrics themes** — Each with distinct typography, color scheme, and animation. Not placeholder options — genuinely different visual identities.
- **Click-through mode** — The lyrics overlay doesn't interfere with other applications, solving a real pain point for gamers and multitaskers.
- **Generated cover art** — SVG gradient placeholders are visually appealing, not gray boxes.

---

## Weaknesses

### Architecture
- **Monolithic Rust backend** — All 917 lines of backend logic live in a single `lib.rs`. This works at current scale but will resist modularization as features are added. The lyrics engine, download manager, and file scanner should be separate modules.
- **No error types** — Every Tauri command returns `Result<T, String>`. Structured error types would enable the frontend to distinguish recoverable errors (network timeout) from permanent ones (tool not installed).
- **Dual yt-dlp integration** — yt-dlp is used both as a subprocess from Rust and as a Python library in the sidecar. This creates an implicit version dependency — behavior could diverge if different versions are installed.

### State Management
- **localStorage persistence** — Playlists, volume, window position, and URL history are stored in the browser's localStorage. This is fragile (cleared on cache wipe), limited in capacity, and not queryable. A SQLite database via Tauri's plugin would be more robust.
- **No queue model** — There's no explicit play queue. Track ordering is determined by array index, and there's no shuffle, repeat, or queue manipulation. The `trackIdx` state variable tracks position but there's no queue data structure.
- **Demo data in production code** — 8 hardcoded demo tracks with SoundHelix URLs are embedded directly in App.tsx. These serve as first-run content but should be loaded from a config file or database.

### Frontend
- **ContentArea size** — At 1,957 lines, ContentArea.tsx is the largest component. It handles 5 distinct views with separate state, loading, and error handling. This should be decomposed into individual view components.
- **Duplicated cover art generation** — `makeCover()` appears in both App.tsx and ContentArea.tsx with identical implementation.
- **No error boundaries** — A crash in any component takes down the entire application. React Error Boundaries would contain failures to individual views.
- **No loading skeletons** — Download previews and playlist imports show basic loading text instead of skeleton UI components.

### Backend
- **Python sidecar lifecycle** — The sidecar must be started manually (or via `run.bat`). There's no health check on startup, no automatic restart, and no graceful shutdown coordination with the Tauri app.
- **No rate limiting** — The app can spam lrclib.net and Spotify APIs without throttling. This risks IP bans during heavy use.
- **CSP disabled** — Content Security Policy is set to `null` in `tauri.conf.json`. While Tauri's ACL provides defense-in-depth, enabling CSP would add another layer against XSS.

---

## Technical Debt

| Item | Severity | Effort | Description |
|------|----------|--------|-------------|
| `LyricsOverlay.tsx` | Low | 5 min | 327-line dead component, never rendered. Delete it. |
| `TrackList.tsx` | Low | 5 min | 115-line unused component, imported but not rendered. Delete it. |
| `App.css` | Low | 1 min | Empty file (1 newline). Delete it. |
| `scratch_*.py` (7 files) | Low | 5 min | Development exploration scripts in project root. Move to a `/scratch` directory or remove. |
| `spotify_playlist.html` | Low | 1 min | Captured Spotify page HTML. Remove from repo. |
| `get_spotify_meta.py` in `src-tauri/` | Low | 1 min | Unused Python script in Rust directory. Remove. |
| Demo tracks in App.tsx | Medium | 30 min | Hardcoded track data should be extracted to a JSON file or loaded from database. |
| `makeCover()` duplication | Medium | 15 min | Extract to a shared utility module. |
| ContentArea.tsx size | Medium | 2 hrs | Decompose into 5 separate view components (Home, Search, Downloads, Discover, PlaylistView). |
| `lib.rs` monolith | Medium | 1 hr | Split into modules: `lyrics.rs`, `download.rs`, `scanner.rs`, `tools.rs`. |
| HTTP wildcard scope | Medium | 10 min | Remove `https://*/*` from capabilities and whitelist only needed domains. |
| No structured error types | Medium | 2 hrs | Replace `String` errors with an enum for typed error handling. |

**Total estimated cleanup: ~7 hours**

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **yt-dlp breaking changes** | Medium | High | yt-dlp updates its JSON schema periodically. Pin version or add schema validation. |
| **YouTube rate limiting** | Medium | Medium | Streaming resolves a new URL per track. High-volume use could trigger rate limits. Add caching for resolved URLs. |
| **LRCLib availability** | Low | High | Single lyrics source with no fallback. Adding Genius or Musixmatch as backup would improve resilience. |
| **Spotify API changes** | Low | Medium | Client Credentials flow is stable, but oembed responses could change. Monitor API changelog. |
| **localStorage corruption** | Medium | Low | Malformed JSON in localStorage crashes playlist loading. The `try/catch` around parsing handles this, but data is lost. |
| **Large playlist performance** | Low | Medium | All tracks are held in a single React state array with no virtualization. Playlists with 1000+ tracks may cause UI lag. |

---

## Scores

### Maintainability Score: 7/10

**Rationale:** The codebase is well-structured at the architectural level with clean separation between frontend, Rust backend, and Python sidecar. Naming is descriptive, logging is structured, and the audit trail (AUDIT_REPORT, IMPLEMENTATION_PLAN, FINAL_IMPLEMENTATION_REPORT) demonstrates a disciplined engineering process. Points deducted for: monolithic lib.rs and ContentArea.tsx files, dead code still present, no automated tests.

### Architecture Score: 8/10

**Rationale:** The three-layer design is appropriate for the problem domain. The Tauri v2 ACL model, multi-window IPC, and subprocess safety patterns show mature architectural thinking. The Levenshtein matching engine is algorithmically sound. Points deducted for: no database layer, no queue data model, dual yt-dlp integration creating implicit coupling.

### Production Readiness Score: 5/10

**Rationale:** The app builds cleanly, runs on Windows, and core features work. However, production readiness requires: automated test suite (none exists), CI/CD pipeline (none exists), proper error reporting, sidecar lifecycle management, rate limiting, and real user testing across platforms. The app is a strong beta, not a production release.

---

## Recommended Next Steps

### Immediate (Before Public Release)

1. **Delete dead code** — Remove `LyricsOverlay.tsx`, `TrackList.tsx`, `App.css`, scratch files, `get_spotify_meta.py`, and `spotify_playlist.html`.
2. **Tighten HTTP scope** — Remove `https://*/*` wildcard from Tauri capabilities.
3. **Add a LICENSE file** — The README references MIT but no LICENSE file exists.
4. **Move demo data** — Extract hardcoded tracks to a loadable JSON file.
5. **Clean up project root** — Move scratch scripts out of the root directory.

### Short-Term (1-2 Weeks)

6. **Split ContentArea.tsx** — Decompose into individual view components.
7. **Modularize lib.rs** — Split into `lyrics.rs`, `download.rs`, `scanner.rs`, `tools.rs`.
8. **Add basic tests** — Unit tests for Levenshtein matching, LRC parsing, query cleaning, and confidence scoring.
9. **Add error boundaries** — Wrap each view in a React Error Boundary.
10. **Enable CSP** — Configure Content Security Policy to restrict inline scripts.

### Medium-Term (1-2 Months)

11. **SQLite persistence** — Replace localStorage with `tauri-plugin-sql` for playlists, play history, and queue state.
12. **Automated CI** — GitHub Actions for TypeScript checks, Rust compilation, and test execution.
13. **Sidecar lifecycle** — Auto-start Python sidecar with health checks and graceful shutdown.
14. **URL caching** — Cache resolved YouTube stream URLs with TTL to reduce redundant yt-dlp calls.
15. **Virtual scrolling** — Add windowed rendering for large track lists.
