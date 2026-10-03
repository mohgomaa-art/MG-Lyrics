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
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { LyricLine } from "./utils/lyrics";
import type { MGProvider } from "./types/track";

const GRADIENTS = [
  "#8A2BE2,#4A0E4E", "#FF007F,#70003C", "#00F0FF,#004E7C", "#1DB954,#0B4E22",
  "#FF8C00,#5A2A00", "#FF4500,#4E1400", "#8A2BE2,#00F0FF", "#FF007F,#00F0FF",
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
      const saved = localStorage.getItem("mg_playlists");
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

  const [allTracks, setAllTracks] = useState<Track[]>(() => {
    try {
      const saved = localStorage.getItem("mg_saved_tracks");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const realTracks = parsed
            .filter((t: any) => !t.audioUrl?.includes("soundhelix.com") && !t.id?.match(/^[1-9]$|^10$/))
            .map((t: any) => ({
              ...t,
              audioUrl: t.audioUrl?.includes("googlevideo.com") ? undefined : t.audioUrl,
            }));
          return realTracks;
        }
      }
    } catch {}
    return [];
  });

  const [currentTrack, setCurrentTrack] = useState<Track | null>(() => {
    try {
      const saved = localStorage.getItem("mg_saved_tracks");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const realTracks = parsed
            .filter((t: any) => !t.audioUrl?.includes("soundhelix.com") && !t.id?.match(/^[1-9]$|^10$/))
            .map((t: any) => ({
              ...t,
              audioUrl: t.audioUrl?.includes("googlevideo.com") ? undefined : t.audioUrl,
            }));
          if (realTracks.length > 0) return realTracks[0];
        }
      }
    } catch {}
    return null;
  });

  const [isPlaying,    setIsPlaying]   = useState(false);
  const [progress,     setProgress]    = useState(0);
  const [lyricsWinOpen, setLyricsWinOpen] = useState(false);
  const [lyricsPinned, setLyricsPinned] = useState(true);
  const [lyricsTheme, setLyricsTheme] = useState("nebula");
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);

  // Volume state (default to 0.8)
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem("mg_volume");
    return saved ? parseFloat(saved) : 0.8;
  });

  // Lyrics state
  const [currentLyrics, setCurrentLyrics] = useState<LyricLine[] | null>(null);
  const currentLyricsRef = useRef<LyricLine[] | null>(null);

  // Playback error state
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  // Refs for emission without stale closures
  const audioRef        = useRef<HTMLAudioElement | null>(null);
  const lyricsWinRef    = useRef(false);
  const currentTrackRef = useRef<Track | null>(null);
  const isPlayingRef    = useRef(false);
  const lastEmitRef     = useRef(0);
  const retryCountRef   = useRef(0);
  const prevVolumeRef   = useRef(0.8);
  const allTracksRef    = useRef(allTracks);

  // In-memory stream cache to avoid re-resolving streams repeatedly (TTL: 2 hours)
  const streamCacheRef = useRef<Map<string, { url: string; timestamp: number }>>(new Map());
  // In-memory lyrics cache for instant switching (TTL: session)
  const lyricsCacheRef = useRef<Map<string, LyricLine[]>>(new Map());
  // In-flight prefetch tracking to avoid duplicate concurrent fetches
  const prefetchInProgressRef = useRef<Set<string>>(new Set());
  // Continuous playback position tracking to survive stream reconnections/refreshes
  const lastKnownTimeRef = useRef<number>(0);
  const stallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { allTracksRef.current = allTracks; }, [allTracks]);

  // Sync volume state with HTML5 audio
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
    localStorage.setItem("mg_volume", volume.toString());
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

  // Listen for sync events from lyrics window
  useEffect(() => {
    const unsubReady = listen("lyrics-ready", () => {
      if (currentTrackRef.current) {
        emit("lyrics-update", {
          trackId:     currentTrackRef.current.id,
          progress:    audioRef.current?.currentTime ?? 0,
          isPlaying:   isPlayingRef.current,
          trackTitle:  currentTrackRef.current.title,
          trackArtist: currentTrackRef.current.artist,
          lyrics:      currentLyricsRef.current,
        }).catch(() => {});
      }
      emit("lyrics-pin-state", { pinned: lyricsPinned }).catch(() => {});
      emit("lyrics-theme-state", { theme: lyricsTheme }).catch(() => {});
    });

    const unsubPin = listen<{ pinned: boolean }>("lyrics-pin-state", (e) => {
      setLyricsPinned(e.payload.pinned);
    });

    const unsubTheme = listen<{ theme: string }>("lyrics-theme-state", (e) => {
      setLyricsTheme(e.payload.theme);
    });

    return () => {
      unsubReady.then(fn => fn());
      unsubPin.then(fn => fn());
      unsubTheme.then(fn => fn());
    };
  }, [lyricsPinned, lyricsTheme]);

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
  useEffect(() => {
    try {
      localStorage.setItem("mg_playlists", JSON.stringify(playlists));
    } catch {}
  }, [playlists]);

  // Persist all tracks whenever updated
  useEffect(() => {
    try {
      localStorage.setItem("mg_saved_tracks", JSON.stringify(sanitizeTracksForStorage(allTracks)));
    } catch (e) {
      console.error("Failed to save tracks to localStorage:", e);
    }
  }, [allTracks]);

  // ---------- track selection helpers ----------
  const playTrack = useCallback((track: Track) => {
    setCurrentTrack(track);
    setAllTracks(prev => {
      const exists = prev.some(t => t.id === track.id);
      if (!exists) {
        const next = [track, ...prev];
        try { localStorage.setItem("mg_saved_tracks", JSON.stringify(sanitizeTracksForStorage(next))); } catch {}
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
    const lyricsKey = `${currentTrack.title.trim().toLowerCase()}::${currentTrack.artist.trim().toLowerCase()}`;
    const cachedLyrics = lyricsCacheRef.current.get(lyricsKey);

    if (cachedLyrics) {
      console.log(`[lyrics] CACHE_HIT: ${currentTrack.title} (${cachedLyrics.length} lines, 0ms)`);
      setCurrentLyrics(cachedLyrics);
      return;
    }

    setCurrentLyrics(null); // null = searching

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
  }, [currentTrack?.id, currentTrack?.title, currentTrack?.artist, currentTrack?.duration, currentTrack?.album]);

  // Resolve stream URL for a track (instant cache hit, multi-detail studio selection, forceFresh bypass)
  const resolveStreamUrl = useCallback(async (track: Track, forceFresh = false): Promise<string> => {
    let src = track.audioUrl ?? "";
    if (track.source === "local") {
      return src;
    }

    const cacheKey = track.id || `${track.title}__${track.artist}`;

    if (!forceFresh) {
      const cached = streamCacheRef.current.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < 2 * 60 * 60 * 1000 && !isExpiredStream(cached.url)) {
        console.log(`[playback] STREAM_CACHE_HIT: ${track.title} (0ms)`);
        return cached.url;
      }

      // If we already have a direct playable audio stream (excluding 30s spotify demo snippets and expired streams), use it immediately
      if (
        src &&
        !src.includes("p.scdn.co") &&
        !src.includes(".m3u8") &&
        !isExpiredStream(src) &&
        (
          src.includes("googlevideo.com") ||
          src.endsWith(".mp3") ||
          src.endsWith(".m4a") ||
          src.endsWith(".opus") ||
          src.startsWith("blob:") ||
          src.startsWith("asset:")
        )
      ) {
        streamCacheRef.current.set(cacheKey, { url: src, timestamp: Date.now() });
        return src;
      }
    } else {
      // Force fresh: Purge expired URL from cache
      streamCacheRef.current.delete(cacheKey);
    }

    // Resolve full track stream dynamically via native backend with multi-detail verification
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
    } catch (err) {
      console.warn("Stream resolution fallback:", err);
    }
    // Guard against passing raw webpage URLs directly to HTML5 audio element
    if (src.includes("spotify.com") || src.includes("youtube.com") || src.includes("youtu.be")) {
      return "";
    }
    return forceFresh ? "" : src;
  }, []);

  // Proactive background pre-fetch: when current track is playing, pre-fetch next track's lyrics and stream
  useEffect(() => {
    if (!currentTrack || !isPlaying || allTracks.length <= 1) return;

    const curIdx = allTracks.findIndex(t => t.id === currentTrack.id);
    if (curIdx === -1) return;

    const nextTrack = allTracks[curIdx + 1];
    if (!nextTrack) return;

    const streamKey = nextTrack.id || `${nextTrack.title}__${nextTrack.artist}`;
    const lyricsKey = `${nextTrack.title.trim().toLowerCase()}::${nextTrack.artist.trim().toLowerCase()}`;

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
    retryCountRef.current = 0;
    lastKnownTimeRef.current = 0;
    setPlaybackError(null);

    const resolveAndPlay = async () => {
      try {
        const src = await resolveStreamUrl(currentTrack);
        if (!active || !audioRef.current) return;

        if (!src) {
          setPlaybackError("No playable stream found for this track");
          setIsPlaying(false);
          audioRef.current.removeAttribute("src");
          return;
        }

        audioRef.current.src = src;
        audioRef.current.volume = volume;
        audioRef.current.load();

        if (isPlayingRef.current) {
          try {
            await audioRef.current.play();
          } catch (err: any) {
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
          setTimeout(() => {
            handleNext();
          }, 1500);
        }
      }
    };

    resolveAndPlay();

    if (lyricsWinRef.current) {
      emit("lyrics-update", {
        trackId: currentTrack.id,
        progress: 0,
        isPlaying,
        trackTitle: currentTrack.title,
        trackArtist: currentTrack.artist,
        lyrics: [],
      }).catch(() => {});
    }
  }, [currentTrack?.id]);

  // Handle audio errors — retry with fresh stream resolution and seamlessly restore playback position
  const handleAudioError = async () => {
    if (!audioRef.current || !currentTrackRef.current) return;
    const track = currentTrackRef.current;

    // Only retry for non-local tracks (local files don't expire)
    if (track.source === "local") {
      setPlaybackError("Playback failed — file may be missing or corrupted");
      setIsPlaying(false);
      return;
    }

    const maxRetries = 2;
    if (retryCountRef.current >= maxRetries) {
      console.error("[playback] STREAM_EXPIRED: Max retries reached for", track.title);
      setPlaybackError(`"${track.title}" unavailable — skipping to next song...`);
      setIsPlaying(false);
      if (audioRef.current) {
        audioRef.current.pause();
      }
      setTimeout(() => {
        handleNext();
      }, 1500);
      return;
    }

    retryCountRef.current += 1;
    const resumePos = lastKnownTimeRef.current;
    console.warn(`[playback] STREAM_REFRESH: Retrying stream resolution (attempt ${retryCountRef.current}/${maxRetries}) for "${track.title}" at ${resumePos.toFixed(1)}s`);
    setPlaybackError(null);

    // Evict stale stream from cache so retry fetches a fresh stream
    const cacheKey = track.id || `${track.title}__${track.artist}`;
    streamCacheRef.current.delete(cacheKey);

    // Small delay to allow any transient network socket reset to settle
    await new Promise(r => setTimeout(r, 400));

    try {
      const src = await resolveStreamUrl(track, true);
      if (!audioRef.current) return;
      if (!src) {
        setPlaybackError("Stream URL unavailable");
        setIsPlaying(false);
        return;
      }
      audioRef.current.src = src;
      audioRef.current.volume = volume;
      audioRef.current.load();

      // Seamlessly restore playback position when metadata is loaded
      const restorePositionAndPlay = () => {
        if (!audioRef.current) return;
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
      audioRef.current.addEventListener("canplay", restorePositionAndPlay, { once: true });

      if (isPlayingRef.current) {
        audioRef.current.play().catch(() => {});
      }
    } catch (err) {
      console.error("[playback] STREAM_REFRESH failed:", err);
      setPlaybackError(`Stream refresh failed: ${err}`);
      setIsPlaying(false);
    }
  };

  const handleAudioWaiting = () => {
    if (!isPlayingRef.current || !audioRef.current) return;
    if (stallTimeoutRef.current) clearTimeout(stallTimeoutRef.current);
    stallTimeoutRef.current = setTimeout(() => {
      if (isPlayingRef.current && audioRef.current && (audioRef.current.paused || audioRef.current.readyState < 3)) {
        console.warn("[playback] Audio stalled for >10s — attempting stream recovery");
        handleAudioError();
      }
    }, 10000);
  };

  // Emit to lyrics window whenever currentLyrics changes (i.e. finished background fetching)
  useEffect(() => {
    if (lyricsWinRef.current && currentTrack) {
      emit("lyrics-update", {
        trackId: currentTrack.id,
        progress: audioRef.current?.currentTime ?? 0,
        isPlaying,
        trackTitle: currentTrack.title,
        trackArtist: currentTrack.artist,
        lyrics: currentLyrics,
      }).catch(() => {});
    }
  }, [currentLyrics, lyricsWinOpen]);

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

    // Throttle lyric events to ~3 per second (plenty for sync)
    const now = Date.now();
    if (lyricsWinRef.current && now - lastEmitRef.current > 330) {
      lastEmitRef.current = now;
      emit("lyrics-update", {
        trackId:     currentTrackRef.current?.id    ?? "",
        progress:    t,
        isPlaying:   isPlayingRef.current,
        trackTitle:  currentTrackRef.current?.title  ?? "",
        trackArtist: currentTrackRef.current?.artist ?? "",
        lyrics:      currentLyricsRef.current,
      }).catch(() => {});
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current && currentTrack) {
      const dur = audioRef.current.duration;
      if (dur && Math.abs((currentTrack.duration || 0) - dur) > 0.1) {
        setCurrentTrack(prev => prev ? { ...prev, duration: dur } : null);
        setAllTracks(prev => prev.map(t => t.id === currentTrack.id ? { ...t, duration: dur } : t));
      }
    }
  };

  const handleSeek = useCallback((time: number) => {
    if (audioRef.current) { audioRef.current.currentTime = time; setProgress(time); }
  }, []);

  // ---------- floating lyrics window ----------
  const openLyricsWindow = useCallback(async () => {
    if (!isTauriApp()) {
      alert("Floating overlay lyrics require the MGlyrics desktop application window. Run 'run.bat' on your machine to use desktop overlay mode.");
      return;
    }
    const existing = await safeGetWebviewWindow("lyrics");
    if (existing) {
      existing.show().catch(() => {});
    } else {
      let x = undefined;
      let y = undefined;
      try {
        const savedPos = localStorage.getItem("mg_lyrics_pos");
        if (savedPos) {
          const parsed = JSON.parse(savedPos);
          if (typeof parsed.x === "number" && typeof parsed.y === "number") {
            x = parsed.x;
            y = parsed.y;
          }
        }
      } catch (e) {}

      try {
        new WebviewWindow("lyrics", {
          url:        "index.html#lyrics",
          title:      "",
          width:      920,
          height:     150,
          x,
          y,
          transparent: true,
          decorations: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          resizable:   true,
          focus:       false,      // never steal focus from game
        });
      } catch (err) {
        console.warn("Failed to create lyrics window:", err);
      }
    }
    lyricsWinRef.current = true;
    setLyricsWinOpen(true);

    // Send current state immediately
    if (currentTrackRef.current) {
      emit("lyrics-update", {
        trackId:     currentTrackRef.current.id,
        progress:    audioRef.current?.currentTime ?? 0,
        isPlaying:   isPlayingRef.current,
        trackTitle:  currentTrackRef.current.title,
        trackArtist: currentTrackRef.current.artist,
        lyrics:      currentLyricsRef.current,
      }).catch(() => {});
    }
  }, []);

  const closeLyricsWindow = useCallback(async () => {
    if (!isTauriApp()) {
      lyricsWinRef.current = false;
      setLyricsWinOpen(false);
      return;
    }
    const win = await safeGetWebviewWindow("lyrics");
    if (win) win.close().catch(() => {});
    lyricsWinRef.current = false;
    setLyricsWinOpen(false);
  }, []);

  const toggleLyrics = useCallback(() => {
    lyricsWinOpen ? closeLyricsWindow() : openLyricsWindow();
  }, [lyricsWinOpen, openLyricsWindow, closeLyricsWindow]);

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
              setProgress(newTime);
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
              setProgress(newTime);
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
              const themes = ["nebula", "cyberpunk", "terminal", "elegant", "minimal", "emerald", "sunset", "synthwave", "nordic", "tokyo"];
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
  }, [toggleLyrics, handlePrev, handleNext]);

  // ---------- local & playlist track injection ----------
  const addLocalTracks = useCallback((newTracks: Track[]) => {
    setAllTracks(prev => {
      const existingIds = new Set(prev.map(t => t.id));
      const existingUrls = new Set(prev.map(t => t.audioUrl).filter(Boolean));
      const fresh = newTracks.filter(t => !existingIds.has(t.id) && (!t.audioUrl || !existingUrls.has(t.audioUrl)));
      if (fresh.length === 0) return prev;
      const updated = [...prev, ...fresh];
      try { localStorage.setItem("mg_saved_tracks", JSON.stringify(sanitizeTracksForStorage(updated))); } catch {}
      return updated;
    });
  }, []);

  const addTrackToPlaylist = useCallback((playlistId: string, track: Track) => {
    setAllTracks(prev => {
      const exists = prev.some(t => t.id === track.id);
      if (!exists) {
        const updated = [track, ...prev];
        try { localStorage.setItem("mg_saved_tracks", JSON.stringify(sanitizeTracksForStorage(updated))); } catch {}
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
      try { localStorage.setItem("mg_playlists", JSON.stringify(updated)); } catch {}
      return updated;
    });
  }, []);

  return (
    <div style={{ height: "100vh", width: "100vw", overflow: "hidden", display: "flex", flexDirection: "column", background: "#08080C", position: "relative" }}>
      {!isTauriApp() && (
        <div style={{
          background: "linear-gradient(90deg, #7c3aed, #db2777)",
          color: "#fff",
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
        onWaiting={handleAudioWaiting}
        onStalled={handleAudioWaiting}
        onPlay={() => {
          setPlaybackError(null);
          if (stallTimeoutRef.current) {
            clearTimeout(stallTimeoutRef.current);
            stallTimeoutRef.current = null;
          }
        }}
      />

      {/* Atmospheric ambient glows */}
      <div style={{ position: "absolute", top: "-20%", left: "-10%", width: "55%", height: "65%", borderRadius: "50%", background: "rgba(138,43,226,0.07)", filter: "blur(120px)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", bottom: "-20%", right: "-10%", width: "45%", height: "55%", borderRadius: "50%", background: "rgba(236,72,153,0.04)", filter: "blur(120px)", pointerEvents: "none" }} />

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
          onSyncPlaylist={pl => setPlaylists(prev => [...prev, pl])}
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
        onClose={() => setShowShortcutsModal(false)}
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
