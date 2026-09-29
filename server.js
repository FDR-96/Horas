const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const compression = require('compression');

// --- Configuración (.env en la raíz, no versionado) ---
try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch (err) {
    if (err.code !== 'ENOENT') throw err; // sin archivo: se usan las variables del entorno
}

const requiredEnv = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'SESSION_SECRET'];
const missingEnv = requiredEnv.filter(name => !process.env[name]);
if (missingEnv.length) {
    console.error(`Faltan variables de entorno en .env: ${missingEnv.join(', ')}`);
    process.exit(1);
}

const app = express();
const port = Number(process.env.PORT) || 3001;
// COOKIE_SECURE=true cuando se sirva por HTTPS (la cookie de sesión no viaja por http).
const HTTPS = process.env.COOKIE_SECURE === 'true';
// TRUST_PROXY=1 solo si queda detrás de un proxy inverso (nginx, túnel), para que req.ip sea el real.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable('x-powered-by');

// --- Database Configuration ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT) || 5432,
});

// --- Cabeceras de seguridad ---
const CSP = [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",           // Chart.js del panel
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com", // el service worker cachea fuentes
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
    res.set({
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Cross-Origin-Opener-Policy': 'same-origin',
    });
    if (HTTPS) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
});

// --- Middleware ---
app.use(compression()); // gzip/brotli para HTML, JS, CSS y JSON
app.use(express.json({ limit: '100kb' }));

// Sesiones: cookie propia, sin sesiones para visitantes anónimos y con vencimiento.
const SESSION_COOKIE = 'tt.sid';
const EMPLEADO_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // se renueva con el uso (rolling)
const ADMIN_MAX_AGE = 8 * 60 * 60 * 1000;
app.use(session({
    name: SESSION_COOKIE,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: HTTPS, maxAge: EMPLEADO_MAX_AGE },
}));

// --- Service worker (app de empleados) ---
// Se sirve con la versión = hash de los archivos de la interfaz. Así cualquier
// cambio desplegado con git pull (incluso sin reiniciar) actualiza la caché de
// los teléfonos, sin tener que acordarse de subir un número de versión.
const SW_FILES = ['sw.js', 'manifest.json', 'login.html', 'empleado_dash.html', 'empleado_solic.html'];
const listarArchivos = dir => fs.readdirSync(path.join(__dirname, dir), { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? listarArchivos(path.join(dir, e.name)) : [path.join(dir, e.name)]));

app.get('/sw.js', (req, res, next) => {
    try {
        const hash = crypto.createHash('sha1');
        [...SW_FILES, ...listarArchivos('assets')].sort()
            .forEach(f => hash.update(f).update(fs.readFileSync(path.join(__dirname, f))));
        const src = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8')
            .replace("'__VERSION__'", `'${hash.digest('hex').slice(0, 12)}'`);
        res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }).send(src);
    } catch (err) {
        next(err);
    }
});

// --- Autenticación ---
const checkAuth = (req, res, next) => {
    if (req.session.user) return next();
    res.redirect('/login.html');
};

const adminConfigured = () => Boolean(process.env.ADMIN_USER && process.env.ADMIN_PASSWORD);

const safeEqual = (a, b) => crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest()
);
const isAdminUser = username => adminConfigured() && safeEqual(username, process.env.ADMIN_USER);
const isAdminPassword = password => adminConfigured() && safeEqual(password, process.env.ADMIN_PASSWORD);

// Límite de intentos fallidos de login (en memoria). Cuenta por clave:
//   "admin:<ip>"          -> 5 fallos contra la cuenta de administrador
//   "user:<ip>:<usuario>" -> 10 fallos contra un mismo usuario (la clave es el DNI)
//   "ip:<ip>"             -> 30 fallos desde una IP con cualquier usuario
// Bloqueo de 15 minutos al superar el límite.
const LOCK_MS = 15 * 60 * 1000;
const LIMITS = { admin: 5, user: 10, ip: 30 };
const fails = new Map();

