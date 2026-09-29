"""API de alertas de inactividad - TimeTrack.

Ejecutar desde la carpeta API:
    uvicorn app.main:app --port 8000        (o: python run.py)
Documentación interactiva: http://localhost:8000/docs
"""
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import date, timedelta

import psycopg
import psycopg_pool
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import scheduler, store
from .alerts import calendar, plan_deliveries, run_alerts
from .config import get_settings, now_local
from .db import ACTIVE_FILTER, close_pool, fetch_all
from .inactivity import evaluate, mask_dni, public_user
from .mailer import PLACEHOLDERS, build_email, send_email
from .metrics import build_metrics
from .schemas import AlertConfig, PreviewRequest, RunRequest, TestEmailRequest
from .workdays import DIAS_SEMANA

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.init()
    if not get_settings().admin_api_key:
        log.warning("ADMIN_API_KEY vacío: todos los endpoints protegidos responderán 503")
    scheduler.start(store.get_config())
    yield
    scheduler.shutdown()
    close_pool()


app = FastAPI(title="TimeTrack - API de Alertas", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_list,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Content-Type", "X-API-Key"],
)


@app.exception_handler(psycopg.OperationalError)
@app.exception_handler(psycopg_pool.PoolTimeout)
async def _db_error(_: Request, exc: Exception):
    log.error("Error de base de datos: %s", exc)
    return JSONResponse(status_code=503, content={"detail": "No se pudo conectar a la base de datos de horas."})


def require_key(x_api_key: str = Header(default="")) -> None:
    expected = get_settings().admin_api_key
    if not expected:
        raise HTTPException(503, "La API no tiene ADMIN_API_KEY configurada.")
    if not secrets.compare_digest(x_api_key.encode(), expected.encode()):
        raise HTTPException(401, "API key inválida.")


protected = [Depends(require_key)]


# ---------------------------------------------------------------- sistema
@app.get("/api/health")
def health():
    return {"status": "ok", "hora_local": now_local().isoformat(timespec="seconds")}


@app.get("/api/meta", dependencies=protected)
def meta():
    s = get_settings()
    cfg = store.get_config()
    cal = calendar(cfg)
    today = now_local().date()
    return {
        "hoy": today.isoformat(),
        "hoy_es_dia_control": cal.is_workday(today),
        "zona_horaria": s.timezone,
        "smtp_configurado": s.smtp_configured,
        "remitente": s.smtp_sender or None,
        "scheduler_activo": s.scheduler_enabled,
        "proximo_envio": scheduler.next_run(),
        "placeholders": PLACEHOLDERS,
        "dias_semana": DIAS_SEMANA,
    }


# ---------------------------------------------------------------- configuración
@app.get("/api/config", response_model=AlertConfig, dependencies=protected)
def get_config():
    return store.get_config()


@app.put("/api/config", dependencies=protected)
def put_config(cfg: AlertConfig):
    store.save_config(cfg)
    scheduler.apply(cfg)
    return {"ok": True, "config": cfg, "proximo_envio": scheduler.next_run()}


@app.get("/api/personal", dependencies=protected)
def personal():
    """Personal activo para asignar a grupos (sin DNI)."""
    return fetch_all(
        f"SELECT p.id_sistema AS id, p.nombre, p.usuario, p.rol::text AS rol "
        f"FROM public.personal p WHERE {ACTIVE_FILTER} ORDER BY p.nombre"
    )


@app.get("/api/calendario", dependencies=protected)
def calendario(desde: date | None = None, hasta: date | None = None):
    cfg = store.get_config()
    cal = calendar(cfg)
    desde = desde or now_local().date()
    hasta = hasta or desde + timedelta(days=60)
    if hasta < desde or (hasta - desde).days > 370:
        raise HTTPException(400, "Rango inválido (máximo 370 días).")
    dias = cal.describe(desde, hasta)
    return {
        "dias": dias,
        "feriados": [d for d in dias if d["feriado"]],
        "dias_control": sum(d["es_control"] for d in dias),
    }


# ---------------------------------------------------------------- métricas
@app.get("/api/metricas", dependencies=protected)
def metricas(dias: int = Query(30, ge=7, le=180)):
    cfg = store.get_config()
    return build_metrics(cfg, calendar(cfg), now_local().date(), dias)


@app.get("/api/inactivos", dependencies=protected)
def inactivos(solo_inactivos: bool = True):
    cfg = store.get_config()
    ev = evaluate(cfg, calendar(cfg), now_local().date())
    usuarios = [u for u in ev["usuarios"] if u["inactivo"] or not solo_inactivos]
    usuarios.sort(key=lambda u: (-u["dias_inactivo"], u["nombre"]))
    return {**ev, "usuarios": [public_user(u) for u in usuarios]}


# ---------------------------------------------------------------- alertas
@app.post("/api/alertas/ejecutar", dependencies=protected)
def ejecutar(req: RunRequest):
    """Evalúa la regla de inactividad y envía los emails (o los simula con dry_run)."""
    return run_alerts(dry_run=req.dry_run, forzar=req.forzar, disparo="manual")


SAMPLE_USER = {
    "id": 0, "nombre": "Juan Ejemplo", "dni": "30123456", "ultima_carga": None,
    "dias_inactivo": 3, "dias_es_minimo": False, "sin_registros": False, "inactivo": True,
    "grupos": [{"id": "_ejemplo", "nombre": "Grupo de ejemplo", "emails": []}],
}


@app.post("/api/alertas/preview", dependencies=protected)
def preview(req: PreviewRequest):
    """Renderiza el email con la configuración recibida (aunque no esté guardada).

    Usa un usuario de ejemplo: la vista previa no expone datos reales.
    """
    cfg = req.config or store.get_config()
    today = now_local().date()
    sample = {**SAMPLE_USER, "ultima_carga": (today - timedelta(days=5)).isoformat()}
    d = plan_deliveries([sample])[0]
    asunto, html, _ = build_email(d["usuarios"], d["grupo"]["nombre"], cfg, today)
    return {"asunto": asunto, "html": html}


@app.post("/api/alertas/test-email", dependencies=protected)
def test_email(req: TestEmailRequest):
    cfg = store.get_config()
    today = now_local().date()
    sample = {**SAMPLE_USER, "ultima_carga": (today - timedelta(days=5)).isoformat()}
    asunto, html, text = build_email([sample], "Prueba de configuración", cfg, today)
    try:
        send_email([req.to], "[PRUEBA] " + asunto, html, text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"No se pudo enviar: {exc}") from exc
    return {"ok": True}


@app.get("/api/alertas/historial", dependencies=protected)
def historial(limit: int = Query(200, ge=1, le=1000), estado: str | None = None):
    rows = store.history(limit, estado)
    for r in rows:
        r["dni"] = mask_dni(r["dni"])
    return rows
