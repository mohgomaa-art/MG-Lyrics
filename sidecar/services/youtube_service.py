import yt_dlp


def extract_playlist(url: str) -> dict:
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

        if info.get("_type") != "playlist":
            raise ValueError("URL is not a playlist")

        entries = list(info.get("entries") or [])

    return {
        "id": info.get("id"),
        "title": info.get("title"),
        "channel": info.get("channel") or info.get("uploader", ""),
        "video_count": info.get("playlist_count") or len(entries),
        "videos": [
            {
                "id": entry["id"],
                "title": entry.get("title"),
                "url": entry.get("url"),
                "duration_seconds": entry.get("duration"),
            }
            for entry in entries
            if entry.get("id")
        ],
    }
