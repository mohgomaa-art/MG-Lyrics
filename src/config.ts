/**
 * Central frontend constants. Persisted-storage keys and default values live
 * here so they are defined once instead of as string literals across files.
 * Build-time overrides: VITE_MG_DISCOVER_DEFAULT_QUERY.
 */
export const STORAGE_KEYS = {
  savedTracks: "mg_saved_tracks",
  playlists: "mg_playlists",
  volume: "mg_volume",
  urlHistory: "mg_url_history",
  lyricsPos: "mg_lyrics_pos",
  lyricsOffset: "mg_lyrics_offset",
  lyricsFontSize: "mg_lyrics_fontsize",
} as const;

export const DEFAULT_DISCOVER_QUERY: string =
  (import.meta.env?.VITE_MG_DISCOVER_DEFAULT_QUERY as string | undefined)?.trim() || "Today's Top Hits";
