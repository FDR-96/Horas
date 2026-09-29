"""Acceso de solo lectura a la base PostgreSQL de la app de horas."""
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import get_settings

_pool: ConnectionPool | None = None

# Mismo criterio que server.js para "usuario activo" (estado puede ser bool, int o texto).
ACTIVE_FILTER = "p.estado::text IN ('true', 't', '1')"


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
