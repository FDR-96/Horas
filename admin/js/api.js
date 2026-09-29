// Cliente del panel. Todo pasa por server.js: /admin-auth/* para la sesión y
// /admin-api/* como proxy a la API Python (la URL y la API key viven en .env).

export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

let onUnauthorized = () => {};
/** Se llama cuando la sesión de administrador venció (401). */
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

function formatDetail(detail) {
    if (!detail) return '';
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) return detail.map(e => String(e.msg).replace(/^Value error, /, '')).join(' · ');
    return JSON.stringify(detail);
}

async function request(method, url, body, { authCheck = true } = {}) {
    let res;
    try {
        res = await fetch(url, {
            method,
            credentials: 'same-origin',
            headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw new ApiError('No se pudo conectar con el servidor.', 0);
    }
    const data = await res.json().catch(() => null);
    if (res.status === 401 && authCheck) onUnauthorized();
    if (!res.ok) throw new ApiError(formatDetail(data?.detail) || `Error ${res.status}`, res.status);
    return data;
}

const call = (method, path, body) => request(method, `/admin-api${path}`, body);

const qs = params => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    return q.toString() ? `?${q}` : '';
};

export const auth = {
    session: () => request('GET', '/admin-auth/session', undefined, { authCheck: false }),
    login: (username, password) => request('POST', '/admin-auth/login', { username, password }, { authCheck: false }),
    logout: () => request('POST', '/admin-auth/logout', {}, { authCheck: false }),
};

export const api = {
    meta: () => call('GET', '/meta'),
    getConfig: () => call('GET', '/config'),
    saveConfig: cfg => call('PUT', '/config', cfg),
    personal: () => call('GET', '/personal'),
    metricas: dias => call('GET', `/metricas${qs({ dias })}`),
    inactivos: (soloInactivos = true) => call('GET', `/inactivos${qs({ solo_inactivos: soloInactivos })}`),
    calendario: (desde, hasta) => call('GET', `/calendario${qs({ desde, hasta })}`),
    ejecutar: (dryRun, forzar) => call('POST', '/alertas/ejecutar', { dry_run: dryRun, forzar }),
    preview: config => call('POST', '/alertas/preview', { config }),
    testEmail: to => call('POST', '/alertas/test-email', { to }),
    historial: estado => call('GET', `/alertas/historial${qs({ estado, limit: 300 })}`),
};
