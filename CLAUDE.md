# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

TimeTrack: carga de horas de los empleados de Metalúrgica Albace, con un panel de administración y alertas por email cuando alguien deja de cargar horas. Interfaz, mensajes y comentarios en español rioplatense (voseo).

## Comandos

No hay paso de build, linter ni suite de tests.

```bash
npm start                      # server.js en :3001 (lee .env de la raíz)

cd API
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # Linux: .venv/bin/
.venv/Scripts/python run.py    # FastAPI en API_HOST:API_PORT (8000); docs en /docs
```

Chequeos de sintaxis que se usan en lugar de tests:

```bash
node --check server.js
node --input-type=module --check < assets/solic.js     # los .js del frontend son ES modules
API/.venv/Scripts/python -m compileall -q API/app
```

La API corre **un solo proceso**: el scheduler de envíos vive dentro (APScheduler); con varios workers se duplicarían los disparos.

## Arquitectura

Dos servicios más una base PostgreSQL externa (`public.personal`, `horas`, `obras`, `sectores`):

- **`server.js` (Express)** sirve la app de empleados y el panel `/admin/`, maneja todas las sesiones y hace de **proxy** `/admin-api/<ruta>` → `ALERTS_API_URL/api/<ruta>` agregando `X-API-Key`. El navegador nunca ve la URL ni la key de la API Python. Escribe en `horas`.
- **`API/` (FastAPI)** evalúa la inactividad, envía los emails (smtplib) y calcula las métricas del panel. Solo **lee** la base de horas. Su configuración y el historial de envíos viven en SQLite (`API/data/alertas.db`, ignorado por git). Ver `API/README.md` para la lista de endpoints.

### Acceso y seguridad (server.js)
- **Archivos estáticos por lista explícita**: `/assets`, `/admin/css`, `/admin/js` (cada uno con su propio `express.static` y su carpeta como raíz), más `login.html` y `manifest.json`. Todo lo demás de la raíz del repo (`.git`, `server.js`, `node_modules`, `*_legacy.html`, `*.txt`) **no** se sirve. Un archivo público nuevo hay que agregarlo ahí.
- Las páginas de empleados (`empleado_dash.html`, `empleado_solic.html`, `/dashboard`, `/solicitar`) requieren `req.session.user`; `/admin/` requiere `req.session.admin`.
- **Login único en `login.html` → `POST /login`**: si coincide con `ADMIN_USER`/`ADMIN_PASSWORD` del `.env` crea sesión de admin y responde `redirect: '/admin/'`. Si no, busca al empleado con `usuario` + **`dni` como contraseña**; los inactivos (`personal.estado = false`) no obtienen sesión. Hay límite de intentos en memoria (admin, por usuario y por IP).
- **Sesiones en MemoryStore**: reiniciar el servicio desloguea a todos. Cookie `tt.sid`, `SameSite=Lax`; `COOKIE_SECURE=true` / `TRUST_PROXY` recién cuando haya HTTPS o proxy.
- **CSP estricta**: nada de scripts ni handlers en línea (`onclick=`). Solo se permiten scripts de `cdn.jsdelivr.net` (Chart.js) y estilos y fuentes de Google Fonts. Los estilos en línea sí están permitidos.

### Frontend de empleados (`assets/`)
JS nativo con ES modules, sin dependencias ni build. `assets/app.js` es la base compartida:
- `api()`: detecta la redirección al login por sesión vencida.
- `openListSheet` / `openActionSheet`: bottom sheets que se cierran con el botón atrás de Android vía `history.pushState`.
- `icon()`: íconos SVG en línea.
- `store`: `localStorage` protegido con try/catch.

Cada página tiene su módulo (`login.js`, `dash.js`, `solic.js`, `install.js`). Zonas táctiles ≥ 48px e inputs a 16px.

### Service worker (`sw.js`)
- `server.js` sirve `/sw.js` reemplazando `'__VERSION__'` por un hash del contenido de `SW_FILES` + `assets/`. Cualquier cambio desplegado actualiza la caché de los teléfonos sin tocar versiones a mano.
- Precachea solo archivos públicos. Las páginas con sesión se guardan al abrirlas con un 200 real.
- `/api`, `/login`, `/logout` y `/admin*` van siempre a la red.
- Solo se activa en HTTPS o `localhost`. El servidor actual usa http, así que en producción no corre.
- Un módulo nuevo de la interfaz debe agregarse a `PRECACHE`.

### Panel de administración (`admin/`)
- **Estructura:** módulos en `admin/js`. `state.js` guarda la config en edición con detección de cambios sin guardar, y `api.js` llama siempre a `/admin-api/*`.
- **Gráficos:** Chart.js, con los colores tomados de los tokens CSS de claro/oscuro.
- **DNI:** las respuestas de la API lo traen enmascarado. Solo el email lleva el DNI completo, porque así se pidió.

