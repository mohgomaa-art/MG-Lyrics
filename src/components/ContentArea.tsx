import { useState, useMemo, useEffect, useRef, memo } from "react";
import type { Track } from "./PlayerBar";
import type { Playlist } from "../App";
import { useCuratedPlaylists, CATEGORY_LABELS } from "../data/curatedPlaylists";
export type { CuratedPlaylistItem } from "../data/curatedPlaylists";
import type { MGProvider } from "../types/track";
import { safeInvoke as invoke, safeConvertFileSrc as convertFileSrc, safeListen } from "../utils/tauriBridge";
import { STORAGE_KEYS, DEFAULT_DISCOVER_QUERY } from "../config";

interface ContentAreaProps {
  tracks: Track[];
  currentTrack: Track | null;
  isPlaying: boolean;
  onSelectTrack: (track: Track) => void;
  activeView: string;
  playlists: Playlist[];
  onNavigate: (view: string) => void;
  onSyncPlaylist: (playlist: Playlist) => void;
  onAddLocalTracks: (tracks: Track[], opts?: { keepUrlDuplicates?: boolean }) => void;
  onAddTrackToPlaylist?: (playlistId: string, track: Track) => void;
}

const GRADIENTS = [
  "#3a3a3a,#141414", "#2e2e2e,#0f0f0f", "#444444,#1a1a1a", "#333333,#111111",
  "#3d3d3d,#161616", "#2a2a2a,#0c0c0c", "#484848,#1c1c1c", "#353535,#121212",
];

