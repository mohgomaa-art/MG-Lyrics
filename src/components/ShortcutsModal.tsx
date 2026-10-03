import React, { useEffect } from "react";

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutCategory {
  category: string;
  color: string;
  shortcuts: ShortcutItem[];
}

const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  {
    category: "Playback & Seeking",
    color: "#8A2BE2",
    shortcuts: [
      { keys: ["Space", "K"], description: "Play / Pause playback" },
      { keys: ["←", "→"], description: "Seek backward / forward 5 seconds" },
      { keys: ["Shift", "← / →"], description: "Seek backward / forward 10 seconds" },
      { keys: ["Ctrl", "← / →"], description: "Previous / Next track" },
      { keys: ["B", "N"], description: "Previous / Next track (single key)" },
      { keys: ["↑", "↓"], description: "Volume Up / Down (5%)" },
      { keys: ["M"], description: "Mute / Unmute audio" },
    ],
  },
  {
    category: "Floating Desktop Lyrics",
    color: "#00F0FF",
    shortcuts: [
      { keys: ["L"], description: "Toggle floating lyrics window" },
      { keys: ["P"], description: "Toggle Pin (always on top / click-through)" },
      { keys: ["["], description: "Nudge lyrics sync 0.5s earlier" },
      { keys: ["]"], description: "Nudge lyrics sync 0.5s later" },
      { keys: ["T"], description: "Cycle lyrics theme (Nebula, Cyberpunk, etc.)" },
      { keys: ["Ctrl", "Scroll"], description: "Resize lyrics font size (in lyrics window)" },
    ],
  },
  {
    category: "Navigation & System",
    color: "#1DB954",
    shortcuts: [
      { keys: ["?"], description: "Open / Close this shortcuts cheatsheet" },
      { keys: ["Shift", "/"], description: "Open shortcuts cheatsheet" },
      { keys: ["Esc"], description: "Close modal / dismiss overlay" },
    ],
  },
];

export default function ShortcutsModal({ isOpen, onClose }: ShortcutsModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 99999,
        padding: "20px",
        animation: "fade-in 0.2s ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "680px",
          maxHeight: "88vh",
          backgroundColor: "rgba(16, 16, 26, 0.95)",
          borderRadius: "22px",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.7), 0 0 40px rgba(138, 43, 226, 0.15)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 100%)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: "linear-gradient(135deg, #8A2BE2, #00F0FF)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                boxShadow: "0 4px 15px rgba(138, 43, 226, 0.35)",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M6 8h.001" />
                <path d="M10 8h.001" />
                <path d="M14 8h.001" />
                <path d="M18 8h.001" />
                <path d="M8 12h.001" />
                <path d="M12 12h.001" />
                <path d="M16 12h.001" />
                <path d="M7 16h10" />
              </svg>
            </div>
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: 17,
                  fontWeight: 800,
                  color: "#fff",
                  letterSpacing: "-0.01em",
                }}
              >
                Keyboard Shortcuts
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: 11,
                  color: "rgba(255, 255, 255, 0.5)",
                }}
              >
                Full playback, lyrics sync, and navigation hotkeys
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: "1px solid rgba(255, 255, 255, 0.1)",
              background: "rgba(255, 255, 255, 0.05)",
              color: "rgba(255, 255, 255, 0.7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.12)";
              e.currentTarget.style.color = "#fff";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
              e.currentTarget.style.color = "rgba(255, 255, 255, 0.7)";
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content list */}
        <div
          style={{
            padding: "20px 24px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 22,
          }}
        >
          {SHORTCUT_CATEGORIES.map((cat, idx) => (
            <div key={idx} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11,
                  fontWeight: 800,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  color: cat.color,
                }}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: cat.color,
                    boxShadow: `0 0 8px ${cat.color}`,
                  }}
                />
                {cat.category}
              </div>

              <div
                style={{
                  backgroundColor: "rgba(255, 255, 255, 0.02)",
                  borderRadius: 14,
                  border: "1px solid rgba(255, 255, 255, 0.05)",
                  overflow: "hidden",
                }}
              >
                {cat.shortcuts.map((sc, sIdx) => (
                  <div
                    key={sIdx}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 16px",
                      borderBottom:
                        sIdx < cat.shortcuts.length - 1
                          ? "1px solid rgba(255, 255, 255, 0.03)"
                          : "none",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12.5,
                        color: "rgba(255, 255, 255, 0.8)",
                        fontWeight: 500,
                      }}
                    >
                      {sc.description}
                    </span>

                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      {sc.keys.map((k, kIdx) => (
                        <React.Fragment key={kIdx}>
                          <kbd
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              minWidth: 26,
                              height: 24,
                              padding: "0 7px",
                              backgroundColor: "rgba(255, 255, 255, 0.07)",
                              border: "1px solid rgba(255, 255, 255, 0.18)",
                              borderRadius: 6,
                              color: "#fff",
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                              fontSize: 11,
                              fontWeight: 700,
                              boxShadow: "0 2px 0 rgba(0, 0, 0, 0.4)",
                              userSelect: "none",
                            }}
                          >
                            {k}
                          </kbd>
                          {kIdx < sc.keys.length - 1 && sc.keys.length > 1 && (
                            <span
                              style={{
                                fontSize: 10,
                                color: "rgba(255, 255, 255, 0.3)",
                                fontWeight: 700,
                              }}
                            >
                              +
                            </span>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer tip */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid rgba(255, 255, 255, 0.06)",
            backgroundColor: "rgba(0, 0, 0, 0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 11, color: "rgba(255, 255, 255, 0.4)" }}>
            Tip: Press <kbd style={{ padding: "1px 5px", background: "rgba(255,255,255,0.08)", borderRadius: 4, color: "#fff" }}>?</kbd> anytime to open this cheatsheet.
          </span>
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              background: "#8A2BE2",
              border: "none",
              color: "#fff",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
