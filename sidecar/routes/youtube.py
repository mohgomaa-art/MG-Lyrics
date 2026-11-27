from fastapi import APIRouter, HTTPException, Query

from services.youtube_service import extract_playlist

router = APIRouter()


# Plain `def` (not `async def`): extraction is blocking, so FastAPI must run
# this in its threadpool instead of blocking the event loop.
@router.get("/playlists/youtube")
def get_youtube_playlist(url: str = Query(..., description="Public YouTube playlist URL")):
    try:
        return extract_playlist(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not extract playlist: {e}")
