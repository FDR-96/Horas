// Service worker de TimeTrack (app de empleados).
//
// - La interfaz (HTML, CSS, JS, íconos) se precachea y se sirve desde caché:
//   la app abre al instante, incluso con mala señal.
// - /api, /login, /logout y el panel de administración NUNCA pasan por caché:
//   los datos siempre vienen de la red.
// - server.js reemplaza __VERSION__ por un hash de los archivos de la interfaz;
//   cualquier cambio (aunque sea un git pull sin reiniciar) instala una versión
//   nueva y borra la anterior.

const VERSION = '__VERSION__';
const SHELL_CACHE = `tt-shell-${VERSION}`;
const FONT_CACHE = 'tt-fonts-v1';

// Solo archivos públicos: las páginas de empleados requieren sesión y se
// guardan la primera vez que se abren con sesión válida (ver PROTECTED_PAGES).
const PRECACHE = [
    '/login.html',
    '/manifest.json',
    '/assets/app.css',
    '/assets/app.js',
    '/assets/login.js',
    '/assets/dash.js',
    '/assets/solic.js',
    '/assets/icons/icon.svg',
    '/assets/icons/icon-white.svg',
    '/assets/icons/tt-glyph.svg',
    '/assets/icons/favicon-32.png',
    '/assets/icons/icon-192.png',
    '/assets/icons/apple-touch-icon.png',
];

// Rutas de navegación que se resuelven con una página precacheada.
// (/dashboard y /solicitar son rutas de server.js que sirven esos archivos.)
const PAGES = {
    '/login.html': '/login.html',
    '/dashboard': '/empleado_dash.html',
    '/empleado_dash.html': '/empleado_dash.html',
    '/solicitar': '/empleado_solic.html',
    '/empleado_solic.html': '/empleado_solic.html',
};

// Siempre a la red, sin tocar.
const NETWORK_ONLY = /^\/(api|admin)(\/|-|$)|^\/(login|logout)$|^\/sw\.js$/i;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' }))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys
                .filter(k => k.startsWith('tt-shell-') && k !== SHELL_CACHE)
                .map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (FONT_HOSTS.includes(url.hostname)) {
        event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
        return;
    }
    if (url.origin !== self.location.origin || NETWORK_ONLY.test(url.pathname)) return;

    if (request.mode === 'navigate') {
        const page = PAGES[url.pathname];
        if (!page) return;
        event.respondWith(PROTECTED_PAGES.has(page) ? protectedPage(page, request) : fromShell(page, request));
        return;
    }
    if (PRECACHE.includes(url.pathname)) {
        event.respondWith(fromShell(url.pathname, request));
    }
});

// Páginas con sesión: se muestra la copia guardada al instante (es solo la
// interfaz; los datos llegan por /api y el servidor valida la sesión) y en
// paralelo se pide a la red para actualizarla. Solo se guarda una respuesta
// 200 real: una redirección al login nunca queda en caché.
const PROTECTED_PAGES = new Set(['/empleado_dash.html', '/empleado_solic.html']);

async function protectedPage(key, request) {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(key);
    const network = fetch(request)
        .then(res => {
            if (res.ok && !res.redirected && res.type === 'basic') cache.put(key, res.clone());
            return res;
        })
        .catch(() => hit || Response.error());
    return hit || network;
}

async function fromShell(key, request) {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(key, { ignoreSearch: true });
    return hit || fetch(request);
}

async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    const network = fetch(request)
        .then(res => { if (res.ok || res.type === 'opaque') cache.put(request, res.clone()); return res; })
        .catch(() => hit || Response.error());
    return hit || network;
}
