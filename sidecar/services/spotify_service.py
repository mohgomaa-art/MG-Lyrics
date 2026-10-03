import os
import time
import base64
import re
import requests

_token: str | None = None
_token_expires_at: float = 0


def _get_app_token() -> str:
    global _token, _token_expires_at
    if _token and time.time() < _token_expires_at:
        return _token

    client_id = os.getenv("SPOTIFY_CLIENT_ID")
    client_secret = os.getenv("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env")

    auth = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    resp = requests.post(
        "https://accounts.spotify.com/api/token",
        headers={"Authorization": f"Basic {auth}"},
        data={"grant_type": "client_credentials"},
    )
    resp.raise_for_status()
    data = resp.json()
    _token = data["access_token"]
    _token_expires_at = time.time() + data.get("expires_in", 3600) - 60
    return _token


def extract_playlist_id(url: str) -> str:
    m = re.search(r"playlist/([a-zA-Z0-9]+)", url)
    if not m:
        raise ValueError(f"Could not extract playlist ID from URL: {url}")
    return m.group(1)


def _api_get(path: str, params: dict | None = None) -> dict:
    token = _get_app_token()
    resp = requests.get(
        f"https://api.spotify.com/v1{path}",
        headers={"Authorization": f"Bearer {token}"},
        params=params,
    )
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
            if not t:
                continue
            tracks.append({
                "title": t["name"],
                "artists": [a["name"] for a in t.get("artists", [])],
                "album": t.get("album", {}).get("name"),
                "cover": t["album"]["images"][0]["url"] if t.get("album", {}).get("images") else None,
                "duration_ms": t.get("duration_ms"),
                "spotify_id": t["id"],
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
