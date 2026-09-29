"""Métricas para el dashboard del panel."""
from datetime import date, timedelta

from . import store
from .db import ACTIVE_FILTER, fetch_all
from .inactivity import DEFAULT_GROUP_NAME, evaluate, public_user
from .schemas import AlertConfig
from .workdays import WorkCalendar

SQL_DIARIO = f"""
SELECT h.fecha,
       COUNT(DISTINCT h.personalid) AS usuarios,
       COALESCE(SUM(EXTRACT(EPOCH FROM h.horas)), 0) / 3600.0 AS horas
FROM public.horas h
JOIN public.personal p ON p.id_sistema = h.personalid
WHERE h.fecha BETWEEN %(desde)s AND %(hasta)s
  AND {ACTIVE_FILTER}
  AND NOT (p.id_sistema = ANY(%(excl)s))
GROUP BY h.fecha
"""

SQL_SECTORES = f"""
SELECT COALESCE(s.sector, 'Sin sector') AS sector,
       COALESCE(SUM(EXTRACT(EPOCH FROM h.horas)), 0) / 3600.0 AS horas
FROM public.horas h
JOIN public.personal p ON p.id_sistema = h.personalid
LEFT JOIN public.sectores s ON s.id_sistema = h.sectorid
WHERE h.fecha BETWEEN %(desde)s AND %(hasta)s
  AND {ACTIVE_FILTER}
  AND NOT (p.id_sistema = ANY(%(excl)s))
GROUP BY 1
ORDER BY 2 DESC
"""

BUCKETS = [("0", 0, 0), ("1", 1, 1), ("2", 2, 2), ("3–5", 3, 5), ("6–10", 6, 10), ("+10", 11, 10**6)]


def build_metrics(cfg: AlertConfig, cal: WorkCalendar, today: date, dias: int) -> dict:
    desde = today - timedelta(days=dias - 1)
    params = {"desde": desde, "hasta": today, "excl": list(cfg.excluidos)}

    ev = evaluate(cfg, cal, today)
    usuarios = ev["usuarios"]
    total = len(usuarios)
    ref = date.fromisoformat(ev["fecha_referencia"])

    diario = {r["fecha"]: r for r in fetch_all(SQL_DIARIO, params)}
    serie = []
    for d in cal.workdays_between(desde, today):
        r = diario.get(d)
        con = int(r["usuarios"]) if r else 0
        serie.append({
            "fecha": d.isoformat(),
            "con_carga": con,
            "sin_carga": max(total - con, 0),
            "horas": round(float(r["horas"]), 1) if r else 0.0,
            "tasa": round(con / total * 100, 1) if total else 0.0,
            "en_curso": d > ref,
        })

    cerrados = [s for s in serie if not s["en_curso"]]
    ultimo = cerrados[-1] if cerrados else None
    horas_total = sum(s["horas"] for s in serie)
    cargas_total = sum(s["con_carga"] for s in serie)
    inactivos = [u for u in usuarios if u["inactivo"]]

    buckets = []
    for label, lo, hi in BUCKETS:
        buckets.append({
            "label": label,
            "cantidad": sum(1 for u in usuarios if lo <= u["dias_inactivo"] <= hi),
            "supera_umbral": lo >= cfg.umbral_dias,
        })

    grupos: dict[str, dict] = {}
    for u in usuarios:
        for g in u["grupos"]:
            row = grupos.setdefault(g["nombre"], {"grupo": g["nombre"], "activos": 0, "inactivos": 0})
            row["inactivos" if u["inactivo"] else "activos"] += 1
    orden = [g.nombre for g in cfg.grupos] + [DEFAULT_GROUP_NAME]
    grupos_list = sorted(grupos.values(), key=lambda r: orden.index(r["grupo"]) if r["grupo"] in orden else 999)

    alertas = store.daily_counts(desde)
    top = sorted(inactivos, key=lambda u: (-u["dias_inactivo"], u["nombre"]))[:25]

    return {
        "desde": desde.isoformat(),
        "hasta": today.isoformat(),
        "fecha_referencia": ev["fecha_referencia"],
        "umbral_dias": cfg.umbral_dias,
        "kpis": {
            "personal_controlado": total,
            "inactivos": len(inactivos),
            "sin_registros": sum(1 for u in usuarios if u["sin_registros"]),
            "con_carga_ultimo_dia": ultimo["con_carga"] if ultimo else 0,
            "ultimo_dia_control": ultimo["fecha"] if ultimo else None,
            "tasa_promedio": round(sum(s["tasa"] for s in cerrados) / len(cerrados), 1) if cerrados else 0.0,
            "horas_total": round(horas_total, 1),
            "horas_por_carga": round(horas_total / cargas_total, 1) if cargas_total else 0.0,
            "alertas_enviadas": sum(a["enviados"] or 0 for a in alertas.values()),
            "alertas_error": sum(a["errores"] or 0 for a in alertas.values()),
            "dias_control_periodo": len(serie),
        },
        "serie_diaria": serie,
        "distribucion": buckets,
        "por_grupo": grupos_list,
        "por_sector": [
            {"sector": r["sector"], "horas": round(float(r["horas"]), 1)}
            for r in fetch_all(SQL_SECTORES, params)
        ],
        "top_inactivos": [public_user(u) for u in top],
        "proximo_dia_control": (lambda d: d.isoformat() if d else None)(cal.next_workday(today, inclusive=False)),
    }
