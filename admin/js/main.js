// Punto de entrada del panel: conexión, navegación, tema y guardado de configuración.
import { initAlertas, loadProximosFeriados, renderAlertas } from './alertas.js';
import { api, auth, setUnauthorizedHandler } from './api.js';
import { initDashboard, loadDashboard, rerenderDashboard } from './dashboard.js';
import { initEnvios, loadEnvios } from './envios.js';
import { initGrupos, renderGrupos } from './grupos.js';
import { isDirty, setSavedConfig, state } from './state.js';
import { $, $$, esc, toast, withBusy } from './ui.js';

const VIEWS = ['dashboard', 'alertas', 'grupos', 'envios'];
let booted = false;

// ------------------------------------------------------------ tema
const THEME_KEY = 'tt_admin_theme';
function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    $('#theme-toggle .material-symbols-outlined').textContent = dark ? 'light_mode' : 'dark_mode';
}
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { applyTheme(null); }

$('#theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* sin persistencia */ }
    applyTheme(next);
    rerenderDashboard();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerenderDashboard);

// ------------------------------------------------------------ navegación
function show(view) {
    if (!VIEWS.includes(view)) view = 'dashboard';
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
    if (booted && view === 'envios') loadEnvios();
}
$$('.nav-item').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.view; }));
window.addEventListener('hashchange', () => show(location.hash.slice(1)));

// ------------------------------------------------------------ estado del servicio
function renderStatus() {
    const m = state.meta;
    const item = (cls, text) => `<div class="status-item ${cls}">${esc(text)}</div>`;
    let auto = item('warn', 'Envío automático sin programar');
    if (m.proximo_envio) {
        const d = new Date(m.proximo_envio);
        auto = item('ok', `Próximo envío ${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })}`);
    }
    $('#status-list').innerHTML = [
        item('ok', 'API de alertas conectada'),
        m.smtp_configurado ? item('ok', 'SMTP configurado') : item('bad', 'SMTP sin configurar'),
        auto,
    ].join('');
}

// ------------------------------------------------------------ guardar
async function save(button) {
    await withBusy(button, async () => {
        try {
            const res = await api.saveConfig(state.config);
            state.meta.proximo_envio = res.proximo_envio;
            state.meta.hora_programada = res.config.hora_envio;
            setSavedConfig(res.config);
            renderAlertas();
            renderGrupos();
            renderStatus();
            loadProximosFeriados();
            loadDashboard();
            toast('Configuración guardada.');
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}
$$('[data-save]').forEach(b => b.addEventListener('click', () => save(b)));
window.addEventListener('beforeunload', e => { if (isDirty()) e.preventDefault(); });

// ------------------------------------------------------------ sesión y arranque
async function boot() {
    state.meta = await api.meta();
    const cfg = await api.getConfig();
    state.meta.hora_programada = cfg.hora_envio;
    setSavedConfig(cfg);
    try {
        state.personal = await api.personal();
    } catch (err) {
        toast(`No se pudo cargar el personal: ${err.message}`, 'error');
    }

    if (!booted) {
        initDashboard();
        initAlertas();
        initGrupos();
        initEnvios();
        booted = true;
    }
    renderStatus();
    renderAlertas();
    renderGrupos();
    show(location.hash.slice(1));
    loadDashboard();
}

function showLogin(message) {
    $('#login-error').textContent = message || '';
    $('#login-error').classList.toggle('hidden', !message);
    $('#login-overlay').classList.remove('hidden');
    ($('#admin-user').value ? $('#admin-pass') : $('#admin-user')).focus();
}

async function enter() {
    try {
        await boot();
        $('#login-overlay').classList.add('hidden');
    } catch (err) {
        // 401 ya abrió el login; otros errores (API caída, etc.) se muestran ahí mismo.
        showLogin(err.status === 401 ? '' : err.message);
    }
}

// Si la sesión vence mientras se usa el panel, se vuelve a pedir el login.
setUnauthorizedHandler(() => showLogin('Tu sesión expiró. Ingresá de nuevo.'));

$('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.submitter || $('#login-form button');
    await withBusy(btn, async () => {
        try {
            await auth.login($('#admin-user').value.trim(), $('#admin-pass').value);
            $('#admin-pass').value = '';
            await enter();
        } catch (err) {
            showLogin(err.message);
        }
    });
});

$('#logout').addEventListener('click', async () => {
    if (isDirty() && !confirm('Hay cambios sin guardar. ¿Cerrar sesión igual?')) return;
    try { await auth.logout(); } catch { /* igual se recarga */ }
    location.reload();
});

(async () => {
    try {
        const s = await auth.session();
        if (s.authenticated) await enter();
        else showLogin();
    } catch (err) {
        showLogin(err.message);
    }
})();