function isLocked(key, max) {
    const f = fails.get(key);
    return Boolean(f && f.count >= max && Date.now() - f.last < LOCK_MS);
}
function registerFail(key) {
    const f = fails.get(key);
    fails.set(key, { count: f && Date.now() - f.last < LOCK_MS ? f.count + 1 : 1, last: Date.now() });
}
setInterval(() => { // limpieza de entradas vencidas
    const now = Date.now();
    for (const [k, f] of fails) if (now - f.last > LOCK_MS) fails.delete(k);
}, LOCK_MS).unref();

/** Sesión nueva (evita fijación de sesión) con los datos indicados. */
function startSession(req, data, maxAge, done) {
    req.session.regenerate(err => {
        if (err) return done(err);
        Object.assign(req.session, data);
        req.session.cookie.maxAge = maxAge;
        done(null);
    });
}

const checkAdmin = (req, res, next) => {
    if (req.session.admin) return next();
    res.status(401).json({ detail: 'Sesión de administrador requerida.' });
};

// --- Archivos públicos (lista explícita) ---
// Solo se sirve lo que figura acá. Todo lo demás (server.js, .git, node_modules,
// API/, .env, *.txt, versiones _legacy) queda fuera aunque exista en la carpeta.
// Cada carpeta tiene su propio express.static con esa carpeta como raíz: una ruta
// con "..", codificada o no, no puede salir de ella.
const staticOpts = { index: false, dotfiles: 'deny', redirect: false };
app.use('/assets', express.static(path.join(__dirname, 'assets'), staticOpts));
app.use('/admin/css', express.static(path.join(__dirname, 'admin', 'css'), staticOpts));
app.use('/admin/js', express.static(path.join(__dirname, 'admin', 'js'), staticOpts));

const archivo = nombre => (req, res) => res.sendFile(path.join(__dirname, nombre));
app.get('/login.html', archivo('login.html'));
app.get('/manifest.json', archivo('manifest.json'));
// Páginas de empleados: solo con sesión.
app.get('/empleado_dash.html', checkAuth, archivo('empleado_dash.html'));
app.get('/empleado_solic.html', checkAuth, archivo('empleado_solic.html'));

// Panel de administración: la página solo se entrega con sesión de administrador.
app.get(['/admin', '/admin/', '/admin/index.html'], (req, res) => {
    if (!req.session.admin) return res.redirect('/login.html');
    if (req.path === '/admin') return res.redirect('/admin/');
    res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

app.get('/admin-auth/session', (req, res) => {
    res.json({ authenticated: Boolean(req.session.admin), usuario: req.session.admin?.usuario || null });
});

app.post('/admin-auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie(SESSION_COOKIE);
        res.json({ success: true });
    });
});

// Proxy /admin-api/<ruta> -> ALERTS_API_URL/api/<ruta>, agregando la API key.
app.use('/admin-api', checkAdmin, async (req, res) => {
    const baseUrl = (process.env.ALERTS_API_URL || '').replace(/\/+$/, '');
    if (!baseUrl || !process.env.ALERTS_API_KEY) {
        return res.status(503).json({ detail: 'Falta ALERTS_API_URL / ALERTS_API_KEY en .env.' });
    }
    // Solo rutas simples bajo /api (sin "..", codificado o no).
    if (!/^\/[\w\-/]*(\?.*)?$/.test(req.url) || /(\.\.|%2e|%2f|%5c)/i.test(req.url)) {
        return res.status(400).json({ detail: 'Ruta inválida.' });
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    try {
        const upstream = await fetch(`${baseUrl}/api${req.url}`, {
            method: req.method,
            headers: {
                'X-API-Key': process.env.ALERTS_API_KEY,
                ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
            },
            body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
            signal: AbortSignal.timeout(120000),
        });
        res.status(upstream.status)
            .type(upstream.headers.get('content-type') || 'application/json')
            .send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
        console.error('Error llamando a la API de alertas:', err.message);
        res.status(502).json({ detail: 'La API de alertas no responde.' });
    }
});

// --- Page Routes ---
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

app.get('/dashboard', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'empleado_dash.html'));
});

app.get('/solicitar', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'empleado_solic.html'));
});


// --- API Routes ---

