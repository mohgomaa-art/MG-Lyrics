import { useState, useRef, useCallback } from "react";
import type { MGProvider } from "../types/track";

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
  duration: number;
  source: MGProvider;
  audioUrl?: string;
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function PlayerBar({
  track,
  isPlaying,
  progress,
  onPlayPause,
  onPrev,
  onNext,
  onToggleLyrics,
  lyricsVisible,
  onSeek,
  lyricsPinned = true,
  onTogglePin = () => {},
  lyricsTheme = "nebula",
  onChangeTheme = () => {},
  volume = 0.8,
  onVolumeChange = () => {},
  playbackError = null,
  onOpenShortcuts,
}: {
  track: Track | null;
  isPlaying: boolean;
  progress: number;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleLyrics: () => void;
  lyricsVisible: boolean;
  onSeek: (time: number) => void;
  lyricsPinned?: boolean;
  onTogglePin?: () => void;
  lyricsTheme?: string;
  onChangeTheme?: (theme: string) => void;
  volume?: number;
  onVolumeChange?: (vol: number) => void;
  playbackError?: string | null;
  onOpenShortcuts?: () => void;
}) {
  const [_dragging, setDragging] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const [prevVolume, setPrevVolume] = useState(0.8);

  const toggleMute = () => {
    if (volume > 0) {
      setPrevVolume(volume);
      onVolumeChange(0);
    } else {
      onVolumeChange(prevVolume);
    }
  };

  const renderSpeakerIcon = () => {
    if (volume === 0) {
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <line x1="22" y1="9" x2="16" y2="15"></line>
          <line x1="16" y1="9" x2="22" y2="15"></line>
        </svg>
      );
    } else if (volume < 0.5) {
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        </svg>
      );
    } else {
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        </svg>
      );
    }
  };

  const handleSeek = useCallback(
    (e: React.MouseEvent) => {
      if (!barRef.current || !track) return;
      const rect = barRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      onSeek(pct * track.duration);
    },
    [track, onSeek]
  );

  if (!track) {
    return (
      <div className="h-20 bg-surface border-t border-border flex items-center justify-center select-none z-10">
        <span className="text-text-disabled text-xs font-bold uppercase tracking-wider">No Track Selected</span>
      </div>
    );
  }

  const pct = track.duration > 0 ? (progress / track.duration) * 100 : 0;

  return (
    <div className="h-22 bg-[#0C0C12]/80 backdrop-blur-xl border-t border-white/5 flex items-center justify-between px-6 select-none z-10 relative"
      style={{ animation: "slide-up 0.3s ease-out" }}>
      
      {/* Current Track Info */}
      <div className="flex items-center gap-4 w-64 min-w-0">
        <div className="relative shrink-0">
          <div
            className={`w-12 h-12 rounded-xl bg-cover bg-center border border-white/5 shadow-md shadow-black/20 transition-transform duration-300
              ${isPlaying ? "scale-105 border-accent/40" : ""}`}
            style={{ backgroundImage: `url(${track.cover})` }}
          />
          {isPlaying && (
            <div className="absolute -top-1 -right-1 flex items-end gap-[2px] h-3.5 bg-black/60 px-1 py-0.5 rounded-md border border-white/5">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="w-[2.5px] rounded-full bg-accent"
                  style={{
                    animation: `eq-bar 0.8s ease-in-out ${i * 0.15}s infinite`,
                    height: "4px",
                  }}
                />
              ))}
            </div>
          )}
        </div>
        
        <div className="min-w-0 text-left">
          <p className="text-sm font-bold text-white truncate">{track.title}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              style={{
                fontSize: 9,
                fontWeight: 800,
                padding: "1px 5px",
                borderRadius: 4,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                background:
                  track.source === "spotify"
                    ? "rgba(29, 185, 84, 0.2)"
                    : track.source === "youtube"
                    ? "rgba(255, 0, 0, 0.2)"
                    : track.source === "soundcloud"
                    ? "rgba(255, 85, 0, 0.2)"
                    : "rgba(138, 43, 226, 0.2)",
                color:
                  track.source === "spotify"
                    ? "#1DB954"
                    : track.source === "youtube"
                    ? "#FF4444"
                    : track.source === "soundcloud"
                    ? "#FF5500"
                    : "#8A2BE2",
                border: `1px solid ${
                  track.source === "spotify"
                    ? "rgba(29, 185, 84, 0.3)"
                    : track.source === "youtube"
                    ? "rgba(255, 0, 0, 0.3)"
                    : track.source === "soundcloud"
                    ? "rgba(255, 85, 0, 0.3)"
                    : "rgba(138, 43, 226, 0.3)"
                }`,
              }}
            >
              {track.source === "youtube" ? "YT Music" : track.source}
            </span>
            <span className="text-xs text-text-secondary truncate font-semibold">{track.artist}</span>
          </div>
          {playbackError && (
            <p className="text-[10px] text-red-400 truncate mt-0.5 font-semibold">{playbackError}</p>
          )}
        </div>
      </div>

      {/* Main Playback Progress & Control Center */}
      <div className="flex-1 flex flex-col items-center gap-2 max-w-xl">
        {/* Buttons */}
        <div className="flex items-center gap-6">
          <button 
            onClick={onPrev} 
            className="text-text-secondary hover:text-white hover:scale-110 active:scale-95 transition-all cursor-pointer p-1"
            title="Previous Track"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
            </svg>
          </button>

          <button
            onClick={onPlayPause}
            className={`w-10 h-10 rounded-full bg-white flex items-center justify-center text-black hover:scale-108 active:scale-95 transition-all cursor-pointer shadow-lg
              ${isPlaying ? "animate-pulse-glow bg-accent text-white" : ""}`}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="translate-x-[1px]">
                <polygon points="6,3 20,12 6,21" />
              </svg>
            )}
          </button>

          <button 
            onClick={onNext} 
            className="text-text-secondary hover:text-white hover:scale-110 active:scale-95 transition-all cursor-pointer p-1"
            title="Next Track"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          </button>
        </div>

        {/* Seekbar */}
        <div className="flex items-center gap-3 w-full">
          <span className="text-[10px] text-text-disabled font-bold w-8 text-right tabular-nums">{formatTime(progress)}</span>
          
          <div
            ref={barRef}
            className="flex-1 h-1.5 bg-white/5 rounded-full cursor-pointer relative group"
            onClick={handleSeek}
            onMouseDown={() => setDragging(true)}
            onMouseUp={() => setDragging(false)}
          >
            {/* Filled Progress bar */}
            <div
              className="h-full bg-accent rounded-full transition-[width] duration-700 relative"
              style={{ width: `${pct}%` }}
            >
              {/* Glow light bulb indicator */}
              <div className="absolute right-[-6px] top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-lg shadow-accent opacity-0 group-hover:opacity-100 transition-opacity duration-150 border border-accent/20 cursor-pointer" />
            </div>
          </div>
          
          <span className="text-[10px] text-text-disabled font-bold w-8 tabular-nums">{formatTime(track.duration)}</span>
        </div>
      </div>

      {/* Extra Action Buttons */}
      <div className="flex items-center gap-2.5 w-96 justify-end">
        {/* Volume Controller */}
        <div className="flex items-center gap-2 mr-3 group/vol">
          <button 
            onClick={toggleMute}
            className="text-text-secondary hover:text-white transition-colors cursor-pointer p-1"
            title={volume === 0 ? "Unmute" : "Mute"}
          >
            {renderSpeakerIcon()}
          </button>
          
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
            className="w-16 h-1 bg-white/10 rounded accent-accent cursor-pointer group-hover/vol:w-20 transition-all duration-300"
            style={{ outline: "none" }}
            title={`Volume: ${Math.round(volume * 100)}%`}
          />
        </div>

        {/* If lyrics window is open, show Theme Selector and Pin/Lock control */}
        {lyricsVisible && (
          <>
            {/* Theme Selector Dropdown */}
            <select
              value={lyricsTheme}
              onChange={(e) => onChangeTheme(e.target.value)}
              className="bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl px-2 py-2 text-[11px] font-bold text-text-secondary hover:text-white cursor-pointer outline-none transition-all"
              title="Select Lyrics Theme"
              style={{ height: "36px" }}
            >
              <option value="nebula" className="bg-[#0C0C12] text-white">Nebula Purple</option>
              <option value="cyberpunk" className="bg-[#0C0C12] text-white">Cyberpunk Cyan</option>
              <option value="terminal" className="bg-[#0C0C12] text-white">Amber Terminal</option>
              <option value="elegant" className="bg-[#0C0C12] text-white">Elegant Serif</option>
              <option value="minimal" className="bg-[#0C0C12] text-white">Minimalist White</option>
              <option value="emerald" className="bg-[#0C0C12] text-white">Emerald Forest</option>
              <option value="sunset" className="bg-[#0C0C12] text-white">Sunset Horizon</option>
              <option value="synthwave" className="bg-[#0C0C12] text-white">Synthwave 80s</option>
              <option value="nordic" className="bg-[#0C0C12] text-white">Nordic Ice</option>
              <option value="tokyo" className="bg-[#0C0C12] text-white">Tokyo Electric</option>
            </select>

            {/* Lock/Unlock Toggle Button */}
            <button
              onClick={onTogglePin}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[11px] font-bold transition-all duration-200 cursor-pointer border ${
                lyricsPinned
                  ? "bg-rose-500/10 border-rose-500/20 text-rose-400 hover:bg-rose-500/20"
                  : "bg-green-500/10 border-green-500/20 text-green-400 hover:bg-green-500/20"
              }`}
              title={lyricsPinned ? "Click to unlock window (allows dragging and resizing)" : "Click to lock window (makes it click-through)"}
              style={{ height: "36px" }}
            >
              {lyricsPinned ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <span>Locked</span>
                </>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                  </svg>
                  <span>Drag Mode</span>
                </>
              )}
            </button>
          </>
        )}

        {/* Toggle Lyrics Button */}
        <button
          onClick={onToggleLyrics}
          className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer border
            ${lyricsVisible
              ? "bg-accent/15 border-accent text-accent shadow-md shadow-accent-glow/10 font-black"
              : "bg-white/5 border-white/10 text-text-secondary hover:text-white hover:bg-white/10"
            }`}
          title="Toggle Lyrics Panel (Press L)"
          style={{ height: "36px" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          Lyrics
        </button>

        {/* Keyboard Shortcuts Cheatsheet Button */}
        {onOpenShortcuts && (
          <button
            onClick={onOpenShortcuts}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer border bg-white/5 border-white/10 text-text-secondary hover:text-white hover:bg-white/10"
            title="Keyboard Shortcuts Cheatsheet (Press ?)"
            style={{ height: "36px" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            <span className="hidden sm:inline">Shortcuts</span>
          </button>
        )}
      </div>
    </div>
  );
}
