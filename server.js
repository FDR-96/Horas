const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = 3001;

// --- Database Configuration ---
// IMPORTANT: Move these details to a .env file for production
const pool = new Pool({
    user: 'postgres',
    host: '192.168.10.8',
    database: 'Horas',
    password: 'Meta#4545',
    port: 5432,
});

// --- Middleware ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Session configuration
app.use(session({
    secret: 'aASDaskllkdasC212m3namssadd', // IMPORTANT: Change this to a long, random string
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // For development. Set to true if using HTTPS in production
}));

// Serve static files from the root directory
app.use(express.static(__dirname));

// --- Authentication Middleware ---
const checkAuth = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login.html');
    }
};

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
        const query = 'SELECT id_sistema, nombre, rol, estado FROM public.personal WHERE usuario = $1 AND dni = $2';
        const result = await pool.query(query, [username, password]);

        if (result.rows.length > 0) {
            const user = result.rows[0];
            req.session.user = {
                id: user.id_sistema,
                nombre: user.nombre,
                rol: user.rol
            };
            console.log('Estado del usuario:', user.estado);
            console.log('Tipo de estado:', typeof user.estado);
            if (user.estado == true) {
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
                h.horas AS horas_solicitadas
            FROM public.horas h
            -- Join con la obra principal
            JOIN public.obras obra ON h.obraid = obra.id_sistema
            -- Join opcional con la subobra (si existe)
            LEFT JOIN public.obras subobra ON h.subobraid = subobra.id_sistema
            WHERE h.personalid = $1
            ORDER BY 
                h.fechacarga DESC LIMIT 500;

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

// Get all "obras" in a hierarchical structure
app.get('/api/obras-jerarquia', checkAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT id_sistema, obra, parent_id FROM public.obras WHERE estado = true ORDER BY parent_id NULLS FIRST, obra');
        const obras = result.rows;
        const hierarchy = [];
        const map = {};

        // First pass: create a map of all obras by their ID
        obras.forEach(o => {
            map[o.id_sistema] = { ...o, subobras: [] };
        });

        // Second pass: build the hierarchy
        obras.forEach(o => {
            if (o.parent_id && map[o.parent_id]) {
                map[o.parent_id].subobras.push(map[o.id_sistema]);
            } else {
                hierarchy.push(map[o.id_sistema]);
            }
        });

        res.json(hierarchy);
    } catch (error) {
        console.error('Error fetching obras hierarchy:', error);
        res.status(500).json({ message: 'Error al obtener la jerarquía de obras.' });
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
    try {
        const query = `SELECT fecha, horas FROM public.horas WHERE personalid = $1 AND DATE(fecha) = CURRENT_DATE`;
        const result = await pool.query(query, [personalId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching horas hoy:', error);
        res.status(500).json({ message: 'Error al obtener horas de hoy.' });
    }
});

// Submit a new hour request
app.post('/api/solicitar', checkAuth, async (req, res) => {
    const { obra: obraId, sector, fecha, horas, razon, comentarios } = req.body;
    const personalId = req.session.user.id;

    // Basic validation
    if (!obraId || !sector || !fecha || !horas) {
        return res.status(400).json({ message: 'Por favor, complete todos los campos obligatorios.' });
    }

    try {
        // Determine if the selected obra is a subobra
        const obraResult = await pool.query('SELECT parent_id FROM public.obras WHERE id_sistema = $1 AND estado = true', [obraId]);
        if (obraResult.rows.length === 0) {
            return res.status(400).json({ message: 'La obra seleccionada no es válida.' });
        }

        const parentId = obraResult.rows[0].parent_id;
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