// Login (empleados y administrador)
app.post('/login', async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';

    if (!username || !password || username.length > 100 || password.length > 100) {
        return res.status(400).json({ success: false, message: 'Usuario y contraseña son requeridos.' });
    }

    const ip = req.ip;
    const bloqueado = { success: false, message: 'Demasiados intentos fallidos. Probá de nuevo en 15 minutos.' };
    const keyIp = `ip:${ip}`;
    const keyUser = `user:${ip}:${username.toLowerCase()}`;
    const keyAdmin = `admin:${ip}`;
    if (isLocked(keyIp, LIMITS.ip) || isLocked(keyUser, LIMITS.user)) return res.status(429).json(bloqueado);

    // Credenciales de administrador (.env): entra directo al panel de administración.
    const esUsuarioAdmin = isAdminUser(username);
    if (esUsuarioAdmin) {
        if (isLocked(keyAdmin, LIMITS.admin)) return res.status(429).json(bloqueado);
        if (isAdminPassword(password)) {
            fails.delete(keyAdmin);
            return startSession(req, { admin: { usuario: process.env.ADMIN_USER } }, ADMIN_MAX_AGE, err => {
                if (err) return res.status(500).json({ success: false, message: 'No se pudo iniciar la sesión.' });
                res.json({ success: true, redirect: '/admin/' });
            });
        }
        // Si no es la clave del admin, puede ser un empleado con ese mismo usuario: se sigue.
    }

    try {
        const query = 'SELECT id_sistema, nombre, usuario, rol, estado FROM public.personal WHERE usuario = $1 AND dni = $2';
        const result = await pool.query(query, [username, password]);
        if (!result.rows.length) {
            registerFail(keyIp);
            registerFail(keyUser);
            if (esUsuarioAdmin) registerFail(keyAdmin);
            return res.status(401).json({ success: false, message: 'Credenciales incorrectas.' });
        }
        const user = result.rows[0];
        if (!(user.estado == true || user.estado === 'true' || user.estado === 't' || user.estado === 1)) {
            // Sin sesión para usuarios inactivos.
            return res.status(403).json({ success: false, message: 'Usuario inactivo. Contacte al administrador.' });
        }
        fails.delete(keyUser);
        const datos = { user: { id: user.id_sistema, nombre: user.nombre, usuario: user.usuario, rol: user.rol } };
        startSession(req, datos, EMPLEADO_MAX_AGE, err => {
            if (err) return res.status(500).json({ success: false, message: 'No se pudo iniciar la sesión.' });
            res.json({ success: true });
        });
    } catch (error) {
        console.error('Error en el login:', error);
        res.status(500).json({ success: false, message: 'Error del servidor.' });
    }
});

// Get user info for dashboard
app.get('/api/user', checkAuth, (req, res) => {
    res.json({
        usuario: req.session.user.usuario,
        nombre: req.session.user.nombre,
        id_usuario: req.session.user.id
    });
});

// Eliminar una carga propia. Solo las cargadas o trabajadas hoy (la misma regla
// que muestra la interfaz, ahora también validada en el servidor).
app.delete('/api/solicitudes/:id', checkAuth, async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const personalId = req.session.user.id;

    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID inválido' });

    try {
        const result = await pool.query(
            `DELETE FROM public.horas
             WHERE id = $1 AND personalid = $2
               AND (fechacarga::date = CURRENT_DATE OR fecha::date = CURRENT_DATE)
             RETURNING id`,
            [id, personalId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Solo se pueden eliminar las cargas de hoy.' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Error eliminando solicitud:', err);
        res.status(500).json({ message: 'Error eliminando la solicitud' });
    }
});


