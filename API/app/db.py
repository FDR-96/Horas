"""Acceso de solo lectura a la base PostgreSQL de la app de horas."""
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import get_settings

_pool: ConnectionPool | None = None

# Personal que se controla: activo (public.personal.estado es boolean) y con
# usuario cargado. Sin usuario no puede iniciar sesión ni cargar horas, así que
# controlarlo solo generaría alertas falsas. Los que no cumplen no se evalúan,
# no generan alertas y no aparecen en métricas ni en grupos.
ACTIVE_FILTER = "p.estado IS TRUE AND NULLIF(BTRIM(p.usuario), '') IS NOT NULL"


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        s = get_settings()
        conninfo = make_conninfo(
            host=s.db_host, port=s.db_port, dbname=s.db_name,
            user=s.db_user, password=s.db_password, connect_timeout=10,
        )
        _pool = ConnectionPool(
            conninfo, min_size=1, max_size=5,
            kwargs={"row_factory": dict_row}, open=True, timeout=10,
        )
    return _pool


def fetch_all(sql: str, params: dict | None = None) -> list[dict]:
    with get_pool().connection() as conn, conn.cursor() as cur:
        cur.execute(sql, params or {})
        return cur.fetchall()


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
