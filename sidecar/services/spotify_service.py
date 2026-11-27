import os
import time
import base64
import re
import requests

TOKEN_URL = os.getenv("SPOTIFY_TOKEN_URL", TOKEN_URL)
API_BASE = os.getenv("SPOTIFY_API_BASE", "https://api.spotify.com/v1").rstrip("/")
HTTP_TIMEOUT = float(os.getenv("MG_SIDECAR_HTTP_TIMEOUT", "15"))

_token: str | None = None
_token_expires_at: float = 0

# Network timeouts (connect, read) in seconds. Without these a hung
# connection would block the request forever.
TOKEN_TIMEOUT = (5, 10)
API_TIMEOUT = (5, 15)


class SpotifyAuthError(RuntimeError):
    """Raised when the client-credentials token cannot be obtained."""


def _get_app_token(force_refresh: bool = False) -> str:
    global _token, _token_expires_at
    if not force_refresh and _token and time.time() < _token_expires_at:
        return _token

    client_id = os.getenv("SPOTIFY_CLIENT_ID")
    client_secret = os.getenv("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise SpotifyAuthError("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env")

    auth = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    try:
        resp = requests.post(
            TOKEN_URL,
            headers={"Authorization": f"Basic {auth}"},
            data={"grant_type": "client_credentials"},
            timeout=TOKEN_TIMEOUT,
        )
    except requests.RequestException as e:
        raise SpotifyAuthError(f"Could not reach Spotify accounts service: {e}") from e
    if resp.status_code in (400, 401):
        raise SpotifyAuthError(
            "Spotify rejected the client credentials — check SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET"
        )
    resp.raise_for_status()
    data = resp.json()
    _token = data["access_token"]
    _token_expires_at = time.time() + data.get("expires_in", 3600) - 60
    return _token


def extract_playlist_id(url: str) -> str:
    # Supports open.spotify.com/playlist/<id> (any locale prefix) and spotify:playlist:<id>
    m = re.search(r"playlist[:/]([a-zA-Z0-9]+)", url)
    if not m:
        raise ValueError(f"Could not extract playlist ID from URL: {url}")
    return m.group(1)


def _api_get(path: str, params: dict | None = None, _retried: bool = False) -> dict:
    token = _get_app_token()
    try:
        resp = requests.get(
            f"{API_BASE}{path}",
            headers={"Authorization": f"Bearer {token}"},
            params=params,
            timeout=API_TIMEOUT,
        )
    except requests.RequestException as e:
        raise RuntimeError(f"Could not reach the Spotify API: {e}") from e

    if resp.status_code == 401 and not _retried:
        # Cached token rejected — refresh once and retry.
        global _token
        _token = None
        _get_app_token(force_refresh=True)
        return _api_get(path, params, _retried=True)
    if resp.status_code == 404:
        raise ValueError("Spotify playlist not found (it may be private or deleted)")
    if resp.status_code == 429:
        retry_after = resp.headers.get("Retry-After", "a few")
        raise RuntimeError(f"Spotify rate limit hit — try again in {retry_after} seconds")
    resp.raise_for_status()
    return resp.json()


def get_playlist_info(playlist_id: str) -> dict:
    data = _api_get(f"/playlists/{playlist_id}", {"fields": "id,name,description,images,external_urls"})
    return {
        "id": data["id"],
        "name": data["name"],
        "description": data.get("description", ""),
        "cover": data["images"][0]["url"] if data.get("images") else None,
        "external_url": data.get("external_urls", {}).get("spotify"),
    }


def get_playlist_tracks(playlist_id: str) -> list[dict]:
    tracks = []
    url = f"/playlists/{playlist_id}/tracks"
    params = {"fields": "items(track(id,name,artists,album,duration_ms,external_urls)),next,total", "limit": "100"}

    while url:
        data = _api_get(url, params)
        for item in data.get("items", []):
            t = item.get("track")
            if not t or not t.get("id"):
                # Removed/unavailable tracks and podcast episodes come back as null
                continue
            tracks.append({
                "title": t["name"],
                "artists": [a["name"] for a in t.get("artists", [])],
                "album": (t.get("album") or {}).get("name"),
                "cover": ((t.get("album") or {}).get("images") or [{}])[0].get("url"),
                "duration_ms": t.get("duration_ms"),
                "spotify_id": t.get("id"),
                "external_url": t.get("external_urls", {}).get("spotify"),
            })
        next_url = data.get("next")
        if next_url:
            url = next_url.replace("https://api.spotify.com/v1", "")
            params = None
        else:
            url = None

    return tracks


def import_playlist(url: str) -> dict:
    playlist_id = extract_playlist_id(url)
    info = get_playlist_info(playlist_id)
    tracks = get_playlist_tracks(playlist_id)
    return {**info, "track_count": len(tracks), "tracks": tracks}
