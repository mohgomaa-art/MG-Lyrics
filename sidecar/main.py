import os

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.spotify import router as spotify_router
from routes.youtube import router as youtube_router

DEFAULT_ORIGINS = "http://localhost:1420,http://localhost:5173,http://tauri.localhost"
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("MG_SIDECAR_CORS_ORIGINS", DEFAULT_ORIGINS).split(",") if o.strip()]

app = FastAPI(title="MG Lyrics Player Sidecar", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(spotify_router)
app.include_router(youtube_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
