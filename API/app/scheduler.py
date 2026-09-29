"""Envío automático diario (APScheduler, dentro del proceso de la API).

Correr la API con un solo worker: con varios, cada uno programaría su propio
disparo (la regla "no repetir" evita duplicados, pero es trabajo repetido).
Alternativa sin scheduler: SCHEDULER_ENABLED=false y llamar a
POST /api/alertas/ejecutar desde cron o el Programador de tareas de Windows.
"""
import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from .config import get_settings
from .schemas import AlertConfig

log = logging.getLogger("scheduler")
JOB_ID = "alertas_diarias"
_scheduler: BackgroundScheduler | None = None


def _job() -> None:
    from .alerts import run_alerts  # import diferido: evita ciclo

    try:
        result = run_alerts(disparo="automatico")
        log.info("Disparo automático: %s", {k: v for k, v in result.items() if k != "emails"})
    except Exception:  # noqa: BLE001
        log.exception("Falló el disparo automático de alertas")


def start(cfg: AlertConfig) -> None:
    global _scheduler
    s = get_settings()
    if not s.scheduler_enabled:
        return
    _scheduler = BackgroundScheduler(timezone=s.timezone)
    _scheduler.start()
    apply(cfg)


def apply(cfg: AlertConfig) -> None:
    """(Re)programa el job según la configuración guardada."""
    if _scheduler is None:
        return
    hh, mm = cfg.hora_envio.split(":")
    # Corre todos los días; run_alerts decide si hoy es día de control
    # (así los feriados se respetan sin reprogramar).
    _scheduler.add_job(_job, CronTrigger(hour=int(hh), minute=int(mm)), id=JOB_ID,
                       misfire_grace_time=3600, coalesce=True, replace_existing=True)


def next_run() -> str | None:
    if _scheduler is None:
        return None
    job = _scheduler.get_job(JOB_ID)
    return job.next_run_time.isoformat() if job and job.next_run_time else None


def shutdown() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
