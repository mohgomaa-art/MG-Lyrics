export type MGProvider = "spotify" | "youtube" | "soundcloud" | "local";

export interface ProviderCapabilities {
  canSearch: boolean;
  canBrowse: boolean;
  canPlay: boolean;
  canDownload: boolean;
  canImportPlaylist: boolean;
  canFetchArtwork: boolean;
  canIdentifyTrack: boolean;
}

export const PROVIDER_CAPABILITIES: Record<MGProvider, ProviderCapabilities> = {
  spotify: {
    canSearch: true,
    canBrowse: true,
    canPlay: false, // Protected by DRM; plays via resolved source
    canDownload: true, // Downloadable via resolution or spotdl
    canImportPlaylist: true,
    canFetchArtwork: true,
    canIdentifyTrack: true,
  },
  youtube: {
    canSearch: true,
    canBrowse: true,
    canPlay: true, // Extracted audio stream
    canDownload: true, // Audio extraction where rights permit
    canImportPlaylist: true,
    canFetchArtwork: true,
    canIdentifyTrack: true,
  },
  soundcloud: {
    canSearch: true,
    canBrowse: true,
    canPlay: true, // Direct audio stream extraction
    canDownload: true, // Audio extraction where rights permit
    canImportPlaylist: true,
    canFetchArtwork: true,
    canIdentifyTrack: true,
  },
  local: {
    canSearch: true,
    canBrowse: true,
    canPlay: true, // Native file via assetProtocol
    canDownload: false, // Already downloaded
    canImportPlaylist: false,
    canFetchArtwork: true,
    canIdentifyTrack: true,
  },
};

export interface MGTrack {
  canonical_id: string;
  provider: MGProvider;
  provider_track_id: string;

  // Track Identity
  title: string;
  artists: string[];
  album: string;
  album_id?: string;
  duration: number; // in seconds
  artwork_url: string;
  isrc?: string;

  // Navigation & Streaming
  source_url: string;
  playback_url?: string;

  // Capabilities & Status Flags
  is_playable: boolean;
  is_downloadable: boolean;
  lyrics_status: "unknown" | "searching" | "available" | "unavailable";
  has_synced_lyrics: boolean;

  // Local Storage
  is_local: boolean;
  local_path?: string;
  metadata_status: "raw" | "verified" | "enriched";

  // Library State
  is_favorite: boolean;
  added_at: number;
  play_count: number;
  last_played_at?: number;
}

// Backward-compatible alias for existing components
export type Track = MGTrack;
