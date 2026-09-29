"""Cálculo de días laborables / días de control.

Un día es "de control" cuando:
  1. su día de semana está en `dias_control` (0=lunes ... 6=domingo), y
  2. no es feriado nacional (si `excluir_feriados_nacionales`) ni un feriado extra
     cargado en el panel (puentes, asuetos de la empresa, vacaciones colectivas).

La inactividad de un usuario se mide en días de control transcurridos desde su
última carga, no en días corridos: un fin de semana o un feriado no suman.
"""
from bisect import bisect_right
from datetime import date, timedelta

import holidays as pyholidays

DIAS_SEMANA = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]


class WorkCalendar:
    def __init__(
        self,
        dias_control: list[int],
        feriados_extra: dict[date, str] | None = None,
        excluir_feriados_nacionales: bool = True,
        country: str = "AR",
    ):
        self.dias_control = set(dias_control)
        self.feriados_extra = feriados_extra or {}
        self.excluir_nacionales = excluir_feriados_nacionales
        self.country = country
        self._by_year: dict[int, pyholidays.HolidayBase] = {}

    def _national(self, year: int) -> pyholidays.HolidayBase:
        if year not in self._by_year:
            try:
                self._by_year[year] = pyholidays.country_holidays(
                    self.country, years=year, language="es"
                )
            except (NotImplementedError, KeyError, ValueError):
                self._by_year[year] = pyholidays.country_holidays(self.country, years=year)
        return self._by_year[year]

    def holiday_name(self, d: date) -> str | None:
        if d in self.feriados_extra:
            return self.feriados_extra[d] or "No laborable (empresa)"
        if self.excluir_nacionales:
            return self._national(d.year).get(d)
        return None

    def is_workday(self, d: date) -> bool:
        return d.weekday() in self.dias_control and self.holiday_name(d) is None

    def workdays_between(self, start: date, end: date) -> list[date]:
        """Días de control en el rango [start, end], ordenados."""
        out, d = [], start
        while d <= end:
            if self.is_workday(d):
                out.append(d)
            d += timedelta(days=1)
        return out

    def count_workdays_after(self, last: date, ref: date) -> int:
        """Días de control en (last, ref]. Es la cantidad de días "sin carga"."""
        if last >= ref:
            return 0
        return len(self.workdays_between(last + timedelta(days=1), ref))

    def previous_workday(self, d: date, inclusive: bool = True, max_back: int = 60) -> date | None:
        cur = d if inclusive else d - timedelta(days=1)
        for _ in range(max_back):
            if self.is_workday(cur):
                return cur
            cur -= timedelta(days=1)
        return None

    def next_workday(self, d: date, inclusive: bool = True, max_ahead: int = 60) -> date | None:
        cur = d if inclusive else d + timedelta(days=1)
        for _ in range(max_ahead):
            if self.is_workday(cur):
                return cur
            cur += timedelta(days=1)
        return None

    def describe(self, start: date, end: date) -> list[dict]:
        """Detalle día por día (para el calendario del panel)."""
        out, d = [], start
        while d <= end:
            name = self.holiday_name(d)
            out.append({
                "fecha": d.isoformat(),
                "dia_semana": DIAS_SEMANA[d.weekday()],
                "es_control": self.is_workday(d),
                "feriado": name,
            })
            d += timedelta(days=1)
        return out


def missed_workdays(sorted_workdays: list[date], last: date | None) -> int:
    """Versión rápida de count_workdays_after sobre una lista precalculada.

    `sorted_workdays` debe terminar en la fecha de referencia. Si `last` es None
    devuelve el total (el usuario no tiene cargas en toda la ventana).
    """
    if last is None:
        return len(sorted_workdays)
    return len(sorted_workdays) - bisect_right(sorted_workdays, last)


def calendar_from_config(cfg, country: str = "AR") -> WorkCalendar:
    return WorkCalendar(
        dias_control=cfg.dias_control,
        feriados_extra={f.fecha: f.descripcion for f in cfg.feriados_extra},
        excluir_feriados_nacionales=cfg.excluir_feriados_nacionales,
        country=country,
    )
