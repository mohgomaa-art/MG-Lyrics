from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.spotify_service import import_playlist

router = APIRouter()


class SpotifyImportRequest(BaseModel):
    url: str


@router.post("/import/spotify")
async def import_spotify_playlist(body: SpotifyImportRequest):
    try:
        return import_playlist(body.url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Spotify API error: {e}")
