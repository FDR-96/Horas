"""Persistencia local de la API (SQLite en API/data/alertas.db).

Guarda la configuración de alertas y el historial de envíos sin tocar el
esquema de la base de horas.
"""
import json
import sqlite3
import threading
from datetime import date, timedelta

from .config import get_settings, now_local
from .schemas import AlertConfig

_lock = threading.Lock()


def _db_path():
    return get_settings().data_dir / "alertas.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    get_settings().data_dir.mkdir(parents=True, exist_ok=True)
    with _lock, _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                data TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS alert_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fecha_envio TEXT NOT NULL,
                disparo TEXT NOT NULL,
                personal_id INTEGER NOT NULL,
                nombre TEXT,
                dni TEXT,
                grupo TEXT,
                destinatarios TEXT,
                dias_inactivo INTEGER,
                estado TEXT NOT NULL,
                detalle TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_alert_log_fecha ON alert_log (fecha_envio);
            """
        )


def get_config() -> AlertConfig:
    with _connect() as conn:
        row = conn.execute("SELECT data FROM config WHERE id = 1").fetchone()
    if row is None:
        return AlertConfig()
    return AlertConfig.model_validate(json.loads(row["data"]))


def save_config(cfg: AlertConfig) -> None:
    data = cfg.model_dump_json()
    with _lock, _connect() as conn:
        conn.execute(
            "INSERT INTO config (id, data, updated_at) VALUES (1, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (data, now_local().strftime("%Y-%m-%d %H:%M:%S")),
        )


def log_alerts(rows: list[dict]) -> None:
    if not rows:
        return
    ts = now_local().strftime("%Y-%m-%d %H:%M:%S")
    with _lock, _connect() as conn:
        conn.executemany(
            "INSERT INTO alert_log (fecha_envio, disparo, personal_id, nombre, dni, grupo, "
            "destinatarios, dias_inactivo, estado, detalle) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
                (ts, r["disparo"], r["personal_id"], r["nombre"], r["dni"], r["grupo"],
                 ", ".join(r["destinatarios"]), r["dias_inactivo"], r["estado"], r.get("detalle"))
                for r in rows
            ],
        )


def recently_alerted(days: int) -> set[tuple[int, str]]:
    """(personal_id, grupo) con envío exitoso en los últimos `days` días (hoy incluido)."""
    if days <= 0:
        return set()
    cutoff = (now_local().date() - timedelta(days=days - 1)).isoformat()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT personal_id, grupo FROM alert_log "
            "WHERE estado = 'enviado' AND fecha_envio >= ?",
            (cutoff,),
        ).fetchall()
    return {(r["personal_id"], r["grupo"]) for r in rows}


def history(limit: int = 200, estado: str | None = None) -> list[dict]:
    sql = "SELECT * FROM alert_log"
    params: list = []
    if estado:
        sql += " WHERE estado = ?"
        params.append(estado)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    with _connect() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def daily_counts(desde: date) -> dict[str, dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT substr(fecha_envio, 1, 10) AS dia, "
            "SUM(estado = 'enviado') AS enviados, SUM(estado = 'error') AS errores "
            "FROM alert_log WHERE fecha_envio >= ? GROUP BY dia",
            (desde.isoformat(),),
        ).fetchall()
    return {r["dia"]: {"enviados": r["enviados"], "errores": r["errores"]} for r in rows}
