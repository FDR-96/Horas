const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');
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

// --- Database Configuration ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT) || 5432,
});

// --- Middleware ---
app.use(compression()); // gzip para HTML, JS, CSS y JSON (la lista de obras baja ~70%)
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // For development. Set to true if using HTTPS in production
}));

// Serve static files from the root directory.
// Nunca servir archivos bajo /api/ (en cualquier capitalización): ahí vive la API
// Python con su .env y la base de alertas. Esas rutas siguen a los endpoints.
const serveStatic = express.static(__dirname);
app.use((req, res, next) => (/^\/api(\/|$)/i.test(req.path) ? next() : serveStatic(req, res, next)));

// --- Authentication Middleware ---
const checkAuth = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login.html');
    }
};

// --- Panel de administración ---
// Login con ADMIN_USER / ADMIN_PASSWORD del .env. El panel nunca ve la API key:
// sus llamadas van a /admin-api/* y este servidor las reenvía a la API Python.
const adminConfigured = () => Boolean(process.env.ADMIN_USER && process.env.ADMIN_PASSWORD);

const safeEqual = (a, b) => crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest()
);

// Bloqueo simple por IP: 5 intentos fallidos -> 15 minutos.
const loginFails = new Map();
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

const checkAdmin = (req, res, next) => {
    if (req.session.admin) return next();
    res.status(401).json({ detail: 'Sesión de administrador requerida.' });
};

app.get('/admin-auth/session', (req, res) => {
    res.json({ authenticated: Boolean(req.session.admin), usuario: req.session.admin?.usuario || null });
});

app.post('/admin-auth/login', (req, res) => {
    if (!adminConfigured()) {
        return res.status(503).json({ detail: 'El panel no está configurado (ADMIN_USER / ADMIN_PASSWORD en .env).' });
    }
    const ip = req.ip;
    const fails = loginFails.get(ip);
    if (fails && fails.count >= LOGIN_MAX_FAILS && Date.now() - fails.last < LOGIN_LOCK_MS) {
        return res.status(429).json({ detail: 'Demasiados intentos fallidos. Probá de nuevo en 15 minutos.' });
    }

    const { username = '', password = '' } = req.body || {};
    const userOk = safeEqual(username, process.env.ADMIN_USER);
    const passOk = safeEqual(password, process.env.ADMIN_PASSWORD);
    if (!(userOk && passOk)) {
        const count = fails && Date.now() - fails.last < LOGIN_LOCK_MS ? fails.count + 1 : 1;
        loginFails.set(ip, { count, last: Date.now() });
        return res.status(401).json({ detail: 'Usuario o contraseña incorrectos.' });
    }

    loginFails.delete(ip);
    req.session.regenerate(err => {
        if (err) return res.status(500).json({ detail: 'No se pudo iniciar la sesión.' });
        req.session.admin = { usuario: process.env.ADMIN_USER };
        res.json({ success: true });
    });
});

app.post('/admin-auth/logout', (req, res) => {
    delete req.session.admin;
    res.json({ success: true });
});

// Proxy /admin-api/<ruta> -> ALERTS_API_URL/api/<ruta>, agregando la API key.
app.use('/admin-api', checkAdmin, async (req, res) => {
    const baseUrl = (process.env.ALERTS_API_URL || '').replace(/\/+$/, '');
    if (!baseUrl || !process.env.ALERTS_API_KEY) {
        return res.status(503).json({ detail: 'Falta ALERTS_API_URL / ALERTS_API_KEY en .env.' });
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
        res.status(502).json({ detail: `La API de alertas no responde (${baseUrl}).` });
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

// Login
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Usuario y contraseña son requeridos.' });
    }

    try {
        const query = 'SELECT id_sistema, nombre, usuario, rol, estado FROM public.personal WHERE usuario = $1 AND dni = $2';
        const result = await pool.query(query, [username, password]);
        console.log('Resultado de la consulta de login:', result.rows);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            req.session.user = {
                id: user.id_sistema,
                nombre: user.nombre,
                usuario: user.usuario,
                rol: user.rol
            };

            if (user.estado == true || user.estado === 'true' || user.estado === 't' || user.estado === 1) {
                res.json({ success: true });
            } else {
                res.status(403).json({ success: false, message: 'Usuario inactivo. Contacte al administrador.' });
            }
        } else {
            res.status(401).json({ success: false, message: 'Credenciales incorrectas.' });
        }
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
// Eliminar solicitud por ID
app.delete('/api/solicitudes/:id', checkAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    const personalId = req.session.user.id;

    if (isNaN(id)) return res.status(400).json({ message: 'ID inválido' });

    try {
        const result = await pool.query(
            'DELETE FROM public.horas WHERE id = $1 AND personalid = $2 RETURNING *',
            [id, personalId]
        );

        if (result.rowCount === 0) return res.status(404).json({ message: 'Solicitud no encontrada' });

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
        const result = await pool.query('SELECT id_sistema, obra FROM public.obras WHERE parent_id IS NULL OR parent_id = 0 AND estado = true');
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
    const { obraId } = req.params;
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
    const fechaValida = fechaParam && /^\d{4}-\d{2}-\d{2}$/.test(fechaParam) ? fechaParam : null;
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
    const { obra: obraId, obraPadre, sector, fecha, horas, razon } = req.body;
    const personalId = req.session.user.id;

    // Basic validation
    if (!obraId || !sector || !fecha || !horas) {
        return res.status(400).json({ message: 'Por favor, complete todos los campos obligatorios.' });
    }

    // Fecha permitida: desde hace 7 dias hasta hoy.
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
        await pool.query(query, [fecha, personalId, finalObraId, subObraId, sector, horas, razon]);
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
        res.clearCookie('connect.sid');
        res.json({ success: true, message: 'Sesión cerrada.' });
    });
});


// --- Server Start ---
app.listen(port, () => {
    console.log(`Servidor corriendo en http://localhost:${port}`);
});