// Get recent requests for the logged-in user
app.get('/api/solicitudes', checkAuth, async (req, res) => {
    const personalId = req.session.user.id;
    try {
        const query = `
         SELECT
            h.id,
            h.estado,
            -- Concatenamos obra y subobra si existe
            CASE
                WHEN subobra.obra IS NOT NULL THEN obra.obra || ' / ' || subobra.obra
                ELSE obra.obra
            END AS nombre_obra,
            h.fecha,
            h.fechacarga::date AS fecha_carga,
            h.horas AS horas_solicitadas
        FROM public.horas h
        -- Join con la obra principal
        JOIN public.obras obra ON h.obraid = obra.id_sistema
        -- Join opcional con la subobra (si existe)
        LEFT JOIN public.obras subobra ON h.subobraid = subobra.id_sistema
        WHERE h.personalid = $1
        AND (
            -- Condición 1: Traer lo que se cargó hoy (si es que hay algo)
            h.fechacarga::date = CURRENT_DATE
            OR
            -- Condición 2: Traer lo del último día histórico registrado
            h.fechacarga::date = (
                SELECT MAX(h2.fechacarga::date)
                FROM public.horas h2
                WHERE h2.personalid = $1
                    AND h2.fechacarga::date < CURRENT_DATE
            )
        )
        ORDER BY
            h.fechacarga DESC;
        `;
        const result = await pool.query(query, [personalId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching solicitudes:', error);
        res.status(500).json({ message: 'Error al obtener las solicitudes.' });
    }
});

// Get all "obras" (projects)
app.get('/api/obras', checkAuth, async (req, res) => {
    try {
        // Selects only parent obras
        const result = await pool.query('SELECT id_sistema, obra FROM public.obras WHERE (parent_id IS NULL OR parent_id = 0) AND estado = true');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching obras:', error);
        res.status(500).json({ message: 'Error al obtener las obras.' });
    }
});
app.get('/api/obras-jerarquia', checkAuth, async (req, res) => {
    try {
        const query = `
            SELECT id_sistema, obra, parent_id
            FROM public.obras
            WHERE estado = true
            ORDER BY
                (CASE WHEN parent_id IS NULL OR parent_id = 0 THEN 0 ELSE 1 END),
                obra
        `;

        const result = await pool.query(query);
        const obras = result.rows;
        const hierarchy = [];
        const raices = {};

        // En public.obras hay id_sistema repetidos entre una obra raíz y una subobra
        // de otra obra. Cada fila es un nodo propio: solo las raíces se indexan por id
        // (son las únicas que pueden ser padre; la jerarquía tiene dos niveles).
        obras.forEach(o => {
            if (o.parent_id === null || o.parent_id === 0) {
                const nodo = { ...o, subobras: [] };
                raices[o.id_sistema] = nodo;
                hierarchy.push(nodo);
            }
        });

        obras.forEach(o => {
            const esRaiz = o.parent_id === null || o.parent_id === 0;
            // Si el padre no existe (inactivo), la subobra no se muestra.
            if (!esRaiz && raices[o.parent_id]) {
                raices[o.parent_id].subobras.push({ ...o, subobras: [] });
            }
        });

        res.json(hierarchy);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Error en la jerarquía.' });
    }
});

// Get "sub-obras" for a given "obra"
app.get('/api/subobras/:obraId', checkAuth, async (req, res) => {
    const obraId = Number.parseInt(req.params.obraId, 10);
    if (!Number.isInteger(obraId)) return res.status(400).json({ message: 'Obra inválida.' });
    try {
        const result = await pool.query('SELECT id_sistema, obra FROM public.obras WHERE parent_id = $1 AND estado = true', [obraId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching sub-obras:', error);
        res.status(500).json({ message: 'Error al obtener las sub-obras.' });
    }
});

// Get all "sectores"
app.get('/api/sectores', checkAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT id_sistema, sector FROM public.sectores WHERE estado = true');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching sectores:', error);
        res.status(500).json({ message: 'Error al obtener los sectores.' });
    }
});

// Get hours for the logged-in user for today
app.get('/api/horas-hoy', checkAuth, async (req, res) => {
    const personalId = req.session.user.id;
    // Acepta fecha local del cliente para evitar desfases por zona horaria
    const fechaParam = req.query.fecha;
    const fechaValida = typeof fechaParam === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fechaParam) ? fechaParam : null;
    try {
        const query = fechaValida
            ? `SELECT fecha, horas FROM public.horas WHERE personalid = $1 AND fecha::date = $2::date`
            : `SELECT fecha, horas FROM public.horas WHERE personalid = $1 AND DATE(fecha) = CURRENT_DATE`;
        const params = fechaValida ? [personalId, fechaValida] : [personalId];
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching horas hoy:', error);
        res.status(500).json({ message: 'Error al obtener horas de hoy.' });
    }
});

