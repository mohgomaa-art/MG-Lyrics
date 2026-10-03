import type { Track } from "./PlayerBar";

function EqBarsSmall() {
  return (
    <div className="flex items-end gap-[2px] h-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="w-[2px] rounded-full bg-accent"
          style={{
            animation: `eq-bar 0.8s ease-in-out ${i * 0.15}s infinite`,
            height: "3px",
          }}
        />
      ))}
    </div>
  );
}

import type { MGProvider } from "../types/track";

function SourceBadge({ source }: { source: MGProvider }) {
  const color = source === "spotify" ? "#1ED760" : source === "youtube" ? "#FF4444" : source === "soundcloud" ? "#FF5500" : "#8A2BE2";
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function TrackList({
  tracks,
  currentTrack,
  isPlaying,
  onSelect,
}: {
  tracks: Track[];
  currentTrack: Track | null;
  isPlaying: boolean;
  onSelect: (track: Track) => void;
}) {
  return (
    <div className="space-y-0.5">
      {tracks.map((track, i) => {
        const active = currentTrack?.id === track.id;
        return (
          <div
            key={track.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(track)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(track);
              }
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 cursor-pointer group select-none outline-none focus-visible:ring-2 focus-visible:ring-accent
              ${active ? "bg-surface-hover" : "hover:bg-surface-hover/60"}`}
            style={i < 20 ? { animation: `fade-in 0.3s ease-out ${i * 0.03}s both` } : undefined}
          >
            <div className="w-5 flex items-center justify-center flex-shrink-0">
              {active && isPlaying ? (
                <EqBarsSmall />
              ) : (
                <span className={`text-xs tabular-nums ${active ? "text-accent" : "text-text-disabled group-hover:hidden"}`}>
                  {i + 1}
                </span>
              )}
              {!active && (
                <svg className="hidden group-hover:block text-text-primary" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="6,3 20,12 6,21" />
                </svg>
              )}
            </div>

            <div
              className="w-9 h-9 rounded bg-cover bg-center flex-shrink-0 shadow-sm"
              style={{ backgroundImage: `url(${track.cover})` }}
            />

            <div className="flex-1 min-w-0 text-left">
              <p className={`text-sm font-medium truncate ${active ? "text-accent" : "text-text-primary"}`}>
                {track.title}
              </p>
              <div className="flex items-center gap-1.5">
                <SourceBadge source={track.source} />
                <p className="text-xs text-text-secondary truncate">{track.artist}</p>
              </div>
            </div>

            <span className="text-xs text-text-disabled tabular-nums flex-shrink-0">{formatTime(track.duration)}</span>

            <button
              className="opacity-0 group-hover:opacity-100 text-text-disabled hover:text-text-primary transition-opacity duration-150 p-1 cursor-pointer"
              onClick={(e) => { e.stopPropagation(); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="12" cy="19" r="2" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
