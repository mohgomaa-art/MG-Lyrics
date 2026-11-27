import { memo } from "react";
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
    color: "var(--accent)",
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
    color: "var(--accent)",
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

function ShortcutsModal({ isOpen, onClose }: ShortcutsModalProps) {
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
          backgroundColor: "color-mix(in srgb, var(--surface) 100%, transparent)",
          borderRadius: "22px",
          border: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.7), 0 0 40px color-mix(in srgb, var(--accent) 15%, transparent)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px",
            borderBottom: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--surface-2) 0%, transparent 100%)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: "var(--surface-2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text)",
                boxShadow: "0 4px 15px color-mix(in srgb, var(--accent) 35%, transparent)",
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
                  color: "var(--text)",
                  letterSpacing: "-0.01em",
                }}
              >
                Keyboard Shortcuts
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: 11,
                  color: "color-mix(in srgb, var(--text) 50%, transparent)",
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
              border: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
              background: "color-mix(in srgb, var(--text) 5%, transparent)",
              color: "color-mix(in srgb, var(--text) 70%, transparent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "color-mix(in srgb, var(--text) 12%, transparent)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "color-mix(in srgb, var(--text) 5%, transparent)";
              e.currentTarget.style.color = "color-mix(in srgb, var(--text) 70%, transparent)";
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
                  backgroundColor: "color-mix(in srgb, var(--text) 2%, transparent)",
                  borderRadius: 14,
                  border: "1px solid color-mix(in srgb, var(--text) 5%, transparent)",
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
                          ? "1px solid color-mix(in srgb, var(--text) 3%, transparent)"
                          : "none",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12.5,
                        color: "color-mix(in srgb, var(--text) 80%, transparent)",
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
                              backgroundColor: "color-mix(in srgb, var(--text) 7%, transparent)",
                              border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)",
                              borderRadius: 6,
                              color: "var(--text)",
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
                                color: "color-mix(in srgb, var(--text) 30%, transparent)",
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
            borderTop: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
            backgroundColor: "rgba(0, 0, 0, 0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--text) 40%, transparent)" }}>
            Tip: Press <kbd style={{ padding: "1px 5px", background: "color-mix(in srgb, var(--text) 8%, transparent)", borderRadius: 4, color: "var(--text)" }}>?</kbd> anytime to open this cheatsheet.
          </span>
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              background: "var(--accent)",
              border: "none",
              color: "var(--accent-fg)",
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

export default memo(ShortcutsModal);
