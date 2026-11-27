import { useState, useCallback, useEffect, useRef } from "react";
import Sidebar from "./components/Sidebar";
import ContentArea from "./components/ContentArea";
import PlayerBar from "./components/PlayerBar";
import ShortcutsModal from "./components/ShortcutsModal";
import type { Track } from "./components/PlayerBar";
import {
  safeEmit as emit,
  safeListen as listen,
  safeInvoke as invoke,
  safeConvertFileSrc as convertFileSrc,
  safeGetWebviewWindow,
  isTauriApp,
} from "./utils/tauriBridge";
import { openOverlayWindow, closeOverlayWindow } from "./utils/overlayWindow";
import type { LyricLine } from "./utils/lyrics";
import type { MGProvider } from "./types/track";
import { STORAGE_KEYS } from "./config";

const GRADIENTS = [
  "#3a3a3a,#141414", "#2e2e2e,#0f0f0f", "#444444,#1a1a1a", "#333333,#111111",
  "#3d3d3d,#161616", "#2a2a2a,#0c0c0c", "#484848,#1c1c1c", "#353535,#121212",
];

function makeCover(idx: number, title: string): string {
  const [c1, c2] = GRADIENTS[idx % GRADIENTS.length].split(",");
  const letter = (title || "M").charAt(0).toUpperCase();
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

export interface Playlist {
  id: string;
  name: string;
  source: MGProvider;
  count: number;
  color: number;
  trackIds: string[];
}

export default function App() {
  const [activeView,  setActiveView]  = useState("home");
  const [playlists,   setPlaylists]   = useState<Playlist[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.playlists);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((pl: Playlist) => {
            const cleanIds = (pl.trackIds || []).filter(id => !id.match(/^[1-9]$|^10$/));
            return {
              ...pl,
              trackIds: cleanIds,
              count: cleanIds.length,
            };
          });
        }
      }
      return defaultPlaylists();
    } catch {
      return defaultPlaylists();
    }
  });

  const isExpiredStream = (url?: string): boolean => {
    if (!url) return true;
    if (url.includes("googlevideo.com")) {
      const m = url.match(/[?&]expire=(\d+)/);
      if (m && m[1]) {
        const exp = parseInt(m[1], 10);
        return Math.floor(Date.now() / 1000) >= exp - 120;
      }
      return true;
    }
    return false;
  };

  const sanitizeTracksForStorage = (tracks: Track[]): Track[] => {
    return tracks.map(t => ({
      ...t,
      audioUrl: t.audioUrl?.includes("googlevideo.com") ? undefined : t.audioUrl,
    }));
  };

  // Parse the saved library once (it used to be JSON.parsed twice at startup)
  const [initialSaved] = useState<Track[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.savedTracks);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed
            .filter((t: any) => !t.audioUrl?.includes("soundhelix.com") && !t.id?.match(/^[1-9]$|^10$/))
            .map((t: any) => ({
              ...t,
              audioUrl: t.audioUrl?.includes("googlevideo.com") ? undefined : t.audioUrl,
            }));
        }
      }
    } catch {}
    return [];
  });
  const [allTracks, setAllTracks] = useState<Track[]>(initialSaved);

  const [currentTrack, setCurrentTrack] = useState<Track | null>(() => initialSaved[0] ?? null);

  const [isPlaying,    setIsPlaying]   = useState(false);
  const [progress,     setProgress]    = useState(0);
  const [lyricsWinOpen, setLyricsWinOpen] = useState(false);
  const [lyricsPinned, setLyricsPinned] = useState(true);
  const [lyricsTheme, setLyricsTheme] = useState("classic");
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);

  // Volume state (default to 0.8)
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.volume);
    const v = saved ? parseFloat(saved) : NaN;
    // Clamp to the valid HTMLAudioElement range; a corrupt stored value would throw on assignment
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
  });

  // Lyrics state
  const [currentLyrics, setCurrentLyrics] = useState<LyricLine[] | null>(null);
  const currentLyricsRef = useRef<LyricLine[] | null>(null);
  // Bumped whenever the lyrics list changes, so the overlay can tell a real
  // change from a heartbeat that carries no lyrics payload.
  const lyricsVersionRef = useRef(0);
  const syncSeqRef = useRef(0);

  // Playback error state
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  // Refs for emission without stale closures
  const audioRef        = useRef<HTMLAudioElement | null>(null);
  const lyricsWinRef    = useRef(false);
  const currentTrackRef = useRef<Track | null>(null);
  const isPlayingRef    = useRef(false);
  const lastEmitRef     = useRef(0);
  const lyricsTrackIdRef = useRef<string | null>(null);
  const retryCountRef   = useRef(0);
  const prevVolumeRef   = useRef(0.8);
  const allTracksRef    = useRef(allTracks);
  const lyricsPinnedRef = useRef(true);
  const lyricsThemeRef  = useRef("classic");
  const errorTokenRef   = useRef(0);

  // In-memory stream cache to avoid re-resolving streams repeatedly (TTL: 2 hours)
  const streamCacheRef = useRef<Map<string, { url: string; timestamp: number }>>(new Map());
  // In-memory lyrics cache for instant switching (TTL: session)
  const lyricsCacheRef = useRef<Map<string, LyricLine[]>>(new Map());
  // In-flight prefetch tracking to avoid duplicate concurrent fetches
  const prefetchInProgressRef = useRef<Set<string>>(new Set());
  // Continuous playback position tracking to survive stream reconnections/refreshes
  const lastKnownTimeRef = useRef<number>(0);
  const stallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pending auto-skip timer, tracked so it can be cancelled when the user changes tracks first
  const skipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Consecutive auto-skips: stops the failure cascade when every track fails (e.g. YouTube bot wall)
  const consecutiveSkipsRef = useRef(0);
  // In-flight stream resolutions, keyed like streamCacheRef, so the next-track prefetch and an
  // actual track switch share one yt-dlp run instead of racing two duplicates
  const resolveInFlightRef = useRef<Map<string, Promise<string>>>(new Map());
  // Last stream-resolution failure detail, surfaced in the player UI instead of being swallowed
  const streamResolveErrorRef = useRef<string | null>(null);
  // Reentrancy guard so the error event and a rejected play() promise don't both trigger a refresh
  const refreshInFlightRef = useRef(false);

  useEffect(() => { allTracksRef.current = allTracks; }, [allTracks]);

  // Sync volume state with HTML5 audio
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
    localStorage.setItem(STORAGE_KEYS.volume, volume.toString());
  }, [volume]);

  // Auto-scan download folder on startup to load downloaded tracks
  useEffect(() => {
    const autoScan = async () => {
      try {
        const dir = await invoke<string>("get_download_dir");
        const local = await invoke<any[]>("scan_local_tracks", { dir });
        const mapped: Track[] = local.map((t, idx) => ({
          id: t.id,
          title: t.title,
          artist: t.artist,
          album: "Local Download",
          cover: makeCover(idx, t.title),
          duration: t.duration > 0 ? t.duration : 0,
          source: "local",
          audioUrl: convertFileSrc(t.file_path),
        }));
        
        setAllTracks(prev => {
          const existingUrls = new Set(prev.map(t => t.audioUrl).filter(Boolean));
          const fresh = mapped.filter(t => t.audioUrl && !existingUrls.has(t.audioUrl));
          return [...prev, ...fresh];
        });
      } catch (err) {
        console.error("Auto-scan on startup failed:", err);
      }
    };
    autoScan();
  }, []);

  // Keep refs in sync
  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
  useEffect(() => { isPlayingRef.current = isPlaying; },      [isPlaying]);
  useEffect(() => { currentLyricsRef.current = currentLyrics; }, [currentLyrics]);
  useEffect(() => { lyricsWinRef.current = lyricsWinOpen; }, [lyricsWinOpen]);
  useEffect(() => { lyricsPinnedRef.current = lyricsPinned; }, [lyricsPinned]);
  useEffect(() => { lyricsThemeRef.current = lyricsTheme; }, [lyricsTheme]);

  // Last lyrics array pushed to the overlay (so ticks don't resend the whole array)
  const lastSentLyricsRef = useRef<LyricLine[] | null | undefined>(undefined);

  /**
   * Send a playback anchor to the overlay window.
   *
   * The overlay runs its own clock from this anchor, so this only needs to fire
   * on a state change (play/pause/seek/track/lyrics) plus a slow heartbeat - not
   * on every position update. `lyrics` is only attached when it changed.
   */
  const pushLyricsSync = useCallback(
    (opts?: {
      includeLyrics?: boolean;
      lyrics?: LyricLine[] | null;
      force?: boolean;
      /** Override the derived play state (used to freeze the overlay while buffering). */
      playing?: boolean;
    }) => {
      if (!lyricsWinRef.current && !opts?.force) return;
      const audio = audioRef.current;
      const track = currentTrackRef.current;
      const duration =
        audio && Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : track?.duration ?? 0;
      const payload: Record<string, unknown> = {
        v: 2,
        seq: ++syncSeqRef.current,
        trackId: track?.id ?? "",
        trackTitle: track?.title ?? "",
        trackArtist: track?.artist ?? "",
        position: audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
        // The audio element is the source of truth: React state lags play()/pause().
        playing: opts?.playing ?? (audio ? !audio.paused && !audio.ended : isPlayingRef.current),
        rate: audio && Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1,
        duration,
        wall: Date.now(),
        lyricsVersion: lyricsVersionRef.current,
      };
      if (opts?.includeLyrics) {
        payload.lyrics = opts.lyrics !== undefined ? opts.lyrics : currentLyricsRef.current;
      }
      emit("lyrics-sync", payload).catch(() => {});
    },
    []
  );

  // Listen for sync events from lyrics window
  useEffect(() => {
    const unsubReady = listen("lyrics-ready", () => {
      // The overlay is alive: it was created hidden and has just painted.
      lyricsWinRef.current = true;
      setLyricsWinOpen(true);
      pushLyricsSync({ includeLyrics: true, force: true });
      emit("lyrics-pin-state", { pinned: lyricsPinned }).catch(() => {});
      emit("lyrics-theme-state", { theme: lyricsTheme }).catch(() => {});
    });

    // The overlay asks for a fresh anchor while playing (and for the lyrics list
    // if it has none, e.g. after the player window reloaded).
    const unsubResync = listen<{ needLyrics?: boolean }>("lyrics-resync", (e) => {
      pushLyricsSync({ includeLyrics: Boolean(e.payload?.needLyrics), force: true });
    });

    const unsubPin = listen<{ pinned: boolean }>("lyrics-pin-state", (e) => {
      setLyricsPinned(e.payload.pinned);
    });

    const unsubTheme = listen<{ theme: string }>("lyrics-theme-state", (e) => {
      setLyricsTheme(e.payload.theme);
    });

    // Best-effort notice from the overlay as it unloads.
    const unsubClosed = listen("lyrics-closed", () => {
      lyricsWinRef.current = false;
      setLyricsWinOpen(false);
    });

    return () => {
      unsubReady.then(fn => fn());
      unsubResync.then(fn => fn());
      unsubPin.then(fn => fn());
      unsubTheme.then(fn => fn());
      unsubClosed.then(fn => fn());
    };
  }, [lyricsPinned, lyricsTheme, pushLyricsSync]);

  // Emit state changes to lyrics window
  useEffect(() => {
    if (lyricsWinOpen) {
      emit("lyrics-pin-state", { pinned: lyricsPinned }).catch(() => {});
    }
  }, [lyricsPinned, lyricsWinOpen]);

  useEffect(() => {
    if (lyricsWinOpen) {
      emit("lyrics-theme-state", { theme: lyricsTheme }).catch(() => {});
    }
  }, [lyricsTheme, lyricsWinOpen]);

  // Persist playlists
  // (debounced: JSON.stringify of the full library on every change blocked the UI thread)
  useEffect(() => {
    const id = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEYS.playlists, JSON.stringify(playlists)); } catch {}
    }, 400);
    return () => clearTimeout(id);
  }, [playlists]);

  // Persist all tracks whenever updated
  const allTracksSaveRef = useRef(allTracks);
  const saveTracksNow = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.savedTracks, JSON.stringify(sanitizeTracksForStorage(allTracksSaveRef.current)));
    } catch (e) {
      console.error("Failed to save tracks to localStorage:", e);
    }
  }, []);
  useEffect(() => {
    allTracksSaveRef.current = allTracks;
    const id = setTimeout(saveTracksNow, 400);
    return () => clearTimeout(id);
  }, [allTracks, saveTracksNow]);
  // Flush a pending debounced save if the window is closed right after a change
  useEffect(() => {
    window.addEventListener("beforeunload", saveTracksNow);
    return () => window.removeEventListener("beforeunload", saveTracksNow);
  }, [saveTracksNow]);

  // ---------- track selection helpers ----------
  const playTrack = useCallback((track: Track) => {
    setCurrentTrack(track);
    setAllTracks(prev => {
      const exists = prev.some(t => t.id === track.id);
      if (!exists) {
        const next = [track, ...prev];
        return next;
      }
      return prev;
    });
    setIsPlaying(true);
    setProgress(0);
  }, []);

  const handlePlayPause = useCallback(() => {
    if (!currentTrack) {
      if (allTracks.length > 0) playTrack(allTracks[0]);
      return;
    }
    setIsPlaying(p => !p);
  }, [currentTrack, allTracks, playTrack]);

  const handlePrev = useCallback(() => {
    if (allTracks.length === 0) return;
    const curIdx = currentTrack ? allTracks.findIndex(t => t.id === currentTrack.id) : 0;
    const idx = Math.max(0, curIdx - 1);
    setCurrentTrack(allTracks[idx]);
    setProgress(0);
  }, [currentTrack, allTracks]);

  const handleNext = useCallback(() => {
    if (allTracks.length === 0) return;
    const curIdx = currentTrack ? allTracks.findIndex(t => t.id === currentTrack.id) : 0;
    const idx = Math.min(allTracks.length - 1, curIdx + 1);
    setCurrentTrack(allTracks[idx]);
    setProgress(0);
  }, [currentTrack, allTracks]);

  // Auto-advance to the next track after an unplayable one, with a short delay so the
  // error is visible. The timer is tracked: a manual track change cancels it, and a run of
  // consecutive failures stops the cascade instead of burning through the whole playlist.
  const scheduleAutoSkip = useCallback(() => {
    if (consecutiveSkipsRef.current >= 3) {
      console.error("[playback] AUTO_SKIP_ABORT: too many consecutive unplayable tracks, staying put");
      return;
    }
    consecutiveSkipsRef.current += 1;
    if (skipTimeoutRef.current) clearTimeout(skipTimeoutRef.current);
    skipTimeoutRef.current = setTimeout(() => {
      skipTimeoutRef.current = null;
      handleNext();
    }, 1500);
  }, [handleNext]);

  const handleEnded = useCallback(() => {
    if (!audioRef.current) return;
    const dur = audioRef.current.duration;
    const cur = audioRef.current.currentTime;
    // Only auto-advance if audio was valid and played to near completion (within 2.5s of the end)
    if (dur > 5 && cur >= dur - 2.5) {
      handleNext();
    } else {
      // Audio ended prematurely or encountered an error: do not auto-advance!
      setIsPlaying(false);
    }
  }, [handleNext]);

  // ---------- audio sync ----------
  useEffect(() => {
    if (!audioRef.current) return;
    // Guard: Only interact with audio element if a valid source has already been loaded.
    // When switching tracks, resolveAndPlay will trigger .play() once the stream URL is ready.
    const currentSrc = audioRef.current.src;
    if (!currentSrc || currentSrc === window.location.href || currentSrc.endsWith("/")) {
      return;
    }

    if (isPlaying) {
      audioRef.current.play().catch((err: any) => {
        if (err.name !== "AbortError") {
          console.warn("[playback] play interrupted/failed:", err);
          setIsPlaying(false);
        }
      });
    } else {
      audioRef.current.pause();
    }
  }, [isPlaying]);

  // Fetch real lyrics from the Rust backend with caching & multi-detail verification
  useEffect(() => {
    if (!currentTrack) {
      setCurrentLyrics(null);
      return;
    }

    let active = true;
    // Cache key includes a duration bucket: the duration is often 0/unknown until audio
    // metadata loads, and lyrics fetched without it can be a different edit/version.
    const durBucket = currentTrack.duration && currentTrack.duration > 15 ? Math.round(currentTrack.duration / 4) : 0;
    const lyricsKey = `${currentTrack.title.trim().toLowerCase()}::${currentTrack.artist.trim().toLowerCase()}::${durBucket}`;
    const cachedLyrics = lyricsCacheRef.current.get(lyricsKey);
    const sameTrackRefetch = lyricsTrackIdRef.current === currentTrack.id;
    lyricsTrackIdRef.current = currentTrack.id;

    if (cachedLyrics) {
      console.log(`[lyrics] CACHE_HIT: ${currentTrack.title} (${cachedLyrics.length} lines, 0ms)`);
      setCurrentLyrics(cachedLyrics);
      return;
    }

    // null = searching. Keep showing current lyrics while refining the same track
    // after its real duration became known (avoids a flash to "Searching...").
    if (!sameTrackRefetch) setCurrentLyrics(null);

    invoke<LyricLine[]>("fetch_lyrics", {
      title: currentTrack.title,
      artist: currentTrack.artist,
      durationSec: currentTrack.duration ?? 0,
      album: currentTrack.album || undefined,
    })
      .then((lyrics) => {
        if (!active) return;
        lyricsCacheRef.current.set(lyricsKey, lyrics);
        setCurrentLyrics(lyrics.length > 0 ? lyrics : []);
      })
      .catch(() => {
        if (!active) return;
        setCurrentLyrics([]); // [] = not found
      });

    return () => { active = false; };
  // duration/album intentionally excluded: loadedmetadata rewrites duration and would
  // cancel the in-flight fetch, re-fetch, and flash the lyrics overlay back to 'searching'.
  }, [currentTrack?.id, currentTrack?.title, currentTrack?.artist]);

  // Resolve stream URL for a track (instant cache hit, multi-detail studio selection, forceFresh bypass)
  const resolveStreamUrl = useCallback(async (track: Track, forceFresh = false): Promise<string> => {
    const src = track.audioUrl ?? "";
    streamResolveErrorRef.current = null;
    if (track.source === "local") {
      return src;
    }

    const cacheKey = track.id || `${track.title}__${track.artist}`;

    // True only for URLs an HTMLAudioElement can play directly: no provider pages,
    // no 30s Spotify previews, no HLS playlists, no expired signed URLs
    const isDirectStream = (u: string): boolean => {
      if (!u || u.includes("p.scdn.co") || u.includes(".m3u8") || isExpiredStream(u)) return false;
      const path = u.split(/[?#]/)[0].toLowerCase();
      return (
        u.includes("googlevideo.com") ||
        path.endsWith(".mp3") ||
        path.endsWith(".m4a") ||
        path.endsWith(".opus") ||
        path.endsWith(".ogg") ||
        path.endsWith(".wav") ||
        path.endsWith(".flac") ||
        path.endsWith(".aac") ||
        path.endsWith(".webm") ||
        u.startsWith("blob:") ||
        u.startsWith("asset:")
      );
    };

    if (!forceFresh) {
      const cached = streamCacheRef.current.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < 2 * 60 * 60 * 1000 && !isExpiredStream(cached.url)) {
        console.log(`[playback] STREAM_CACHE_HIT: ${track.title} (0ms)`);
        return cached.url;
      }

      // Join an in-flight resolution (e.g. the next-track prefetch) instead of starting a duplicate yt-dlp run
      const inFlight = resolveInFlightRef.current.get(cacheKey);
      if (inFlight) {
        console.log(`[playback] STREAM_RESOLVE_JOIN: ${track.title}`);
        return inFlight;
      }

      // If we already have a direct playable audio stream, use it immediately
      if (isDirectStream(src)) {
        streamCacheRef.current.set(cacheKey, { url: src, timestamp: Date.now() });
        return src;
      }
    } else {
      // Force fresh: Purge expired URL from cache
      streamCacheRef.current.delete(cacheKey);
    }

    // Resolve full track stream dynamically via native backend with multi-detail verification.
    // Registered in resolveInFlightRef so concurrent callers share this same promise.
    const resolution = (async (): Promise<string> => {
      try {
        const query = (track.audioUrl && (track.audioUrl.includes("youtube.com/watch") || track.audioUrl.includes("youtu.be/")))
          ? track.audioUrl
          : `${track.artist} - ${track.title}`.trim();
        const info = await invoke<any>("get_preview_info", {
          input: query,
          expectedDuration: track.duration > 0 ? track.duration : undefined,
          expectedArtist: track.artist || undefined,
          expectedAlbum: track.album || undefined,
        });
        if (info && info.stream_url && !info.stream_url.includes("p.scdn.co") && !info.stream_url.includes(".m3u8")) {
          streamCacheRef.current.set(cacheKey, { url: info.stream_url, timestamp: Date.now() });
          // Update in-place so subsequent access doesn't retain expired audioUrl
          track.audioUrl = info.stream_url;
          if (currentTrackRef.current && currentTrackRef.current.id === track.id) {
            currentTrackRef.current.audioUrl = info.stream_url;
          }
          return info.stream_url;
        }
        // Backend answered but returned nothing playable
        streamResolveErrorRef.current = info
          ? "Backend returned no directly playable stream for this track"
          : "Backend returned no stream metadata";
      } catch (err) {
        // Keep the real backend error (yt-dlp bot wall, timeout, missing binary...)
        // so the UI can show it instead of a generic "no stream" message
        streamResolveErrorRef.current = String(err);
        console.warn("[playback] stream resolution failed:", err);
      }
      // Never hand a stale/expired/preview/webpage URL to the audio element as a fallback:
      // it can only fail, or worse, silently play a 30-second preview
      return "";
    })();

    resolveInFlightRef.current.set(cacheKey, resolution);
    try {
      return await resolution;
    } finally {
      resolveInFlightRef.current.delete(cacheKey);
    }
  }, []);

  // Proactive background pre-fetch: when current track is playing, pre-fetch next track's lyrics and stream
  useEffect(() => {
    if (!currentTrack || !isPlaying || allTracks.length <= 1) return;

    const curIdx = allTracks.findIndex(t => t.id === currentTrack.id);
    if (curIdx === -1) return;

    const nextTrack = allTracks[curIdx + 1];
    if (!nextTrack) return;

    const streamKey = nextTrack.id || `${nextTrack.title}__${nextTrack.artist}`;
    const nextDurBucket = nextTrack.duration && nextTrack.duration > 15 ? Math.round(nextTrack.duration / 4) : 0;
    const lyricsKey = `${nextTrack.title.trim().toLowerCase()}::${nextTrack.artist.trim().toLowerCase()}::${nextDurBucket}`;

    // 1. Prefetch lyrics early (after 3.5s) - lightweight text JSON, eliminates lyrics delay on track switch
    const lyricsTimer = setTimeout(() => {
      if (!lyricsCacheRef.current.has(lyricsKey)) {
        invoke<LyricLine[]>("fetch_lyrics", {
          title: nextTrack.title,
          artist: nextTrack.artist,
          durationSec: nextTrack.duration ?? 0,
          album: nextTrack.album || undefined,
        })
          .then(lyrics => {
            lyricsCacheRef.current.set(lyricsKey, lyrics);
          })
          .catch(() => {});
      }
    }, 3500);

    // 2. Prefetch audio stream only after 15s of steady playback to eliminate wasted network bandwidth during song skips
    const streamTimer = setTimeout(() => {
      if (!streamCacheRef.current.has(streamKey) && !prefetchInProgressRef.current.has(streamKey)) {
        prefetchInProgressRef.current.add(streamKey);
        resolveStreamUrl(nextTrack)
          .catch(() => {})
          .finally(() => prefetchInProgressRef.current.delete(streamKey));
      }
    }, 15000);

    return () => {
      clearTimeout(lyricsTimer);
      clearTimeout(streamTimer);
    };
  }, [currentTrack?.id, isPlaying, allTracks, resolveStreamUrl]);

  useEffect(() => {
    if (!audioRef.current || !currentTrack) return;

    let active = true;
    errorTokenRef.current++;
    retryCountRef.current = 0;
    lastKnownTimeRef.current = 0;
    setPlaybackError(null);
    // A new track supersedes any auto-skip scheduled by the previous one
    if (skipTimeoutRef.current) {
      clearTimeout(skipTimeoutRef.current);
      skipTimeoutRef.current = null;
    }

    // Stop the previous track immediately: it must not keep playing (and keep pushing
    // progress/lyrics events for the old position) while the new stream resolves
    audioRef.current.pause();
    audioRef.current.removeAttribute("src");
    audioRef.current.load();

    const resolveAndPlay = async () => {
      try {
        const src = await resolveStreamUrl(currentTrack);
        if (!active || !audioRef.current) return;

        if (!src) {
          setPlaybackError(streamResolveErrorRef.current ?? "No playable stream found for this track");
          setIsPlaying(false);
          scheduleAutoSkip();
          return;
        }

        audioRef.current.src = src;
        // Element volume persists across src changes and stays in sync via the volume effect
        audioRef.current.load();

        if (isPlayingRef.current) {
          try {
            await audioRef.current.play();
          } catch (err: any) {
            if (!active) return;
            if (err.name !== "AbortError") {
              console.error("[playback] play error:", err);
              handleAudioError();
            }
          }
        }
      } catch (err) {
        console.error("[playback] STREAM_RESOLVE failed:", err);
        if (active) {
          setPlaybackError(`Failed to resolve stream: ${err}`);
          setIsPlaying(false);
          scheduleAutoSkip();
        }
      }
    };

    resolveAndPlay();

    // A new track: tell the overlay right away (null = "searching", so it shows
    // the searching state instead of "lyrics unavailable" while fetching).
    lyricsVersionRef.current += 1;
    pushLyricsSync({ includeLyrics: true, lyrics: null });

    // Cancel this resolution if the track changes again before it finishes: without this,
    // a slow yt-dlp run for track A can overwrite track B's freshly loaded stream
    return () => { active = false; };
  }, [currentTrack?.id]);

  // Core stream-recovery path shared by the audio error event and the stall watchdog:
  // re-resolves a fresh stream URL and seamlessly restores playback position
  const attemptStreamRefresh = async (reason: string) => {
    if (!audioRef.current || !currentTrackRef.current) return;
    // The error event and a rejected play() promise can both fire for one failure: refresh once
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const track = currentTrackRef.current;

      const maxRetries = 2;
      if (retryCountRef.current >= maxRetries) {
        console.error("[playback] STREAM_EXPIRED: Max retries reached for", track.title, `(${reason})`);
        setPlaybackError(`"${track.title}" unavailable — skipping to next song...`);
        setIsPlaying(false);
        audioRef.current.pause();
        scheduleAutoSkip();
        return;
      }

      retryCountRef.current += 1;
      const resumePos = lastKnownTimeRef.current;
      console.warn(`[playback] STREAM_REFRESH: Retrying stream resolution (attempt ${retryCountRef.current}/${maxRetries}) for "${track.title}" at ${resumePos.toFixed(1)}s (${reason})`);
      setPlaybackError(null);

      // Evict stale stream from cache so retry fetches a fresh stream
      const cacheKey = track.id || `${track.title}__${track.artist}`;
      streamCacheRef.current.delete(cacheKey);

      // Small delay to allow any transient network socket reset to settle
      await new Promise(r => setTimeout(r, 400));

      // The user may have switched tracks while we waited: never clobber the new track
      if (currentTrackRef.current?.id !== track.id) return;

      try {
        const src = await resolveStreamUrl(track, true);
        if (currentTrackRef.current?.id !== track.id || !audioRef.current) return;
        if (!src) {
          setPlaybackError(streamResolveErrorRef.current ?? "Stream URL unavailable");
          setIsPlaying(false);
          scheduleAutoSkip();
          return;
        }
        audioRef.current.src = src;
        // Element volume persists across src changes and stays in sync via the volume effect
        audioRef.current.load();

        // Seamlessly restore playback position when metadata is loaded
        const restorePositionAndPlay = () => {
          if (!audioRef.current || currentTrackRef.current?.id !== track.id) return;
          if (resumePos > 0) {
            try {
              audioRef.current.currentTime = Math.max(0, resumePos);
            } catch (e) {
              console.warn("[playback] Could not restore currentTime:", e);
            }
          }
          if (isPlayingRef.current) {
            audioRef.current.play().catch(playErr => {
              console.warn("[playback] Auto-resume play error:", playErr);
            });
          }
        };

        audioRef.current.addEventListener("loadedmetadata", restorePositionAndPlay, { once: true });

        if (isPlayingRef.current) {
          audioRef.current.play().catch(() => {});
        }
      } catch (err) {
        console.error("[playback] STREAM_REFRESH failed:", err);
        if (currentTrackRef.current?.id !== track.id) return;
        setPlaybackError(`Stream refresh failed: ${err}`);
        setIsPlaying(false);
      }
    } finally {
      refreshInFlightRef.current = false;
    }
  };

  // Handle audio element errors: decode errors skip immediately (a fresh URL serves the
  // same bytes), everything else retries with a fresh stream URL (expired signed URLs
  // are the common case)
  const handleAudioError = async () => {
    if (!audioRef.current || !currentTrackRef.current) return;
    // No source loaded (e.g. we just cleared it for a track switch): nothing to recover
    if (!audioRef.current.currentSrc) return;
    const track = currentTrackRef.current;
    const mediaErr = audioRef.current.error;
    const MEDIA_ERR_DECODE = 3;
    const codeNames: Record<number, string> = {
      1: "MEDIA_ERR_ABORTED",
      2: "MEDIA_ERR_NETWORK",
      3: "MEDIA_ERR_DECODE",
      4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
    };
    const errDesc = mediaErr
      ? `${codeNames[mediaErr.code] || `MediaError ${mediaErr.code}`}${mediaErr.message ? `: ${mediaErr.message}` : ""}`
      : "unknown playback error";

    // Only retry for non-local tracks (local files don't expire)
    if (track.source === "local") {
      setPlaybackError(`Playback failed — file may be missing or corrupted (${errDesc})`);
      setIsPlaying(false);
      return;
    }

    if (mediaErr && mediaErr.code === MEDIA_ERR_DECODE) {
      console.error("[playback] DECODE_ERROR:", errDesc);
      setPlaybackError(`"${track.title}" could not be decoded — skipping...`);
      setIsPlaying(false);
      scheduleAutoSkip();
      return;
    }

    attemptStreamRefresh(errDesc);
  };

  const handleAudioWaiting = () => {
    if (!isPlayingRef.current || !audioRef.current) return;
    if (stallTimeoutRef.current) clearTimeout(stallTimeoutRef.current);
    stallTimeoutRef.current = setTimeout(() => {
      stallTimeoutRef.current = null;
      if (isPlayingRef.current && audioRef.current && (audioRef.current.paused || audioRef.current.readyState < 3)) {
        console.warn("[playback] Audio stalled for >10s — attempting stream recovery");
        attemptStreamRefresh("stalled >10s (buffer underrun)");
      }
    }, 10000);
  };

  // Push the lyrics list when it changes (search finished, cache hit, no match).
  useEffect(() => {
    lyricsVersionRef.current += 1;
    pushLyricsSync({ includeLyrics: true });
  }, [currentLyrics, pushLyricsSync]);

  const handleTimeUpdate = () => {
    if (!audioRef.current) return;
    const t = audioRef.current.currentTime;
    if (t > 0) {
      lastKnownTimeRef.current = t;
    }
    setProgress(t);

    if (stallTimeoutRef.current) {
      clearTimeout(stallTimeoutRef.current);
      stallTimeoutRef.current = null;
    }

    // Heartbeat only: the overlay extrapolates from the last anchor with its own
    // clock, so position does not need to be pushed at 3Hz. This rides on media
    // time (which keeps ticking in a minimised window) instead of a timer, and
    // is only a safety net for audio-clock drift; the overlay also requests a
    // fresh anchor every few seconds.
    const now = Date.now();
    if (lyricsWinRef.current && now - lastEmitRef.current > 2000) {
      lastEmitRef.current = now;
      pushLyricsSync();
    }
  };

  const handleSeek = useCallback((time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setProgress(time);
      lastKnownTimeRef.current = time;
      // Seek is authoritative: push at once instead of waiting for `seeked`.
      pushLyricsSync();
    }
  }, [pushLyricsSync]);

  const handleLoadedMetadata = () => {
    if (audioRef.current && currentTrack) {
      const dur = audioRef.current.duration;
      if (dur && Math.abs((currentTrack.duration || 0) - dur) > 0.1) {
        setCurrentTrack(prev => prev ? { ...prev, duration: dur } : null);
        setAllTracks(prev => prev.map(t => t.id === currentTrack.id ? { ...t, duration: dur } : t));
      }
      // Real duration is now known: the overlay clamps its clock to it.
      pushLyricsSync();
    }
  };

  // ---------- floating lyrics window ----------
  const openLyricsWindow = useCallback(async () => {
    if (!isTauriApp()) {
      alert("Floating overlay lyrics require the MGlyrics desktop application window. Run 'run.bat' on your machine to use desktop overlay mode.");
      return;
    }
    const win = await openOverlayWindow();
    if (!win) {
      console.warn("[overlay] lyrics window could not be created");
      alert("The lyrics overlay window could not be created. Close it from the taskbar if one is open and try again.");
      return;
    }
    // The window can be closed from the OS (Alt+F4, its own X, app shutdown).
    // Reset the player state when that happens, otherwise the toggle stays "on"
    // and the next press closes a window that is no longer there.
    win
      .once("tauri://destroyed", () => {
        lyricsWinRef.current = false;
        setLyricsWinOpen(false);
      })
      .catch(() => {});
    lyricsWinRef.current = true;
    lastSentLyricsRef.current = undefined;
    setLyricsWinOpen(true);
    // Send current state immediately (the overlay also asks on `lyrics-ready`).
    pushLyricsSync({ includeLyrics: true, force: true });
  }, [pushLyricsSync]);

  const closeLyricsWindow = useCallback(async () => {
    lyricsWinRef.current = false;
    setLyricsWinOpen(false);
    if (!isTauriApp()) return;
    await closeOverlayWindow();
  }, []);

  const toggleLyrics = useCallback(async () => {
    // Authoritative: ask the window manager rather than trusting our own flag.
    const existing = await safeGetWebviewWindow("lyrics");
    if (existing) await closeLyricsWindow();
    else await openLyricsWindow();
  }, [openLyricsWindow, closeLyricsWindow]);

  // ---------- overlay lifetime guard ----------
  // The overlay is click-through, frameless and hidden from the taskbar, so if this
  // window goes away without taking it down the user cannot dismiss it at all.
  // Rust owns the primary path (on_window_event); this is the fallback: heartbeat while
  // we are alive, an explicit app-closing signal, and a watchdog on the other side.
  useEffect(() => {
    if (!lyricsWinOpen) return;
    const beat = setInterval(() => {
      emit("lyrics-heartbeat", { t: Date.now() }).catch(() => {});
    }, 2000);
    return () => clearInterval(beat);
  }, [lyricsWinOpen]);

  useEffect(() => {
    const announceExit = () => {
      emit("app-closing", {}).catch(() => {});
    };
    window.addEventListener("pagehide", announceExit);
    window.addEventListener("beforeunload", announceExit);
    return () => {
      window.removeEventListener("pagehide", announceExit);
      window.removeEventListener("beforeunload", announceExit);
    };
  }, []);

  // ---------- keyboard shortcuts ----------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (target as any)?.isContentEditable
      ) {
        return;
      }

      let handled = false;

      // Shortcuts modal toggle: ? or Shift+/
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        setShowShortcutsModal(prev => !prev);
        handled = true;
      } else if (e.key === "Escape") {
        setShowShortcutsModal(false);
        handled = true;
      } else {
        switch (e.key) {
          case " ":
          case "k":
          case "K":
          case "MediaPlayPause": {
            if (!currentTrackRef.current) break;
            if (tag === "BUTTON") (target as HTMLButtonElement).blur();
            setIsPlaying(p => !p);
            handled = true;
            break;
          }
          case "ArrowLeft": {
            if (e.ctrlKey || e.altKey) {
              handlePrev();
            } else if (audioRef.current) {
              const delta = e.shiftKey ? 10 : 5;
              const newTime = Math.max(0, audioRef.current.currentTime - delta);
              audioRef.current.currentTime = newTime;
              lastKnownTimeRef.current = newTime;
              setProgress(newTime);
              lastKnownTimeRef.current = newTime;
              pushLyricsSync();
            }
            handled = true;
            break;
          }
          case "ArrowRight": {
            if (e.ctrlKey || e.altKey) {
              handleNext();
            } else if (audioRef.current && audioRef.current.duration) {
              const delta = e.shiftKey ? 10 : 5;
              const newTime = Math.min(audioRef.current.duration, audioRef.current.currentTime + delta);
              audioRef.current.currentTime = newTime;
              lastKnownTimeRef.current = newTime;
              setProgress(newTime);
              lastKnownTimeRef.current = newTime;
              pushLyricsSync();
            }
            handled = true;
            break;
          }
          case "b":
          case "B":
          case "MediaTrackPrevious": {
            if (e.ctrlKey || e.metaKey || e.altKey) break;
            handlePrev();
            handled = true;
            break;
          }
          case "n":
          case "N":
          case "MediaTrackNext": {
            if (e.ctrlKey || e.metaKey || e.altKey) break;
            handleNext();
            handled = true;
            break;
          }
          case "ArrowUp": {
            setVolume(v => Math.min(1, Math.round((v + 0.05) * 100) / 100));
            handled = true;
            break;
          }
          case "ArrowDown": {
            setVolume(v => Math.max(0, Math.round((v - 0.05) * 100) / 100));
            handled = true;
            break;
          }
          case "m":
          case "M": {
            if (e.ctrlKey || e.metaKey || e.altKey) break;
            setVolume(v => {
              if (v > 0) {
                prevVolumeRef.current = v;
                return 0;
              }
              return prevVolumeRef.current || 0.8;
            });
            handled = true;
            break;
          }
          case "l":
          case "L": {
            if (e.ctrlKey || e.metaKey || e.altKey) break;
            toggleLyrics();
            handled = true;
            break;
          }
          case "p":
          case "P": {
            if (e.ctrlKey || e.metaKey || e.altKey) break;
            setLyricsPinned(prev => !prev);
            handled = true;
            break;
          }
          case "[": {
            if (e.ctrlKey || e.metaKey || e.altKey) break;
            emit("lyrics-offset-nudge", { delta: -0.5 }).catch(() => {});
            handled = true;
            break;
          }
          case "]": {
            if (e.ctrlKey || e.metaKey || e.altKey) break;
            emit("lyrics-offset-nudge", { delta: 0.5 }).catch(() => {});
            handled = true;
            break;
          }
          case "t":
          case "T": {
            if (e.ctrlKey || e.metaKey || e.altKey) break;
            setLyricsTheme(prev => {
              const themes = ["classic", "inverse", "serif", "mono", "nebula", "cyberpunk", "terminal", "elegant", "minimal", "emerald", "sunset", "synthwave", "nordic", "tokyo"];
              const nextIdx = (themes.indexOf(prev) + 1) % themes.length;
              return themes[nextIdx];
            });
            handled = true;
            break;
          }
        }
      }

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [toggleLyrics, handlePrev, handleNext, pushLyricsSync]);

  // ---------- local & playlist track injection ----------
  // keepUrlDuplicates: playlist imports reference tracks by id, so a track must
  // never be dropped just because the same URL exists under another id,
  // otherwise the playlist keeps an id that resolves to nothing.
  const addLocalTracks = useCallback((newTracks: Track[], opts?: { keepUrlDuplicates?: boolean }) => {
    setAllTracks(prev => {
      const existingIds = new Set(prev.map(t => t.id));
      const existingUrls = new Set(prev.map(t => t.audioUrl).filter(Boolean));
      const fresh = newTracks.filter(t => !existingIds.has(t.id) && (opts?.keepUrlDuplicates || !t.audioUrl || !existingUrls.has(t.audioUrl)));
      if (fresh.length === 0) return prev;
      const updated = [...prev, ...fresh];
      return updated;
    });
  }, []);

  const addTrackToPlaylist = useCallback((playlistId: string, track: Track) => {
    setAllTracks(prev => {
      const exists = prev.some(t => t.id === track.id);
      if (!exists) {
        const updated = [track, ...prev];
        return updated;
      }
      return prev;
    });

    setPlaylists(prev => {
      const updated = prev.map(pl => {
        if (pl.id === playlistId) {
          const ids = pl.trackIds || [];
          if (!ids.includes(track.id)) {
            const nextIds = [...ids, track.id];
            return { ...pl, trackIds: nextIds, count: nextIds.length };
          }
        }
        return pl;
      });
      return updated;
    });
  }, []);

  const closeShortcuts = useCallback(() => setShowShortcutsModal(false), []);
  const syncPlaylist = useCallback((pl: Playlist) => setPlaylists(prev => prev.some(p => p.id === pl.id) ? prev : [...prev, pl]), []);

  return (
    <div style={{ height: "100vh", width: "100vw", overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--bg)", position: "relative" }}>
      {!isTauriApp() && (
        <div style={{
          background: "var(--surface-2)",
          color: "var(--text)",
          padding: "7px 16px",
          fontSize: "12px",
          fontWeight: 700,
          textAlign: "center",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "10px",
          zIndex: 9999,
          boxShadow: "0 2px 10px rgba(0,0,0,0.5)"
        }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <span><strong>Web Browser Preview:</strong> Running in web browser. Native downloads, filesystem scanning, and transparent overlay require the desktop app. Run <code>run.bat</code> on your PC to launch the native desktop player!</span>
          </span>
        </div>
      )}
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onError={handleAudioError}
        onWaiting={() => { handleAudioWaiting(); pushLyricsSync({ playing: false }); }}
        onStalled={() => { handleAudioWaiting(); pushLyricsSync({ playing: false }); }}
        onPlay={() => {
          setPlaybackError(null);
          // Successful playback resets the failure bookkeeping so a later, unrelated
          // failure gets a full set of retries again
          retryCountRef.current = 0;
          consecutiveSkipsRef.current = 0;
          if (stallTimeoutRef.current) {
            clearTimeout(stallTimeoutRef.current);
            stallTimeoutRef.current = null;
          }
          pushLyricsSync();
        }}
        onPlaying={() => pushLyricsSync()}
        onPause={() => pushLyricsSync()}
        onSeeking={() => pushLyricsSync()}
        onSeeked={() => pushLyricsSync()}
        onRateChange={() => pushLyricsSync()}
      />

      {/* Atmospheric ambient glows */}

      <div style={{ display: "flex", flex: 1, minHeight: 0, zIndex: 1 }}>
        <Sidebar
          activeView={activeView}
          onNavigate={setActiveView}
          playlists={playlists}
        />
        <ContentArea
          tracks={allTracks}
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          onSelectTrack={playTrack}
          activeView={activeView}
          playlists={playlists}
          onNavigate={setActiveView}
          onSyncPlaylist={syncPlaylist}
          onAddLocalTracks={addLocalTracks}
          onAddTrackToPlaylist={addTrackToPlaylist}
        />
      </div>

      <PlayerBar
        track={currentTrack}
        isPlaying={isPlaying}
        progress={progress}
        onPlayPause={handlePlayPause}
        onPrev={handlePrev}
        onNext={handleNext}
        onToggleLyrics={toggleLyrics}
        lyricsVisible={lyricsWinOpen}
        onSeek={handleSeek}
        lyricsPinned={lyricsPinned}
        onTogglePin={() => setLyricsPinned(p => !p)}
        lyricsTheme={lyricsTheme}
        onChangeTheme={setLyricsTheme}
        volume={volume}
        onVolumeChange={setVolume}
        playbackError={playbackError}
        onOpenShortcuts={() => setShowShortcutsModal(true)}
      />

      {/* Global Keyboard Shortcuts Cheatsheet Modal */}
      <ShortcutsModal
        isOpen={showShortcutsModal}
        onClose={closeShortcuts}
      />
    </div>
  );
}

function defaultPlaylists(): Playlist[] {
  return [
    { id: "p1", name: "Favorites",             source: "spotify",    count: 0, color: 0, trackIds: [] },
    { id: "p2", name: "YouTube Favorites",     source: "youtube",    count: 0, color: 1, trackIds: [] },
    { id: "p3", name: "SoundCloud Electronic", source: "soundcloud", count: 0, color: 4, trackIds: [] },
    { id: "p4", name: "Offline Downloads",     source: "local",      count: 0, color: 2, trackIds: [] },
  ];
}
