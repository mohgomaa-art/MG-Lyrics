/**
 * LyricsWindow.tsx
 * Renders in a separate, borderless, transparent, always-on-top Tauri window.
 * Completely click-through (setIgnoreCursorEvents = true) — zero gaming interference.
 * Receives live playback state from the main window via Tauri events.
 * Features: 5 themes, font size control (A-/A+), position persistence.
 */
import { useEffect, useState, useRef, useCallback } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { safeInvoke } from "./utils/tauriBridge";
import { STORAGE_KEYS } from "./config";
import { LyricsClock, selectLineIndex, wordState, type LyricLine } from "./utils/lyricsClock";
import { saveOverlayRect } from "./utils/overlayWindow";

/**
 * Payload of the `lyrics-sync` event (protocol v2).
 *
 * The player sends an *anchor*: the audio position together with the wall-clock
 * instant it was read (`wall`). The overlay extrapolates from that anchor with
 * its own clock, so the display keeps moving between events and does not lag by
 * the event interval. `lyrics` is only present when the list actually changed.
 */
interface LyricsPayload {
  v?: number;
  seq?: number;
  trackId: string;
  position?: number;
  wall?: number;
  playing?: boolean;
  rate?: number;
  duration?: number;
  trackTitle: string;
  trackArtist: string;
  lyrics?: LyricLine[] | null;
  // fields of the pre-v2 `lyrics-update` event, still accepted
  progress?: number;
  isPlaying?: boolean;
}

