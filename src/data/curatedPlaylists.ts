import { useEffect, useState } from "react";

export interface FeaturedCard {
  title: string;
  desc: string;
  query: string;
  url: string;
  color: string;
}

export interface CuratedPlaylistItem {
  id: string;
  title: string;
  desc: string;
  provider: "spotify" | "youtube" | "soundcloud";
  category: "charts" | "pop" | "hiphop" | "rock" | "edm" | "chill" | "latin" | "decades";
  url: string;
  color: string;
  badge: string;
  gradient: string;
}

export interface CuratedData {
  version: number;
  featured: { spotify: FeaturedCard[]; ytmusic: FeaturedCard[]; soundcloud: FeaturedCard[] };
  catalog: CuratedPlaylistItem[];
}

export const EMPTY_CURATED: CuratedData = {
  version: 0,
  featured: { spotify: [], ytmusic: [], soundcloud: [] },
  catalog: [],
};

export const CATEGORY_LABELS: Record<string, string> = {
  charts: "Charts",
  pop: "Pop",
  hiphop: "Hip-Hop",
  rock: "Rock",
  edm: "EDM",
  chill: "Chill & Lo-Fi",
  latin: "Latin",
  decades: "Decades",
};

// Optional override: set VITE_CURATED_PLAYLISTS_URL to a remote JSON with the same shape.
const SOURCE: string =
  (import.meta.env.VITE_CURATED_PLAYLISTS_URL as string | undefined) || "/curated-playlists.json";
const CACHE_KEY = "mg_curated_playlists_cache";

function valid(d: unknown): d is CuratedData {
  const x = d as CuratedData;
  return !!x && Array.isArray(x.catalog) && !!x.featured &&
    Array.isArray(x.featured.spotify) && Array.isArray(x.featured.ytmusic) && Array.isArray(x.featured.soundcloud);
}

/** Loads the curated playlist catalog at runtime (network/asset first, last good copy as fallback). */
export function useCuratedPlaylists(): { data: CuratedData; loading: boolean; error: string } {
  const [data, setData] = useState<CuratedData>(EMPTY_CURATED);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(SOURCE, { cache: "no-cache" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!valid(j)) throw new Error("Invalid catalog format");
        if (!alive) return;
        setData(j);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(j)); } catch { /* quota */ }
      } catch (e) {
        if (!alive) return;
        try {
          const c = localStorage.getItem(CACHE_KEY);
          const j = c ? JSON.parse(c) : null;
          if (valid(j)) { setData(j); return; }
        } catch { /* ignore */ }
        setError(`Could not load curated playlists (${e instanceof Error ? e.message : String(e)})`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  return { data, loading, error };
}
