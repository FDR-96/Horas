// Utilidades de interfaz compartidas por las vistas.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(message, type = 'ok') {
    const icon = { ok: 'check_circle', error: 'error', info: 'info' }[type] || 'info';
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="material-symbols-outlined">${icon}</span><span>${esc(message)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 7000 : 3500);
}

const pad = n => String(n).padStart(2, '0');
const parseIso = iso => (iso && iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso));

export function fmtDate(iso) {
    if (!iso) return '—';
    const d = parseIso(iso);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function fmtShort(iso) {
    const d = parseIso(iso);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

export function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = parseIso(iso.replace(' ', 'T'));
    return `${fmtDate(iso.slice(0, 10))} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fmtNum = (n, digits = 0) =>
    Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export async function withBusy(button, fn) {
    button.disabled = true;
    try { return await fn(); } finally { button.disabled = false; }
}

/**
 * Tabla simple. columns: [{ label, key | render(row), num? }]
 */
export function renderTable(container, columns, rows, emptyMessage = 'Sin datos') {
    if (!rows.length) {
        container.innerHTML = `<p class="muted small group-empty">${esc(emptyMessage)}</p>`;
        return;
    }
    const head = columns.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
    const body = rows.map(r => `<tr>${columns.map(c =>
        `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
    container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Input de emails tipo "chips". Enter, coma o salir del campo agregan el email.
 */
export function emailInput(container, getList, onChange) {
    const render = () => {
        container.innerHTML = getList().map((e, i) =>
            `<span class="chip">${esc(e)}<button type="button" data-i="${i}" aria-label="Quitar ${esc(e)}">
                <span class="material-symbols-outlined">close</span></button></span>`).join('') +
            '<input type="email" placeholder="Agregar email y Enter">';
        const input = $('input', container);
        const add = () => {
            const values = input.value.split(/[,;\s]+/).map(v => v.trim().toLowerCase()).filter(Boolean);
            if (!values.length) return;
            const bad = values.filter(v => !EMAIL_RE.test(v));
            if (bad.length) { toast(`Email inválido: ${bad.join(', ')}`, 'error'); return; }
            const list = getList();
            values.forEach(v => { if (!list.includes(v)) list.push(v); });
            onChange();
            render();
            $('input', container).focus();
        };
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
            if (e.key === 'Backspace' && !input.value && getList().length) {
                getList().pop(); onChange(); render(); $('input', container).focus();
            }
        });
        input.addEventListener('blur', () => { if (input.value.trim()) add(); });
    };
    container.addEventListener('click', e => {
        const btn = e.target.closest('button[data-i]');
        if (btn) { getList().splice(Number(btn.dataset.i), 1); onChange(); render(); }
        else if (e.target === container) $('input', container)?.focus();
    });
    render();
    return render;
}
