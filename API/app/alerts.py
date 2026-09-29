"""Orquestación del disparo de alertas."""
import logging
import threading

from . import store
from .config import get_settings, now_local
from .inactivity import evaluate
from .mailer import build_email, send_email
from .schemas import AlertConfig
from .workdays import calendar_from_config

log = logging.getLogger("alertas")
_run_lock = threading.Lock()


def calendar(cfg: AlertConfig):
    return calendar_from_config(cfg, get_settings().holidays_country)


def plan_deliveries(inactivos: list[dict]) -> list[dict]:
    """Un email por grupo con todos sus inactivos.

    Un usuario en varios grupos se notifica a cada uno.
    """
    by_group: dict[str, dict] = {}
    for u in inactivos:
        for g in u["grupos"]:
            d = by_group.setdefault(g["id"], {"grupo": g, "usuarios": []})
            d["usuarios"].append(u)
    return list(by_group.values())


def run_alerts(dry_run: bool = False, forzar: bool = False, disparo: str = "manual") -> dict:
    if not _run_lock.acquire(blocking=False):
        return {"ejecutado": False, "motivo": "Ya hay una ejecución en curso"}
    try:
        cfg = store.get_config()
        cal = calendar(cfg)
        today = now_local().date()

        if not forzar and not cal.is_workday(today):
            return {"ejecutado": False, "motivo": f"{today:%d/%m/%Y} no es día de control"}

        ev = evaluate(cfg, cal, today)
        inactivos = [u for u in ev["usuarios"] if u["inactivo"]]
        recientes = set() if forzar else store.recently_alerted(cfg.no_repetir_dias)

        omitidos = 0
        pendientes = []
        for u in inactivos:
            grupos = [g for g in u["grupos"] if (u["id"], g["nombre"]) not in recientes]
            omitidos += len(u["grupos"]) - len(grupos)
            if grupos:
                pendientes.append({**u, "grupos": grupos})

        resultados, log_rows = [], []
        for d in plan_deliveries(pendientes):
            grupo, usuarios = d["grupo"], d["usuarios"]
            to = grupo["emails"]
            asunto, html, text = build_email(usuarios, grupo["nombre"], cfg, today)

            if not to:
                estado, detalle = "sin_destinatario", "El grupo no tiene emails configurados"
            elif dry_run:
                estado, detalle = "simulado", None
            else:
                try:
                    send_email(to, asunto, html, text)
                    estado, detalle = "enviado", None
                except Exception as exc:  # noqa: BLE001 - se informa por grupo
                    log.exception("Error enviando alerta a %s", to)
                    estado, detalle = "error", str(exc)

            resultados.append({
                "grupo": grupo["nombre"], "destinatarios": to, "asunto": asunto,
                "usuarios": [u["nombre"] for u in usuarios], "estado": estado, "detalle": detalle,
            })
            if not dry_run:
                log_rows += [{
                    "disparo": disparo, "personal_id": u["id"], "nombre": u["nombre"],
                    "dni": u["dni"], "grupo": grupo["nombre"], "destinatarios": to,
                    "dias_inactivo": u["dias_inactivo"], "estado": estado, "detalle": detalle,
                } for u in usuarios]

        store.log_alerts(log_rows)
        return {
            "ejecutado": True,
            "dry_run": dry_run,
            "fecha_referencia": ev["fecha_referencia"],
            "evaluados": len(ev["usuarios"]),
            "inactivos": len(inactivos),
            "omitidos_por_repeticion": omitidos,
            "emails": resultados,
        }
    finally:
        _run_lock.release()
