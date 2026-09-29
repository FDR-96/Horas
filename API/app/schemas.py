"""Modelos de configuración y requests."""
import re
from datetime import date

from pydantic import BaseModel, Field, field_validator

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
HORA_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def clean_emails(values: list[str]) -> list[str]:
    out: list[str] = []
    for raw in values:
        e = raw.strip().lower()
        if not e:
            continue
        if not EMAIL_RE.match(e):
            raise ValueError(f"Email inválido: {raw}")
        if e not in out:
            out.append(e)
    return out


class Grupo(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    nombre: str = Field(min_length=1, max_length=80)
    emails: list[str] = []
    miembros: list[int] = []

    @field_validator("emails")
    @classmethod
    def _emails(cls, v: list[str]) -> list[str]:
        return clean_emails(v)


class FeriadoExtra(BaseModel):
    fecha: date
    descripcion: str = Field("", max_length=120)


DEFAULT_ASUNTO = "⚠️ Alerta de inactividad: {cantidad} persona(s) sin cargar horas"
DEFAULT_MENSAJE = (
    "{nombre} (DNI {dni}) no registra carga de horas hace {dias} día(s) laborable(s). "
    "Última carga: {ultima_carga}. Por favor, contactalo para regularizar la situación."
)


class AlertConfig(BaseModel):
    umbral_dias: int = Field(2, ge=1, le=60)
    dias_control: list[int] = [0, 1, 2, 3, 4]
    excluir_feriados_nacionales: bool = True
    feriados_extra: list[FeriadoExtra] = []
    # El envío automático está siempre activo, a esta hora, en días de control.
    hora_envio: str = "09:00"
    no_repetir_dias: int = Field(1, ge=0, le=30)
    grupos: list[Grupo] = []
    emails_por_defecto: list[str] = []
    excluidos: list[int] = []
    asunto: str = Field(DEFAULT_ASUNTO, min_length=1, max_length=200)
    mensaje: str = Field(DEFAULT_MENSAJE, min_length=1, max_length=2000)

    @field_validator("dias_control")
    @classmethod
    def _dias(cls, v: list[int]) -> list[int]:
        v = sorted(set(v))
        if not v or any(d < 0 or d > 6 for d in v):
            raise ValueError("Seleccioná al menos un día de control (0=lunes … 6=domingo)")
        return v

    @field_validator("hora_envio")
    @classmethod
    def _hora(cls, v: str) -> str:
        if not HORA_RE.match(v):
            raise ValueError("Hora inválida, usar formato HH:MM (24 h)")
        return v

    @field_validator("emails_por_defecto")
    @classmethod
    def _emails(cls, v: list[str]) -> list[str]:
        return clean_emails(v)

    @field_validator("grupos")
    @classmethod
    def _grupos(cls, v: list[Grupo]) -> list[Grupo]:
        ids = [g.id for g in v]
        if len(ids) != len(set(ids)):
            raise ValueError("Hay grupos con id repetido")
        return v


class RunRequest(BaseModel):
    dry_run: bool = False
    forzar: bool = Field(False, description="Ignora día no laborable y la regla de no repetir")


class TestEmailRequest(BaseModel):
    to: str

    @field_validator("to")
    @classmethod
    def _to(cls, v: str) -> str:
        return clean_emails([v])[0]


class PreviewRequest(BaseModel):
    config: AlertConfig | None = None
