# API de alertas de inactividad (TimeTrack)

## Cómo se integra

```
 Empleados ──► app Express (server.js :3001) ──────────────► PostgreSQL "Horas"
 Admin ──► /admin/ ──login──► server.js ──/admin-api/*──►  API Python (:8000)    ▲ solo lectura
          (usuario y clave     (agrega X-API-Key            │ config + historial ─► API/data/alertas.db
           de .env)             desde .env)                 └─► SMTP ─► emails a encargados
```

El navegador nunca conoce la URL ni la API key de esta API: el panel inicia
sesión contra `server.js` (`ADMIN_USER` / `ADMIN_PASSWORD` del `.env` raíz) y
`server.js` reenvía `/admin-api/<ruta>` a `ALERTS_API_URL/api/<ruta>` con
`ALERTS_API_KEY`, que debe ser igual a `ADMIN_API_KEY` de `API/.env`.

- **La app existente no cambia su flujo.** Los empleados siguen cargando horas en
  `public.horas` vía Express. La API Python **solo lee** `personal`, `horas` y
  `sectores`; no altera el esquema.
- **Inactividad** = días de control (laborables configurados, sin feriados) desde
  la última `horas.fecha` del usuario hasta hoy inclusive.
  Se alerta cuando ese número ≥ umbral. Lógica en [app/workdays.py](app/workdays.py).
- **Configuración** (umbral, días, feriados extra, grupos, emails, mensaje) y
  **historial** de envíos viven en SQLite local (`API/data/alertas.db`).
- **Panel** (`/admin/`, servido por Express) consume la API a través del proxy de `server.js`.
- **Disparo**: siempre automático a la hora configurada (APScheduler, solo días de
  control), además del manual con `POST /api/alertas/ejecutar`. Se envía un email
  por grupo. Una misma persona no se re-alerta al mismo grupo dentro de `no_repetir_dias`.

## Puesta en marcha

```powershell
cd API
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env     # completar DB_*, ADMIN_API_KEY y SMTP_*
.\.venv\Scripts\python run.py
```

- Documentación interactiva: http://localhost:8000/docs
- Panel: http://localhost:3001/admin/ (con `npm start` corriendo). Pide el usuario
  y la contraseña de administrador definidos en el `.env` de la raíz.
- Correr **un solo proceso** (el scheduler vive dentro). Para usar cron / Programador
  de tareas en su lugar: `SCHEDULER_ENABLED=false` y programar
  `POST /api/alertas/ejecutar` con el header `X-API-Key`.

## Endpoints (todos salvo `/api/health` requieren `X-API-Key`)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/health` | Estado del servicio |
| GET | `/api/meta` | SMTP, próximo envío, placeholders |
| GET / PUT | `/api/config` | Leer / guardar configuración de alertas |
| GET | `/api/personal` | Personal activo (sin DNI) para armar grupos |
| GET | `/api/calendario?desde&hasta` | Días de control y feriados |
| GET | `/api/metricas?dias=30` | Datos del dashboard |
| GET | `/api/inactivos` | Quiénes superan hoy el umbral |
| POST | `/api/alertas/ejecutar` | `{dry_run, forzar}` evalúa y envía |
| POST | `/api/alertas/preview` | Render del email con config sin guardar |
| POST | `/api/alertas/test-email` | `{to}` email de prueba |
| GET | `/api/alertas/historial` | Envíos registrados |

## Mensaje

Asunto y mensaje admiten `{nombre}`, `{dni}`, `{dias}`, `{ultima_carga}`,
`{grupo}`, `{umbral}`, `{cantidad}`, `{fecha}`. El email siempre destaca el nombre
completo y el DNI de cada persona.
