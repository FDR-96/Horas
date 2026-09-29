// TimeTrack · utilidades compartidas de la app de empleados (sin dependencias).

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Minúsculas y sin acentos, para búsquedas ("Construcción" ~ "construccion"). */
export const normalize = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ------------------------------------------------------------ íconos (SVG en línea)
const ICONS = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18M10.6 5.1A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

export const icon = (name, cls = '') =>
    `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ------------------------------------------------------------ storage seguro
export const store = {
    get(key, fallback = null) {
        try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin storage: no se recuerda */ }
    },
    getRaw(key) { try { return localStorage.getItem(key); } catch { return null; } },
    setRaw(key, value) { try { localStorage.setItem(key, value); } catch { /* idem */ } },
};

/** Agrega `id` al frente de una lista de recientes (sin duplicados). */
export function pushRecent(key, id, max = 5) {
    const list = store.get(key, []).filter(x => x !== id);
    list.unshift(id);
    store.set(key, list.slice(0, max));
}

// ------------------------------------------------------------ fechas y horas
const pad = n => String(n).padStart(2, '0');
export const isoLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function fmtMinutes(total) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (!h) return `${m} m`;
    return m ? `${h} h ${m} m` : `${h} h`;
}

export const toHHMM = total => `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;

/** Minutos de un valor `horas` de la API (intervalo de pg como objeto, "HH:MM" o número). */
export function intervalToMinutes(h) {
    if (h && typeof h === 'object') return (Number(h.hours) || 0) * 60 + (Number(h.minutes) || 0);
    if (typeof h === 'string') {
        const m = h.match(/^(\d{1,2}):(\d{2})/);
        if (m) return Number(m[1]) * 60 + Number(m[2]);
        const n = parseFloat(h.replace(',', '.'));
        return Number.isNaN(n) ? 0 : Math.round(n * 60);
    }
    if (typeof h === 'number') return Math.round(h * 60);
    return 0;
}