function makeCover(idx: number, title: string): string {
  const [c1, c2] = GRADIENTS[idx % GRADIENTS.length].split(",");
  const letter = title.charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect width="200" height="200" fill="url(#g)" rx="24"/>
    <text x="100" y="122" text-anchor="middle" font-size="82"
      font-family="Outfit,sans-serif" font-weight="900" fill="white" opacity="0.85">${letter}</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function formatDuration(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const PLATFORM_COLORS: Record<string, string> = {
  spotify: "#1DB954",
  youtube: "#FF0000",
  soundcloud: "#FF5500",
  local: "var(--accent)",
};

export interface UrlAnalysis {
  isUrl: boolean;
  platform: "spotify" | "youtube" | "soundcloud" | "generic" | null;
  kind: "playlist" | "album" | "artist" | "track" | "collection" | "unknown";
  label: string;
  color: string;
}

export function isUrlQuery(rawQuery: string): boolean {
  const q = rawQuery.trim();
  return (
    /^https?:\/\//i.test(q) ||
    /^spotify:/i.test(q) ||
    q.includes("spotify.com") ||
    q.includes("youtube.com") ||
    q.includes("youtu.be") ||
    q.includes("soundcloud.com")
  );
}

export function analyzeSearchQuery(rawQuery: string): UrlAnalysis {
  const q = rawQuery.trim();
  if (!isUrlQuery(q)) {
    return { isUrl: false, platform: null, kind: "unknown", label: "", color: "var(--accent)" };
  }

  // Spotify
  if (q.includes("spotify.com") || q.startsWith("spotify:")) {
    if (q.includes("artist/") || q.includes("artist:")) {
      return { isUrl: true, platform: "spotify", kind: "artist", label: "Spotify Artist", color: "#1DB954" };
    }
    if (q.includes("album/") || q.includes("album:")) {
      return { isUrl: true, platform: "spotify", kind: "album", label: "Spotify Album", color: "#1DB954" };
    }
    if (q.includes("playlist/") || q.includes("playlist:")) {
      return { isUrl: true, platform: "spotify", kind: "playlist", label: "Spotify Playlist", color: "#1DB954" };
    }
    if (q.includes("track/") || q.includes("track:")) {
      return { isUrl: true, platform: "spotify", kind: "track", label: "Spotify Track", color: "#1DB954" };
    }
    return { isUrl: true, platform: "spotify", kind: "collection", label: "Spotify Collection", color: "#1DB954" };
  }

  // YouTube / YouTube Music
  if (q.includes("youtube.com") || q.includes("youtu.be")) {
    if (q.includes("list=") || q.includes("/playlist")) {
      return { isUrl: true, platform: "youtube", kind: "playlist", label: "YouTube Playlist", color: "#FF0000" };
    }
    return { isUrl: true, platform: "youtube", kind: "track", label: "YouTube Track", color: "#FF0000" };
  }

  // SoundCloud
  if (q.includes("soundcloud.com")) {
    if (q.includes("/sets/")) {
      return { isUrl: true, platform: "soundcloud", kind: "playlist", label: "SoundCloud Set", color: "#FF5500" };
    }
    return { isUrl: true, platform: "soundcloud", kind: "track", label: "SoundCloud Track", color: "#FF5500" };
  }

  return { isUrl: true, platform: "generic", kind: "unknown", label: "Web Audio Link", color: "var(--accent)" };
}



export interface OnlinePlaylistResult {
  id: string;
  title: string;
  description: string;
  thumbnail: string;
  uploader: string;
  url: string;
  track_count?: number;
  source: string;
}

interface DiscoverTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  video_url: string;
  stream_url?: string;
  thumbnail?: string;
  source?: string;
  album?: string;
  release_date?: string;
}

interface DiscoverPlaylistInfo {
  title: string;
  description: string;
  thumbnail: string;
  uploader: string;
  source?: string;
  tracks: DiscoverTrack[];
}

function ContentArea({
  tracks,
  currentTrack,
  isPlaying,
  onSelectTrack,
  activeView,
  playlists,
  onNavigate,
  onSyncPlaylist,
  onAddLocalTracks,
  onAddTrackToPlaylist,
}: ContentAreaProps) {
  const { data: curated, loading: curatedLoading, error: curatedError } = useCuratedPlaylists();
  const [searchQuery, setSearchQuery] = useState("");
  const urlAnalysis = useMemo(() => analyzeSearchQuery(searchQuery), [searchQuery]);
  const [showImportModal, setShowImportModal] = useState(false);
  const [newPlName, setNewPlName] = useState("");
  const [newPlSource, setNewPlSource] = useState<MGProvider>("spotify");
  const [providerFilter, setProviderFilter] = useState<MGProvider | "all">("all");
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [hoveredTrack, setHoveredTrack] = useState<string | null>(null);
  const [hoveredPlaylist, setHoveredPlaylist] = useState<string | null>(null);

  // Download states
  const [downloadUrl, setDownloadUrl] = useState("");
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [dlPercent, setDlPercent] = useState<Record<string, number>>({});

  // Live progress from the Rust download runner (job "main" = URL box, else track id)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dead = false;
    safeListen<{ job: string; label: string; percent: number; phase: string }>("mg-download-progress", (e) => {
      const { job, percent, phase, label } = e.payload;
      setDlPercent(prev => ({ ...prev, [job]: percent }));
      if (job === "main") {
        setDownloadStatus(phase === "convert" ? `Converting to MP3... ${label}` : `Downloading ${Math.round(percent)}% ${label}`);
      }
    }).then(u => { if (dead) u(); else unlisten = u; });
    return () => { dead = true; if (unlisten) unlisten(); };
  }, []);

  const cancelAllDownloads = async () => {
    try { await invoke<string>("cancel_downloads"); } catch {}
  };
  const [localTracks, setLocalTracks] = useState<Track[]>([]);
  const [downloadDir, setDownloadDir] = useState("");
  const [ytdlpStatus, setYtdlpStatus] = useState<string | null>(null);
  const [spotdlStatus, setSpotdlStatus] = useState<string | null>(null);
  const [ffmpegStatus, setFfmpegStatus] = useState<string | null>(null);

  // Preview states
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewInfo, setPreviewInfo] = useState<{
    title: string; artist: string; thumbnail: string;
    stream_url: string; video_url: string;
  } | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Discover states
  const [discoverUrl, setDiscoverUrl] = useState("");
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState("");
  const [loadedPlaylist, setLoadedPlaylist] = useState<DiscoverPlaylistInfo | null>(null);
  const [previewingTrackId, setPreviewingTrackId] = useState<string | null>(null);
  const [downloadingTracks, setDownloadingTracks] = useState<Record<string, { status: "idle" | "loading" | "success" | "error"; error?: string }>>({});

  // Playlist discovery & online search states
  const [playlistCategory, setPlaylistCategory] = useState<string>("all");
  const [onlinePlaylistQuery, setOnlinePlaylistQuery] = useState("");
  const [onlinePlaylistProvider, setOnlinePlaylistProvider] = useState<"all" | "spotify" | "youtube">("all");
  const [onlinePlaylists, setOnlinePlaylists] = useState<OnlinePlaylistResult[]>([]);
  const [isSearchingOnlinePlaylists, setIsSearchingOnlinePlaylists] = useState(false);
  const [onlinePlaylistError, setOnlinePlaylistError] = useState("");

  const handleSearchOnlinePlaylists = async (q: string, prov: string = onlinePlaylistProvider) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setOnlinePlaylists([]);
      return;
    }
    setIsSearchingOnlinePlaylists(true);
    setOnlinePlaylistError("");
    try {
      const res = await invoke<OnlinePlaylistResult[]>("search_online_playlists", {
        query: trimmed,
        provider: prov,
      });
      setOnlinePlaylists(res || []);
    } catch (err: any) {
      setOnlinePlaylistError(err.toString());
    } finally {
      setIsSearchingOnlinePlaylists(false);
    }
  };

  // Auto-fetch fresh live playlists when user opens discover view and list is empty
  useEffect(() => {
    if (activeView === "discover" && onlinePlaylists.length === 0 && !isSearchingOnlinePlaylists) {
      handleSearchOnlinePlaylists(DEFAULT_DISCOVER_QUERY, "all");
    }
  }, [activeView]);

  // Online search states
  const [onlineTracks, setOnlineTracks] = useState<DiscoverTrack[]>([]);
  const [isSearchingOnline, setIsSearchingOnline] = useState(false);
  const [onlineSearchError, setOnlineSearchError] = useState("");

  // Add songs to active playlist states
  const [playlistSearchQuery, setPlaylistSearchQuery] = useState("");
  const [playlistSearchResults, setPlaylistSearchResults] = useState<DiscoverTrack[]>([]);
  const [isSearchingPlaylist, setIsSearchingPlaylist] = useState(false);
  const [playlistUrlInput, setPlaylistUrlInput] = useState("");
  const [isImportingUrl, setIsImportingUrl] = useState(false);
  const [playlistImportError, setPlaylistImportError] = useState("");
  const [showAddSongsPanel, setShowAddSongsPanel] = useState(false);
  const [addedTrackMap, setAddedTrackMap] = useState<Record<string, boolean>>({});

  // Hub provider search state
  const [hubSearchQuery, setHubSearchQuery] = useState("");
  const [hubSearchResults, setHubSearchResults] = useState<DiscoverTrack[]>([]);
  const [hubSearchError, setHubSearchError] = useState("");
  const [isSearchingHub, setIsSearchingHub] = useState(false);
  const [isAutoPopulating, setIsAutoPopulating] = useState(false);

  const executeOnlineSearch = async (query: string, provider: string = "all") => {
    const q = query.trim();
    if (!q) {
      setOnlineTracks([]);
      setLoadedPlaylist(null);
      return;
    }
    setIsSearchingOnline(true);
    setOnlineSearchError("");

    const info = analyzeSearchQuery(q);

    if (info.isUrl) {
      try {
        // Step 1: For collections (playlist, album, artist, collection, or unknown URL), fetch playlist info
        if (
          info.kind === "playlist" ||
          info.kind === "album" ||
          info.kind === "artist" ||
          info.kind === "collection" ||
          info.kind === "unknown"
        ) {
          try {
            const plInfo = await invoke<DiscoverPlaylistInfo>("get_playlist_info", { url: q });
            if (plInfo && plInfo.tracks && plInfo.tracks.length > 0) {
              setLoadedPlaylist(plInfo);
              setOnlineTracks(plInfo.tracks);
              return;
            }
          } catch (plErr: any) {
            console.warn("Playlist info fetch failed, trying single track preview:", plErr);
          }
        }

        // Step 2: For track URLs (or fallback if playlist info produced 0 tracks)
        const preview = await invoke<any>("get_preview_info", { input: q });
        if (preview && (preview.title || preview.stream_url || preview.video_url)) {
          const singleTrack: DiscoverTrack = {
            id: `track-${Date.now()}`,
            title: preview.title || "Track",
            artist: preview.artist || "Artist",
            duration: preview.duration || 180,
            video_url: preview.video_url || q,
            stream_url: preview.stream_url,
            thumbnail: preview.thumbnail,
            source: preview.provider || info.platform || "youtube",
          };
          setOnlineTracks([singleTrack]);
          setLoadedPlaylist({
            title: singleTrack.title,
            description: `Streamable track by ${singleTrack.artist}`,
            thumbnail: singleTrack.thumbnail || "",
            uploader: singleTrack.artist,
            source: singleTrack.source,
            tracks: [singleTrack],
          });
          return;
        }

        setOnlineSearchError(`Could not find streamable tracks from this URL: ${q}`);
      } catch (err: any) {
        setOnlineSearchError(err.toString());
      } finally {
        setIsSearchingOnline(false);
      }
      return;
    }

    // Normal non-URL query
    try {
      setLoadedPlaylist(null);
      const results = await invoke<DiscoverTrack[]>("search_online_tracks", {
        query: q,
        provider: provider === "all" ? "youtube" : provider,
      });
      setOnlineTracks(results || []);
    } catch (err: any) {
      setOnlineSearchError(err.toString());
    } finally {
      setIsSearchingOnline(false);
    }
  };

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setOnlineTracks([]);
      setLoadedPlaylist(null);
      return;
    }

    if (isUrlQuery(q)) {
      const timer = setTimeout(() => {
        executeOnlineSearch(q, providerFilter);
      }, 350);
      return () => clearTimeout(timer);
    }

    if (activeView === "search" && q.length >= 2) {
      const timer = setTimeout(() => {
        executeOnlineSearch(q, providerFilter);
      }, 450);
      return () => clearTimeout(timer);
    }
  }, [searchQuery, providerFilter, activeView]);

  const handleSearchForPlaylist = async (query: string) => {
    const q = query.trim();
    if (!q) return;
    setIsSearchingPlaylist(true);
    try {
      const p = activePlaylist?.source || "all";
      const results = await invoke<DiscoverTrack[]>("search_online_tracks", {
        query: q,
        provider: p === "all" ? "youtube" : p,
      });
      setPlaylistSearchResults(results || []);
    } catch (e: any) {
      console.error("Playlist search failed:", e);
    } finally {
      setIsSearchingPlaylist(false);
    }
  };

  const handleAddTrackToCurrentPlaylist = (t: DiscoverTrack) => {
    if (!activePlaylist) return;
    const mapped: Track = {
      id: `${t.source || activePlaylist.source}-${t.id}`,
      title: t.title,
      artist: t.artist,
      album: activePlaylist.name,
      cover: t.thumbnail || makeCover(0, t.title),
      duration: t.duration > 0 ? t.duration : 180,
      source: (t.source as MGProvider) || activePlaylist.source,
      audioUrl: t.stream_url || t.video_url,
    };
    if (onAddTrackToPlaylist) {
      onAddTrackToPlaylist(activePlaylist.id, mapped);
    }
    setAddedTrackMap(prev => ({ ...prev, [t.id]: true }));
  };

  const handleImportUrlIntoActivePlaylist = async (url: string) => {
    if (!activePlaylist || !url.trim()) return;
    setIsImportingUrl(true);
    setPlaylistImportError("");
    try {
      const info = await invoke<DiscoverPlaylistInfo>("get_playlist_info", { url: url.trim() });
      if (info && info.tracks && info.tracks.length > 0) {
        const mappedTracks: Track[] = info.tracks.map((t, idx) => ({
          id: `${info.source || activePlaylist.source}-${t.id}`,
          title: t.title,
          artist: t.artist,
          album: activePlaylist.name,
          cover: t.thumbnail || info.thumbnail || makeCover(idx, t.title),
          duration: t.duration > 0 ? t.duration : 180,
          source: (info.source as MGProvider) || activePlaylist.source,
          audioUrl: t.stream_url || t.video_url,
        }));
        onAddLocalTracks(mappedTracks);
        mappedTracks.forEach(tr => {
          if (onAddTrackToPlaylist) {
            onAddTrackToPlaylist(activePlaylist.id, tr);
          }
        });
        setPlaylistUrlInput("");
      } else {
        setPlaylistImportError("No tracks found in the provided URL");
      }
    } catch (err: any) {
      setPlaylistImportError(err.toString());
    } finally {
      setIsImportingUrl(false);
    }
  };

  const handleHubSearch = async (query: string, provider: string) => {
    if (!query.trim()) return;
    setIsSearchingHub(true);
    setHubSearchError("");
    try {
      const results = await invoke<DiscoverTrack[]>("search_online_tracks", {
        query: query.trim(),
        provider,
      });
      setHubSearchResults(results || []);
      if (!results || results.length === 0) {
        setHubSearchError("No results found for that search.");
      }
    } catch (e: any) {
      console.error("Hub search error:", e);
      setHubSearchResults([]);
      setHubSearchError(typeof e === "string" ? e : e?.toString?.() || "Search failed");
    } finally {
      setIsSearchingHub(false);
    }
  };

  const handleAutoPopulatePlaylist = async (playlist: Playlist) => {
    setIsAutoPopulating(true);
    try {
      const info = await invoke<DiscoverPlaylistInfo>("get_playlist_info", {
        url: playlist.name,
      });
      if (info && info.tracks && info.tracks.length > 0) {
        const mappedTracks: Track[] = info.tracks.map((t, idx) => ({
          id: `${t.source || playlist.source || "online"}-${t.id}`,
          title: t.title,
          artist: t.artist,
          album: playlist.name,
          cover: t.thumbnail || info.thumbnail || makeCover(idx, t.title),
          duration: t.duration > 0 ? t.duration : 180,
          source: (t.source as MGProvider) || playlist.source,
          audioUrl: t.stream_url || t.video_url,
        }));
        onAddLocalTracks(mappedTracks);
        mappedTracks.forEach((tr) => {
          if (onAddTrackToPlaylist) {
            onAddTrackToPlaylist(playlist.id, tr);
          }
        });
      }
    } catch (e) {
      console.error("Auto populate failed:", e);
    } finally {
      setIsAutoPopulating(false);
    }
  };

  const handleLoadPlaylist = async (url: string) => {
    const trimmed = url.trim().replace(/^['"`<]+|['"`>]+$/g, '').trim();
    if (!trimmed) return;

    setDiscoverLoading(true);
    setDiscoverError("");
    setLoadedPlaylist(null);

    try {
      const info = await invoke<DiscoverPlaylistInfo>("get_playlist_info", { url: trimmed });
      setLoadedPlaylist(info);
    } catch (err: any) {
      setDiscoverError(err.toString());
    } finally {
      setDiscoverLoading(false);
    }
  };

  const handlePlaylistTrackPreview = (track: DiscoverTrack) => {
    const mappedTrack: Track = {
      id: `${track.source || loadedPlaylist?.source || "online"}-${track.id}`,
      title: track.title,
      artist: track.artist,
      album: track.album || loadedPlaylist?.title || "Online Discovery",
      cover: track.thumbnail || loadedPlaylist?.thumbnail || makeCover(0, track.title),
      duration: track.duration > 0 ? track.duration : 180,
      source: (track.source as MGProvider) || (loadedPlaylist?.source as MGProvider) || "youtube",
      audioUrl: track.stream_url || track.video_url,
    };
    onSelectTrack(mappedTrack);
    setPreviewingTrackId(track.id);
  };

  const handlePlaylistTrackDownload = async (track: DiscoverTrack) => {
    setDownloadingTracks(prev => ({
      ...prev,
      [track.id]: { status: "loading" }
    }));

    try {
      const dir = downloadDir || await invoke<string>("get_download_dir");
      if (!downloadDir) setDownloadDir(dir);

      await invoke<string>("download_audio", { url: track.video_url, outputDir: dir, jobId: track.id, single: true });
      
      setDownloadingTracks(prev => ({
        ...prev,
        [track.id]: { status: "success" }
      }));

      // Re-scan local tracks
      const local = await invoke<any[]>("scan_local_tracks", { dir });
      const mapped = local.map((t, idx) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: "Local Download",
        cover: makeCover(idx, t.title),
        duration: t.duration > 0 ? t.duration : 180,
        source: "local" as const,
        audioUrl: convertFileSrc(t.file_path),
      }));
      setLocalTracks(mapped);
      onAddLocalTracks(mapped);
    } catch (err: any) {
      setDownloadingTracks(prev => ({
        ...prev,
        [track.id]: { status: "error", error: err.toString() }
      }));
    }
  };

  const handleImportPlaylist = () => {
    if (!loadedPlaylist) return;

    const provider: MGProvider = (loadedPlaylist.source as MGProvider) || (loadedPlaylist.uploader === "Spotify" ? "spotify" : "youtube");

    const mappedTracks: Track[] = loadedPlaylist.tracks.map((t, idx) => ({
      id: `${provider}-${t.id}`,
      title: t.title,
      artist: t.artist,
      album: t.album || loadedPlaylist.title,
      cover: loadedPlaylist.thumbnail || makeCover(idx, t.title),
      duration: t.duration > 0 ? t.duration : 180,
      source: provider,
      audioUrl: t.stream_url || t.video_url,
    }));

    const newPl: Playlist = {
      id: `pl-${Date.now()}`,
      name: loadedPlaylist.title,
      source: provider,
      count: loadedPlaylist.tracks.length,
      color: provider === "spotify" ? 2 : Math.floor(Math.random() * 8),
      trackIds: mappedTracks.map(t => t.id),
    };

    onAddLocalTracks(mappedTracks, { keepUrlDuplicates: true });
    onSyncPlaylist(newPl);
    onNavigate(newPl.id);
  };

  const handlePlayAllTracks = () => {
    if (!loadedPlaylist || loadedPlaylist.tracks.length === 0) return;

    const provider: MGProvider = (loadedPlaylist.source as MGProvider) || (loadedPlaylist.uploader === "Spotify" ? "spotify" : "youtube");

    const mappedTracks: Track[] = loadedPlaylist.tracks.map((t, idx) => ({
      id: `${t.source || provider}-${t.id}`,
      title: t.title,
      artist: t.artist,
      album: t.album || loadedPlaylist.title,
      cover: t.thumbnail || loadedPlaylist.thumbnail || makeCover(idx, t.title),
      duration: t.duration > 0 ? t.duration : 180,
      source: (t.source as MGProvider) || provider,
      audioUrl: t.stream_url || t.video_url,
    }));

    onAddLocalTracks(mappedTracks);
    onSelectTrack(mappedTracks[0]);
  };

  const [urlHistory, setUrlHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.urlHistory) ?? "[]");
    } catch {
      return [];
    }
  });

  const saveUrlToHistory = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setUrlHistory(prev => {
      const filtered = prev.filter(u => u !== trimmed);
      const updated = [trimmed, ...filtered].slice(0, 10);
      localStorage.setItem(STORAGE_KEYS.urlHistory, JSON.stringify(updated));
      return updated;
    });
  };

  const clearHistory = () => {
    setUrlHistory([]);
    localStorage.removeItem(STORAGE_KEYS.urlHistory);
  };

  // Initialize and load local folder & tracks
  useEffect(() => {
    let active = true;

    async function init() {
      try {
        const ytdlp = await invoke<string>("check_ytdlp");
        if (active) setYtdlpStatus(ytdlp);
      } catch (err) {
        if (active) setYtdlpStatus("not_found");
      }

      try {
        const spotdl = await invoke<string>("check_spotdl");
        if (active) setSpotdlStatus(spotdl);
      } catch (err) {
        if (active) setSpotdlStatus("not_found");
      }

      try {
        const ffmpeg = await invoke<string>("check_ffmpeg");
        if (active) setFfmpegStatus(ffmpeg);
      } catch (err) {
        if (active) setFfmpegStatus("not_found");
      }

      try {
        const dir = await invoke<string>("get_download_dir");
        if (active) {
          setDownloadDir(dir);
          // Scan
          const local = await invoke<any[]>("scan_local_tracks", { dir });
          const mapped = local.map((t, idx) => ({
            id: t.id,
            title: t.title,
            artist: t.artist,
            album: "Local Download",
            cover: makeCover(idx, t.title),
            duration: t.duration > 0 ? t.duration : 180,
            source: "local" as const,
            audioUrl: convertFileSrc(t.file_path),
          }));
          setLocalTracks(mapped);
          onAddLocalTracks(mapped);
        }
      } catch (err: any) {
        console.error("Init local tracks failed", err);
      }
    }

    if (activeView === "downloads") {
      init();
    }
    return () => {
      active = false;
    };
  }, [activeView, onAddLocalTracks]);

  const handleDownload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!downloadUrl.trim()) return;

    saveUrlToHistory(downloadUrl);
    setIsDownloading(true);
    setDownloadStatus("Initiating download...");
    setDownloadError("");

    try {
      const dir = downloadDir || await invoke<string>("get_download_dir");
      if (!downloadDir) setDownloadDir(dir);

      setDownloadStatus("Running download engine (yt-dlp / spotdl)... This may take a moment.");
      
      const res = await invoke<string>("download_audio", { url: downloadUrl, outputDir: dir, jobId: "main" });
      setDownloadStatus(res);
      setDownloadUrl("");

      // Re-scan
      const local = await invoke<any[]>("scan_local_tracks", { dir });
      const mapped = local.map((t, idx) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: "Local Download",
        cover: makeCover(idx, t.title),
        duration: t.duration > 0 ? t.duration : 180,
        source: "local" as const,
        audioUrl: convertFileSrc(t.file_path),
      }));
      setLocalTracks(mapped);
      onAddLocalTracks(mapped);
    } catch (err: any) {
      setDownloadError(err.toString());
      setDownloadStatus("Download failed");
    } finally {
      setIsDownloading(false);
    }
  };

  const handleScan = async () => {
    try {
      const dir = downloadDir || await invoke<string>("get_download_dir");
      if (!downloadDir) setDownloadDir(dir);

      const local = await invoke<any[]>("scan_local_tracks", { dir });
      const mapped = local.map((t, idx) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: "Local Download",
        cover: makeCover(idx, t.title),
        duration: t.duration > 0 ? t.duration : 180,
        source: "local" as const,
        audioUrl: convertFileSrc(t.file_path),
      }));
      setLocalTracks(mapped);
      onAddLocalTracks(mapped);
      setDownloadStatus(`Scan complete. Found ${mapped.length} local tracks.`);
    } catch (err: any) {
      setDownloadError(err.toString());
    }
  };

  const handlePreview = async () => {
    if (!downloadUrl.trim()) return;
    saveUrlToHistory(downloadUrl);
    setPreviewLoading(true);
    setPreviewError("");
    setPreviewInfo(null);
    stopPreview();

    try {
      const info = await invoke<{
        title: string; artist: string; thumbnail: string;
        stream_url: string; video_url: string;
      }>("get_preview_info", { input: downloadUrl });

      setPreviewInfo(info);
      setIsPreviewing(false);

      // Start streaming audio from the live URL
      if (previewAudioRef.current) {
        previewAudioRef.current.src = info.stream_url;
        previewAudioRef.current.load();
        previewAudioRef.current.play().then(() => {
          setIsPreviewing(true);
        }).catch(() => {
          // Audio streaming failed (CORS or format issue), show card without audio
          setIsPreviewing(false);
        });
      }
    } catch (err: any) {
      setPreviewError(err.toString());
    } finally {
      setPreviewLoading(false);
    }
  };

  const stopPreview = () => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.src = "";
    }
    setIsPreviewing(false);
    setPreviewingTrackId(null);
  };

  const togglePreviewPlayback = () => {
    if (!previewAudioRef.current || !previewInfo) return;
    if (isPreviewing) {
      previewAudioRef.current.pause();
      setIsPreviewing(false);
    } else {
      previewAudioRef.current.play().catch(() => {});
      setIsPreviewing(true);
    }
  };

  const activePlaylist = useMemo(() => playlists.find((p) => p.id === activeView), [playlists, activeView]);

  const displayedTracks = useMemo(() => {
    let list = tracks;
    if (activePlaylist) {
      list = tracks.filter((t) => activePlaylist.trackIds.includes(t.id));
    } else if (activeView === "provider-spotify") {
      list = tracks.filter((t) => t.source === "spotify");
    } else if (activeView === "provider-ytmusic") {
      list = tracks.filter((t) => t.source === "youtube");
    } else if (activeView === "provider-soundcloud") {
      list = tracks.filter((t) => t.source === "soundcloud");
    } else if (activeView === "provider-local") {
      list = tracks.filter((t) => t.source === "local");
    }

    if (activeView === "search" && providerFilter !== "all") {
      list = list.filter((t) => t.source === providerFilter);
    }

    if (searchQuery.trim()) {
      if (isUrlQuery(searchQuery)) {
        return [];
      }
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q)
      );
    }
    return list;
  }, [tracks, activePlaylist, activeView, searchQuery, providerFilter]);

  const handleCreatePlaylist = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlName.trim()) return;
    const newPl: Playlist = {
      id: `pl-${Date.now()}`,
      name: newPlName,
      source: newPlSource,
      count: selectedTrackIds.length,
      color: Math.floor(Math.random() * 8),
      trackIds: selectedTrackIds,
    };
    onSyncPlaylist(newPl);
    setNewPlName("");
    setSelectedTrackIds([]);
    setShowImportModal(false);
    onNavigate(newPl.id);
  };

  const toggleTrackSel = (id: string) =>
    setSelectedTrackIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div style={{
      flex: 1,
      height: "100%",
      overflowY: "auto",
      padding: "28px 32px",
      position: "relative",
    }}>
      {/* Universal preview audio element - always mounted for all views */}
      <audio ref={previewAudioRef} style={{ display: "none" }} onEnded={stopPreview} />

      {/* Page header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 900, color: "var(--text)", letterSpacing: "-0.03em" }}>
            {activePlaylist 
              ? activePlaylist.name 
              : activeView === "search" 
              ? "Unified Search" 
              : activeView === "downloads" 
              ? "Downloads & Offline Storage" 
              : activeView === "discover"
              ? "Discover & Playlists"
              : activeView === "provider-spotify"
              ? "Spotify Music Hub"
              : activeView === "provider-ytmusic"
              ? "YouTube Music Hub"
              : activeView === "provider-soundcloud"
              ? "SoundCloud Hub"
              : activeView === "provider-local"
              ? "Local Music Library"
              : "Home Library"}
          </h2>
          <p style={{ fontSize: 12, color: "var(--text-2)", marginTop: 4, fontWeight: 500 }}>
            {activePlaylist
              ? `${activePlaylist.source.toUpperCase()} · ${displayedTracks.length} tracks`
              : activeView === "downloads"
              ? "Download music and manage offline tracks"
              : activeView === "discover"
              ? "Explore public playlists and load new music"
              : activeView === "provider-spotify"
              ? `Stream, preview, and load tracks and playlists from Spotify · ${displayedTracks.length} tracks in library`
              : activeView === "provider-ytmusic"
              ? `High-bitrate streams, trending music, and public YouTube playlists · ${displayedTracks.length} tracks in library`
              : activeView === "provider-soundcloud"
              ? `Independent artists, remixes, and direct audio streams from SoundCloud · ${displayedTracks.length} tracks in library`
              : activeView === "provider-local"
              ? `Offline MP3s saved on your computer with zero latency · ${displayedTracks.length} tracks in library`
              : "Your unified multi-source music library"}
          </p>
        </div>
        {activePlaylist && (
          <button
            onClick={() => setShowAddSongsPanel((prev) => !prev)}
            style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "9px 18px", borderRadius: 12,
              background: showAddSongsPanel ? "color-mix(in srgb, var(--text) 12%, transparent)" : "var(--accent)",
              color: "var(--accent-fg)",
              border: `1px solid ${showAddSongsPanel ? "color-mix(in srgb, var(--text) 20%, transparent)" : "transparent"}`,
              fontSize: 12, fontWeight: 700,
              cursor: "pointer", boxShadow: "0 4px 20px color-mix(in srgb, var(--accent) 35%, transparent)",
              transition: "all 0.15s ease",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {showAddSongsPanel ? "Hide Add Panel" : "+ Add Songs"}
          </button>
        )}
        {!activePlaylist && activeView === "home" && (
          <button
            onClick={() => setShowImportModal(true)}
            style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "9px 18px", borderRadius: 12,
              background: "var(--accent)", color: "var(--accent-fg)",
              border: "none", fontSize: 12, fontWeight: 700,
              cursor: "pointer", boxShadow: "0 4px 20px color-mix(in srgb, var(--accent) 35%, transparent)",
              transition: "transform 0.15s ease",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Create Playlist
          </button>
        )}
      </div>

      {/* Vinyl Hero Card */}
      {!activePlaylist && activeView === "home" && currentTrack && (
        <div style={{
          display: "flex", alignItems: "center", gap: 32,
          padding: "24px 28px", borderRadius: 20, marginBottom: 28,
          background: "color-mix(in srgb, var(--surface) 90%, transparent)",
          
          border: "1px solid color-mix(in srgb, var(--text) 7%, transparent)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          position: "relative", overflow: "hidden",
        }}>
          {/* Ambient glow */}
          <div style={{
            position: "absolute", inset: 0,
            background: "var(--surface)",
            pointerEvents: "none",
          }} />

          {/* Vinyl Record */}
          <div style={{ position: "relative", flexShrink: 0 }}>
            <div
              style={{
                width: 130, height: 130, borderRadius: "50%",
                background: "var(--surface-2)",
                border: "3px solid #2a2a3a",
                boxShadow: "0 0 30px rgba(0,0,0,0.8), inset 0 0 20px rgba(0,0,0,0.5)",
                display: "flex", alignItems: "center", justifyContent: "center",
                position: "relative",
                animation: isPlaying ? "spin-slow 12s linear infinite" : "none",
              }}
            >
              {/* Groove rings */}
              {[20, 32, 44, 56].map((r) => (
                <div key={r} style={{
                  position: "absolute",
                  width: `${100 - r}%`, height: `${100 - r}%`,
                  borderRadius: "50%",
                  border: "1px solid color-mix(in srgb, var(--text) 4%, transparent)",
                }} />
              ))}
              {/* Center label */}
              <div style={{
                width: 46, height: 46, borderRadius: "50%",
                backgroundImage: `url(${currentTrack.cover})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                border: "1px solid rgba(0,0,0,0.4)",
                boxShadow: "0 0 12px rgba(0,0,0,0.6)",
              }} />
              {/* Center pin */}
              <div style={{
                position: "absolute", width: 8, height: 8,
                borderRadius: "50%",
                background: "var(--surface)",
                border: "1px solid color-mix(in srgb, var(--text) 15%, transparent)",
              }} />
            </div>
            {/* Tone arm */}
            <div style={{
              position: "absolute", top: -4, right: -16, pointerEvents: "none",
              transform: isPlaying ? "rotate(14deg)" : "rotate(4deg)",
              transformOrigin: "top right",
              transition: "transform 0.7s ease",
            }}>
              <svg width="38" height="65" viewBox="0 0 38 65" fill="none">
                <line x1="30" y1="8" x2="10" y2="48" stroke="#666" strokeWidth="2" strokeLinecap="round" />
                <rect x="7" y="46" width="7" height="7" rx="1.5" fill="#333" />
              </svg>
            </div>
          </div>

          {/* Track Info */}
          <div style={{ flex: 1, zIndex: 1 }}>
            <div style={{
              display: "inline-block",
              fontSize: 9, fontWeight: 800, letterSpacing: "0.12em",
              textTransform: "uppercase", color: "var(--accent)",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              padding: "3px 10px", borderRadius: 99, marginBottom: 10,
            }}>
              Now Playing
            </div>
            <h3 style={{ fontSize: 26, fontWeight: 900, color: "var(--text)", letterSpacing: "-0.03em", lineHeight: 1.1, marginBottom: 6 }}>
              {currentTrack.title}
            </h3>
            <p style={{ fontSize: 13, color: "var(--text-2)", fontWeight: 600, marginBottom: 18 }}>
              {currentTrack.artist}
              <span style={{ opacity: 0.5, fontWeight: 400 }}> — {currentTrack.album}</span>
            </p>
            <button
              onClick={() => onSelectTrack(currentTrack)}
              style={{
                padding: "9px 22px", borderRadius: 10,
                background: "var(--accent)", color: "var(--accent-fg)",
                border: "none", fontSize: 12, fontWeight: 800,
                cursor: "pointer",
                boxShadow: "0 4px 14px color-mix(in srgb, var(--text) 10%, transparent)",
                transition: "transform 0.15s ease",
              }}
            >
              ▶  Play Now
            </button>
          </div>
        </div>
      )}

      {/* Search Input & Provider Filter */}
      {(activeView === "search" || activeView === "home") && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 28 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ position: "relative", flex: 1 }}>
              <input
                type="text"
                placeholder={
                  activeView === "home"
                    ? "Search songs, artists, albums, or discover online (Spotify, YouTube, SoundCloud)..."
                    : "Search songs, artists, albums across all connected providers..."
                }
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData("text").trim();
                  if (isUrlQuery(pasted)) {
                    setSearchQuery(pasted);
                    executeOnlineSearch(pasted, providerFilter);
                    if (activeView === "home") onNavigate("search");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    executeOnlineSearch(searchQuery, providerFilter);
                    if (activeView === "home") onNavigate("search");
                  }
                }}
                style={{
                  width: "100%", padding: searchQuery ? "12px 40px 12px 44px" : "12px 16px 12px 44px",
                  borderRadius: 14,
                  background: "color-mix(in srgb, var(--text) 4%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                  color: "var(--text)", fontSize: 13, fontWeight: 500,
                  outline: "none", boxSizing: "border-box",
                }}
              />
              <svg style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: "var(--text-3)" }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => { setSearchQuery(""); setOnlineTracks([]); setLoadedPlaylist(null); }}
                  style={{
                    position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)",
                    background: "color-mix(in srgb, var(--text) 10%, transparent)", border: "none", borderRadius: "50%",
                    color: "var(--text-2)", width: 22, height: 22, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11,
                  }}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
            <button
              onClick={() => {
                executeOnlineSearch(searchQuery, providerFilter);
                if (activeView === "home") onNavigate("search");
              }}
              disabled={isSearchingOnline || !searchQuery.trim()}
              style={{
                padding: "0 22px", borderRadius: 14,
                background: urlAnalysis.isUrl ? urlAnalysis.color : "var(--accent)", color: "var(--accent-fg)",
                border: "none", fontSize: 13, fontWeight: 700,
                cursor: isSearchingOnline ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: 8,
                boxShadow: `0 4px 16px ${urlAnalysis.isUrl ? `${urlAnalysis.color}40` : "color-mix(in srgb, var(--accent) 35%, transparent)"}`,
              }}
            >
              {isSearchingOnline ? (
                <>
                  <div style={{ width: 14, height: 14, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%", animation: "spin-slow 1s linear infinite" }} />
                  Loading...
                </>
              ) : urlAnalysis.isUrl ? (
                `⚡ Load ${urlAnalysis.label}`
              ) : (
                "Search Online"
              )}
            </button>
          </div>

          {/* Smart Link Detection Pill */}
          {urlAnalysis.isUrl && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "10px 16px", borderRadius: 12,
              background: `${urlAnalysis.color}15`,
              border: `1px solid ${urlAnalysis.color}40`,
              gap: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                <span style={{
                  fontSize: 10, fontWeight: 900, textTransform: "uppercase",
                  background: urlAnalysis.color, color: "var(--text)",
                  padding: "3px 8px", borderRadius: 6, letterSpacing: "0.06em", flexShrink: 0,
                }}>
                  {urlAnalysis.label}
                </span>
                <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 700, flexShrink: 0 }}>
                  Smart Link Detected:
                </span>
                <span style={{ fontSize: 12, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {searchQuery.trim()}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  executeOnlineSearch(searchQuery, providerFilter);
                  if (activeView === "home") onNavigate("search");
                }}
                disabled={isSearchingOnline}
                style={{
                  padding: "6px 14px", borderRadius: 8,
                  background: urlAnalysis.color, color: "var(--text)", border: "none",
                  fontSize: 11, fontWeight: 800, cursor: isSearchingOnline ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
                  boxShadow: `0 2px 10px ${urlAnalysis.color}40`,
                }}
              >
                {isSearchingOnline ? (
                  <>
                    <div style={{ width: 12, height: 12, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%", animation: "spin-slow 1s linear infinite" }} />
                    Loading...
                  </>
                ) : (
                  <>⚡ Load & Stream</>
                )}
              </button>
            </div>
          )}

          {/* Provider Filter Tabs */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginRight: 4 }}>
              Provider Filter:
            </span>
            {[
              { id: "all", label: "All Sources", color: "var(--accent)" },
              { id: "spotify", label: "Spotify", color: "#1DB954" },
              { id: "youtube", label: "YouTube Music", color: "#FF0000" },
              { id: "soundcloud", label: "SoundCloud", color: "#FF5500" },
              { id: "local", label: "Local Files", color: "var(--accent)" },
            ].map(p => {
              const isSelected = providerFilter === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setProviderFilter(p.id as any)}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 99,
                    fontSize: 11,
                    fontWeight: isSelected ? 800 : 600,
                    cursor: "pointer",
                    background: isSelected ? `${p.color}25` : "color-mix(in srgb, var(--text) 3%, transparent)",
                    color: isSelected ? (p.id === "all" ? "var(--text)" : p.color) : "var(--text-2)",
                    border: `1px solid ${isSelected ? p.color : "color-mix(in srgb, var(--text) 6%, transparent)"}`,
                    transition: "all 0.15s ease",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {p.id !== "all" && (
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: p.color,
                      boxShadow: isSelected ? `0 0 6px ${p.color}` : "none",
                    }} />
                  )}
                  {p.label}
                </button>
              );
            })}
            {activeView === "home" && searchQuery.trim() && (
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--accent)", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                <span>Filtering {displayedTracks.length} song{displayedTracks.length === 1 ? "" : "s"} in library</span>
                <span style={{ opacity: 0.5 }}>·</span>
                <span style={{ color: "var(--text-2)", fontWeight: 500 }}>Press Enter to search online</span>
              </span>
            )}
          </div>

          {/* Online Search Results */}
          {isSearchingOnline && (
            <div style={{
              padding: "24px", textAlign: "center",
              background: "color-mix(in srgb, var(--accent) 6%, transparent)", borderRadius: 16,
              border: "1px dashed color-mix(in srgb, var(--accent) 25%, transparent)",
            }}>
              <div style={{
                display: "inline-block", width: 22, height: 22,
                border: "2px solid var(--accent)", borderTopColor: "transparent",
                borderRadius: "50%", animation: "spin-slow 1s linear infinite",
                marginBottom: 10,
              }} />
              <p style={{ color: "var(--text-2)", fontSize: 13, fontWeight: 600, margin: 0 }}>
                {urlAnalysis.isUrl
                  ? `Loading ${urlAnalysis.label}... Resolving track metadata & high-bitrate streams`
                  : "Searching online catalog across Spotify, YouTube Music, and SoundCloud..."}
              </p>
            </div>
          )}

          {onlineSearchError && (
            <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", color: "#EF4444", fontSize: 12 }}>
              Failed to complete online search: {onlineSearchError}
            </div>
          )}

          {/* Loaded Online Collection Header (from URL or Discover) */}
          {loadedPlaylist && (
            <div style={{
              display: "flex", alignItems: "center", gap: 20,
              padding: "20px 24px", borderRadius: 16,
              background: "color-mix(in srgb, var(--surface) 90%, transparent)",
              
              border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
              marginBottom: 16,
            }}>
              <div style={{
                width: 90, height: 90, borderRadius: 12, flexShrink: 0,
                backgroundImage: loadedPlaylist.thumbnail ? `url(${loadedPlaylist.thumbnail})` : "none",
                backgroundSize: "cover", backgroundPosition: "center",
                background: !loadedPlaylist.thumbnail ? "var(--surface-2)" : undefined,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: loadedPlaylist.thumbnail ? 0 : 32, fontWeight: 900, color: "var(--text)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
              }}>
                {!loadedPlaylist.thumbnail && loadedPlaylist.title.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 900,
                    color: (loadedPlaylist.source === "spotify" || loadedPlaylist.uploader === "Spotify") ? "#1DB954" : (loadedPlaylist.source === "soundcloud" ? "#FF5500" : "#FF0000"),
                    letterSpacing: "0.12em", textTransform: "uppercase",
                    background: (loadedPlaylist.source === "spotify" || loadedPlaylist.uploader === "Spotify") ? "rgba(29,185,84,0.12)" : (loadedPlaylist.source === "soundcloud" ? "rgba(255,85,0,0.12)" : "rgba(255,0,0,0.12)"),
                    padding: "2px 8px", borderRadius: 6,
                  }}>
                    {(loadedPlaylist.source === "spotify" || loadedPlaylist.uploader === "Spotify") ? "Spotify" : (loadedPlaylist.source === "soundcloud" ? "SoundCloud" : "YouTube")}
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 800, color: "var(--text-2)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                    {urlAnalysis.isUrl ? urlAnalysis.label : "Online Collection"}
                  </span>
                </div>
                <h3 style={{ fontSize: 18, fontWeight: 900, color: "var(--text)", margin: "2px 0 4px 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {loadedPlaylist.title}
                </h3>
                <p style={{ fontSize: 11, color: "var(--text-2)", fontWeight: 500, margin: "0 0 10px 0" }}>
                  Curator / Artist: <span style={{ color: "var(--text)", fontWeight: 700 }}>{loadedPlaylist.uploader}</span> · {loadedPlaylist.tracks.length} tracks
                </p>
                {loadedPlaylist.description && (
                  <p style={{
                    fontSize: 10.5, color: "var(--text-3)", lineHeight: 1.4, margin: "0 0 12px 0",
                    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                  }}>
                    {loadedPlaylist.description}
                  </p>
                )}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={handlePlayAllTracks}
                    style={{
                      padding: "7px 16px", borderRadius: 10,
                      background: "var(--surface-2)", color: "var(--text)",
                      border: "none", fontSize: 11, fontWeight: 800,
                      cursor: "pointer", boxShadow: "0 4px 16px color-mix(in srgb, var(--accent) 30%, transparent)",
                      display: "flex", alignItems: "center", gap: 6,
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    Play All ({loadedPlaylist.tracks.length})
                  </button>
                  <button
                    type="button"
                    onClick={handleImportPlaylist}
                    style={{
                      padding: "7px 16px", borderRadius: 10,
                      background: "var(--accent)", color: "var(--accent-fg)",
                      border: "none", fontSize: 11, fontWeight: 800,
                      cursor: "pointer", boxShadow: "0 4px 16px color-mix(in srgb, var(--accent) 30%, transparent)",
                      display: "flex", alignItems: "center", gap: 6,
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Save to My Playlists
                  </button>
                  <button
                    type="button"
                    onClick={() => { setLoadedPlaylist(null); setOnlineTracks([]); }}
                    style={{
                      padding: "7px 14px", borderRadius: 10,
                      background: "color-mix(in srgb, var(--text) 5%, transparent)", border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                      color: "var(--text-2)", fontSize: 11, fontWeight: 700, cursor: "pointer",
                    }}
                  >
                    ✕ Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}

          {onlineTracks.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, color: "var(--accent)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                <span>Online Streamable Results</span>
                <span style={{ padding: "2px 6px", borderRadius: 4, background: "color-mix(in srgb, var(--accent) 15%, transparent)", fontSize: 9 }}>
                  {onlineTracks.length} found
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {onlineTracks.map((t, idx) => {
                  const isCurrent = currentTrack?.id === `${t.source || "online"}-${t.id}`;
                  return (
                    <div
                      key={t.id}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "10px 14px", borderRadius: 14,
                        background: isCurrent ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "color-mix(in srgb, var(--text) 3%, transparent)",
                        border: `1px solid ${isCurrent ? "color-mix(in srgb, var(--accent) 40%, transparent)" : "color-mix(in srgb, var(--text) 6%, transparent)"}`,
                        transition: "all 0.15s ease",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1 }}>
                        <span style={{ width: 20, textAlign: "center", fontSize: 11, fontWeight: 700, color: "var(--text-3)" }}>
                          {idx + 1}
                        </span>
                        {t.thumbnail ? (
                          <img src={t.thumbnail} alt="" loading="lazy" decoding="async" style={{ width: 42, height: 42, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
                        ) : (
                          <div style={{ width: 42, height: 42, borderRadius: 8, background: "color-mix(in srgb, var(--text) 6%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)", fontWeight: 800, flexShrink: 0 }}>
                            {t.title.charAt(0)}
                          </div>
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {t.title}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {t.artist}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                        <span style={{
                          fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 5,
                          textTransform: "uppercase",
                          background: t.source === "spotify" ? "rgba(29,185,84,0.15)" : t.source === "soundcloud" ? "rgba(255,85,0,0.15)" : "rgba(255,0,0,0.15)",
                          color: t.source === "spotify" ? "#1DB954" : t.source === "soundcloud" ? "#FF5500" : "#FF4444",
                          border: `1px solid ${t.source === "spotify" ? "color-mix(in srgb, var(--accent) 30%, transparent)" : t.source === "soundcloud" ? "rgba(255,85,0,0.3)" : "rgba(255,0,0,0.3)"}`,
                        }}>
                          {t.source === "youtube" ? "YouTube" : t.source || "Web"}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                          {formatDuration(t.duration)}
                        </span>
                        <button
                          onClick={() => handlePlaylistTrackPreview(t)}
                          style={{
                            padding: "6px 14px", borderRadius: 8,
                            background: "var(--accent)", color: "var(--accent-fg)", border: "none",
                            fontSize: 11, fontWeight: 700, cursor: "pointer",
                            display: "flex", alignItems: "center", gap: 5,
                          }}
                        >
                          ▶ Stream
                        </button>
                        {playlists.length > 0 && (
                          <button
                            onClick={() => {
                              const targetPl = playlists[0];
                              const mapped: Track = {
                                id: `${t.source || "online"}-${t.id}`,
                                title: t.title,
                                artist: t.artist,
                                album: targetPl.name,
                                cover: t.thumbnail || makeCover(0, t.title),
                                duration: t.duration > 0 ? t.duration : 180,
                                source: (t.source as MGProvider) || "youtube",
                                audioUrl: t.stream_url || t.video_url,
                              };
                              if (onAddTrackToPlaylist) onAddTrackToPlaylist(targetPl.id, mapped);
                            }}
                            style={{
                              padding: "6px 12px", borderRadius: 8,
                              background: "color-mix(in srgb, var(--text) 6%, transparent)", color: "var(--text)",
                              border: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
                              fontSize: 11, fontWeight: 600, cursor: "pointer",
                            }}
                            title={`Add to ${playlists[0].name}`}
                          >
                            + Playlist
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeView === "search" && !isSearchingOnline && onlineTracks.length === 0 && searchQuery.trim().length === 0 && (
            <div style={{
              padding: "24px", borderRadius: 16,
              background: "color-mix(in srgb, var(--text) 2%, transparent)", border: "1px dashed color-mix(in srgb, var(--text) 6%, transparent)",
              display: "flex", flexDirection: "column", gap: 12, alignItems: "center",
            }}>
              <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Suggested Searches
              </span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                {["Coldplay", "The Weeknd", "Dua Lipa", "Lofi Beats", "Taylor Swift", "Imagine Dragons", "Chillstep"].map(term => (
                  <button
                    key={term}
                    onClick={() => {
                      setSearchQuery(term);
                      executeOnlineSearch(term, providerFilter);
                    }}
                    style={{
                      padding: "6px 14px", borderRadius: 99,
                      background: "color-mix(in srgb, var(--text) 5%, transparent)", border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                      color: "var(--text-2)", fontSize: 12, fontWeight: 600, cursor: "pointer",
                      display: "inline-flex", alignItems: "center", gap: 6,
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <span>{term}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dedicated Provider Portal Banner */}
      {activeView.startsWith("provider-") && (
        <div style={{
          display: "flex", flexDirection: "column", gap: 16, marginBottom: 28,
          padding: "24px 28px", borderRadius: 20,
          background: "color-mix(in srgb, var(--surface) 90%, transparent)",
          
          border: `1px solid ${
            activeView === "provider-spotify"
              ? "color-mix(in srgb, var(--accent) 30%, transparent)"
              : activeView === "provider-ytmusic"
              ? "rgba(255,0,0,0.3)"
              : activeView === "provider-soundcloud"
              ? "rgba(255,85,0,0.3)"
              : "color-mix(in srgb, var(--accent) 30%, transparent)"
          }`,
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          position: "relative", overflow: "hidden",
        }}>
          

          {/* Header Row */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{
                width: 48, height: 48, borderRadius: 14,
                background:
                  activeView === "provider-spotify"
                    ? "rgba(29,185,84,0.18)"
                    : activeView === "provider-ytmusic"
                    ? "rgba(255,0,0,0.18)"
                    : activeView === "provider-soundcloud"
                    ? "rgba(255,85,0,0.18)"
                    : "color-mix(in srgb, var(--accent) 18%, transparent)",
                color:
                  activeView === "provider-spotify"
                    ? "#1DB954"
                    : activeView === "provider-ytmusic"
                    ? "#FF0000"
                    : activeView === "provider-soundcloud"
                    ? "#FF5500"
                    : "var(--accent)",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: `0 0 20px ${
                  activeView === "provider-spotify"
                    ? "color-mix(in srgb, var(--accent) 30%, transparent)"
                    : activeView === "provider-ytmusic"
                    ? "rgba(255,0,0,0.3)"
                    : activeView === "provider-soundcloud"
                    ? "rgba(255,85,0,0.3)"
                    : "color-mix(in srgb, var(--accent) 30%, transparent)"
                }`,
              }}>
                {activeView === "provider-spotify" && (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                  </svg>
                )}
                {activeView === "provider-ytmusic" && (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.144a7.144 7.144 0 1 1 0-14.288 7.144 7.144 0 0 1 0 14.288zm0-11.43a4.286 4.286 0 1 0 0 8.572 4.286 4.286 0 0 0 0-8.572zm-1.714 6.215V10.07l3.857 1.93-3.857 1.93z" />
                  </svg>
                )}
                {activeView === "provider-soundcloud" && (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M1.175 12.225c-.05 0-.09.042-.09.092l-.21 2.378c0 .05.04.091.09.091l.21-.01c.05 0 .09-.041.09-.091l.21-2.378c0-.05-.04-.092-.09-.092h-.2zm2.083-1.636c-.05 0-.091.042-.091.092l-.337 4.014c0 .05.041.092.091.092h.211c.05 0 .09-.042.09-.092l.338-4.014c0-.05-.04-.092-.09-.092h-.212zm2.148-.737c-.05 0-.091.041-.091.091l-.274 4.751c0 .05.04.092.09.092h.212c.05 0 .09-.042.09-.092l.275-4.751c0-.05-.04-.091-.09-.091h-.212zm2.13-.198c-.05 0-.092.041-.092.091l-.224 4.949c0 .05.042.092.092.092h.21c.05 0 .092-.042.092-.092l.225-4.949c0-.05-.042-.091-.092-.091h-.211zm2.149-.556c-.05 0-.091.041-.091.091l-.161 5.505c0 .05.041.092.091.092h.212c.05 0 .09-.042.09-.092l.162-5.505c0-.05-.04-.091-.09-.091h-.213zm4.512-1.92c-.378 0-.742.062-1.084.175-.126.042-.236.14-.265.27-.061.272-.095.556-.095.847 0 .148.01.292.029.435-.027-.003-.055-.008-.083-.008-.051 0-.092.041-.092.091l-.11 6.596c0 .05.041.092.092.092h8.04c1.91 0 3.46-1.55 3.46-3.46 0-1.85-1.46-3.36-3.29-3.45-.44-1.89-2.14-3.3-4.17-3.3z" />
                  </svg>
                )}
                {activeView === "provider-local" && (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="2" />
                  </svg>
                )}
              </div>
              <div>
                <h3 style={{ fontSize: 20, fontWeight: 900, color: "var(--text)", margin: "0 0 4px 0" }}>
                  {activeView === "provider-spotify"
                    ? "Spotify Music Hub"
                    : activeView === "provider-ytmusic"
                    ? "YouTube Music Hub"
                    : activeView === "provider-soundcloud"
                    ? "SoundCloud Hub"
                    : "Local Storage"}
                </h3>
                <span style={{ fontSize: 12, color: "var(--text-2)" }}>
                  {activeView === "provider-spotify"
                    ? "Direct Spotify links, metadata extraction, and library synchronizer"
                    : activeView === "provider-ytmusic"
                    ? "Direct YouTube & YouTube Music stream resolver and audio extractor"
                    : activeView === "provider-soundcloud"
                    ? "SoundCloud tracks, sets, and indie electronic releases"
                    : "Offline MP3 audio storage in your MG-Lyrics directory"}
                </span>
              </div>
            </div>

            {/* Quick Actions */}
            <div style={{ display: "flex", gap: 10 }}>
              {activeView === "provider-local" ? (
                <button
                  onClick={handleScan}
                  style={{
                    padding: "9px 18px", borderRadius: 12,
                    background: "var(--accent)", color: "var(--accent-fg)", border: "none",
                    fontSize: 12, fontWeight: 800, cursor: "pointer",
                    boxShadow: "0 4px 16px color-mix(in srgb, var(--accent) 40%, transparent)",
                  }}
                >
                  Scan Downloads Folder
                </button>
              ) : (
                <button
                  onClick={() => onNavigate("downloads")}
                  style={{
                    padding: "9px 18px", borderRadius: 12,
                    background:
                      activeView === "provider-spotify"
                        ? "#1DB954"
                        : activeView === "provider-ytmusic"
                        ? "#FF0000"
                        : "#FF5500",
                    color: "var(--text)", border: "none",
                    fontSize: 12, fontWeight: 800, cursor: "pointer",
                    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
                  }}
                >
                  Open Downloader →
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Provider Catalog Search & Curated Collections */}
      {activeView.startsWith("provider-") && activeView !== "provider-local" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20, marginBottom: 28 }}>
          {/* Provider Specific Search */}
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ position: "relative", flex: 1 }}>
              <input
                type="text"
                placeholder={
                  activeView === "provider-spotify"
                    ? "Search Spotify catalog for artists, tracks, or albums..."
                    : activeView === "provider-ytmusic"
                    ? "Search YouTube Music for official audio, videos, and remixes..."
                    : "Search SoundCloud for independent music, podcasts, and sets..."
                }
                value={hubSearchQuery}
                onChange={(e) => setHubSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const prov = activeView === "provider-spotify" ? "spotify" : activeView === "provider-ytmusic" ? "youtube" : "soundcloud";
                    handleHubSearch(hubSearchQuery, prov);
                  }
                }}
                style={{
                  width: "100%", padding: "12px 16px 12px 42px",
                  borderRadius: 14,
                  background: "color-mix(in srgb, var(--text) 4%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                  color: "var(--text)", fontSize: 13, outline: "none", boxSizing: "border-box",
                }}
              />
              <svg style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--text-3)" }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
            <button
              onClick={() => {
                const prov = activeView === "provider-spotify" ? "spotify" : activeView === "provider-ytmusic" ? "youtube" : "soundcloud";
                handleHubSearch(hubSearchQuery, prov);
              }}
              disabled={isSearchingHub || !hubSearchQuery.trim()}
              style={{
                padding: "0 22px", borderRadius: 14,
                background:
                  activeView === "provider-spotify"
                    ? "#1DB954"
                    : activeView === "provider-ytmusic"
                    ? "#FF0000"
                    : "#FF5500",
                color: "var(--text)", border: "none", fontSize: 13, fontWeight: 700,
                cursor: isSearchingHub ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              {isSearchingHub ? "Searching..." : "Search Catalog"}
            </button>
          </div>

          {/* Hub Search Results */}
          {isSearchingHub && (
            <div style={{
              padding: "20px", textAlign: "center",
              background: "color-mix(in srgb, var(--text) 2%, transparent)", borderRadius: 14,
              border: "1px dashed color-mix(in srgb, var(--text) 8%, transparent)",
            }}>
              <p style={{ color: "var(--text-2)", fontSize: 13, fontWeight: 600, margin: 0 }}>
                Querying live provider catalog...
              </p>
            </div>
          )}

          {hubSearchError && !isSearchingHub && (
            <div style={{
              padding: "12px 16px", borderRadius: 12,
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.18)",
              color: "#f87171", fontSize: 12, fontWeight: 600,
            }}>
              {hubSearchError}
            </div>
          )}

          {hubSearchResults.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>
                Live Search Results ({hubSearchResults.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {hubSearchResults.map((t, idx) => {
                  const prov = activeView === "provider-spotify" ? "spotify" : activeView === "provider-ytmusic" ? "youtube" : "soundcloud";
                  const isCurrent = currentTrack?.id === `${prov}-${t.id}`;
                  return (
                    <div
                      key={t.id}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "10px 14px", borderRadius: 12,
                        background: isCurrent ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "color-mix(in srgb, var(--text) 3%, transparent)",
                        border: `1px solid ${isCurrent ? "color-mix(in srgb, var(--accent) 40%, transparent)" : "color-mix(in srgb, var(--text) 6%, transparent)"}`,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1 }}>
                        <span style={{ width: 20, textAlign: "center", fontSize: 11, fontWeight: 700, color: "var(--text-3)" }}>
                          {idx + 1}
                        </span>
                        {t.thumbnail ? (
                          <img src={t.thumbnail} alt="" loading="lazy" decoding="async" style={{ width: 38, height: 38, borderRadius: 8, objectFit: "cover" }} />
                        ) : (
                          <div style={{ width: 38, height: 38, borderRadius: 8, background: "color-mix(in srgb, var(--text) 6%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)", fontWeight: 800 }}>
                            {t.title.charAt(0)}
                          </div>
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {t.title}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {t.artist}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                        <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                          {formatDuration(t.duration)}
                        </span>
                        <button
                          onClick={() => handlePlaylistTrackPreview(t)}
                          style={{
                            padding: "6px 14px", borderRadius: 8,
                            background: "var(--accent)", color: "var(--accent-fg)", border: "none",
                            fontSize: 11, fontWeight: 700, cursor: "pointer",
                          }}
                        >
                          ▶ Stream Now
                        </button>
                        {playlists.length > 0 && (
                          <button
                            onClick={() => {
                              const targetPl = playlists[0];
                              const mapped: Track = {
                                id: `${prov}-${t.id}`,
                                title: t.title,
                                artist: t.artist,
                                album: targetPl.name,
                                cover: t.thumbnail || makeCover(0, t.title),
                                duration: t.duration > 0 ? t.duration : 180,
                                source: prov as MGProvider,
                                audioUrl: t.stream_url || t.video_url,
                              };
                              if (onAddTrackToPlaylist) onAddTrackToPlaylist(targetPl.id, mapped);
                            }}
                            style={{
                              padding: "6px 12px", borderRadius: 8,
                              background: "color-mix(in srgb, var(--text) 6%, transparent)", color: "var(--text)",
                              border: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
                              fontSize: 11, fontWeight: 600, cursor: "pointer",
                            }}
                          >
                            + Playlist
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Curated Stations */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-3)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 14 }}>
              Featured Curated Playlists & Stations
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
              {(activeView === "provider-spotify"
                ? curated.featured.spotify
                : activeView === "provider-ytmusic"
                ? curated.featured.ytmusic
                : curated.featured.soundcloud
              ).map((card) => (
                <div
                  key={card.title}
                  style={{
                    padding: "18px", borderRadius: 16,
                    background: "color-mix(in srgb, var(--text) 3%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
                    display: "flex", flexDirection: "column", justifyContent: "space-between",
                    gap: 12,
                    transition: "all 0.2s ease",
                  }}
                >
                  <div>
                    <div style={{
                      display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                      background: card.color, marginBottom: 10,
                      boxShadow: `0 0 10px ${card.color}`,
                    }} />
                    <h4 style={{ fontSize: 15, fontWeight: 800, color: "var(--text)", margin: "0 0 6px 0" }}>
                      {card.title}
                    </h4>
                    <p style={{ fontSize: 11, color: "var(--text-2)", margin: 0, lineHeight: 1.4 }}>
                      {card.desc}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button
                      onClick={() => {
                        onNavigate("discover");
                        handleLoadPlaylist(card.url);
                      }}
                      style={{
                        flex: 1, padding: "8px 12px", borderRadius: 10,
                        background: `${card.color}25`,
                        border: `1px solid ${card.color}60`,
                        color: "var(--text)", fontSize: 11, fontWeight: 700, cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                      }}
                    >
                      ▶ Stream / Explore
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Featured Playlists Grid */}
      {!activePlaylist && activeView === "home" && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text-3)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 14 }}>
            Featured Playlists
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 14 }}>
            {playlists.map((pl) => {
              const isHovered = hoveredPlaylist === pl.id;
              const color = PLATFORM_COLORS[pl.source];
              return (
                <div
                  key={pl.id}
                  onClick={() => onNavigate(pl.id)}
                  onMouseEnter={() => setHoveredPlaylist(pl.id)}
                  onMouseLeave={() => setHoveredPlaylist(null)}
                  style={{
                    padding: "16px", borderRadius: 16,
                    background: isHovered ? "color-mix(in srgb, var(--text) 7%, transparent)" : "color-mix(in srgb, var(--text) 3%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                    transform: isHovered ? "translateY(-2px) scale(1.02)" : "none",
                    boxShadow: isHovered ? "0 8px 24px rgba(0,0,0,0.3)" : "none",
                  }}
                >
                  <div style={{
                    width: 38, height: 38, borderRadius: 10, marginBottom: 14,
                    background: `${color}18`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color,
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M9 18V5l12-2v13" />
                      <circle cx="6" cy="18" r="3" />
                      <circle cx="18" cy="16" r="3" />
                    </svg>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {pl.name}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-3)", fontWeight: 600 }}>
                    {pl.count} {pl.count === 1 ? "song" : "songs"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Downloads View */}
      {activeView === "downloads" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          {/* Status dashboard & URL Downloader */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1.2fr 1fr",
            gap: 24,
            width: "100%",
          }} className="download-grid-container">
            {/* Download Panel */}
            <div style={{
              padding: "24px 28px", borderRadius: 20,
              background: "color-mix(in srgb, var(--surface) 90%, transparent)",
              
              border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}>

              <div style={{ fontSize: 10, fontWeight: 800, color: "var(--accent)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
                Downloader
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 900, color: "var(--text)", margin: 0 }}>Paste URL to Download</h3>
              <p style={{ fontSize: 11, color: "var(--text-2)", margin: "0 0 8px 0", lineHeight: 1.4 }}>
                Supports Spotify tracks, YouTube videos/playlists. Preview before you download!
              </p>
              
              <form onSubmit={handleDownload} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <input
                  type="text"
                  placeholder="https://open.spotify.com/track/... or YouTube link"
                  value={downloadUrl}
                  onChange={(e) => { setDownloadUrl(e.target.value); setPreviewInfo(null); stopPreview(); }}
                  disabled={isDownloading}
                  style={{
                    width: "100%", padding: "12px 14px",
                    borderRadius: 12,
                    background: "color-mix(in srgb, var(--text) 4%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                    color: "var(--text)", fontSize: 12, fontWeight: 500,
                    outline: "none", boxSizing: "border-box",
                  }}
                />
                
                {/* Action Buttons Row */}
                <div style={{ display: "flex", gap: 10 }}>
                  {/* Preview Button */}
                  <button
                    type="button"
                    onClick={handlePreview}
                    disabled={previewLoading || isDownloading || !downloadUrl.trim()}
                    style={{
                      flex: 1, padding: "12px", borderRadius: 12,
                      background: previewLoading ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "color-mix(in srgb, var(--accent) 12%, transparent)",
                      color: "var(--accent)",
                      border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
                      fontSize: 12, fontWeight: 800,
                      cursor: previewLoading || isDownloading || !downloadUrl.trim() ? "not-allowed" : "pointer",
                      letterSpacing: "0.04em", textTransform: "uppercase",
                      boxShadow: downloadUrl.trim() && !previewLoading ? "0 4px 16px color-mix(in srgb, var(--accent) 15%, transparent)" : "none",
                      transition: "all 0.15s ease",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    }}
                  >
                    {previewLoading ? (
                      <>
                        <div className="animate-spin-slow" style={{ width: 12, height: 12, border: "2px solid var(--accent)", borderTopColor: "transparent", borderRadius: "50%" }} />
                        Fetching...
                      </>
                    ) : (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <circle cx="12" cy="12" r="10" />
                          <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
                        </svg>
                        Preview
                      </>
                    )}
                  </button>

                  {/* Download Button */}
                  <button
                    type="submit"
                    disabled={isDownloading || !downloadUrl.trim()}
                    style={{
                      flex: 1.4, padding: "12px", borderRadius: 12,
                      background: isDownloading ? "color-mix(in srgb, var(--accent) 30%, transparent)" : "var(--accent)",
                      color: "var(--accent-fg)", border: "none", fontSize: 12, fontWeight: 800,
                      cursor: isDownloading || !downloadUrl.trim() ? "not-allowed" : "pointer",
                      letterSpacing: "0.06em", textTransform: "uppercase",
                      boxShadow: !isDownloading && downloadUrl.trim() ? "0 4px 20px color-mix(in srgb, var(--accent) 40%, transparent)" : "none",
                      transition: "all 0.15s ease",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    }}
                  >
                    {isDownloading ? (
                      <>
                        <div className="animate-spin-slow" style={{ width: 12, height: 12, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%" }} />
                        Downloading...
                      </>
                    ) : (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Download MP3
                      </>
                    )}
                  </button>
                  {isDownloading && (
                    <button type="button" onClick={cancelAllDownloads}
                      style={{ padding: "0 14px", borderRadius: 12, border: "1px solid rgba(239,68,68,0.4)", background: "transparent", color: "#EF4444", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                      Cancel
                    </button>
                  )}
                </div>
              </form>

              {/* Recently Entered Links */}
              {urlHistory.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: "var(--text-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                      Recent Links
                    </span>
                    <button
                      type="button"
                      onClick={clearHistory}
                      style={{
                        background: "none", border: "none", color: "var(--accent)", fontSize: 9, fontWeight: 700, cursor: "pointer", padding: 0
                      }}
                    >
                      Clear
                    </button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 85, overflowY: "auto", paddingRight: 4 }}>
                    {urlHistory.map((hUrl, hIdx) => (
                      <div
                        key={hIdx}
                        onClick={() => {
                          if (!isDownloading) {
                            setDownloadUrl(hUrl);
                            setPreviewInfo(null);
                            stopPreview();
                          }
                        }}
                        style={{
                          fontSize: 10.5,
                          color: "var(--text-2)",
                          cursor: isDownloading ? "not-allowed" : "pointer",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          background: "color-mix(in srgb, var(--text) 2%, transparent)",
                          padding: "5px 9px",
                          borderRadius: 8,
                          border: "1px solid color-mix(in srgb, var(--text) 4%, transparent)",
                          transition: "all 0.15s ease",
                        }}
                        onMouseEnter={(e) => {
                          if (!isDownloading) {
                            e.currentTarget.style.color = "var(--text)";
                            e.currentTarget.style.background = "color-mix(in srgb, var(--text) 5%, transparent)";
                          }
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.color = "var(--text-2)";
                          e.currentTarget.style.background = "color-mix(in srgb, var(--text) 2%, transparent)";
                        }}
                      >
                        {hUrl}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Preview Card */}
              {previewInfo && (
                <div style={{
                  borderRadius: 16,
                  background: "color-mix(in srgb, var(--text) 3%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                  overflow: "hidden",
                  animation: "fade-in 0.3s ease",
                }}>
                  {/* Thumbnail Banner */}
                  <div style={{
                    position: "relative",
                    height: 120,
                    backgroundImage: `url(${previewInfo.thumbnail})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    overflow: "hidden",
                  }}>
                    {/* Gradient overlay */}
                    <div style={{
                      position: "absolute", inset: 0,
                      background: "linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, var(--bg) 100%)",
                    }} />

                    {/* Play/Pause overlay button */}
                    <button
                      onClick={togglePreviewPlayback}
                      style={{
                        position: "absolute",
                        top: "50%", left: "50%",
                        transform: "translate(-50%, -50%)",
                        width: 48, height: 48, borderRadius: "50%",
                        background: isPreviewing ? "color-mix(in srgb, var(--accent) 85%, transparent)" : "color-mix(in srgb, var(--text) 85%, transparent)",
                        border: "none",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        cursor: "pointer",
                        boxShadow: `0 0 20px ${isPreviewing ? "color-mix(in srgb, var(--accent) 50%, transparent)" : "color-mix(in srgb, var(--text) 30%, transparent)"}`,
                        transition: "all 0.2s ease",
                        color: "var(--bg)",
                      }}
                    >
                      {isPreviewing ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 2 }}>
                          <polygon points="6,3 20,12 6,21" />
                        </svg>
                      )}
                    </button>

                    {/* Live badge */}
                    {isPreviewing && (
                      <div style={{
                        position: "absolute", top: 10, right: 10,
                        background: "var(--accent)", color: "var(--accent-fg)",
                        fontSize: 9, fontWeight: 900, padding: "3px 8px",
                        borderRadius: 4, letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        boxShadow: "0 0 10px color-mix(in srgb, var(--accent) 50%, transparent)",
                      }}>
                        ◉ LIVE
                      </div>
                    )}
                  </div>

                  {/* Info Row */}
                  <div style={{
                    padding: "12px 16px",
                    display: "flex", alignItems: "center",
                    justifyContent: "space-between", gap: 12,
                  }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 800, color: "var(--text)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        marginBottom: 3,
                      }}>
                        {previewInfo.title}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-2)", fontWeight: 600 }}>
                        {previewInfo.artist}
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      {/* Open in YouTube link */}
                      <a
                        href={previewInfo.video_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "flex", alignItems: "center", gap: 5,
                          padding: "6px 12px", borderRadius: 8,
                          background: "rgba(255,0,0,0.1)",
                          border: "1px solid rgba(255,0,0,0.2)",
                          color: "#FF4545", fontSize: 10, fontWeight: 800,
                          textDecoration: "none",
                          letterSpacing: "0.05em",
                          transition: "all 0.15s ease",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                        </svg>
                        YouTube
                      </a>

                      {/* Stop Preview */}
                      <button
                        onClick={stopPreview}
                        style={{
                          padding: "6px 10px", borderRadius: 8,
                          background: "color-mix(in srgb, var(--text) 5%, transparent)",
                          border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                          color: "var(--text-3)",
                          cursor: "pointer",
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}
                        title="Close preview"
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Preview error */}
              {previewError && (
                <div style={{
                  padding: 12, borderRadius: 10,
                  background: "rgba(239,68,68,0.07)",
                  border: "1px solid rgba(239,68,68,0.15)",
                  fontSize: 11, color: "#EF4444",
                }}>
                  <span style={{ fontWeight: "bold" }}>Preview Error: </span>{previewError}
                </div>
              )}

              {/* Status and Progress log */}
              {(downloadStatus || downloadError) && (
                <div style={{
                  padding: 12, borderRadius: 10,
                  background: downloadError ? "rgba(239,68,68,0.07)" : "color-mix(in srgb, var(--text) 2%, transparent)",
                  border: `1px solid ${downloadError ? "rgba(239,68,68,0.15)" : "color-mix(in srgb, var(--text) 6%, transparent)"}`,
                  fontSize: 11,
                  fontFamily: "monospace",
                  wordBreak: "break-all",
                  color: downloadError ? "#EF4444" : "var(--text-2)",
                }}>
                  {downloadError ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontWeight: "bold" }}>Error:</span>
                      <span>{downloadError}</span>
                    </div>
                  ) : (
                    downloadStatus
                  )}
                </div>
              )}
            </div>

            {/* Dashboard / Info panel */}
            <div style={{
              padding: "24px 28px", borderRadius: 20,
              background: "color-mix(in srgb, var(--surface) 90%, transparent)",
              
              border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              gap: 16,
            }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: "var(--accent)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 16 }}>
                  System Status
                </div>
                
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, color: "var(--text-2)", fontWeight: 600 }}>yt-dlp (YouTube engine)</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{
                        width: 7, height: 7, borderRadius: "50%",
                        background: ytdlpStatus && ytdlpStatus !== "not_found" ? "#1DB954" : "#EF4444",
                        boxShadow: `0 0 8px ${ytdlpStatus && ytdlpStatus !== "not_found" ? "#1DB954" : "#EF4444"}`,
                      }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>
                        {ytdlpStatus === null ? "Checking..." : ytdlpStatus === "not_found" ? "Not Installed" : ytdlpStatus}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, color: "var(--text-2)", fontWeight: 600 }}>spotdl (Spotify engine)</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{
                        width: 7, height: 7, borderRadius: "50%",
                        background: spotdlStatus && spotdlStatus !== "not_found" ? "#1DB954" : "#EF4444",
                        boxShadow: `0 0 8px ${spotdlStatus && spotdlStatus !== "not_found" ? "#1DB954" : "#EF4444"}`,
                      }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>
                        {spotdlStatus === null ? "Checking..." : spotdlStatus === "not_found" ? "Not Installed" : spotdlStatus}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, color: "var(--text-2)", fontWeight: 600 }}>ffmpeg (audio codec)</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{
                        width: 7, height: 7, borderRadius: "50%",
                        background: ffmpegStatus && ffmpegStatus !== "not_found" ? "#1DB954" : "#EF4444",
                        boxShadow: `0 0 8px ${ffmpegStatus && ffmpegStatus !== "not_found" ? "#1DB954" : "#EF4444"}`,
                      }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>
                        {ffmpegStatus === null ? "Checking..." : ffmpegStatus === "not_found" ? "Not Installed" : "Installed"}
                      </span>
                    </div>
                  </div>

                  <div style={{ height: 1, background: "color-mix(in srgb, var(--text) 5%, transparent)", margin: "4px 0" }} />

                  <div>
                    <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 800, textTransform: "uppercase", display: "block", marginBottom: 4 }}>
                      Download Folder
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text)", fontFamily: "monospace", wordBreak: "break-all" }}>
                      {downloadDir || "Resolving directory..."}
                    </span>
                  </div>
                </div>
              </div>

              <button
                onClick={handleScan}
                style={{
                  padding: "10px", borderRadius: 10,
                  background: "color-mix(in srgb, var(--text) 5%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                  color: "var(--text)", fontSize: 11, fontWeight: 700,
                  cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  transition: "all 0.15s ease",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Scan Folder For Local Audio
              </button>
            </div>
          </div>

          {/* Local Scanned Tracks list */}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text-3)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
                Scanned Offline Tracks
              </div>
              <span style={{ fontSize: 10, color: "var(--text-2)", fontWeight: 600 }}>
                {localTracks.length} {localTracks.length === 1 ? "track" : "tracks"}
              </span>
            </div>

            {localTracks.length === 0 ? (
              <div style={{
                padding: "40px", textAlign: "center",
                border: "1px dashed color-mix(in srgb, var(--text) 7%, transparent)", borderRadius: 16,
              }}>
                <p style={{ color: "var(--text-3)", fontSize: 13, fontWeight: 500, margin: "0 0 4px 0" }}>No offline tracks found</p>
                <p style={{ color: "#3E4150", fontSize: 11, fontWeight: 500, margin: 0 }}>
                  Paste a link above to download, or make sure your audio files are inside the MG-Lyrics folder.
                </p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {localTracks.map((track, idx) => {
                  const isCurrent = currentTrack?.id === track.id;
                  const isHovered = hoveredTrack === track.id;
                  return (
                    <div
                      key={track.id}
                      onClick={() => onSelectTrack(track)}
                      onMouseEnter={() => setHoveredTrack(track.id)}
                      onMouseLeave={() => setHoveredTrack(null)}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "10px 14px", borderRadius: 14,
                        background: isCurrent
                          ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                          : isHovered ? "color-mix(in srgb, var(--text) 5%, transparent)" : "transparent",
                        border: `1px solid ${isCurrent ? "color-mix(in srgb, var(--accent) 30%, transparent)" : "transparent"}`,
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0, flex: 1 }}>
                        <span style={{ width: 20, textAlign: "center", fontSize: 11, fontWeight: 700, color: "var(--text-3)", flexShrink: 0 }}>
                          {isCurrent && isPlaying ? (
                            <span style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: 14, justifyContent: "center" }}>
                              {[1, 2, 3].map((i) => (
                                <span key={i} style={{
                                  display: "block", width: 3, borderRadius: 2,
                                  background: "var(--accent)",
                                  animation: `eq-bar ${0.5 + i * 0.15}s ease-in-out infinite`,
                                  height: `${4 + i * 3}px`,
                                }} />
                              ))}
                            </span>
                          ) : (
                            idx + 1
                          )}
                        </span>

                        <div style={{
                          width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                          backgroundImage: `url(${track.cover})`,
                          backgroundSize: "cover", backgroundPosition: "center",
                          border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
                          boxShadow: isCurrent ? "0 0 12px color-mix(in srgb, var(--accent) 30%, transparent)" : "none",
                        }} />

                        <div style={{ minWidth: 0 }}>
                          <div style={{
                            fontSize: 13, fontWeight: 700,
                            color: isCurrent ? "var(--accent)" : "var(--text)",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            marginBottom: 2,
                          }}>
                            {track.title}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-2)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {track.artist}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 24, flexShrink: 0, paddingLeft: 16 }}>
                        <span style={{ fontSize: 10, color: "var(--text-3)", background: "color-mix(in srgb, var(--text) 5%, transparent)", padding: "2px 8px", borderRadius: 6, fontWeight: 700, textTransform: "uppercase" }}>
                          Local
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Discover View */}
      {activeView === "discover" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 28, animation: "fade-in 0.3s ease" }}>
          {/* Search & Fetch Playlists Section */}
          <div style={{
            padding: "24px 28px", borderRadius: 20,
            background: "color-mix(in srgb, var(--surface) 90%, transparent)",
            
            border: "1px solid color-mix(in srgb, var(--text) 7%, transparent)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "var(--accent)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
                Top Playlists & Live Explorer
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, color: "color-mix(in srgb, var(--text) 40%, transparent)" }}>
                36+ Curated Top Playlists · Live Spotify & YouTube Search
              </span>
            </div>

            <h3 style={{ fontSize: 17, fontWeight: 900, color: "var(--text)", margin: "0 0 6px 0" }}>
              Fetch & Stream All Spotify and YouTube Top Playlists
            </h3>
            <p style={{ fontSize: 11, color: "var(--text-2)", margin: "0 0 16px 0", lineHeight: 1.4 }}>
              Search across YouTube & Spotify for any top charts, playlists, and moods, or paste a direct public playlist link to load and stream instantly.
            </p>

            {/* Search Input Bar */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const raw = (onlinePlaylistQuery || discoverUrl).trim();
                if (!raw) return;
                const q = raw.replace(/^['"`<]+|['"`>]+$/g, '').trim();
                if (q.startsWith("http://") || q.startsWith("https://") || q.startsWith("spotify:")) {
                  handleLoadPlaylist(q);
                } else {
                  handleSearchOnlinePlaylists(q, onlinePlaylistProvider);
                }
              }}
              style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
            >
              {/* Provider selector */}
              <select
                value={onlinePlaylistProvider}
                onChange={(e) => {
                  const val = e.target.value as "all" | "spotify" | "youtube";
                  setOnlinePlaylistProvider(val);
                  if (onlinePlaylistQuery.trim()) {
                    handleSearchOnlinePlaylists(onlinePlaylistQuery.trim(), val);
                  }
                }}
                style={{
                  padding: "0 14px", height: "42px",
                  borderRadius: 12,
                  background: "color-mix(in srgb, var(--text) 6%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
                  color: "var(--text)", fontSize: 11.5, fontWeight: 700,
                  outline: "none", cursor: "pointer",
                }}
              >
                <option value="all" className="bg-[var(--bg)] text-[var(--text)]">All Providers</option>
                <option value="spotify" className="bg-[var(--bg)] text-[var(--text)]">Spotify</option>
                <option value="youtube" className="bg-[var(--bg)] text-[var(--text)]">YouTube</option>
              </select>

              {/* Text Input */}
              <input
                type="text"
                placeholder="Search playlists (e.g. Top 50, Today's Top Hits, RapCaviar, Lo-Fi) or paste URL..."
                value={onlinePlaylistQuery || discoverUrl}
                onChange={(e) => {
                  setOnlinePlaylistQuery(e.target.value);
                  setDiscoverUrl(e.target.value);
                }}
                disabled={isSearchingOnlinePlaylists || discoverLoading}
                style={{
                  flex: 1, minWidth: "220px", height: "42px", padding: "0 16px",
                  borderRadius: 12,
                  background: "color-mix(in srgb, var(--text) 4%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                  color: "var(--text)", fontSize: 12, fontWeight: 500,
                  outline: "none", boxSizing: "border-box",
                }}
              />

              {/* Fetch Playlists button */}
              <button
                type="submit"
                disabled={isSearchingOnlinePlaylists || discoverLoading || !(onlinePlaylistQuery || discoverUrl).trim()}
                style={{
                  padding: "0 20px", height: "42px", borderRadius: 12,
                  background: (isSearchingOnlinePlaylists || discoverLoading)
                    ? "color-mix(in srgb, var(--accent) 30%, transparent)"
                    : "var(--surface-2)",
                  color: "var(--text)", border: "none", fontSize: 12, fontWeight: 800,
                  cursor: (isSearchingOnlinePlaylists || discoverLoading) || !(onlinePlaylistQuery || discoverUrl).trim()
                    ? "not-allowed" : "pointer",
                  letterSpacing: "0.04em",
                  boxShadow: !(isSearchingOnlinePlaylists || discoverLoading) && (onlinePlaylistQuery || discoverUrl).trim()
                    ? "0 4px 18px color-mix(in srgb, var(--accent) 35%, transparent)" : "none",
                  transition: "all 0.15s ease",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                }}
              >
                {isSearchingOnlinePlaylists || discoverLoading ? (
                  <>
                    <div className="animate-spin-slow" style={{ width: 12, height: 12, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%" }} />
                    Searching...
                  </>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    Fetch Playlists
                  </>
                )}
              </button>

              {/* Refresh Live Button */}
              <button
                type="button"
                onClick={() => {
                  const liveMixes = [
                    "Today's Top Hits",
                    "Top 50 Global",
                    "Billboard Hot 100",
                    "New Music Friday",
                    "Global Viral Hits",
                    "RapCaviar",
                    "mint EDM Hits",
                    "Viva Latino",
                  ];
                  const pick = liveMixes[Math.floor(Math.random() * liveMixes.length)];
                  setOnlinePlaylistQuery(pick);
                  setDiscoverUrl(pick);
                  handleSearchOnlinePlaylists(pick, onlinePlaylistProvider);
                }}
                disabled={isSearchingOnlinePlaylists || discoverLoading}
                style={{
                  padding: "0 16px", height: "42px", borderRadius: 12,
                  background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
                  color: "var(--accent)", fontSize: 12, fontWeight: 800,
                  cursor: isSearchingOnlinePlaylists || discoverLoading ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                  transition: "all 0.15s ease",
                  boxShadow: "0 2px 10px color-mix(in srgb, var(--accent) 10%, transparent)",
                }}
                title="Shuffle & fetch fresh live trending tracks from Spotify & YouTube"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
                Refresh Live
              </button>
            </form>

            {/* Quick search preset chips */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "color-mix(in srgb, var(--text) 40%, transparent)" }}>Trending:</span>
              {[
                "Today's Top Hits",
                "Top 50 Global",
                "Billboard Hot 100",
                "New Music Friday",
                "Global Viral Hits",
                "RapCaviar",
                "mint EDM Hits",
                "Deep Focus",
                "Viva Latino",
                "All Out 80s",
              ].map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => {
                    setOnlinePlaylistQuery(chip);
                    setDiscoverUrl(chip);
                    handleSearchOnlinePlaylists(chip, onlinePlaylistProvider);
                  }}
                  style={{
                    padding: "4px 10px", borderRadius: 8,
                    background: "color-mix(in srgb, var(--text) 4%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                    color: "color-mix(in srgb, var(--text) 70%, transparent)", fontSize: 10.5, fontWeight: 600,
                    cursor: "pointer", transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "color-mix(in srgb, var(--accent) 18%, transparent)";
                    e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 40%, transparent)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "color-mix(in srgb, var(--text) 4%, transparent)";
                    e.currentTarget.style.borderColor = "color-mix(in srgb, var(--text) 8%, transparent)";
                    e.currentTarget.style.color = "color-mix(in srgb, var(--text) 70%, transparent)";
                  }}
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>

          {/* Error messages */}
          {(discoverError || onlinePlaylistError) && (
            <div style={{
              padding: 16, borderRadius: 14,
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.18)",
              color: "#EF4444", fontSize: 12,
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            }}>
              <span><strong>Error:</strong> {discoverError || onlinePlaylistError}</span>
              <button
                onClick={() => { setDiscoverError(""); setOnlinePlaylistError(""); }}
                style={{ background: "none", border: "none", color: "#EF4444", cursor: "pointer", display: "flex", alignItems: "center" }}
                title="Dismiss"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}

          {/* Live Online Playlist Search Results */}
          {!loadedPlaylist && !discoverLoading && onlinePlaylists.length > 0 && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
                  <span style={{ fontSize: 11, fontWeight: 800, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                    Online Playlist Search Results ({onlinePlaylists.length})
                  </span>
                </div>
                <button
                  onClick={() => setOnlinePlaylists([])}
                  style={{
                    padding: "4px 10px", borderRadius: 8,
                    background: "color-mix(in srgb, var(--text) 5%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
                    color: "color-mix(in srgb, var(--text) 60%, transparent)", fontSize: 10, fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Clear Results
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 18 }}>
                {onlinePlaylists.map((pl) => (
                  <div
                    key={pl.id}
                    onClick={() => { setDiscoverUrl(pl.url); handleLoadPlaylist(pl.url); }}
                    style={{
                      padding: "16px", borderRadius: 18,
                      background: "color-mix(in srgb, var(--text) 3%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--text) 7%, transparent)",
                      cursor: "pointer",
                      transition: "all 0.25s ease",
                      display: "flex", flexDirection: "column", gap: 12,
                      boxShadow: "0 4px 20px rgba(0,0,0,0.2)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = "translateY(-4px)";
                      e.currentTarget.style.background = "color-mix(in srgb, var(--text) 7%, transparent)";
                      e.currentTarget.style.borderColor = pl.source === "spotify" ? "rgba(29,185,84,0.4)" : "rgba(255,0,0,0.4)";
                      e.currentTarget.style.boxShadow = "0 12px 30px rgba(0,0,0,0.4)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "none";
                      e.currentTarget.style.background = "color-mix(in srgb, var(--text) 3%, transparent)";
                      e.currentTarget.style.borderColor = "color-mix(in srgb, var(--text) 7%, transparent)";
                      e.currentTarget.style.boxShadow = "0 4px 20px rgba(0,0,0,0.2)";
                    }}
                  >
                    {/* Thumbnail */}
                    <div style={{
                      width: "100%", height: 120, borderRadius: 12,
                      backgroundImage: pl.thumbnail ? `url(${pl.thumbnail})` : "none",
                      backgroundSize: "cover", backgroundPosition: "center",
                      background: !pl.thumbnail ? "var(--surface-2)" : undefined,
                      position: "relative", overflow: "hidden",
                    }}>
                      {/* Provider Badge */}
                      <span style={{
                        position: "absolute", top: 8, left: 8,
                        fontSize: 9, fontWeight: 900,
                        padding: "3px 8px", borderRadius: 6,
                        background: pl.source === "spotify" ? "rgba(29,185,84,0.9)" : "rgba(255,0,0,0.9)",
                        color: "var(--text)", letterSpacing: "0.08em", textTransform: "uppercase",
                      }}>
                        {pl.source === "spotify" ? "Spotify" : "YouTube"}
                      </span>
                      {pl.track_count && (
                        <span style={{
                          position: "absolute", bottom: 8, right: 8,
                          fontSize: 9, fontWeight: 800,
                          padding: "2px 7px", borderRadius: 5,
                          background: "rgba(0,0,0,0.75)",
                          color: "var(--text)",
                        }}>
                          {pl.track_count} tracks
                        </span>
                      )}
                    </div>

                    <div>
                      <h4 style={{
                        fontSize: 13.5, fontWeight: 800, color: "var(--text)",
                        margin: "0 0 4px 0",
                        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                      }}>
                        {pl.title}
                      </h4>
                      <p style={{ fontSize: 11, color: "var(--text-2)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        By {pl.uploader}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Curated Grid - only when no playlist is loaded */}
          {!loadedPlaylist && !discoverLoading && (
            <div>
              {/* Category Filter Tabs */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 9, fontWeight: 800, color: "var(--accent)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 4 }}>
                    Official Catalog
                  </div>
                  <h4 style={{ fontSize: 16, fontWeight: 800, color: "var(--text)", margin: 0 }}>
                    Top Curated Spotify & YouTube Playlists
                  </h4>
                </div>

                {/* Filter Pills */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {[
                    { id: "all", label: `All (${curated.catalog.length})` },
                    ...Object.keys(CATEGORY_LABELS)
                      .map((id) => ({ id, n: curated.catalog.filter((c) => c.category === id).length }))
                      .filter((c) => c.n > 0)
                      .map((c) => ({ id: c.id, label: `${CATEGORY_LABELS[c.id]} (${c.n})` })),
                  ].map((tab) => {
                    const isActive = playlistCategory === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setPlaylistCategory(tab.id)}
                        style={{
                          padding: "6px 12px", borderRadius: 10,
                          background: isActive ? "var(--accent)" : "color-mix(in srgb, var(--text) 4%, transparent)",
                          color: isActive ? "var(--accent-fg)" : "color-mix(in srgb, var(--text) 65%, transparent)",
                          border: `1px solid ${isActive ? "var(--accent)" : "color-mix(in srgb, var(--text) 7%, transparent)"}`,
                          fontSize: 11, fontWeight: 700,
                          cursor: "pointer", transition: "all 0.15s ease",
                          boxShadow: isActive ? "0 2px 10px color-mix(in srgb, var(--accent) 35%, transparent)" : "none",
                        }}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {curatedLoading && <div style={{ color: "#9FA2B4", fontSize: 12 }}>Loading curated playlists…</div>}
              {curatedError && <div style={{ color: "#f87171", fontSize: 12 }}>{curatedError}</div>}
              {/* Grid of Curated Playlists */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 18 }}>
                {curated.catalog
                  .filter((p) => playlistCategory === "all" || p.category === playlistCategory)
                  .map((cur) => (
                    <div
                      key={cur.id}
                      onClick={() => { setDiscoverUrl(cur.url); handleLoadPlaylist(cur.url); }}
                      style={{
                        padding: "18px", borderRadius: 18,
                        background: "color-mix(in srgb, var(--text) 3%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
                        cursor: "pointer",
                        transition: "all 0.25s ease",
                        display: "flex", flexDirection: "column", gap: 14,
                        boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
                        position: "relative",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = "translateY(-4px)";
                        e.currentTarget.style.background = "color-mix(in srgb, var(--text) 6%, transparent)";
                        e.currentTarget.style.borderColor = cur.provider === "spotify" ? "color-mix(in srgb, var(--accent) 30%, transparent)" : "rgba(255,0,0,0.35)";
                        e.currentTarget.style.boxShadow = "0 12px 30px rgba(0,0,0,0.3)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = "none";
                        e.currentTarget.style.background = "color-mix(in srgb, var(--text) 3%, transparent)";
                        e.currentTarget.style.borderColor = "color-mix(in srgb, var(--text) 6%, transparent)";
                        e.currentTarget.style.boxShadow = "0 4px 20px rgba(0,0,0,0.15)";
                      }}
                    >
                      {/* Gradient Artwork Card */}
                      <div style={{
                        width: "100%", height: 115, borderRadius: 12,
                        background: cur.gradient,
                        display: "flex", flexDirection: "column",
                        alignItems: "center", justifyContent: "center",
                        color: "var(--text)", position: "relative",
                        boxShadow: "inset 0 0 20px rgba(0,0,0,0.25)",
                      }}>
                        {/* Provider tag */}
                        <span style={{
                          position: "absolute", top: 8, left: 8,
                          fontSize: 9, fontWeight: 900,
                          padding: "2px 7px", borderRadius: 5,
                          background: cur.provider === "spotify" ? "rgba(29,185,84,0.9)" : "rgba(255,0,0,0.9)",
                          color: "var(--text)", letterSpacing: "0.08em", textTransform: "uppercase",
                        }}>
                          {cur.provider === "spotify" ? "Spotify" : "YouTube"}
                        </span>

                        {/* Badge tag */}
                        <span style={{
                          position: "absolute", bottom: 8, right: 8,
                          fontSize: 9, fontWeight: 800,
                          padding: "2px 6px", borderRadius: 5,
                          background: "rgba(0,0,0,0.6)",
                          color: "var(--text)",
                        }}>
                          {cur.badge}
                        </span>

                        <div style={{ fontSize: 32, fontWeight: 900, opacity: 0.9 }}>
                          {cur.title.charAt(0)}
                        </div>
                      </div>

                      <div>
                        <h4 style={{ fontSize: 14, fontWeight: 800, color: "var(--text)", marginBottom: 6, lineHeight: 1.25 }}>
                          {cur.title}
                        </h4>
                        <p style={{
                          fontSize: 11, color: "var(--text-2)", lineHeight: 1.4, margin: 0,
                          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                        }}>
                          {cur.desc}
                        </p>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Loading Skeleton/State */}
          {discoverLoading && (
            <div style={{
              padding: "60px 40px", textAlign: "center",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 18,
              border: "1px dashed color-mix(in srgb, var(--text) 7%, transparent)", borderRadius: 20,
            }}>
              <div className="animate-spin-slow" style={{
                width: 38, height: 38,
                border: "3px solid var(--accent)",
                borderTopColor: "transparent",
                borderRadius: "50%",
                boxShadow: "0 0 15px color-mix(in srgb, var(--accent) 30%, transparent)",
              }} />
              <div>
                <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 700, margin: "0 0 4px 0" }}>Fetching Playlist Information</p>
                <p style={{ color: "var(--text-3)", fontSize: 11, margin: 0 }}>Parsing tracks and metadata from playlist provider. This may take a moment...</p>
              </div>
            </div>
          )}

          {/* Loaded Playlist Track View */}
          {loadedPlaylist && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              {/* Playlist banner */}
              <div style={{
                display: "flex", alignItems: "center", gap: 24,
                padding: "24px", borderRadius: 20,
                background: "color-mix(in srgb, var(--surface) 90%, transparent)",
                
                border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
                boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
                position: "relative",
              }} className="playlist-detail-banner">
                {/* Cover art / thumbnail */}
                <div style={{
                  width: 110, height: 110, borderRadius: 14,
                  flexShrink: 0,
                  backgroundImage: loadedPlaylist.thumbnail ? `url(${loadedPlaylist.thumbnail})` : "none",
                  backgroundSize: "cover", backgroundPosition: "center",
                  background: !loadedPlaylist.thumbnail ? "var(--surface-2)" : undefined,
                  border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: loadedPlaylist.thumbnail ? 0 : 36, fontWeight: 900, color: "var(--text)",
                }}>
                  {!loadedPlaylist.thumbnail && loadedPlaylist.title.charAt(0).toUpperCase()}
                </div>

                {/* Metadata details */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{
                      fontSize: 9, fontWeight: 900,
                      color: (loadedPlaylist.source === "spotify" || loadedPlaylist.uploader === "Spotify") ? "#1DB954" : "#FF0000",
                      letterSpacing: "0.12em", textTransform: "uppercase",
                      background: (loadedPlaylist.source === "spotify" || loadedPlaylist.uploader === "Spotify") ? "rgba(29,185,84,0.12)" : "rgba(255,0,0,0.12)",
                      padding: "2px 8px", borderRadius: 6,
                    }}>
                      {(loadedPlaylist.source === "spotify" || loadedPlaylist.uploader === "Spotify") ? "Spotify" : "YouTube"}
                    </span>
                    <span style={{ fontSize: 9, fontWeight: 800, color: "var(--text-2)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                      Public Playlist
                    </span>
                  </div>
                  <h3 style={{ fontSize: 20, fontWeight: 900, color: "var(--text)", margin: "4px 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {loadedPlaylist.title}
                  </h3>
                  <p style={{ fontSize: 11, color: "var(--text-2)", fontWeight: 500, margin: "0 0 12px 0" }}>
                    Curator: <span style={{ color: "var(--text)", fontWeight: 700 }}>{loadedPlaylist.uploader}</span> · {loadedPlaylist.tracks.length} tracks
                  </p>
                  {loadedPlaylist.description && (
                    <p style={{
                      fontSize: 10.5, color: "var(--text-3)", lineHeight: 1.4, margin: "0 0 14px 0",
                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                    }}>
                      {loadedPlaylist.description}
                    </p>
                  )}
                  
                  {/* Action buttons */}
                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      onClick={() => setLoadedPlaylist(null)}
                      style={{
                        padding: "8px 16px", borderRadius: 10,
                        background: "color-mix(in srgb, var(--text) 4%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                        color: "var(--text-2)", fontSize: 11, fontWeight: 700,
                        cursor: "pointer", transition: "all 0.15s ease",
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.color = "var(--text)"}
                      onMouseLeave={(e) => e.currentTarget.style.color = "var(--text-2)"}
                    >
                      ← Back to Playlists
                    </button>
                    <button
                      onClick={handlePlayAllTracks}
                      style={{
                        padding: "8px 18px", borderRadius: 10,
                        background: "var(--surface-2)", color: "var(--text)",
                        border: "none", fontSize: 11, fontWeight: 800,
                        cursor: "pointer", boxShadow: "0 4px 16px color-mix(in srgb, var(--accent) 30%, transparent)",
                        transition: "all 0.15s ease",
                        display: "flex", alignItems: "center", gap: 6,
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.transform = "scale(1.02)"}
                      onMouseLeave={(e) => e.currentTarget.style.transform = "none"}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      Play All ({loadedPlaylist.tracks.length})
                    </button>
                    <button
                      onClick={handleImportPlaylist}
                      style={{
                        padding: "8px 18px", borderRadius: 10,
                        background: "var(--accent)", color: "var(--accent-fg)",
                        border: "none", fontSize: 11, fontWeight: 800,
                        cursor: "pointer", boxShadow: "0 4px 16px color-mix(in srgb, var(--accent) 30%, transparent)",
                        transition: "all 0.15s ease",
                        display: "flex", alignItems: "center", gap: 6,
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.transform = "scale(1.02)"}
                      onMouseLeave={(e) => e.currentTarget.style.transform = "none"}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      Import to Library
                    </button>
                  </div>
                </div>
              </div>

              {/* Track list */}
              <div>
                <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text-3)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 12 }}>
                  Playlist Songs
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {loadedPlaylist.tracks.map((track, idx) => {
                    const isPreviewPlaying = previewingTrackId === track.id && isPreviewing;
                    const isTrackPreviewLoading = previewingTrackId === track.id && previewLoading;
                    const downloadState = downloadingTracks[track.id] || { status: "idle" };

                    return (
                      <div
                        key={track.id}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "10px 14px", borderRadius: 14,
                          background: isPreviewPlaying
                            ? "color-mix(in srgb, var(--accent) 6%, transparent)"
                            : "color-mix(in srgb, var(--text) 2%, transparent)",
                          border: `1px solid ${isPreviewPlaying ? "color-mix(in srgb, var(--accent) 20%, transparent)" : "transparent"}`,
                          transition: "all 0.15s ease",
                        }}
                        onMouseEnter={(e) => {
                          if (!isPreviewPlaying) {
                            e.currentTarget.style.background = "color-mix(in srgb, var(--text) 4%, transparent)";
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isPreviewPlaying) {
                            e.currentTarget.style.background = "color-mix(in srgb, var(--text) 2%, transparent)";
                          }
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0, flex: 1 }}>
                          {/* Track number / Preview playing indicator */}
                          <span style={{ width: 20, textAlign: "center", fontSize: 11, fontWeight: 700, color: "var(--text-3)", flexShrink: 0 }}>
                            {isPreviewPlaying ? (
                              <span style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: 14, justifyContent: "center" }}>
                                {[1, 2, 3].map((i) => (
                                  <span key={i} style={{
                                    display: "block", width: 3, borderRadius: 2,
                                    background: "var(--accent)",
                                    animation: `eq-bar ${0.5 + i * 0.15}s ease-in-out infinite`,
                                    height: `${4 + i * 3}px`,
                                  }} />
                                ))}
                              </span>
                            ) : (
                              idx + 1
                            )}
                          </span>

                          {/* Cover placeholder */}
                          <div style={{
                            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                            background: "var(--surface-2)",
                            border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 14, fontWeight: 900, color: "var(--text-3)",
                          }}>
                            {track.title.charAt(0).toUpperCase()}
                          </div>

                          {/* Title & Artist */}
                          <div style={{ minWidth: 0 }}>
                            <div style={{
                              fontSize: 13, fontWeight: 700,
                              color: isPreviewPlaying ? "var(--accent)" : "var(--text)",
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              marginBottom: 2,
                            }}>
                              {track.title}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--text-2)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {track.artist}
                            </div>
                          </div>
                        </div>

                        {/* Right side: Duration + Action buttons */}
                        <div style={{ display: "flex", alignItems: "center", gap: 24, flexShrink: 0, paddingLeft: 16 }}>
                          <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                            {formatDuration(track.duration)}
                          </span>
                          
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            {/* Preview playback button */}
                            <button
                              onClick={() => handlePlaylistTrackPreview(track)}
                              disabled={isTrackPreviewLoading}
                              style={{
                                width: 28, height: 28, borderRadius: "50%",
                                background: isPreviewPlaying ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "color-mix(in srgb, var(--text) 5%, transparent)",
                                border: `1px solid ${isPreviewPlaying ? "color-mix(in srgb, var(--accent) 30%, transparent)" : "color-mix(in srgb, var(--text) 8%, transparent)"}`,
                                color: isPreviewPlaying ? "var(--accent)" : "var(--text)",
                                display: "flex", alignItems: "center", justifyContent: "center",
                                cursor: isTrackPreviewLoading ? "not-allowed" : "pointer",
                                transition: "all 0.15s ease",
                              }}
                              title="Preview Song"
                            >
                              {isTrackPreviewLoading ? (
                                <div className="animate-spin-slow" style={{ width: 10, height: 10, border: "1.5px solid var(--accent)", borderTopColor: "transparent", borderRadius: "50%" }} />
                              ) : isPreviewPlaying ? (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                                  <rect x="6" y="4" width="4" height="16" rx="1" />
                                  <rect x="14" y="4" width="4" height="16" rx="1" />
                                </svg>
                              ) : (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 1 }}>
                                  <polygon points="6,3 20,12 6,21" />
                                </svg>
                              )}
                            </button>

                            {/* Download button */}
                            <button
                              onClick={() => handlePlaylistTrackDownload(track)}
                              disabled={downloadState.status === "loading" || downloadState.status === "success"}
                              style={{
                                width: 28, height: 28, borderRadius: "50%",
                                background: downloadState.status === "success"
                                  ? "rgba(29,185,84,0.15)"
                                  : downloadState.status === "loading"
                                  ? "color-mix(in srgb, var(--accent) 15%, transparent)"
                                  : downloadState.status === "error"
                                  ? "rgba(239,68,68,0.15)"
                                  : "color-mix(in srgb, var(--text) 5%, transparent)",
                                border: `1px solid ${
                                  downloadState.status === "success"
                                    ? "color-mix(in srgb, var(--accent) 30%, transparent)"
                                    : downloadState.status === "loading"
                                    ? "color-mix(in srgb, var(--accent) 30%, transparent)"
                                    : downloadState.status === "error"
                                    ? "rgba(239,68,68,0.3)"
                                    : "color-mix(in srgb, var(--text) 8%, transparent)"
                                }`,
                                color: downloadState.status === "success"
                                  ? "#1DB954"
                                  : downloadState.status === "loading"
                                  ? "var(--accent)"
                                  : downloadState.status === "error"
                                  ? "#EF4444"
                                  : "var(--text-2)",
                                display: "flex", alignItems: "center", justifyContent: "center",
                                cursor: downloadState.status === "loading" || downloadState.status === "success" ? "not-allowed" : "pointer",
                                transition: "all 0.15s ease",
                              }}
                              title={
                                downloadState.status === "success"
                                  ? "Downloaded"
                                  : downloadState.status === "loading"
                                  ? (dlPercent[track.id] != null ? `Downloading ${Math.round(dlPercent[track.id])}%` : "Queued / downloading...")
                                  : downloadState.status === "error"
                                  ? `Failed: ${downloadState.error}`
                                  : "Download Track"
                              }
                            >
                              {downloadState.status === "loading" ? (
                                <div className="animate-spin-slow" style={{ width: 10, height: 10, border: "1.5px solid var(--accent)", borderTopColor: "transparent", borderRadius: "50%" }} />
                              ) : downloadState.status === "success" ? (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              ) : downloadState.status === "error" ? (
                                <span style={{ fontSize: 10, fontWeight: 900 }}>!</span>
                              ) : (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                  <polyline points="7 10 12 15 17 10" />
                                  <line x1="12" y1="15" x2="12" y2="3" />
                                </svg>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Active Playlist Add Songs & Auto-Populate Panel */}
      {activePlaylist && (showAddSongsPanel || displayedTracks.length === 0) && (
        <div style={{
          padding: "24px", borderRadius: 18, marginBottom: 24,
          background: "color-mix(in srgb, var(--surface) 90%, transparent)",
          border: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 800, color: "var(--text)", margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "var(--accent)" }}>+</span> Add Songs to {activePlaylist.name}
              </h3>
              <p style={{ fontSize: 12, color: "var(--text-2)", margin: "4px 0 0 0" }}>
                Search for songs, import from playlist URL, or auto-populate tracks.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {displayedTracks.length === 0 && (
                <button
                  onClick={() => handleAutoPopulatePlaylist(activePlaylist)}
                  disabled={isAutoPopulating}
                  style={{
                    padding: "7px 14px", borderRadius: 10,
                    background: "color-mix(in srgb, var(--accent) 15%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                    color: "var(--accent)", fontSize: 11, fontWeight: 700,
                    cursor: isAutoPopulating ? "not-allowed" : "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                >
                  {isAutoPopulating ? (
                    <>
                      <div style={{ width: 12, height: 12, border: "2px solid var(--accent)", borderTopColor: "transparent", borderRadius: "50%", animation: "spin-slow 1s linear infinite" }} />
                      Populating...
                    </>
                  ) : (
                    <>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                      <span>Auto-fill Tracks for "{activePlaylist.name}"</span>
                    </>
                  )}
                </button>
              )}
              {displayedTracks.length > 0 && (
                <button
                  onClick={() => setShowAddSongsPanel(false)}
                  style={{
                    background: "color-mix(in srgb, var(--text) 6%, transparent)", border: "none", color: "var(--text-2)",
                    padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  Done Adding
                </button>
              )}
            </div>
          </div>

          {/* Search input to add songs */}
          <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
            <div style={{ position: "relative", flex: 1 }}>
              <input
                type="text"
                placeholder={`Search song title or artist to add to ${activePlaylist.name}...`}
                value={playlistSearchQuery}
                onChange={(e) => setPlaylistSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearchForPlaylist(playlistSearchQuery);
                }}
                style={{
                  width: "100%", padding: "10px 14px 10px 38px",
                  borderRadius: 12,
                  background: "color-mix(in srgb, var(--text) 4%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                  color: "var(--text)", fontSize: 12, outline: "none", boxSizing: "border-box",
                }}
              />
              <svg style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text-3)" }} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
            <button
              onClick={() => handleSearchForPlaylist(playlistSearchQuery)}
              disabled={isSearchingPlaylist || !playlistSearchQuery.trim()}
              style={{
                padding: "0 18px", borderRadius: 12,
                background: "var(--accent)", color: "var(--accent-fg)",
                border: "none", fontSize: 12, fontWeight: 700,
                cursor: isSearchingPlaylist ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              {isSearchingPlaylist ? "Searching..." : "Search"}
            </button>
          </div>

          {/* URL Import row */}
          <div style={{
            display: "flex", gap: 10, padding: 10, borderRadius: 12,
            background: "color-mix(in srgb, var(--text) 2%, transparent)",
            border: "1px dashed color-mix(in srgb, var(--text) 8%, transparent)",
            marginBottom: playlistSearchResults.length > 0 ? 14 : 0,
          }}>
            <input
              type="text"
              placeholder="Or paste public Spotify / YouTube / SoundCloud playlist URL to import all tracks..."
              value={playlistUrlInput}
              onChange={(e) => setPlaylistUrlInput(e.target.value)}
              style={{
                flex: 1, padding: "8px 12px", borderRadius: 8,
                background: "color-mix(in srgb, var(--text) 3%, transparent)",
                border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
                color: "var(--text)", fontSize: 11, outline: "none",
              }}
            />
            <button
              onClick={() => handleImportUrlIntoActivePlaylist(playlistUrlInput)}
              disabled={isImportingUrl || !playlistUrlInput.trim()}
              style={{
                padding: "8px 14px", borderRadius: 8,
                background: "#1DB954", color: "var(--text)", border: "none",
                fontSize: 11, fontWeight: 800, cursor: isImportingUrl ? "not-allowed" : "pointer",
              }}
            >
              {isImportingUrl ? "Importing..." : "Import Playlist"}
            </button>
          </div>

          {playlistImportError && (
            <p style={{ color: "#EF4444", fontSize: 11, margin: "8px 0 0 0" }}>{playlistImportError}</p>
          )}

          {/* Search results */}
          {playlistSearchResults.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                Matching Tracks ({playlistSearchResults.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto" }}>
                {playlistSearchResults.map((t) => {
                  const isAdded = addedTrackMap[t.id];
                  return (
                    <div
                      key={t.id}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "8px 12px", borderRadius: 10,
                        background: "color-mix(in srgb, var(--text) 3%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                        {t.thumbnail ? (
                          <img src={t.thumbnail} alt="" loading="lazy" decoding="async" style={{ width: 34, height: 34, borderRadius: 6, objectFit: "cover" }} />
                        ) : (
                          <div style={{ width: 34, height: 34, borderRadius: 6, background: "color-mix(in srgb, var(--text) 6%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)", fontWeight: 700 }}>
                            {t.title.charAt(0)}
                          </div>
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {t.title}
                          </div>
                          <div style={{ fontSize: 10, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {t.artist}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        <button
                          onClick={() => handlePlaylistTrackPreview(t)}
                          style={{
                            padding: "5px 10px", borderRadius: 6,
                            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                            border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
                            color: "var(--accent)", fontSize: 10, fontWeight: 700, cursor: "pointer",
                          }}
                        >
                          ▶ Stream
                        </button>
                        <button
                          onClick={() => handleAddTrackToCurrentPlaylist(t)}
                          disabled={isAdded}
                          style={{
                            padding: "5px 12px", borderRadius: 6,
                            background: isAdded ? "rgba(29,185,84,0.25)" : "var(--accent)",
                            border: `1px solid ${isAdded ? "rgba(29,185,84,0.5)" : "transparent"}`,
                            color: isAdded ? "#1DB954" : "var(--accent-fg)",
                            fontSize: 10, fontWeight: 700, cursor: isAdded ? "default" : "pointer",
                          }}
                        >
                          {isAdded ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              <span>Added</span>
                            </span>
                          ) : (
                            "+ Add"
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tracks Table */}
      {activeView !== "downloads" && activeView !== "discover" && (!isUrlQuery(searchQuery) || displayedTracks.length > 0) && (
        <div>
          <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text-3)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 12 }}>
            Songs {displayedTracks.length > 0 ? `(${displayedTracks.length})` : ""}
          </div>
          {displayedTracks.length === 0 ? (
            <div style={{
              padding: "40px", textAlign: "center",
              border: "1px dashed color-mix(in srgb, var(--text) 7%, transparent)", borderRadius: 16,
            }}>
              <p style={{ color: "var(--text-2)", fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
                {activePlaylist
                  ? `"${activePlaylist.name}" is empty`
                  : searchQuery.trim()
                  ? `No library songs match "${searchQuery.trim()}"`
                  : "No tracks found in this library view"}
              </p>
              <p style={{ color: "var(--text-3)", fontSize: 12, margin: 0 }}>
                {activePlaylist
                  ? "Use the search & import panel above to add songs, or click Auto-fill to load 15 tracks."
                  : searchQuery.trim()
                  ? "Search online across Spotify, YouTube Music, and SoundCloud to stream this song immediately."
                  : "Search online or explore Discover to stream songs and build your playlist."}
              </p>
              {searchQuery.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    executeOnlineSearch(searchQuery, providerFilter);
                    onNavigate("search");
                  }}
                  style={{
                    marginTop: 14, padding: "9px 20px", borderRadius: 12,
                    background: "var(--accent)", color: "var(--accent-fg)", border: "none",
                    fontSize: 12, fontWeight: 800, cursor: "pointer",
                    display: "inline-flex", alignItems: "center", gap: 7,
                    boxShadow: "0 4px 16px color-mix(in srgb, var(--accent) 35%, transparent)",
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <span>Search Online for "{searchQuery.trim()}"</span>
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {displayedTracks.map((track, index) => {
                const isCurrent = currentTrack?.id === track.id;
                const isHovered = hoveredTrack === track.id;
                return (
                  <div
                    key={track.id}
                    onClick={() => onSelectTrack(track)}
                    onMouseEnter={() => setHoveredTrack(track.id)}
                    onMouseLeave={() => setHoveredTrack(null)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "10px 14px", borderRadius: 14,
                      background: isCurrent
                        ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                        : isHovered ? "color-mix(in srgb, var(--text) 5%, transparent)" : "transparent",
                      border: `1px solid ${isCurrent ? "color-mix(in srgb, var(--accent) 30%, transparent)" : "transparent"}`,
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0, flex: 1 }}>
                      {/* Track number / EQ indicator */}
                      <span style={{ width: 20, textAlign: "center", fontSize: 11, fontWeight: 700, color: "var(--text-3)", flexShrink: 0 }}>
                        {isCurrent && isPlaying ? (
                          <span style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: 14, justifyContent: "center" }}>
                            {[1, 2, 3].map((i) => (
                              <span key={i} style={{
                                display: "block", width: 3, borderRadius: 2,
                                background: "var(--accent)",
                                animation: `eq-bar ${0.5 + i * 0.15}s ease-in-out infinite`,
                                height: `${4 + i * 3}px`,
                              }} />
                            ))}
                          </span>
                        ) : (
                          index + 1
                        )}
                      </span>

                      {/* Album art */}
                      <div style={{
                        width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                        backgroundImage: `url(${track.cover})`,
                        backgroundSize: "cover", backgroundPosition: "center",
                        border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
                        boxShadow: isCurrent ? "0 0 12px color-mix(in srgb, var(--accent) 30%, transparent)" : "none",
                      }} />

                      {/* Title & Artist */}
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontSize: 13, fontWeight: 700,
                          color: isCurrent ? "var(--accent)" : "var(--text)",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          marginBottom: 2,
                        }}>
                          {track.title}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-2)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {track.artist}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0, paddingLeft: 16 }}>
                      <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 500, display: "none" }} className="track-album">
                        {track.album}
                      </span>
                      {/* Provider badge */}
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 800,
                          padding: "2px 7px",
                          borderRadius: 5,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          background:
                            track.source === "spotify"
                              ? "rgba(29, 185, 84, 0.15)"
                              : track.source === "youtube"
                              ? "rgba(255, 0, 0, 0.15)"
                              : track.source === "soundcloud"
                              ? "rgba(255, 85, 0, 0.15)"
                              : "color-mix(in srgb, var(--accent) 15%, transparent)",
                          color:
                            track.source === "spotify"
                              ? "#1DB954"
                              : track.source === "youtube"
                              ? "#FF4444"
                              : track.source === "soundcloud"
                              ? "#FF5500"
                              : "var(--accent)",
                          border: `1px solid ${
                            track.source === "spotify"
                              ? "color-mix(in srgb, var(--accent) 30%, transparent)"
                              : track.source === "youtube"
                              ? "rgba(255, 0, 0, 0.3)"
                              : track.source === "soundcloud"
                              ? "rgba(255, 85, 0, 0.3)"
                              : "color-mix(in srgb, var(--accent) 30%, transparent)"
                          }`,
                        }}
                      >
                        {track.source === "youtube" ? "YT Music" : track.source}
                      </span>

                      {/* Synced lyrics badge */}
                      <span
                        title="Synchronized lyrics verified"
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                          color: "var(--accent)",
                          border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
                        }}
                      >
                        Synced Lyrics
                      </span>

                      <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                        {formatDuration(track.duration)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Create Playlist Modal */}
      {showImportModal && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 50,
          background: "rgba(0,0,0,0.65)",
          
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 16,
          animation: "fade-in 0.2s ease-out",
        }}>
          <div style={{
            width: "100%", maxWidth: 440,
            background: "color-mix(in srgb, var(--surface) 100%, transparent)",
            
            border: "1px solid color-mix(in srgb, var(--text) 10%, transparent)",
            borderRadius: 22,
            padding: 28,
            boxShadow: "0 24px 60px rgba(0,0,0,0.7)",
            position: "relative",
          }}>
            <button
              onClick={() => setShowImportModal(false)}
              style={{
                position: "absolute", top: 16, right: 16,
                padding: 8, borderRadius: 10,
                background: "color-mix(in srgb, var(--text) 5%, transparent)",
                border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                color: "var(--text-2)", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>

            <h3 style={{ fontSize: 18, fontWeight: 900, color: "var(--text)", marginBottom: 22 }}>Create Playlist</h3>

            <form onSubmit={handleCreatePlaylist} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <div>
                <label style={{ fontSize: 9, fontWeight: 800, color: "var(--text-3)", letterSpacing: "0.14em", textTransform: "uppercase", display: "block", marginBottom: 7 }}>
                  Name
                </label>
                <input
                  type="text"
                  placeholder="My Playlist"
                  value={newPlName}
                  onChange={(e) => setNewPlName(e.target.value)}
                  required
                  style={{
                    width: "100%", padding: "11px 14px",
                    borderRadius: 11,
                    background: "color-mix(in srgb, var(--text) 4%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)",
                    color: "var(--text)", fontSize: 13, fontWeight: 500,
                    outline: "none", boxSizing: "border-box",
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: 9, fontWeight: 800, color: "var(--text-3)", letterSpacing: "0.14em", textTransform: "uppercase", display: "block", marginBottom: 7 }}>
                  Platform
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {(["spotify", "youtube"] as const).map((src) => {
                    const color = PLATFORM_COLORS[src];
                    const isSelected = newPlSource === src;
                    return (
                      <button
                        key={src}
                        type="button"
                        onClick={() => setNewPlSource(src)}
                        style={{
                          padding: "11px", borderRadius: 11,
                          border: `1px solid ${isSelected ? color : "color-mix(in srgb, var(--text) 8%, transparent)"}`,
                          background: isSelected ? `${color}1a` : "color-mix(in srgb, var(--text) 3%, transparent)",
                          color: isSelected ? color : "var(--text-2)",
                          fontSize: 11, fontWeight: 800, cursor: "pointer",
                          letterSpacing: "0.08em", textTransform: "uppercase",
                          boxShadow: isSelected ? `0 0 14px ${color}25` : "none",
                          transition: "all 0.15s ease",
                        }}
                      >
                        {src}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label style={{ fontSize: 9, fontWeight: 800, color: "var(--text-3)", letterSpacing: "0.14em", textTransform: "uppercase", display: "block", marginBottom: 7 }}>
                  Tracks ({selectedTrackIds.length} selected)
                </label>
                <div style={{
                  maxHeight: 160, overflowY: "auto",
                  border: "1px solid color-mix(in srgb, var(--text) 6%, transparent)",
                  borderRadius: 11, padding: 8,
                  background: "color-mix(in srgb, var(--text) 2%, transparent)",
                  display: "flex", flexDirection: "column", gap: 3,
                }}>
                  {tracks.map((t) => {
                    const sel = selectedTrackIds.includes(t.id);
                    return (
                      <div
                        key={t.id}
                        onClick={() => toggleTrackSel(t.id)}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "7px 10px", borderRadius: 8,
                          background: sel ? "color-mix(in srgb, var(--accent) 18%, transparent)" : "transparent",
                          cursor: "pointer", fontSize: 12, fontWeight: 600,
                          color: sel ? "var(--text)" : "var(--text-2)",
                          transition: "all 0.12s ease",
                        }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                          {t.title} — {t.artist}
                        </span>
                        <div style={{
                          width: 16, height: 16, borderRadius: 5, flexShrink: 0, marginLeft: 8,
                          border: `1.5px solid ${sel ? "var(--accent)" : "color-mix(in srgb, var(--text) 15%, transparent)"}`,
                          background: sel ? "var(--accent)" : "transparent",
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                          {sel && (
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--accent-fg)" strokeWidth="3.5">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <button
                type="submit"
                disabled={!newPlName.trim()}
                style={{
                  padding: "13px", borderRadius: 12,
                  background: "var(--accent)", color: "var(--accent-fg)",
                  border: "none", fontSize: 12, fontWeight: 800,
                  cursor: "pointer", letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  boxShadow: "0 4px 20px color-mix(in srgb, var(--accent) 40%, transparent)",
                  opacity: newPlName.trim() ? 1 : 0.4,
                  pointerEvents: newPlName.trim() ? "auto" : "none",
                  transition: "all 0.15s ease",
                  marginTop: 4,
                }}
              >
                Create Playlist
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ContentArea);
