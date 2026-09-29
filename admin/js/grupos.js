// Vista Grupos: encargados (emails) por grupo, integrantes, destinatarios por defecto y excluidos.
import { markChanged, membership, onConfigChange, personById, state } from './state.js';
import { $, emailInput, esc } from './ui.js';

const PREVIEW_MEMBERS = 6;

export function initGrupos() {
    $('#grupo-add').addEventListener('click', () => {
        state.config.grupos.push({ id: `g${Date.now().toString(36)}`, nombre: `Grupo ${state.config.grupos.length + 1}`, emails: [], miembros: [] });
        markChanged();
        renderGrupos();
        $('#groups .group-card:last-child input.group-name')?.select();
    });

    $('#groups').addEventListener('input', e => {
        if (!e.target.matches('input.group-name')) return;
        grupo(e.target).nombre = e.target.value;
        markChanged();
    });
    $('#groups').addEventListener('click', e => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const g = grupo(btn);
        if (btn.dataset.action === 'delete') {
            if (!confirm(`¿Eliminar el grupo "${g.nombre}"? Sus integrantes pasarán a "Sin grupo".`)) return;
            state.config.grupos = state.config.grupos.filter(x => x !== g);
            markChanged();
            renderGrupos();
        } else if (btn.dataset.action === 'members') {
            openPicker({
                title: `Integrantes de ${g.nombre}`,
                selected: g.miembros,
                ownGroup: g,
                onApply: ids => { g.miembros = ids; markChanged(); renderGrupos(); },
            });
        }
    });

    $('#excluidos-edit').addEventListener('click', () => openPicker({
        title: 'Excluidos del control',
        selected: state.config.excluidos,
        onApply: ids => { state.config.excluidos = ids; markChanged(); renderGrupos(); },
    }));

    initPicker();
    onConfigChange(renderNotice);
}

const grupo = el => state.config.grupos.find(g => g.id === el.closest('[data-group]').dataset.group);

function memberChips(ids) {
    if (!ids.length) return '<span class="muted">Sin integrantes</span>';
    const names = ids.slice(0, PREVIEW_MEMBERS).map(id => `<span class="tag">${esc(personById(id)?.nombre ?? `#${id}`)}</span>`);
    if (ids.length > PREVIEW_MEMBERS) names.push(`<span class="tag">+${ids.length - PREVIEW_MEMBERS}</span>`);
    return names.join('');
}

export function renderGrupos() {
    const cont = $('#groups');
    const grupos = state.config.grupos;
    cont.innerHTML = grupos.length ? '' : `<div class="card group-empty">
        <p>Todavía no hay grupos. Creá uno y asigná los emails de sus encargados.</p></div>`;

    grupos.forEach(g => {
        const card = document.createElement('article');
        card.className = 'card group-card';
        card.dataset.group = g.id;
        card.innerHTML = `
            <div class="group-head">
                <input type="text" class="group-name" value="${esc(g.nombre)}" maxlength="80" aria-label="Nombre del grupo">
                <button class="icon-btn danger" data-action="delete" title="Eliminar grupo">
                    <span class="material-symbols-outlined">delete</span></button>
            </div>
            <div class="field"><span>Emails de encargados</span><div class="email-input"></div></div>
            <div class="field"><span>Integrantes (${g.miembros.length})</span>
                <div class="member-summary">${memberChips(g.miembros)}</div>
                <button class="btn ghost small" data-action="members">Editar integrantes</button>
            </div>`;
        cont.appendChild(card);
        emailInput(card.querySelector('.email-input'), () => g.emails, markChanged);
    });

    emailInput($('#emails-defecto'), () => state.config.emails_por_defecto, markChanged);
    $('#excluidos-summary').innerHTML = memberChips(state.config.excluidos);
    renderNotice();
}

function renderNotice() {
    if (!state.config) return;
    const m = membership();
    const excl = new Set(state.config.excluidos);
    const sinGrupo = state.personal.filter(p => !m.has(p.id) && !excl.has(p.id)).length;
    const sinMail = state.config.grupos.filter(g => g.miembros.length && !g.emails.length).map(g => g.nombre);
    const parts = [];
    if (sinGrupo) {
        parts.push(`${sinGrupo} persona(s) no pertenecen a ningún grupo: sus alertas van a "Sin grupo"` +
            (state.config.emails_por_defecto.length ? '.' : ', que no tiene emails cargados.'));
    }
    if (sinMail.length) parts.push(`Grupos sin emails: ${sinMail.join(', ')}.`);
    $('#sin-grupo-notice').innerHTML = parts.length
        ? `<span class="material-symbols-outlined">info</span><span>${esc(parts.join(' '))}</span>` : '';
}

// ------------------------------------------------------------ selector de personal
let picker = null;

function initPicker() {
    const overlay = $('#picker-overlay');
    const close = () => { overlay.classList.add('hidden'); picker = null; };
    overlay.addEventListener('click', e => { if (e.target === overlay || e.target.closest('[data-close-picker]')) close(); });
    $('#picker-search').addEventListener('input', renderPickerList);
    $('#picker-only-free').addEventListener('change', renderPickerList);
    $('#picker-list').addEventListener('change', e => {
        const id = Number(e.target.value);
        if (e.target.checked) picker.selected.add(id); else picker.selected.delete(id);
        renderPickerCount();
    });
    $('#picker-ok').addEventListener('click', () => {
        const ids = state.personal.map(p => p.id).filter(id => picker.selected.has(id));
        // conservar ids que ya no están activos para no perderlos en silencio
        picker.original.forEach(id => { if (!personById(id) && picker.selected.has(id)) ids.push(id); });
        picker.onApply(ids);
        close();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && picker) close(); });
}

function openPicker({ title, selected, onApply, ownGroup = null }) {
    picker = { selected: new Set(selected), original: [...selected], onApply, ownGroup };
    $('#picker-title').textContent = title;
    $('#picker-search').value = '';
    $('#picker-only-free').checked = false;
    $('#picker-only-free').parentElement.classList.toggle('hidden', !ownGroup);
    $('#picker-overlay').classList.remove('hidden');
    renderPickerList();
    $('#picker-search').focus();
}

function renderPickerList() {
    const q = $('#picker-search').value.trim().toLowerCase();
    const onlyFree = $('#picker-only-free').checked;
    const m = membership();
    const rows = state.personal.filter(p => {
        if (q && !`${p.nombre} ${p.usuario}`.toLowerCase().includes(q)) return false;
        if (onlyFree) {
            const others = (m.get(p.id) || []).filter(n => n !== picker.ownGroup?.nombre);
            if (others.length) return false;
        }
        return true;
    });
    $('#picker-list').innerHTML = rows.length ? rows.map(p => {
        const grupos = (m.get(p.id) || []).join(', ');
        return `<li><label>
            <input type="checkbox" value="${p.id}" ${picker.selected.has(p.id) ? 'checked' : ''}>
            <span class="who">${esc(p.nombre)}<small>${esc(p.usuario)}${p.rol ? ` · ${esc(p.rol)}` : ''}</small></span>
            ${grupos ? `<span class="tag">${esc(grupos)}</span>` : ''}
        </label></li>`;
    }).join('') : '<li class="group-empty">Sin resultados</li>';
    renderPickerCount();
}

function renderPickerCount() {
    $('#picker-count').textContent = `${picker.selected.size} seleccionado(s)`;
}
