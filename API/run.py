"""Arranque rápido: python run.py (desde la carpeta API)."""
import uvicorn

from app.config import get_settings

if __name__ == "__main__":
    s = get_settings()
    # Un solo worker: el scheduler de envíos vive dentro del proceso.
    uvicorn.run("app.main:app", host=s.api_host, port=s.api_port)
