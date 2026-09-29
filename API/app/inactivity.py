"""Evaluación de inactividad: días de control sin carga de horas por usuario."""
from datetime import date, timedelta

from .db import ACTIVE_FILTER, fetch_all
from .schemas import AlertConfig
from .workdays import WorkCalendar, missed_workdays

# Ventana máxima hacia atrás. Quien no cargó nada en este período figura con
# el total de días de la ventana y `dias_es_minimo = True` ("+N" en el panel).
LOOKBACK_DAYS = 120

DEFAULT_GROUP_ID = "_default"
DEFAULT_GROUP_NAME = "Sin grupo"

SQL_PERSONAL = f"""
SELECT p.id_sistema AS id, p.nombre, p.dni::text AS dni, p.usuario, p.rol::text AS rol,
       (SELECT MAX(h.fecha) FROM public.horas h
         WHERE h.personalid = p.id_sistema AND h.fecha <= %(ref)s) AS ultima_carga
FROM public.personal p
WHERE {ACTIVE_FILTER}
ORDER BY p.nombre
"""


def mask_dni(dni: str | None) -> str:
    if not dni:
        return "—"
    digits = "".join(ch for ch in dni if ch.isalnum())
    return "•••• " + digits[-3:] if len(digits) > 3 else "••••"


def format_dni(dni: str | None) -> str:
    """30123456 -> 30.123.456 (si es numérico)."""
    if not dni:
        return "—"
    s = dni.strip()
    if s.isdigit() and len(s) >= 7:
        return f"{int(s):,}".replace(",", ".")
    return s


def groups_for(cfg: AlertConfig) -> dict[int, list[dict]]:
    by_member: dict[int, list[dict]] = {}
    for g in cfg.grupos:
        info = {"id": g.id, "nombre": g.nombre, "emails": g.emails}
        for m in g.miembros:
            by_member.setdefault(m, []).append(info)
    return by_member


def default_group(cfg: AlertConfig) -> dict:
    return {"id": DEFAULT_GROUP_ID, "nombre": DEFAULT_GROUP_NAME, "emails": cfg.emails_por_defecto}


def evaluate(cfg: AlertConfig, cal: WorkCalendar, today: date) -> dict:
    # El día de hoy siempre cuenta como día controlado.
    ref = today
    window_start = ref - timedelta(days=LOOKBACK_DAYS)
    wdays = cal.workdays_between(window_start, ref)
    by_member = groups_for(cfg)
    fallback = default_group(cfg)
    excluidos = set(cfg.excluidos)

    usuarios = []
    for r in fetch_all(SQL_PERSONAL, {"ref": ref}):
        if r["id"] in excluidos:
            continue
        last: date | None = r["ultima_carga"]
        fuera = last is None or last < window_start
        dias = missed_workdays(wdays, None if fuera else last)
        usuarios.append({
            "id": r["id"],
            "nombre": (r["nombre"] or "").strip() or r["usuario"],
            "usuario": r["usuario"],
            "rol": r["rol"],
            "dni": r["dni"],
            "ultima_carga": last.isoformat() if last else None,
            "dias_inactivo": dias,
            "dias_es_minimo": fuera,
            "sin_registros": last is None,
            "inactivo": dias >= cfg.umbral_dias,
            "grupos": by_member.get(r["id"]) or [fallback],
        })

    return {
        "fecha_referencia": ref.isoformat(),
        "es_dia_control_hoy": cal.is_workday(today),
        "umbral_dias": cfg.umbral_dias,
        "usuarios": usuarios,
    }


def public_user(u: dict) -> dict:
    """Vista para el panel: el DNI es la contraseña de login, así que se enmascara."""
    out = {k: v for k, v in u.items() if k != "dni"}
    out["dni"] = mask_dni(u["dni"])
    out["grupos"] = [{"id": g["id"], "nombre": g["nombre"]} for g in u["grupos"]]
    return out
