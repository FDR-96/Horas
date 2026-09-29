"""Configuración de entorno (API/.env)."""
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Base de datos
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "Horas"
    db_user: str = "postgres"
    db_password: str = ""

    # Seguridad
    admin_api_key: str = ""
    cors_origins: str = "http://localhost:3001,http://127.0.0.1:3001"

    # Servidor
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    timezone: str = "America/Argentina/Buenos_Aires"
    holidays_country: str = "AR"
    scheduler_enabled: bool = True
    data_dir: Path = BASE_DIR / "data"

    # SMTP
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_security: str = "starttls"  # starttls | ssl | none
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_from_name: str = "TimeTrack - Alertas"

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def smtp_sender(self) -> str:
        """Remitente: SMTP_FROM, o la cuenta de login si no se definió."""
        return self.smtp_from or self.smtp_user

    @property
    def smtp_configured(self) -> bool:
        return bool(self.smtp_host and self.smtp_sender)

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)


@lru_cache
def get_settings() -> Settings:
    return Settings()


def now_local() -> datetime:
    return datetime.now(get_settings().tz)