// Submit a new hour request
app.post('/api/solicitar', checkAuth, async (req, res) => {
    const { obra, obraPadre, sector, fecha, horas, razon } = req.body || {};
    const personalId = req.session.user.id;

    const obraId = Number.parseInt(obra, 10);
    const sectorId = Number.parseInt(sector, 10);
    if (!Number.isInteger(obraId) || !Number.isInteger(sectorId) || !fecha || !horas) {
        return res.status(400).json({ message: 'Por favor, complete todos los campos obligatorios.' });
    }

    // Horas "HH:MM": entre 1 minuto y 24 h.
    const hm = typeof horas === 'string' && horas.match(/^(\d{1,2}):([0-5]\d)$/);
    const minutos = hm ? Number(hm[1]) * 60 + Number(hm[2]) : 0;
    if (!hm || minutos <= 0 || minutos > 24 * 60) {
        return res.status(400).json({ message: 'La cantidad de horas no es válida.' });
    }

    const motivo = typeof razon === 'string' ? razon.trim() : '';
    if (motivo.length > 255) {
        return res.status(400).json({ message: 'Las observaciones pueden tener hasta 255 caracteres.' });
    }

    // Fecha permitida: desde hace 7 dias hasta hoy.
    if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return res.status(400).json({ message: 'La fecha seleccionada no es valida.' });
    }
    const fechaSolicitada = new Date(`${fecha}T00:00:00`);
    if (Number.isNaN(fechaSolicitada.getTime())) {
        return res.status(400).json({ message: 'La fecha seleccionada no es valida.' });
    }

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const fechaMinima = new Date(hoy);
    fechaMinima.setDate(fechaMinima.getDate() - 7);

    if (fechaSolicitada < fechaMinima || fechaSolicitada > hoy) {
        return res.status(400).json({ message: 'La fecha debe estar dentro de los ultimos 7 dias.' });
    }

    try {
        // Determinar si la obra elegida es una subobra. Hay id_sistema repetidos entre
        // una raíz y una subobra de otra obra: `obraPadre` (0 = raíz) indica cuál se
        // eligió. Sin ese dato (pantalla anterior) se usa la raíz, como en las cargas
        // históricas de esos ids.
        const obraResult = await pool.query(
            'SELECT COALESCE(parent_id, 0) AS parent_id FROM public.obras WHERE id_sistema = $1 AND estado = true ORDER BY COALESCE(parent_id, 0)',
            [obraId]
        );
        let fila = obraResult.rows[0];
        if (obraPadre !== undefined && obraPadre !== null && obraPadre !== '') {
            fila = obraResult.rows.find(r => Number(r.parent_id) === Number(obraPadre));
        }
        if (!fila) {
            return res.status(400).json({ message: 'La obra seleccionada no es válida.' });
        }

        const parentId = Number(fila.parent_id);
        const finalObraId = parentId || obraId;
        const subObraId = parentId ? obraId : 0;

        const query = `
            INSERT INTO public.horas
            (fecha, personalid, obraid, subobraid, sectorid, fechacarga, horas, estado, motivo)
            VALUES ($1, $2, $3, $4, $5, NOW(), $6, 'Aprobado', $7)
        `;
        await pool.query(query, [fecha, personalId, finalObraId, subObraId, sectorId, horas, motivo]);
        res.status(201).json({ success: true, message: 'Solicitud enviada correctamente.' });
    } catch (error) {
        console.error('Error inserting new request:', error);
        res.status(500).json({ success: false, message: 'Error al guardar la solicitud.' });
    }
});

// Logout
app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ message: 'No se pudo cerrar la sesión.' });
        }
        res.clearCookie(SESSION_COOKIE);
        res.json({ success: true, message: 'Sesión cerrada.' });
    });
});

// Todo lo que no coincide con una ruta: 404 sin detalles.
app.use((req, res) => res.status(404).type('text/plain').send('No encontrado'));

// Errores no controlados: sin volcar trazas al cliente.
app.use((err, req, res, next) => {
    console.error('Error no controlado:', err);
    if (res.headersSent) return next(err);
    if (err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ message: 'Solicitud inválida.' });
    }
    res.status(500).json({ message: 'Error del servidor.' });
});


// --- Server Start ---
app.listen(port, () => {
    console.log(`Servidor corriendo en http://localhost:${port}`);
});
