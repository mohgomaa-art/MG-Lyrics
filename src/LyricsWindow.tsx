/**
 * LyricsWindow.tsx
 * Renders in a separate, borderless, transparent, always-on-top Tauri window.
 * Completely click-through (setIgnoreCursorEvents = true) — zero gaming interference.
 * Receives live playback state from the main window via Tauri events.
 * Features: 5 themes, font size control (A-/A+), position persistence.
 */
import { useEffect, useState, useRef } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface LyricLine { time: number; text: string; }

interface LyricsPayload {
  trackId: string;
  progress: number;
  isPlaying: boolean;
  trackTitle: string;
  trackArtist: string;
  lyrics?: LyricLine[] | null;
}

export default function LyricsWindow() {
  const [info, setInfo] = useState<LyricsPayload>({
    trackId: "", progress: 0, isPlaying: false,
    trackTitle: "MG Lyrics", trackArtist: "No track",
  });
  const [lyricsList, setLyricsList] = useState<LyricLine[] | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [lyricsTheme, setLyricsTheme] = useState("nebula");

  // Persisted lyrics sync offset (in seconds)
  const [syncOffset, setSyncOffset] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("mg_lyrics_offset");
      return saved ? parseFloat(saved) : 0;
    } catch {
      return 0;
    }
  });

  const handleOffsetChange = (delta: number) => {
    setSyncOffset((prev) => {
      const next = Math.round((prev + delta) * 10) / 10;
      try { localStorage.setItem("mg_lyrics_offset", String(next)); } catch {}
      return next;
    });
  };

  // Persisted font size
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem("mg_lyrics_fontsize");
    return saved ? Math.max(14, Math.min(60, parseInt(saved, 10))) : 28;
  });

  const positionSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Make background and root transparent
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";

    // Set initial ignore cursor events to true (pinned)
    getCurrentWindow().setIgnoreCursorEvents(true).catch(() => {});

    // Save window position to localStorage (debounced)
    const unsubMove = getCurrentWindow().listen("tauri://move", () => {
      if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
      positionSaveTimer.current = setTimeout(async () => {
        try {
          const pos = await getCurrentWindow().outerPosition();
          localStorage.setItem("mg_lyrics_pos", JSON.stringify({ x: pos.x, y: pos.y }));
        } catch {}
      }, 500);
    });

    // Listen for live updates from the main player window
    const unsubUpdate = listen<LyricsPayload>("lyrics-update", (e) => {
      setInfo(e.payload);
      if (e.payload.lyrics !== undefined) {
        setLyricsList(e.payload.lyrics);
      }
    });

    // Listen for pin state changes
    const unsubPin = listen<{ pinned: boolean }>("lyrics-pin-state", (e) => {
      setIsPinned(e.payload.pinned);
      getCurrentWindow().setIgnoreCursorEvents(e.payload.pinned).catch(() => {});
    });

    // Listen for theme changes
    const unsubTheme = listen<{ theme: string }>("lyrics-theme-state", (e) => {
      setLyricsTheme(e.payload.theme);
    });

    // Listen for font size changes from main window
    const unsubFont = listen<{ fontSize: number }>("lyrics-fontsize-state", (e) => {
      setFontSize(e.payload.fontSize);
      localStorage.setItem("mg_lyrics_fontsize", String(e.payload.fontSize));
    });

    // Listen for lyrics offset nudge from main player shortcuts
    const unsubNudge = listen<{ delta: number }>("lyrics-offset-nudge", (e) => {
      if (typeof e.payload?.delta === "number") {
        setSyncOffset((prev) => {
          const next = Math.round((prev + e.payload.delta) * 10) / 10;
          try { localStorage.setItem("mg_lyrics_offset", String(next)); } catch {}
          return next;
        });
      }
    });

    // Global wheel event for Ctrl+Scroll font sizing
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 2 : -2;
        setFontSize(prev => {
          const next = Math.max(14, Math.min(60, prev + delta));
          localStorage.setItem("mg_lyrics_fontsize", String(next));
          emit("lyrics-fontsize-state", { fontSize: next }).catch(() => {});
          return next;
        });
      }
    };
    window.addEventListener("wheel", handleWheel, { passive: false });

    // Notify main window that lyrics window is ready and request current state
    emit("lyrics-ready", {}).catch(() => {});

    return () => {
      unsubMove.then(fn => fn());
      unsubUpdate.then(fn => fn());
      unsubPin.then(fn => fn());
      unsubTheme.then(fn => fn());
      unsubFont.then(fn => fn());
      unsubNudge.then(fn => fn());
      window.removeEventListener("wheel", handleWheel);
    };
  }, []);

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
    setFontSize(prev => {
      const next = Math.max(14, Math.min(60, prev + delta));
      localStorage.setItem("mg_lyrics_fontsize", String(next));
      emit("lyrics-fontsize-state", { fontSize: next }).catch(() => {});
      return next;
    });
  };

  // Compute current lyric line using absolute progress + sync offset
  const activeLyrics = lyricsList;
  const currentProgress = Math.max(0, info.progress + syncOffset);

  let idx = -1;
  if (activeLyrics && activeLyrics.length > 0) {
    for (let i = activeLyrics.length - 1; i >= 0; i--) {
      if (currentProgress >= activeLyrics[i].time) {
        idx = i;
        break;
      }
    }
  }

  const current  = activeLyrics && idx >= 0 ? activeLyrics[idx] : null;
  const prev     = activeLyrics && idx > 0 ? activeLyrics[idx - 1] : null;
  const next     = activeLyrics && idx >= 0 && idx < activeLyrics.length - 1 
    ? activeLyrics[idx + 1] 
    : (activeLyrics && idx === -1 && activeLyrics.length > 0 ? activeLyrics[0] : null);
  const nextLine = activeLyrics && idx >= 0 && activeLyrics.length > idx + 1 ? activeLyrics[idx + 1] : null;

  // Word-by-word highlight with duration cap
  const naturalLineDur = nextLine && current ? nextLine.time - current.time : 4.5;
  const words = current ? current.text.split(" ").filter(Boolean) : [];
  const cappedLineDur = Math.min(naturalLineDur, Math.max(2.5, words.length * 0.6));
  const elapsed = current ? Math.max(0, currentProgress - current.time) : 0;
  const wDur = words.length > 0 ? cappedLineDur / words.length : 1;
  const activeW = words.length > 0 
    ? (elapsed >= cappedLineDur ? words.length : Math.min(Math.floor(elapsed / wDur), words.length - 1))
    : 0;

  // 10 Themes configs
  const THEME_CONFIGS: Record<string, any> = {
    nebula: {
      fontFamily: "'Outfit', sans-serif",
      activeColor: "#C084FC",
      inactiveColor: "rgba(255,255,255,0.28)",
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
      outline: "0 0 4px #000, 0 2px 10px #000",
      glowShadow: "0 0 18px rgba(167, 139, 250, 0.8), 0 0 30px rgba(236, 72, 153, 0.4), 0 0 4px #000",
      animationClass: "theme-tokyo-active",
      background: "rgba(5, 5, 18, 0.35)",
      borderColor: "rgba(167, 139, 250, 0.45)",
    },
  };

  const currentTheme = THEME_CONFIGS[lyricsTheme] ?? THEME_CONFIGS.nebula;

  // Render loading state
  if (activeLyrics === null) {
    return (
      <div 
        data-tauri-drag-region={!isPinned ? "true" : undefined}
        style={{
          width: "100vw", height: "100vh",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          background: !isPinned ? "rgba(10,10,16,0.85)" : currentTheme.background,
          backdropFilter: !isPinned ? "blur(10px)" : "none",
          overflow: "hidden",
          padding: !isPinned ? "40px 20px 20px 20px" : "0 20px",
          pointerEvents: !isPinned ? "auto" : "none",
          userSelect: "none",
          fontFamily: currentTheme.fontFamily,
          border: !isPinned ? `2px dashed ${currentTheme.borderColor}` : "none",
          borderRadius: !isPinned ? 12 : 0,
          position: "relative",
          transition: "all 0.3s ease",
        }}
      >
        {!isPinned && (
          <div 
            data-tauri-drag-region="true"
            style={{
              position: "absolute", top: 0, left: 0, right: 0,
              height: 38, background: "rgba(255,255,255,0.04)",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              display: "flex", alignItems: "center",
              padding: "0 14px",
              fontFamily: "'Inter', sans-serif",
              fontSize: 11, fontWeight: 700, color: "#fff",
              zIndex: 10,
              justifyContent: "space-between",
            }}
          >
            <div data-tauri-drag-region="true" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: currentTheme.activeColor }} />
              Free Mode (Drag anywhere to move)
            </div>
            
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#5A5D70", marginRight: 4 }}>Theme:</span>
              {Object.keys(THEME_CONFIGS).map((t) => (
                <button
                  key={t}
                  onClick={() => handleThemeChange(t)}
                  style={{
                    background: lyricsTheme === t ? currentTheme.activeColor : "rgba(255,255,255,0.06)",
                    border: "none", color: lyricsTheme === t ? "#000" : "#9FA2B4",
                    padding: "2px 8px", borderRadius: 4,
                    fontSize: 9, fontWeight: 800, cursor: "pointer",
                    textTransform: "uppercase",
                    transition: "all 0.15s ease",
                  }}
                >
                  {t}
                </button>
              ))}

              <span style={{ color: "#5A5D70", marginLeft: 10, marginRight: 4 }}>Font:</span>
              <button
                onClick={() => handleFontSize(-2)}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "none", color: "#9FA2B4",
                  width: 20, height: 20, borderRadius: 4,
                  fontSize: 10, fontWeight: 800, cursor: "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center"
                }}
                title="Decrease Font Size"
              >
                A-
              </button>
              <span style={{ color: "#FFF", fontSize: 10, minWidth: 24, textAlign: "center" }}>{fontSize}px</span>
              <button
                onClick={() => handleFontSize(2)}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "none", color: "#9FA2B4",
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
                  background: "#EC4899",
                  border: "none", color: "#fff",
                  padding: "3px 10px", borderRadius: 6,
                  fontSize: 10, fontWeight: 800, cursor: "pointer",
                  boxShadow: "0 2px 8px rgba(236,72,153,0.3)",
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
          background: !isPinned ? "rgba(10,10,16,0.85)" : currentTheme.background,
          backdropFilter: !isPinned ? "blur(10px)" : "none",
          overflow: "hidden",
          padding: !isPinned ? "40px 20px 20px 20px" : "0 20px",
          pointerEvents: !isPinned ? "auto" : "none",
          userSelect: "none",
          fontFamily: currentTheme.fontFamily,
          border: !isPinned ? `2px dashed ${currentTheme.borderColor}` : "none",
          borderRadius: !isPinned ? 12 : 0,
          position: "relative",
          transition: "all 0.3s ease",
        }}
      >
        {!isPinned && (
          <div 
            data-tauri-drag-region="true"
            style={{
              position: "absolute", top: 0, left: 0, right: 0,
              height: 38, background: "rgba(255,255,255,0.04)",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "0 14px",
              fontFamily: "'Inter', sans-serif",
              fontSize: 11, fontWeight: 700, color: "#fff",
              zIndex: 10,
            }}
          >
            <div data-tauri-drag-region="true" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: currentTheme.activeColor }} />
              Free Mode (Drag anywhere to move)
            </div>
            
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#5A5D70", marginRight: 4 }}>Theme:</span>
              {Object.keys(THEME_CONFIGS).map((t) => (
                <button
                  key={t}
                  onClick={() => handleThemeChange(t)}
                  style={{
                    background: lyricsTheme === t ? currentTheme.activeColor : "rgba(255,255,255,0.06)",
                    border: "none", color: lyricsTheme === t ? "#000" : "#9FA2B4",
                    padding: "2px 8px", borderRadius: 4,
                    fontSize: 9, fontWeight: 800, cursor: "pointer",
                    textTransform: "uppercase",
                    transition: "all 0.15s ease",
                  }}
                >
                  {t}
                </button>
              ))}

              <span style={{ color: "#5A5D70", marginLeft: 10, marginRight: 4 }}>Font:</span>
              <button
                onClick={() => handleFontSize(-2)}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "none", color: "#9FA2B4",
                  width: 20, height: 20, borderRadius: 4,
                  fontSize: 10, fontWeight: 800, cursor: "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center"
                }}
                title="Decrease Font Size"
              >
                A-
              </button>
              <span style={{ color: "#FFF", fontSize: 10, minWidth: 24, textAlign: "center" }}>{fontSize}px</span>
              <button
                onClick={() => handleFontSize(2)}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "none", color: "#9FA2B4",
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
                  background: "#EC4899",
                  border: "none", color: "#fff",
                  padding: "3px 10px", borderRadius: 6,
                  fontSize: 10, fontWeight: 800, cursor: "pointer",
                  boxShadow: "0 2px 8px rgba(236,72,153,0.3)",
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
        background: !isPinned ? "rgba(10,10,16,0.85)" : currentTheme.background,
        backdropFilter: !isPinned ? "blur(10px)" : "none",
        overflow: "hidden",
        padding: !isPinned ? "40px 20px 20px 20px" : "0 20px",
        pointerEvents: !isPinned ? "auto" : "none",
        userSelect: "none",
        gap: 10,
        fontFamily: currentTheme.fontFamily,
        border: !isPinned ? `2px dashed ${currentTheme.borderColor}` : "none",
        borderRadius: !isPinned ? 12 : 0,
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
            height: 38, background: "rgba(255,255,255,0.04)",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "0 14px",
            fontFamily: "'Inter', sans-serif",
            fontSize: 11, fontWeight: 700, color: "#fff",
            zIndex: 10,
          }}
        >
          <div data-tauri-drag-region="true" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: currentTheme.activeColor }} />
            Free Mode (Drag anywhere to move)
          </div>
          
          {/* Quick theme toggles */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#5A5D70", marginRight: 4 }}>Theme:</span>
            {Object.keys(THEME_CONFIGS).map((t) => (
              <button
                key={t}
                onClick={() => handleThemeChange(t)}
                style={{
                  background: lyricsTheme === t ? currentTheme.activeColor : "rgba(255,255,255,0.06)",
                  border: "none", color: lyricsTheme === t ? "#000" : "#9FA2B4",
                  padding: "2px 8px", borderRadius: 4,
                  fontSize: 9, fontWeight: 800, cursor: "pointer",
                  textTransform: "uppercase",
                  transition: "all 0.15s ease",
                }}
              >
                {t}
              </button>
            ))}

            <span style={{ color: "#5A5D70", marginLeft: 10, marginRight: 4 }}>Font:</span>
            <button
              onClick={() => handleFontSize(-2)}
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "none", color: "#9FA2B4",
                width: 20, height: 20, borderRadius: 4,
                fontSize: 10, fontWeight: 800, cursor: "pointer",
                display: "inline-flex", alignItems: "center", justifyContent: "center"
              }}
              title="Decrease Font Size"
            >
              A-
            </button>
            <span style={{ color: "#FFF", fontSize: 10, minWidth: 24, textAlign: "center" }}>{fontSize}px</span>
            <button
              onClick={() => handleFontSize(2)}
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "none", color: "#9FA2B4",
                width: 20, height: 20, borderRadius: 4,
                fontSize: 10, fontWeight: 800, cursor: "pointer",
                display: "inline-flex", alignItems: "center", justifyContent: "center"
              }}
              title="Increase Font Size"
            >
              A+
            </button>

            <span style={{ color: "#5A5D70", marginLeft: 10, marginRight: 4 }}>Sync:</span>
            <button
              onClick={() => handleOffsetChange(-0.5)}
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "none", color: "#9FA2B4",
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
                background: "rgba(255,255,255,0.06)",
                border: "none", color: "#9FA2B4",
                padding: "2px 6px", borderRadius: 4,
                fontSize: 10, fontWeight: 800, cursor: "pointer",
              }}
              title="Shift lyrics 0.5s later"
            >
              +0.5s
            </button>
            {syncOffset !== 0 && (
              <button
                onClick={() => setSyncOffset(0)}
                style={{
                  background: "transparent",
                  border: "none", color: "#EF4444",
                  fontSize: 9, fontWeight: 700, cursor: "pointer",
                  padding: "2px 4px",
                }}
                title="Reset sync offset"
              >
                Reset
              </button>
            )}
            
            <button
              onClick={() => handlePinToggle(true)}
              style={{
                marginLeft: 10,
                background: "#EC4899",
                border: "none", color: "#fff",
                padding: "3px 10px", borderRadius: 6,
                fontSize: 10, fontWeight: 800, cursor: "pointer",
                boxShadow: "0 2px 8px rgba(236,72,153,0.3)",
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

      {/* Previous line — dim */}
      <div style={{
        fontSize: Math.max(10, Math.round(fontSize * 0.5)), fontWeight: 600,
        color: currentTheme.inactiveColor,
        textShadow: currentTheme.outline,
        textAlign: "center",
        opacity: prev ? 1 : 0,
        transition: "opacity 0.4s ease",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "100%",
        letterSpacing: "0.01em",
      }}>
        {prev?.text ?? " "}
      </div>

      {/* Current line — word by word highlight */}
      <div style={{
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
                className={isActive ? currentTheme.animationClass : ""}
                style={{
                  display: "inline-block",
                  fontSize:    isActive ? fontSize : Math.max(12, Math.round(fontSize * 0.9)),
                  fontWeight:  isActive ? 900 : isPast ? 700 : 600,
                  color:       isActive ? currentTheme.activeColor : isPast ? "rgba(255,255,255,0.9)" : currentTheme.inactiveColor,
                  textShadow:  isActive ? currentTheme.glowShadow : currentTheme.outline,
                  transform:   isActive && lyricsTheme !== "cyberpunk" && lyricsTheme !== "terminal" && lyricsTheme !== "elegant" && lyricsTheme !== "minimal"
                    ? "translateY(-2px) scale(1.05)" 
                    : "scale(1)",
                  transition:  "all 0.2s ease",
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
        transition: "opacity 0.4s ease",
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
