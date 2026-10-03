import { invoke, isTauri, convertFileSrc } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Returns true if running inside the native Tauri desktop webview.
 */
export function isTauriApp(): boolean {
  try {
    if (typeof isTauri === "function" && isTauri()) {
      return true;
    }
    return typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
  } catch {
    return false;
  }
}

/**
 * Safe invoke wrapper that guards against execution inside regular web browsers.
 * If running in Tauri, executes native Rust command.
 * If running in web browser preview, provides functional mock/preview responses
 * so the UI functions smoothly without throwing fatal desktop errors.
 */
export async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriApp()) {
    console.info(`[TauriBridge:WebPreview] Handling '${cmd}' with browser fallback`, args);
    const input = ((args as any)?.input || (args as any)?.url || "") as string;

    if (cmd === "get_preview_info") {
      const isSpotify = input.includes("spotify.com");
      const isSoundCloud = input.includes("soundcloud.com");
      const provider = isSoundCloud ? "soundcloud" : isSpotify ? "spotify" : "youtube";
      const cleanName = input.includes("http") ? (input.split("/").filter(Boolean).pop()?.replace(/[-_]/g, " ") || "Stream Preview") : (input || "Demonstration Track");

      return {
        title: cleanName.charAt(0).toUpperCase() + cleanName.slice(1),
        artist: provider === "spotify" ? "Spotify Artist" : provider === "soundcloud" ? "SoundCloud Creator" : "YouTube Artist",
        thumbnail: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300",
        stream_url: "",
        video_url: input || "",
        is_playable: false,
        provider,
      } as unknown as T;
    }

    if (cmd === "get_download_dir") {
      return "Downloads/MG-Lyrics" as unknown as T;
    }

    if (cmd === "check_ytdlp" || cmd === "check_spotdl" || cmd === "check_ffmpeg") {
      return "v2026.03 (Ready)" as unknown as T;
    }

    if (cmd === "scan_local_tracks") {
      return [] as unknown as T;
    }

    if (cmd === "download_audio") {
      return `Downloaded '${input || "Audio"}' successfully to Downloads/MG-Lyrics` as unknown as T;
    }

    if (cmd === "get_playlist_info") {
      return {
        title: "Curated Web Playlist",
        description: "Preview playlist loaded in browser environment",
        thumbnail: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300",
        uploader: "MGlyrics Music Curation",
        tracks: [
          { id: "web-1", title: "Midnight Ambient Wave", artist: "Synth Collective", duration: 215, video_url: "https://youtube.com/watch?v=1" },
          { id: "web-2", title: "Lofi Coding Session", artist: "Chill Station", duration: 184, video_url: "https://youtube.com/watch?v=2" },
          { id: "web-3", title: "SoundCloud Spotlight Track", artist: "Indie Producer", duration: 242, video_url: "https://soundcloud.com/track/3" },
        ],
      } as unknown as T;
    }

    if (cmd === "fetch_lyrics") {
      return [
        { time: 0, text: "MGlyrics Universal Music Engine" },
        { time: 4, text: "Seamless streaming across Spotify, YouTube Music, and SoundCloud" },
        { time: 8, text: "Synchronized lyrics automatically matched and loaded" },
        { time: 14, text: "Floating desktop overlay ready on native launch" },
      ] as unknown as T;
    }

    return null as unknown as T;
  }
  return invoke<T>(cmd, args);
}

/**
 * Safe convertFileSrc wrapper
 */
export function safeConvertFileSrc(filePath: string): string {
  if (!isTauriApp()) {
    return filePath;
  }
  try {
    return convertFileSrc(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Safe event emitter wrapper
 */
export async function safeEmit(event: string, payload?: unknown): Promise<void> {
  if (!isTauriApp()) {
    return;
  }
  try {
    await emit(event, payload);
  } catch (err) {
    console.debug(`[TauriBridge] emit ${event} ignored in browser mode:`, err);
  }
}

/**
 * Safe event listener wrapper
 */
export async function safeListen<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<() => void> {
  if (!isTauriApp()) {
    return () => {};
  }
  try {
    return await listen<T>(event, handler);
  } catch {
    return () => {};
  }
}

/**
 * Safe WebviewWindow getter
 */
export async function safeGetWebviewWindow(label: string): Promise<WebviewWindow | null> {
  if (!isTauriApp()) {
    return null;
  }
  try {
    return await WebviewWindow.getByLabel(label);
  } catch {
    return null;
  }
}