### Lógica de alertas (`API/app/`)
- **Cálculo:** inactividad = días de control desde la última `horas.fecha` hasta **hoy inclusive**. Los días de control son los de semana configurados, menos los feriados de Argentina (librería `holidays`) y los no laborables que se cargan en el panel (`workdays.py`). Hay alerta cuando ese número alcanza el umbral.
- **Envío:** siempre automático a `hora_envio`, solo en días de control, con **un email por grupo** (`alerts.plan_deliveries`). El personal sin grupo va a `emails_por_defecto`. `no_repetir_dias` evita repetir la alerta a la misma persona y grupo.
- **Zona horaria:** el servidor está en UTC, así que el `CronTrigger` necesita la zona de `TIMEZONE` explícita.
- **Personal controlado:** `db.ACTIVE_FILTER` define a quién se evalúa: `estado IS TRUE` y `usuario` no vacío (sin usuario no puede loguearse ni cargar horas). Los demás no aparecen en métricas, alertas ni grupos.

## Particularidades de los datos
- **`obras.id_sistema` no es único:** existen ids repetidos entre una obra raíz y una subobra de **otra** obra.
  - La jerarquía (`/api/obras-jerarquia`) tiene 2 niveles y trata cada fila como un nodo propio.
  - El frontend identifica una obra por `padre:id`.
  - `POST /api/solicitar` recibe `obraPadre` (0 = raíz) para elegir la fila. Si falta, usa la raíz.
  - En `horas` queda `obraid` = padre y `subobraid` = subobra, o 0 si es raíz.
- **`horas.horas` es `INTERVAL`:** `pg` lo devuelve como `{ hours, minutes }` y el cliente envía `"HH:MM"`. Para leerlo usar `intervalToMinutes()` de `app.js`.
- **Fechas:** `horas.fecha` es `DATE`; en JSON llega como `YYYY-MM-DDT00:00:00.000Z` porque el servidor está en UTC, y el frontend se queda con la parte antes de la `T`. Solo se puede cargar hasta 7 días atrás, y borrar solo lo cargado o trabajado hoy; las dos reglas se validan también en el servidor.

## Configuración
- **Dos `.env`, ambos fuera de git** (plantillas en `.env.example` y `API/.env.example`):
  - Raíz: `DB_*`, `SESSION_SECRET`, `ADMIN_USER`/`ADMIN_PASSWORD`, `ALERTS_API_URL`/`ALERTS_API_KEY`.
  - `API/.env`: `DB_*`, `ADMIN_API_KEY`, `SMTP_*`, `TIMEZONE`.
- **Claves:** `ALERTS_API_KEY` (raíz) tiene que ser igual a `ADMIN_API_KEY` (API).
- **Remitente:** si `SMTP_FROM` está vacío, se usa `SMTP_USER`.

## Despliegue
- **Producción:** servidor Debian `192.168.10.8` (el mismo que aloja PostgreSQL), en `~/apps/Horas` (clon del repo). Dos servicios systemd:
  - `timetrack` (node): sus logs van a `/var/log/timetrack*.log`.
  - `timetrack-api` (uvicorn, escuchando en `127.0.0.1:8000`).
- **Acceso público:** `https://albace_hr.avalon.ar` pasa por Cloudflare, con un túnel que corre en `192.168.10.13` y llega al puerto 3001. No se toca nada de eso.
  - Por eso el `.env` lleva `TRUST_PROXY=192.168.10.13` y `COOKIE_SECURE=true`. Sin `TRUST_PROXY` todos los usuarios comparten la IP del túnel, y el límite de intentos de login los bloquearía a todos juntos.
  - Cloudflare inyecta Rocket Loader, Web Analytics y un script en línea de detección de bots. La CSP bloquea los dos últimos, pero la app funciona igual.
- **Actualizar:** `git pull`, sin `npm install`, porque **`node_modules` está versionado en el repo**.
- **Reinicios:** reiniciar `timetrack` solo si cambió `server.js` (desloguea a todos). Si solo cambiaron archivos de `assets/` o `admin/`, alcanza con el pull. Reiniciar `timetrack-api` si cambió `API/`.
- **Servidor de pruebas:** `192.168.10.10` (`~/Apps/Albace.Horas`, servicios `albace-horas` / `albace-horas-api`). Está apagado y deshabilitado para no duplicar los mails de alertas.
- **Legacy:** `empleado_*_legacy.html` son las pantallas previas al rediseño. No se sirven; se conservan solo como referencia o para volver atrás.