export default function LyricsWindow() {
  const [info, setInfo] = useState<{
    trackId: string;
    trackTitle: string;
    trackArtist: string;
    playing: boolean;
    duration: number;
  }>({ trackId: "", trackTitle: "MG Lyrics", trackArtist: "No track", playing: false, duration: 0 });

  const [lyricsList, setLyricsList] = useState<LyricLine[] | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [lyricsTheme, setLyricsTheme] = useState("classic");

  // Persisted lyrics sync offset (in seconds), stored per track.
  const [syncOffset, setSyncOffset] = useState<number>(0);

  // Persisted font size
  const [fontSize, setFontSize] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.lyricsFontSize);
      return saved ? Math.max(14, Math.min(60, parseInt(saved, 10))) : 28;
    } catch {
      return 28;
    }
  });

  // Derived line/word state. Recomputed by the animation frame loop and only
  // committed to React state when the visible result changes.
  const [frame, setFrame] = useState({
    idx: -1,
    activeWord: -1,
    elapsed: 0,
    lineDuration: 4.5,
    finished: false,
  });

  const clockRef       = useRef<LyricsClock>(new LyricsClock());
  const lyricsRef      = useRef<LyricLine[] | null>(null);
  const offsetRef      = useRef(0);
  const trackIdRef     = useRef("");
  const frameKeyRef    = useRef("");
  const shownRef       = useRef(false);
  const positionSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Offset for a track, falling back to the global default. */
  const readOffset = useCallback((trackId: string): number => {
    try {
      const raw =
        (trackId ? localStorage.getItem(`${STORAGE_KEYS.lyricsOffset}:${trackId}`) : null) ??
        localStorage.getItem(STORAGE_KEYS.lyricsOffset);
      const value = raw ? parseFloat(raw) : 0;
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }, []);

  const writeOffset = useCallback((trackId: string, value: number) => {
    try {
      if (trackId) localStorage.setItem(`${STORAGE_KEYS.lyricsOffset}:${trackId}`, String(value));
      else localStorage.setItem(STORAGE_KEYS.lyricsOffset, String(value));
    } catch {
      /* storage disabled */
    }
  }, []);

  const setOffsetFor = useCallback(
    (next: number) => {
      const value = Math.round(next * 10) / 10;
      offsetRef.current = value;
      setSyncOffset(value);
      writeOffset(trackIdRef.current, value);
    },
    [writeOffset]
  );

  const handleOffsetChange = useCallback(
    (delta: number) => setOffsetFor(offsetRef.current + delta),
    [setOffsetFor]
  );

  /** Apply an anchor from the player window. */
  const applyAnchor = useCallback(
    (p: LyricsPayload) => {
      if (!p || typeof p !== "object") return;
      const wall = typeof p.wall === "number" ? p.wall : Date.now();
      const position =
        typeof p.position === "number" ? p.position : typeof p.progress === "number" ? p.progress : 0;
      const playing = typeof p.playing === "boolean" ? p.playing : Boolean(p.isPlaying);
      const duration = typeof p.duration === "number" && p.duration > 0 ? p.duration : 0;
      const trackId = typeof p.trackId === "string" ? p.trackId : "";

      if (trackId !== trackIdRef.current) {
        trackIdRef.current = trackId;
        const offset = readOffset(trackId);
        offsetRef.current = offset;
        setSyncOffset(offset);
        frameKeyRef.current = "";
      }

      clockRef.current.sync(
        { trackId, position, wall, playing, rate: typeof p.rate === "number" ? p.rate : 1, duration },
        Date.now()
      );

      if (typeof p.lyrics !== "undefined") {
        lyricsRef.current = p.lyrics ?? null;
        setLyricsList(p.lyrics ?? null);
        frameKeyRef.current = "";
      }

      setInfo((prev) =>
        prev.trackId === trackId &&
        prev.trackTitle === p.trackTitle &&
        prev.trackArtist === p.trackArtist &&
        prev.playing === playing &&
        prev.duration === duration
          ? prev
          : {
              trackId,
              trackTitle: p.trackTitle ?? prev.trackTitle,
              trackArtist: p.trackArtist ?? prev.trackArtist,
              playing,
              duration,
            }
      );
    },
    [readOffset]
  );

  useEffect(() => {
    // Make background and root transparent
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";

    // Set initial ignore cursor events to true (pinned)
    getCurrentWindow().setIgnoreCursorEvents(true).catch(() => {});

    // Global default offset until a track arrives
    const initialOffset = readOffset("");
    offsetRef.current = initialOffset;
    setSyncOffset(initialOffset);

    // Save window position to localStorage (debounced).
    // outerPosition() is physical, the window options are logical, so the scale
    // factor is applied here - otherwise the overlay drifts on scaled displays.
    const unsubMove = getCurrentWindow().listen("tauri://move", () => {
      if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
      positionSaveTimer.current = setTimeout(async () => {
        try {
          const win = getCurrentWindow();
          const [pos, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
          const s = scale > 0 ? scale : 1;
          saveOverlayRect(pos.x / s, pos.y / s, s);
        } catch {
          /* ignore */
        }
      }, 500);
    });

    const listeners = Promise.all([
      listen<LyricsPayload>("lyrics-sync", (e) => applyAnchor(e.payload)),
      // Compatibility with a player build that still emits the old event.
      listen<LyricsPayload>("lyrics-update", (e) => applyAnchor(e.payload)),
      listen<{ pinned: boolean }>("lyrics-pin-state", (e) => {
        setIsPinned(e.payload.pinned);
        getCurrentWindow().setIgnoreCursorEvents(e.payload.pinned).catch(() => {});
      }),
      listen<{ theme: string }>("lyrics-theme-state", (e) => setLyricsTheme(e.payload.theme)),
      listen<{ fontSize: number }>("lyrics-fontsize-state", (e) => {
        setFontSize(e.payload.fontSize);
        try { localStorage.setItem(STORAGE_KEYS.lyricsFontSize, String(e.payload.fontSize)); } catch {}
      }),
      listen<{ delta: number }>("lyrics-offset-nudge", (e) => {
        if (typeof e.payload?.delta === "number") {
          const next = Math.round((offsetRef.current + e.payload.delta) * 10) / 10;
          offsetRef.current = next;
          setSyncOffset(next);
          writeOffset(trackIdRef.current, next);
        }
      }),
    ]);

    // Announce readiness only after every listener is registered, otherwise the
    // player's immediate reply can be emitted into the void.
    listeners.then(() => {
      emit("lyrics-ready", {}).catch(() => {});
    });

    // Ask the player for a fresh anchor while playing. This keeps the overlay
    // correct even when the player window is minimised and its own timers are
    // throttled - the request is answered on message delivery, not on a timer.
    const resyncTimer = setInterval(() => {
      if (clockRef.current.isPlaying()) {
        emit("lyrics-resync", { needLyrics: lyricsRef.current === null }).catch(() => {});
      }
    }, 5000);

    // Global wheel event for Ctrl+Scroll font sizing
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 2 : -2;
        setFontSize((prev) => {
          const next = Math.max(14, Math.min(60, prev + delta));
          try { localStorage.setItem(STORAGE_KEYS.lyricsFontSize, String(next)); } catch {}
          emit("lyrics-fontsize-state", { fontSize: next }).catch(() => {});
          return next;
        });
      }
    };
    window.addEventListener("wheel", handleWheel, { passive: false });

    // Escape closes the overlay while it is in free (interactive) mode
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        getCurrentWindow().close().catch(() => {});
      }
    };
    window.addEventListener("keydown", handleKey);

    // Animation frame loop: the display clock, not the event stream.
    let raf = 0;
    const tick = () => {
      const clock = clockRef.current;
      const position = clock.positionAt(Date.now()) + offsetRef.current;
      const lines = lyricsRef.current;
      const idx = selectLineIndex(lines, position);
      const state = wordState(lines, idx, position);
      const key = `${idx}|${state.activeWord}|${state.finished ? 1 : 0}`;
      if (key !== frameKeyRef.current) {
        frameKeyRef.current = key;
        setFrame({
          idx,
          activeWord: state.activeWord,
          elapsed: state.elapsed,
          lineDuration: state.lineDuration,
          finished: state.finished,
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // The window is created hidden so the transparent webview never flashes
    // white; show it once this first frame has painted.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!shownRef.current) {
          shownRef.current = true;
          getCurrentWindow().show().catch(() => {});
        }
      })
    );

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(resyncTimer);
      if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", handleKey);
      listeners.then((fns) => fns.forEach((fn) => fn()));
      unsubMove.then((fn) => fn());
    };
  }, [applyAnchor, readOffset, writeOffset]);

  const handlePinToggle = (pinned: boolean) => {
    setIsPinned(pinned);
    getCurrentWindow().setIgnoreCursorEvents(pinned).catch(() => {});
    emit("lyrics-pin-state", { pinned }).catch(() => {});
  };

  const handleThemeChange = (theme: string) => {
    setLyricsTheme(theme);
    emit("lyrics-theme-state", { theme }).catch(() => {});
  };

  const handleFontSize = (delta: number) => {
    setFontSize((prev) => {
      const next = Math.max(14, Math.min(60, prev + delta));
      try { localStorage.setItem(STORAGE_KEYS.lyricsFontSize, String(next)); } catch {}
      emit("lyrics-fontsize-state", { fontSize: next }).catch(() => {});
      return next;
    });
  };

  // Close this overlay from inside the window (no ACL window-destroy permission needed).
  const closeOverlay = async () => {
    try {
      await safeInvoke("close_overlay_window");
    } catch {
      try { await getCurrentWindow().close(); } catch {}
    }
  };

  // Watchdog: this window is click-through, frameless and hidden from the taskbar, so an
  // orphaned overlay cannot be dismissed by the user at all. If the main window stops
  // sending heartbeats (closed, crashed, or never attached), close ourselves.
  useEffect(() => {
    let lastBeat = Date.now();
    const unsubBeat = listen("lyrics-heartbeat", () => { lastBeat = Date.now(); });
    const unsubClosing = listen("app-closing", () => { void closeOverlay(); });
    const timer = setInterval(() => {
      if (Date.now() - lastBeat > 15000) void closeOverlay();
    }, 2000);
    return () => {
      clearInterval(timer);
      unsubBeat.then(fn => fn());
      unsubClosing.then(fn => fn());
    };
  }, []);

  const handleClose = () => { void closeOverlay(); };

  // Line/word state comes from the frame loop (see `tick` above).
  const activeLyrics = lyricsList;
  const { idx, activeWord, elapsed, lineDuration } = frame;
  const current = activeLyrics && idx >= 0 && idx < activeLyrics.length ? activeLyrics[idx] : null;
  const prev = activeLyrics && idx > 0 ? activeLyrics[idx - 1] : null;
  const next = activeLyrics && idx >= 0 && idx < activeLyrics.length - 1
    ? activeLyrics[idx + 1]
    : (activeLyrics && idx === -1 && activeLyrics.length > 0 ? activeLyrics[0] : null);
  const words = current ? current.text.split(" ").filter(Boolean) : [];
  const activeW = activeWord;
  const cappedLineDur = lineDuration;

  // 14 overlay themes: 4 restrained (classic/inverse/serif/mono) + 10 colour themes
  const THEME_CONFIGS: Record<string, any> = {
    classic: {
      fontFamily: "'Inter', sans-serif",
      activeColor: "#FFFFFF",
      pastColor: "rgba(255,255,255,0.85)",
      inactiveColor: "rgba(255,255,255,0.58)",
      outline: "0 1px 2px rgba(0,0,0,0.45), 0 2px 12px rgba(0,0,0,0.28)",
      glowShadow: "0 1px 2px rgba(0,0,0,0.5), 0 3px 16px rgba(0,0,0,0.32)",
      animationClass: "theme-classic-active",
      background: "transparent",
      borderColor: "rgba(255,255,255,0.25)",
    },
    inverse: {
      fontFamily: "'Inter', sans-serif",
      activeColor: "#000000",
      pastColor: "rgba(0,0,0,0.85)",
      inactiveColor: "rgba(0,0,0,0.58)",
      outline: "0 1px 2px rgba(255,255,255,0.5), 0 2px 12px rgba(255,255,255,0.3)",
      glowShadow: "0 1px 2px rgba(255,255,255,0.55), 0 3px 16px rgba(255,255,255,0.35)",
      animationClass: "theme-inverse-active",
      background: "transparent",
      borderColor: "rgba(0,0,0,0.25)",
    },
    serif: {
      fontFamily: "'Playfair Display', 'Georgia', serif",
      activeColor: "#FFFFFF",
      pastColor: "rgba(255,255,255,0.85)",
      inactiveColor: "rgba(255,255,255,0.56)",
      outline: "0 1px 2px rgba(0,0,0,0.45), 0 2px 12px rgba(0,0,0,0.28)",
      glowShadow: "0 1px 2px rgba(0,0,0,0.5), 0 3px 16px rgba(0,0,0,0.32)",
      animationClass: "theme-serif-active",
      background: "transparent",
      borderColor: "rgba(255,255,255,0.25)",
    },
    mono: {
      fontFamily: "'Fira Code', 'Courier New', monospace",
      activeColor: "#FFFFFF",
      pastColor: "rgba(255,255,255,0.8)",
      inactiveColor: "rgba(255,255,255,0.54)",
      outline: "0 1px 2px rgba(0,0,0,0.5), 0 2px 10px rgba(0,0,0,0.3)",
      glowShadow: "0 1px 2px rgba(0,0,0,0.55), 0 3px 14px rgba(0,0,0,0.34)",
      animationClass: "theme-mono-active",
      background: "transparent",
      borderColor: "rgba(255,255,255,0.25)",
    },
    nebula: {
      fontFamily: "'Outfit', sans-serif",
      activeColor: "#C084FC",
      inactiveColor: "rgba(255,255,255,0.28)",
      pastColor: "rgba(255,255,255,0.5)",
      outline: "0 0 4px #000, 0 0 4px #000, 0 2px 12px #000, 0 2px 22px rgba(0,0,0,0.9)",
      glowShadow: "0 0 22px rgba(192,132,252,0.75), 0 0 4px #000, 0 0 4px #000",
      animationClass: "theme-nebula-active",
      background: "transparent",
      borderColor: "rgba(192, 132, 252, 0.4)",
    },
    cyberpunk: {
      fontFamily: "'Orbitron', 'Segoe UI', sans-serif",
      activeColor: "#00F0FF",
      inactiveColor: "rgba(0, 240, 255, 0.25)",
      pastColor: "rgba(0, 240, 255, 0.5)",
      outline: "0 0 3px #000, 0 0 3px #000, 0 1px 8px #000",
      glowShadow: "0 0 15px rgba(0, 240, 255, 0.8), 0 0 30px rgba(0, 240, 255, 0.4), 0 0 3px #000",
      animationClass: "theme-cyberpunk-active",
      background: "rgba(0, 0, 0, 0.25)",
      borderColor: "rgba(0, 240, 255, 0.5)",
    },
    terminal: {
      fontFamily: "'Fira Code', 'Courier New', monospace",
      activeColor: "#FFB000",
      inactiveColor: "rgba(255, 176, 0, 0.22)",
      pastColor: "rgba(255, 176, 0, 0.45)",
      outline: "0 0 2px #000, 0 2px 4px #000",
      glowShadow: "0 0 8px rgba(255, 176, 0, 0.6), 0 0 2px #000",
      animationClass: "theme-terminal-active",
      background: "rgba(5, 12, 5, 0.45)",
      borderColor: "rgba(255, 176, 0, 0.5)",
    },
    elegant: {
      fontFamily: "'Playfair Display', 'Georgia', serif",
      activeColor: "#F472B6",
      inactiveColor: "rgba(255,255,255,0.2)",
      pastColor: "rgba(255,255,255,0.45)",
      outline: "0 0 4px #000, 0 1px 8px rgba(0,0,0,0.5)",
      glowShadow: "0 0 12px rgba(244,114,182,0.5), 0 0 4px #000",
      animationClass: "theme-elegant-active",
      background: "transparent",
      borderColor: "rgba(244, 114, 182, 0.4)",
    },
    minimal: {
      fontFamily: "'Inter', sans-serif",
      activeColor: "#FFFFFF",
      inactiveColor: "rgba(255,255,255,0.3)",
      pastColor: "rgba(255,255,255,0.55)",
      outline: "0 0 5px #000, 0 2px 10px rgba(0,0,0,0.8)",
      glowShadow: "0 0 10px rgba(255,255,255,0.5), 0 0 5px #000",
      animationClass: "theme-minimal-active",
      background: "transparent",
      borderColor: "rgba(255, 255, 255, 0.3)",
    },
    emerald: {
      fontFamily: "'Plus Jakarta Sans', sans-serif",
      activeColor: "#10B981",
      inactiveColor: "rgba(16, 185, 129, 0.28)",
      pastColor: "rgba(16, 185, 129, 0.5)",
      outline: "0 0 4px #000, 0 0 4px #000, 0 2px 10px rgba(0,0,0,0.9)",
      glowShadow: "0 0 20px rgba(16, 185, 129, 0.8), 0 0 4px #000",
      animationClass: "theme-emerald-active",
      background: "transparent",
      borderColor: "rgba(16, 185, 129, 0.4)",
    },
    sunset: {
      fontFamily: "'Cinzel', 'Times New Roman', serif",
      activeColor: "#FF6B35",
      inactiveColor: "rgba(255, 107, 53, 0.25)",
      pastColor: "rgba(255, 107, 53, 0.5)",
      outline: "0 0 4px #000, 0 1px 8px #000",
      glowShadow: "0 0 18px rgba(255, 107, 53, 0.75), 0 0 4px #000",
      animationClass: "theme-sunset-active",
      background: "transparent",
      borderColor: "rgba(255, 107, 53, 0.45)",
    },
    synthwave: {
      fontFamily: "'Audiowide', cursive, sans-serif",
      activeColor: "#FF1493",
      inactiveColor: "rgba(255, 20, 147, 0.25)",
      pastColor: "rgba(255, 20, 147, 0.5)",
      outline: "0 0 4px #000, 0 0 8px rgba(0,0,0,0.9)",
      glowShadow: "0 0 22px rgba(255, 20, 147, 0.85), 0 0 35px rgba(0, 240, 255, 0.4), 0 0 4px #000",
      animationClass: "theme-synthwave-active",
      background: "rgba(10, 0, 20, 0.35)",
      borderColor: "rgba(255, 20, 147, 0.5)",
    },
    nordic: {
      fontFamily: "'Space Grotesk', sans-serif",
      activeColor: "#38BDF8",
      inactiveColor: "rgba(56, 189, 248, 0.25)",
      pastColor: "rgba(56, 189, 248, 0.5)",
      outline: "0 0 4px #000, 0 2px 10px rgba(0,0,0,0.85)",
      glowShadow: "0 0 18px rgba(56, 189, 248, 0.75), 0 0 4px #000",
      animationClass: "theme-nordic-active",
      background: "transparent",
      borderColor: "rgba(56, 189, 248, 0.4)",
    },
    tokyo: {
      fontFamily: "'Rajdhani', sans-serif",
      activeColor: "#A78BFA",
      inactiveColor: "rgba(167, 139, 250, 0.25)",
      pastColor: "rgba(167, 139, 250, 0.5)",
      outline: "0 0 4px #000, 0 2px 10px #000",
      glowShadow: "0 0 18px rgba(167, 139, 250, 0.8), 0 0 30px rgba(236, 72, 153, 0.4), 0 0 4px #000",
      animationClass: "theme-tokyo-active",
      background: "rgba(5, 5, 18, 0.35)",
      borderColor: "rgba(167, 139, 250, 0.45)",
    },
  };

  const currentTheme = THEME_CONFIGS[lyricsTheme] ?? THEME_CONFIGS.classic;

  // Render loading state
  if (activeLyrics === null) {
    return (
      <div 
        data-tauri-drag-region={!isPinned ? "true" : undefined}
        style={{
          width: "100vw", height: "100vh",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          background: !isPinned ? "rgba(14,14,16,0.62)" : currentTheme.background,
          backdropFilter: !isPinned ? "blur(14px) saturate(110%)" : "none",
          overflow: "hidden",
          padding: !isPinned ? "40px 20px 20px 20px" : "0 20px",
          pointerEvents: !isPinned ? "auto" : "none",
          userSelect: "none",
          fontFamily: currentTheme.fontFamily,
          border: !isPinned ? "1px solid rgba(255,255,255,0.12)" : "none",
          borderRadius: !isPinned ? 18 : 0,
          position: "relative",
          transition: "all 0.3s ease",
        }}
      >
        {!isPinned && (
          <div 
            data-tauri-drag-region="true"
            style={{
              position: "absolute", top: 0, left: 0, right: 0,
              height: 38, background: "color-mix(in srgb, var(--text) 4%, transparent)",
              borderBottom: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
              display: "flex", alignItems: "center",
              padding: "0 14px",
              fontFamily: "'Inter', sans-serif",
              fontSize: 11, fontWeight: 700, color: "var(--text)",
              zIndex: 10,
              justifyContent: "space-between",
            }}
          >
            <div data-tauri-drag-region="true" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: currentTheme.activeColor }} />
              Free Mode (Drag anywhere to move)
            </div>
            
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-3)", marginRight: 4 }}>Theme:</span>
              {Object.keys(THEME_CONFIGS).map((t) => (
                <button
                  key={t}
                  onClick={() => handleThemeChange(t)}
                  style={{
                    background: lyricsTheme === t ? "var(--accent)" : "color-mix(in srgb, var(--text) 6%, transparent)",
                    border: "none", color: lyricsTheme === t ? "var(--accent-fg)" : "var(--text-2)",
                    padding: "2px 8px", borderRadius: 4,
                    fontSize: 9, fontWeight: 800, cursor: "pointer",
                    textTransform: "uppercase",
                    transition: "all 0.15s ease",
                  }}
                >
                  {t}
                </button>
              ))}

              <span style={{ color: "var(--text-3)", marginLeft: 10, marginRight: 4 }}>Font:</span>
              <button
                onClick={() => handleFontSize(-2)}
                style={{
                  background: "color-mix(in srgb, var(--text) 6%, transparent)",
                  border: "none", color: "var(--text-2)",
                  width: 20, height: 20, borderRadius: 4,
                  fontSize: 10, fontWeight: 800, cursor: "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center"
                }}
                title="Decrease Font Size"
              >
                A-
              </button>
              <span style={{ color: "var(--text)", fontSize: 10, minWidth: 24, textAlign: "center" }}>{fontSize}px</span>
              <button
                onClick={() => handleFontSize(2)}
                style={{
                  background: "color-mix(in srgb, var(--text) 6%, transparent)",
                  border: "none", color: "var(--text-2)",
                  width: 20, height: 20, borderRadius: 4,
                  fontSize: 10, fontWeight: 800, cursor: "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center"
                }}
                title="Increase Font Size"
              >
                A+
              </button>
              
              <button
                onClick={() => handlePinToggle(true)}
                style={{
                  marginLeft: 10,
                  background: "var(--accent)",
                  border: "none", color: "var(--accent-fg)",
                  padding: "3px 10px", borderRadius: 6,
                  fontSize: 10, fontWeight: 800, cursor: "pointer",
                  boxShadow: "0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent)",
                  display: "inline-flex", alignItems: "center", gap: 5,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>Pin Overlay</span>
              </button>
            </div>
          </div>
        )}

        <div style={{
          fontSize: 16, fontWeight: 700,
          color: currentTheme.activeColor,
          textShadow: currentTheme.glowShadow,
          textAlign: "center",
          opacity: 0.8,
        }}>
          Searching for lyrics...
        </div>

        <div style={{
          position: "absolute", bottom: 8, right: 14,
          fontSize: 9, fontWeight: 700,
          color: currentTheme.inactiveColor,
          textShadow: currentTheme.outline,
          letterSpacing: "0.12em", textTransform: "uppercase",
          whiteSpace: "nowrap", overflow: "hidden",
          textOverflow: "ellipsis", maxWidth: "55%",
        }}>
          {info.trackTitle} · {info.trackArtist}
        </div>
      </div>
    );
  }

  // Render empty state (no lyrics found)
  if (activeLyrics.length === 0) {
    return (
      <div 
        data-tauri-drag-region={!isPinned ? "true" : undefined}
        style={{
          width: "100vw", height: "100vh",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          background: !isPinned ? "rgba(14,14,16,0.62)" : currentTheme.background,
          backdropFilter: !isPinned ? "blur(14px) saturate(110%)" : "none",
          overflow: "hidden",
          padding: !isPinned ? "40px 20px 20px 20px" : "0 20px",
          pointerEvents: !isPinned ? "auto" : "none",
          userSelect: "none",
          fontFamily: currentTheme.fontFamily,
          border: !isPinned ? "1px solid rgba(255,255,255,0.12)" : "none",
          borderRadius: !isPinned ? 18 : 0,
          position: "relative",
          transition: "all 0.3s ease",
        }}
      >
        {!isPinned && (
          <div 
            data-tauri-drag-region="true"
            style={{
              position: "absolute", top: 0, left: 0, right: 0,
              height: 38, background: "color-mix(in srgb, var(--text) 4%, transparent)",
              borderBottom: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "0 14px",
              fontFamily: "'Inter', sans-serif",
              fontSize: 11, fontWeight: 700, color: "var(--text)",
              zIndex: 10,
            }}
          >
            <div data-tauri-drag-region="true" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: currentTheme.activeColor }} />
              Free Mode (Drag anywhere to move)
            </div>
            
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-3)", marginRight: 4 }}>Theme:</span>
              {Object.keys(THEME_CONFIGS).map((t) => (
                <button
                  key={t}
                  onClick={() => handleThemeChange(t)}
                  style={{
                    background: lyricsTheme === t ? "var(--accent)" : "color-mix(in srgb, var(--text) 6%, transparent)",
                    border: "none", color: lyricsTheme === t ? "var(--accent-fg)" : "var(--text-2)",
                    padding: "2px 8px", borderRadius: 4,
                    fontSize: 9, fontWeight: 800, cursor: "pointer",
                    textTransform: "uppercase",
                    transition: "all 0.15s ease",
                  }}
                >
                  {t}
                </button>
              ))}

              <span style={{ color: "var(--text-3)", marginLeft: 10, marginRight: 4 }}>Font:</span>
              <button
                onClick={() => handleFontSize(-2)}
                style={{
                  background: "color-mix(in srgb, var(--text) 6%, transparent)",
                  border: "none", color: "var(--text-2)",
                  width: 20, height: 20, borderRadius: 4,
                  fontSize: 10, fontWeight: 800, cursor: "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center"
                }}
                title="Decrease Font Size"
              >
                A-
              </button>
              <span style={{ color: "var(--text)", fontSize: 10, minWidth: 24, textAlign: "center" }}>{fontSize}px</span>
              <button
                onClick={() => handleFontSize(2)}
                style={{
                  background: "color-mix(in srgb, var(--text) 6%, transparent)",
                  border: "none", color: "var(--text-2)",
                  width: 20, height: 20, borderRadius: 4,
                  fontSize: 10, fontWeight: 800, cursor: "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center"
                }}
                title="Increase Font Size"
              >
                A+
              </button>
              
              <button
                onClick={() => handlePinToggle(true)}
                style={{
                  marginLeft: 10,
                  background: "var(--accent)",
                  border: "none", color: "var(--accent-fg)",
                  padding: "3px 10px", borderRadius: 6,
                  fontSize: 10, fontWeight: 800, cursor: "pointer",
                  boxShadow: "0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent)",
                  display: "inline-flex", alignItems: "center", gap: 5,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>Pin Overlay</span>
              </button>
            </div>
          </div>
        )}

        <div style={{
          fontSize: 14, fontWeight: 700,
          color: currentTheme.inactiveColor,
          textShadow: currentTheme.outline,
          textAlign: "center",
        }}>
          Lyrics unavailable for this track
        </div>

        <div style={{
          position: "absolute", bottom: 8, right: 14,
          fontSize: 9, fontWeight: 700,
          color: currentTheme.inactiveColor,
          textShadow: currentTheme.outline,
          letterSpacing: "0.12em", textTransform: "uppercase",
          whiteSpace: "nowrap", overflow: "hidden",
          textOverflow: "ellipsis", maxWidth: "55%",
        }}>
          {info.trackTitle} · {info.trackArtist}
        </div>
      </div>
    );
  }

  return (
    <div 
      data-tauri-drag-region={!isPinned ? "true" : undefined}
      style={{
        width: "100vw", height: "100vh",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        background: !isPinned ? "rgba(14,14,16,0.62)" : currentTheme.background,
        backdropFilter: !isPinned ? "blur(14px) saturate(110%)" : "none",
        overflow: "hidden",
        padding: !isPinned ? "40px 20px 20px 20px" : "0 20px",
        pointerEvents: !isPinned ? "auto" : "none",
        userSelect: "none",
        gap: 10,
        fontFamily: currentTheme.fontFamily,
        border: !isPinned ? "1px solid rgba(255,255,255,0.12)" : "none",
        borderRadius: !isPinned ? 18 : 0,
        position: "relative",
        transition: "all 0.3s ease",
      }}
    >
      {/* Free mode toolbar header */}
      {!isPinned && (
        <div 
          data-tauri-drag-region="true"
          style={{
            position: "absolute", top: 0, left: 0, right: 0,
            height: 38, background: "color-mix(in srgb, var(--text) 4%, transparent)",
            borderBottom: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "0 14px",
            fontFamily: "'Inter', sans-serif",
            fontSize: 11, fontWeight: 700, color: "var(--text)",
            zIndex: 10,
          }}
        >
          <div data-tauri-drag-region="true" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: currentTheme.activeColor }} />
            Free Mode (Drag anywhere to move)
          </div>
          
          {/* Quick theme toggles */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--text-3)", marginRight: 4 }}>Theme:</span>
            {Object.keys(THEME_CONFIGS).map((t) => (
              <button
                key={t}
                onClick={() => handleThemeChange(t)}
                style={{
                  background: lyricsTheme === t ? "var(--accent)" : "color-mix(in srgb, var(--text) 6%, transparent)",
                  border: "none", color: lyricsTheme === t ? "var(--accent-fg)" : "var(--text-2)",
                  padding: "2px 8px", borderRadius: 4,
                  fontSize: 9, fontWeight: 800, cursor: "pointer",
                  textTransform: "uppercase",
                  transition: "all 0.15s ease",
                }}
              >
                {t}
              </button>
            ))}

            <span style={{ color: "var(--text-3)", marginLeft: 10, marginRight: 4 }}>Font:</span>
            <button
              onClick={() => handleFontSize(-2)}
              style={{
                background: "color-mix(in srgb, var(--text) 6%, transparent)",
                border: "none", color: "var(--text-2)",
                width: 20, height: 20, borderRadius: 4,
                fontSize: 10, fontWeight: 800, cursor: "pointer",
                display: "inline-flex", alignItems: "center", justifyContent: "center"
              }}
              title="Decrease Font Size"
            >
              A-
            </button>
            <span style={{ color: "var(--text)", fontSize: 10, minWidth: 24, textAlign: "center" }}>{fontSize}px</span>
            <button
              onClick={() => handleFontSize(2)}
              style={{
                background: "color-mix(in srgb, var(--text) 6%, transparent)",
                border: "none", color: "var(--text-2)",
                width: 20, height: 20, borderRadius: 4,
                fontSize: 10, fontWeight: 800, cursor: "pointer",
                display: "inline-flex", alignItems: "center", justifyContent: "center"
              }}
              title="Increase Font Size"
            >
              A+
            </button>

            <span style={{ color: "var(--text-3)", marginLeft: 10, marginRight: 4 }}>Sync:</span>
            <button
              onClick={() => handleOffsetChange(-0.5)}
              style={{
                background: "color-mix(in srgb, var(--text) 6%, transparent)",
                border: "none", color: "var(--text-2)",
                padding: "2px 6px", borderRadius: 4,
                fontSize: 10, fontWeight: 800, cursor: "pointer",
              }}
              title="Shift lyrics 0.5s earlier"
            >
              -0.5s
            </button>
            <span style={{ color: syncOffset !== 0 ? currentTheme.activeColor : "#FFF", fontSize: 10, minWidth: 28, textAlign: "center" }}>
              {syncOffset > 0 ? `+${syncOffset}s` : `${syncOffset}s`}
            </span>
            <button
              onClick={() => handleOffsetChange(0.5)}
              style={{
                background: "color-mix(in srgb, var(--text) 6%, transparent)",
                border: "none", color: "var(--text-2)",
                padding: "2px 6px", borderRadius: 4,
                fontSize: 10, fontWeight: 800, cursor: "pointer",
              }}
              title="Shift lyrics 0.5s later"
            >
              +0.5s
            </button>
            {syncOffset !== 0 && (
              <button
                onClick={() => setOffsetFor(0)}
                style={{
                  background: "transparent",
                  border: "none", color: "#EF4444",
                  fontSize: 9, fontWeight: 700, cursor: "pointer",
                  padding: "2px 4px",
                }}
                title="Reset sync offset for this track"
              >
                Reset
              </button>
            )}
            
            <button
              onClick={() => handlePinToggle(true)}
              style={{
                marginLeft: 10,
                background: "var(--accent)",
                border: "none", color: "var(--accent-fg)",
                padding: "3px 10px", borderRadius: 6,
                fontSize: 10, fontWeight: 800, cursor: "pointer",
                boxShadow: "0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent)",
                display: "inline-flex", alignItems: "center", gap: 5,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>Pin Overlay</span>
            </button>

            <button
              onClick={handleClose}
              title="Close overlay (or press Esc)"
              style={{
                marginLeft: 6,
                background: "rgba(255,255,255,0.06)",
                border: "none", color: "#9FA2B4",
                width: 22, height: 22, borderRadius: 6,
                fontSize: 12, fontWeight: 800, cursor: "pointer",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Previous line — dim */}
      <div style={{
        fontSize: Math.max(10, Math.round(fontSize * 0.5)), fontWeight: 600,
        color: currentTheme.inactiveColor,
        textShadow: currentTheme.outline,
        textAlign: "center",
        opacity: prev ? 1 : 0,
        transition: "opacity 0.5s cubic-bezier(0.22,1,0.36,1)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "100%",
        letterSpacing: "0.01em",
      }}>
        {prev?.text ?? " "}
      </div>

      {/* Current line — word by word highlight */}
      <div key={idx} className="lyric-line-active" style={{
        display: "flex", flexWrap: "wrap",
        justifyContent: "center", alignItems: "baseline",
        gap: "0 0.25em", maxWidth: "100%",
        textAlign: "center",
      }}>
        {current ? (
          words.map((word, wi) => {
            const isActive = wi === activeW && elapsed < cappedLineDur;
            const isPast   = wi < activeW || elapsed >= cappedLineDur;
            return (
              <span 
                key={`${idx}-${wi}`} 
                className={`lyric-word ${isActive ? currentTheme.animationClass : ""}`}
                style={{
                  display: "inline-block",
                  fontSize:    isActive ? fontSize : Math.max(12, Math.round(fontSize * 0.9)),
                  fontWeight:  isActive ? 900 : isPast ? 700 : 600,
                  color:       isActive ? currentTheme.activeColor : isPast ? currentTheme.pastColor : currentTheme.inactiveColor,
                  textShadow:  isActive ? currentTheme.glowShadow : currentTheme.outline,
                  transform:   isActive ? "translateY(-1px) scale(1.03)" : "scale(1)",
                  letterSpacing: "-0.01em",
                  lineHeight: 1.2,
                }}
              >
                {word}
              </span>
            );
          })
        ) : (
          <span style={{
            fontSize: Math.max(13, Math.round(fontSize * 0.65)),
            fontWeight: 700,
            color: currentTheme.inactiveColor,
            textShadow: currentTheme.outline,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            opacity: 0.8,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
            <span>Instrumental Intro</span>
          </span>
        )}
      </div>

      {/* Next line — dim */}
      <div style={{
        fontSize: Math.max(10, Math.round(fontSize * 0.5)), fontWeight: 600,
        color: currentTheme.inactiveColor,
        textShadow: currentTheme.outline,
        textAlign: "center",
        opacity: next ? 1 : 0,
        transition: "opacity 0.5s cubic-bezier(0.22,1,0.36,1)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "100%",
        letterSpacing: "0.01em",
      }}>
        {next?.text ?? " "}
      </div>

      {/* Track label — bottom right corner */}
      <div style={{
        position: "absolute", bottom: 8, right: 14,
        fontSize: 9, fontWeight: 700,
        color: currentTheme.inactiveColor,
        textShadow: currentTheme.outline,
        letterSpacing: "0.12em", textTransform: "uppercase",
        whiteSpace: "nowrap", overflow: "hidden",
        textOverflow: "ellipsis", maxWidth: "55%",
      }}>
        {info.trackTitle} · {info.trackArtist}
      </div>
    </div>
  );
}