// ------------------------------------------------------------ API
export class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
        res = await fetch(path, {
            method,
            credentials: 'same-origin',
            headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw new ApiError('Sin conexión con el servidor. Revisá tu señal e intentá de nuevo.', 0);
    }
    // checkAuth redirige al login cuando la sesión venció.
    if (res.redirected && res.url.includes('/login')) {
        location.href = '/login.html';
        throw new ApiError('Tu sesión expiró.', 401);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(data?.message || `Error ${res.status}`, res.status);
    return data;
}

// ------------------------------------------------------------ toast
export function toast(message, type = 'ok') {
    let host = $('.toast-host');
    if (!host) {
        host = document.createElement('div');
        host.className = 'toast-host';
        host.setAttribute('role', 'status');
        host.setAttribute('aria-live', 'polite');
        document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

// ------------------------------------------------------------ bottom sheet
// Se cierra con la X, tocando afuera, con Escape o con el botón "atrás" del
// teléfono (se agrega una entrada al historial mientras está abierto).
let activeSheet = null;

function mountSheet({ title, tall = false, content }) {
    const root = document.createElement('div');
    root.innerHTML = `
        <div class="sheet-backdrop"></div>
        <div class="sheet ${tall ? 'tall' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1">
            <div class="sheet-handle"></div>
            <div class="sheet-head">
                <h2>${esc(title)}</h2>
                <button type="button" class="icon-btn" data-close aria-label="Cerrar">${icon('close')}</button>
            </div>
            ${content}
        </div>`;
    document.body.appendChild(root);
    return root;
}

function presentSheet(root, onClose) {
    const previousFocus = document.activeElement;
    const sheet = $('.sheet', root);
    let closed = false;

    const close = (value, fromHistory = false) => {
        if (closed) return;
        closed = true;
        activeSheet = null;
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('popstate', onPop);
        root.classList.remove('sheet-open');
        document.documentElement.style.overflow = '';
        setTimeout(() => root.remove(), 250);
        if (!fromHistory && history.state?.sheet) history.back();
        previousFocus?.focus?.({ preventScroll: true });
        onClose(value);
    };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    const onPop = () => close(null, true);

    root.addEventListener('click', e => {
        if (e.target.classList.contains('sheet-backdrop') || e.target.closest('[data-close]')) close(null);
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onPop);
    history.pushState({ sheet: true }, '');
    document.documentElement.style.overflow = 'hidden';
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('sheet-open')));
    sheet.focus({ preventScroll: true });
    activeSheet = { close };
    return close;
}

/**
 * Lista seleccionable con búsqueda.
 * render(term) -> [{ title?, items: [{ key, title, sub?, count?, group?, expanded?, child?, selected? }] }]
 * onGroup(item) se llama al tocar un item `group` (para expandir / contraer).
 * Devuelve una promesa con el item elegido o null.
 */
export function openListSheet({ title, searchPlaceholder = 'Buscar', render, onGroup = () => {}, emptyText = 'Sin resultados' }) {
    activeSheet?.close(null);
    return new Promise(resolve => {
        const root = mountSheet({
            title, tall: true,
            content: `
                <div class="sheet-search">
                    <div class="input-wrap">
                        ${icon('search', 'icon-left')}
                        <input type="search" class="input" placeholder="${esc(searchPlaceholder)}"
                               autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
                    </div>
                </div>
                <div class="sheet-list" role="listbox"></div>`,
        });
        const list = $('.sheet-list', root);
        const input = $('input', root);
        let current = [];

        const draw = () => {
            const term = input.value.trim();
            const sections = render(term).filter(s => s.items.length);
            current = sections.flatMap(s => s.items);
            if (!current.length) {
                list.innerHTML = `<div class="sheet-empty">${esc(emptyText)}</div>`;
                return;
            }
            let i = 0;
            list.innerHTML = sections.map(s => `
                ${s.title ? `<div class="sheet-section">${esc(s.title)}</div>` : ''}
                ${s.items.map(it => {
                    const idx = i++;
                    const cls = ['sheet-item', it.group && 'group', it.child && 'child', it.selected && 'selected'].filter(Boolean).join(' ');
                    const aria = it.group ? `aria-expanded="${Boolean(it.expanded)}"` : `role="option" aria-selected="${Boolean(it.selected)}"`;
                    const trail = it.group
                        ? `<span class="count">${esc(it.count ?? '')}</span>${icon('chevron')}`
                        : (it.selected ? icon('check', 'check') : '');
                    return `<button type="button" class="${cls}" data-idx="${idx}" ${aria}>
                        <span class="t"><b>${highlight(it.title, term)}</b>${it.sub ? `<small>${highlight(it.sub, term)}</small>` : ''}</span>
                        ${trail}</button>`;
                }).join('')}`).join('');
        };

        let t;
        input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { list.scrollTop = 0; draw(); }, 80); });
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });

        const close = presentSheet(root, resolve);
        list.addEventListener('click', e => {
            const btn = e.target.closest('[data-idx]');
            if (!btn) return;
            const item = current[Number(btn.dataset.idx)];
            if (item.group) { onGroup(item); draw(); return; }
            close(item);
        });
        draw();
        // Llevar a la vista el elegido actual
        requestAnimationFrame(() => $('.sheet-item.selected', list)?.scrollIntoView({ block: 'center' }));
    });
}

/** Sheet con contenido libre y botones. actions: [{ id, label, primary? }] -> id elegido o null. */
export function openActionSheet({ title, body, actions }) {
    activeSheet?.close(null);
    return new Promise(resolve => {
        const root = mountSheet({
            title,
            content: `<div class="sheet-body">${body}</div>
                <div class="sheet-actions">${actions.map(a =>
                    `<button type="button" class="btn btn-block ${a.primary ? 'btn-primary' : 'btn-secondary'}" data-action="${esc(a.id)}">${esc(a.label)}</button>`).join('')}
                </div>`,
        });
        const close = presentSheet(root, resolve);
        root.addEventListener('click', e => {
            const btn = e.target.closest('[data-action]');
            if (btn) close(btn.dataset.action);
        });
    });
}

function highlight(text, term) {
    const safe = esc(text);
    if (!term) return safe;
    // Resaltado sin acentos: se busca en la versión normalizada y se marca sobre el original.
    const norm = normalize(text);
    const ranges = [];
    normalize(term).split(/\s+/).filter(Boolean).forEach(w => {
        let from = 0, at;
        while ((at = norm.indexOf(w, from)) !== -1) { ranges.push([at, at + w.length]); from = at + w.length; }
    });
    if (!ranges.length) return safe;
    ranges.sort((a, b) => a[0] - b[0]);
    let out = '', pos = 0;
    for (const [s, e] of ranges) {
        if (s < pos) continue;
        out += esc(text.slice(pos, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>';
        pos = e;
    }
    return out + esc(text.slice(pos));
}
