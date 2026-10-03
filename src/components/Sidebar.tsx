import type { Playlist } from "../App";

interface SidebarProps {
  activeView: string;
  onNavigate: (view: string) => void;
  playlists: Playlist[];
}

export default function Sidebar({ activeView, onNavigate, playlists }: SidebarProps) {
  const navItems = [
    {
      id: "home",
      label: "Home",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      ),
    },
    {
      id: "discover",
      label: "Discover",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
        </svg>
      ),
    },
    {
      id: "search",
      label: "Search",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      ),
    },
    {
      id: "downloads",
      label: "Downloads",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      ),
    },
  ];

  const providerItems = [
    {
      id: "provider-spotify",
      label: "Spotify",
      tag: "Stream",
      color: "#1DB954",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
        </svg>
      ),
    },
    {
      id: "provider-ytmusic",
      label: "YouTube Music",
      tag: "Live",
      color: "#FF0000",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.144a7.144 7.144 0 1 1 0-14.288 7.144 7.144 0 0 1 0 14.288zm0-11.43a4.286 4.286 0 1 0 0 8.572 4.286 4.286 0 0 0 0-8.572zm-1.714 6.215V10.07l3.857 1.93-3.857 1.93z" />
        </svg>
      ),
    },
    {
      id: "provider-soundcloud",
      label: "SoundCloud",
      tag: "Lossless",
      color: "#FF5500",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M1.175 12.225c-.05 0-.09.042-.09.092l-.21 2.378c0 .05.04.091.09.091l.21-.01c.05 0 .09-.041.09-.091l.21-2.378c0-.05-.04-.092-.09-.092h-.2zm2.083-1.636c-.05 0-.091.042-.091.092l-.337 4.014c0 .05.041.092.091.092h.211c.05 0 .09-.042.09-.092l.338-4.014c0-.05-.04-.092-.09-.092h-.212zm2.148-.737c-.05 0-.091.041-.091.091l-.274 4.751c0 .05.04.092.09.092h.212c.05 0 .09-.042.09-.092l.275-4.751c0-.05-.04-.091-.09-.091h-.212zm2.13-.198c-.05 0-.092.041-.092.091l-.224 4.949c0 .05.042.092.092.092h.21c.05 0 .092-.042.092-.092l.225-4.949c0-.05-.042-.091-.092-.091h-.211zm2.149-.556c-.05 0-.091.041-.091.091l-.161 5.505c0 .05.041.092.091.092h.212c.05 0 .09-.042.09-.092l.162-5.505c0-.05-.04-.091-.09-.091h-.213zm4.512-1.92c-.378 0-.742.062-1.084.175-.126.042-.236.14-.265.27-.061.272-.095.556-.095.847 0 .148.01.292.029.435-.027-.003-.055-.008-.083-.008-.051 0-.092.041-.092.091l-.11 6.596c0 .05.041.092.092.092h8.04c1.91 0 3.46-1.55 3.46-3.46 0-1.85-1.46-3.36-3.29-3.45-.44-1.89-2.14-3.3-4.17-3.3z" />
        </svg>
      ),
    },
    {
      id: "provider-local",
      label: "Local Files",
      tag: "Offline",
      color: "#8A2BE2",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="2" />
        </svg>
      ),
    },
  ];

  return (
    <aside
      style={{
        width: "220px",
        minWidth: "220px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "rgba(10, 10, 16, 0.6)",
        backdropFilter: "blur(24px)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
        padding: "20px 12px",
        gap: "6px",
        overflowY: "hidden",
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "0 8px 18px" }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            background: "linear-gradient(135deg, #8A2BE2, #EC4899)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 0 18px rgba(138,43,226,0.4)",
            flexShrink: 0,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 512 512" fill="none">
            <g transform="translate(56, 56)" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round" fill="none">
              <path d="M 100 320 L 100 100 L 200 200" stroke="#FFFFFF" />
              <path d="M 200 200 L 300 100 L 300 260 A 60 60 0 0 1 180 260 L 180 220" stroke="#FFFFFF" />
              <g stroke="#FFFFFF" opacity="0.9">
                <path d="M 40 160 L 100 160" />
                <path d="M 180 220 L 360 220" />
              </g>
            </g>
          </svg>
        </div>
        <div>
          <div style={{ fontWeight: 900, fontSize: 15, color: "#fff", letterSpacing: "-0.02em", lineHeight: 1.1 }}>
            MG LYRICS
          </div>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.12em", color: "#8A2BE2", textTransform: "uppercase" }}>
            Premium Player
          </div>
        </div>
      </div>

      {/* Nav */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ fontSize: 9, fontWeight: 800, color: "#5A5D70", letterSpacing: "0.14em", textTransform: "uppercase", padding: "0 10px 6px" }}>
          Menu
        </div>
        {navItems.map((item) => {
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 12,
                border: isActive ? "1px solid rgba(138,43,226,0.3)" : "1px solid transparent",
                background: isActive ? "rgba(138,43,226,0.12)" : "transparent",
                color: isActive ? "#fff" : "#9FA2B4",
                fontSize: 13,
                fontWeight: isActive ? 700 : 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
                textAlign: "left",
                width: "100%",
              }}
            >
              <span style={{ color: isActive ? "#8A2BE2" : "inherit", flexShrink: 0 }}>{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: "rgba(255,255,255,0.05)", margin: "6px 0" }} />

      {/* Providers */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ fontSize: 9, fontWeight: 800, color: "#5A5D70", letterSpacing: "0.14em", textTransform: "uppercase", padding: "0 10px 6px" }}>
          Providers
        </div>
        {providerItems.map((item) => {
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                borderRadius: 11,
                border: isActive ? `1px solid ${item.color}50` : "1px solid transparent",
                background: isActive ? `${item.color}15` : "transparent",
                color: isActive ? "#fff" : "#9FA2B4",
                fontSize: 12,
                fontWeight: isActive ? 700 : 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
                textAlign: "left",
                width: "100%",
              }}
            >
              <span style={{ color: item.color, flexShrink: 0 }}>{item.icon}</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.label}
              </span>
              <span style={{
                fontSize: 8,
                fontWeight: 800,
                padding: "1px 5px",
                borderRadius: 4,
                background: `${item.color}25`,
                color: item.color,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}>
                {item.tag}
              </span>
            </button>
          );
        })}
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: "rgba(255,255,255,0.05)", margin: "6px 0" }} />

      {/* Playlists */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px 8px" }}>
          <span style={{ fontSize: 9, fontWeight: 800, color: "#5A5D70", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            Playlists
          </span>
          <span style={{ fontSize: 9, fontWeight: 700, color: "#5A5D70", background: "rgba(255,255,255,0.05)", padding: "2px 6px", borderRadius: 99 }}>
            {playlists.length}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 2, overflowY: "auto", flex: 1 }}>
          {playlists.map((pl) => {
            const isActive = activeView === pl.id;
            const dotColor = pl.source === "spotify" ? "#1DB954" : pl.source === "soundcloud" ? "#FF5500" : pl.source === "youtube" ? "#FF0000" : "#8A2BE2";
            return (
              <button
                key={pl.id}
                onClick={() => onNavigate(pl.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "9px 12px",
                  borderRadius: 11,
                  border: isActive ? "1px solid rgba(255,255,255,0.1)" : "1px solid transparent",
                  background: isActive ? "rgba(255,255,255,0.07)" : "transparent",
                  color: isActive ? "#fff" : "#9FA2B4",
                  fontSize: 12,
                  fontWeight: isActive ? 700 : 500,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  textAlign: "left",
                  width: "100%",
                  minWidth: 0,
                }}
              >
                <span style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: dotColor,
                  boxShadow: `0 0 6px ${dotColor}`,
                  flexShrink: 0,
                }} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {pl.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Footer status */}
      <div style={{ paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.05)", marginTop: "auto" }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderRadius: 10,
          background: "rgba(255,255,255,0.03)",
        }}>
          <div style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "#1DB954",
            boxShadow: "0 0 8px #1DB954",
            animation: "pulse-glow 2s infinite",
          }} />
          <span style={{ fontSize: 9, fontWeight: 700, color: "#5A5D70", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Engine Online
          </span>
        </div>
      </div>
    </aside>
  );
}
