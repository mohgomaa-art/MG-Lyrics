from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.spotify_service import SpotifyAuthError, import_playlist

router = APIRouter()


class SpotifyImportRequest(BaseModel):
    url: str


# Plain `def` (not `async def`): the service uses blocking `requests` calls,
# so FastAPI must run this in its threadpool instead of on the event loop.
@router.post("/import/spotify")
def import_spotify_playlist(body: SpotifyImportRequest):
    try:
        return import_playlist(body.url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except SpotifyAuthError as e:
        raise HTTPException(status_code=500, detail=f"Spotify credentials problem: {e}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Spotify API error: {e}")
