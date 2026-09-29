// Pantalla "Cargar horas". Mismo contrato con el backend que la versión anterior:
// POST /api/solicitar { obra, sector, fecha: YYYY-MM-DD, horas: "HH:MM", razon }.
import {
    $, api, fmtMinutes, icon, intervalToMinutes, isoLocal, normalize,
    openActionSheet, openListSheet, pushRecent, store, toast, toHHMM, esc,
} from './app.js';

const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const HORAS_RAPIDAS = [1, 2, 3, 4, 6, 8];
const PASO_MIN = 15;
const MAX_MIN = 24 * 60;
const DIAS_ATRAS = 7;                          // el servidor acepta hasta 7 días atrás
const DIA_LARGO_MIN = 12 * 60;                 // aviso si el día supera esto

// Claves compartidas con la versión anterior (empleado_solic_legacy.html)
const K_LAST_OBRA = 'last_obra_node';          // "subobra-<id>"
const K_LAST_OBRA_TXT = 'last_obra_display';
const K_LAST_SECTOR = 'last_sector';           // "<id>"
const K_LAST_OBRA_KEY = 'last_obra_key';       // "<padreId>:<id>" (0 = obra raíz)
const K_RECENT_OBRAS = 'recent_obras_v2';      // claves "<padreId>:<id>"
const K_RECENT_SECTORES = 'recent_sectores';

const state = {
    fecha: isoLocal(new Date()),
    obra: null,          // { id, title, parent, path }
    sector: null,        // { id, name }
    minutos: 0,
    minutosDia: 0,       // ya cargado en la fecha elegida
    enviando: false,
};

let obras = { roots: [], leaves: new Map() };
let sectores = [];

// ------------------------------------------------------------ íconos estáticos
document.querySelectorAll('[data-icon]').forEach(el => { el.outerHTML = icon(el.dataset.icon); });
$('#back').innerHTML = icon('back');
$('#menos').innerHTML = icon('minus');
$('#mas').innerHTML = icon('plus');

// ------------------------------------------------------------ fecha
function renderFechas() {
    const hoy = new Date();
    const chips = [];
    for (let i = 0; i <= DIAS_ATRAS; i++) {
        const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - i);
        const iso = isoLocal(d);
        const nombre = i === 0 ? 'Hoy' : i === 1 ? 'Ayer' : DIAS[d.getDay()];
        const on = iso === state.fecha;
        chips.push(`<button type="button" class="chip ${on ? 'on' : ''}" role="radio" aria-checked="${on}" data-fecha="${iso}">
            ${nombre}<small>${d.getDate()}/${d.getMonth() + 1}</small></button>`);
    }
    $('#fechas').innerHTML = chips.join('');
}

$('#fechas').addEventListener('click', e => {
    const chip = e.target.closest('[data-fecha]');
    if (!chip || chip.dataset.fecha === state.fecha) return;
    state.fecha = chip.dataset.fecha;
    renderFechas();
    cargarTotalDia();
});

function etiquetaFecha(iso = state.fecha) {
    const hoy = new Date();
    const ayer = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1);
    if (iso === isoLocal(hoy)) return 'hoy';
    if (iso === isoLocal(ayer)) return 'ayer';
    const [y, m, d] = iso.split('-').map(Number);
    return `el ${DIAS[new Date(y, m - 1, d).getDay()].toLowerCase()} ${d}/${m}`;
}

let totalReq = 0;
async function cargarTotalDia() {
    const req = ++totalReq;
    state.minutosDia = 0;
    renderAviso();
    try {
        const rows = await api(`/api/horas-hoy?fecha=${state.fecha}`);
        if (req !== totalReq) return; // llegó tarde: el usuario ya cambió de fecha
        state.minutosDia = rows.reduce((acc, r) => acc + intervalToMinutes(r.horas), 0);
        renderAviso();
    } catch { /* el aviso es informativo: si falla, no se muestra */ }
}

function renderAviso() {
    const el = $('#dia-notice');
    const { minutosDia, minutos } = state;
    if (!minutosDia) { el.classList.add('hidden'); return; }
    const total = minutosDia + minutos;
    const cuando = etiquetaFecha();
    let html = `${icon('info')}<span>${cuando[0].toUpperCase() + cuando.slice(1)} ya tenés <strong>${fmtMinutes(minutosDia)}</strong> cargadas`;
    if (minutos) html += ` · con esta carga, <strong>${fmtMinutes(total)}</strong>`;
    if (total > DIA_LARGO_MIN) html += '. Revisá que sea correcto.';
    el.innerHTML = `${html}</span>`;
    el.classList.remove('hidden');
}

// ------------------------------------------------------------ horas
function renderHoras() {
    $('#horas-rapidas').innerHTML = HORAS_RAPIDAS.map(h => {
        const on = state.minutos === h * 60;
        return `<button type="button" class="chip ${on ? 'on' : ''}" role="radio" aria-checked="${on}" data-h="${h}">${h} h</button>`;
    }).join('');
    const out = $('#horas-value');
    out.textContent = state.minutos ? fmtMinutes(state.minutos) : 'Elegí o ajustá';
    out.classList.toggle('empty', !state.minutos);
    $('#menos').disabled = state.minutos <= PASO_MIN;
    $('#mas').disabled = state.minutos >= MAX_MIN;
    $('#submit').textContent = state.minutos ? `Cargar ${fmtMinutes(state.minutos)}` : 'Cargar';
    renderAviso();
}

function setMinutos(m) {
    state.minutos = Math.max(0, Math.min(MAX_MIN, m));
    if (state.minutos) setInvalid('f-horas', false);
    renderHoras();
}

$('#horas-rapidas').addEventListener('click', e => {
    const chip = e.target.closest('[data-h]');
    if (chip) setMinutos(Number(chip.dataset.h) * 60);
});
$('#menos').addEventListener('click', () => setMinutos(state.minutos - PASO_MIN));
$('#mas').addEventListener('click', () => setMinutos(state.minutos + PASO_MIN));

// ------------------------------------------------------------ obra
// En public.obras hay id_sistema repetidos entre obras distintas (una raíz y una
// subobra de otra obra), así que una obra se identifica por padre + id.
const obraKey = (padreId, id) => `${padreId}:${id}`;

function indexarObras(data) {
    const byName = (a, b) => a.obra.localeCompare(b.obra, 'es');
    const leaves = new Map();
    const addLeaf = leaf => { leaves.set(leaf.key, leaf); return leaf; };
    const roots = data
        .filter(o => o.obra && o.obra.trim())
        .sort(byName)
        .map(o => {
            const subs = (o.subobras || []).filter(s => s.obra && s.obra.trim()).sort(byName);
            if (!subs.length) {
                addLeaf({ key: obraKey(0, o.id_sistema), id: o.id_sistema, padreId: 0,
                    title: o.obra, parent: null, path: o.obra });
                return { id: o.id_sistema, title: o.obra, children: [] };
            }
            const children = subs.map(s => addLeaf({ key: obraKey(o.id_sistema, s.id_sistema), id: s.id_sistema,
                padreId: o.id_sistema, title: s.obra, parent: o.obra, path: `${o.obra} / ${s.obra}` }));
            return { id: o.id_sistema, title: o.obra, children };
        });
    return { roots, leaves };
}

function setObra(leaf) {
    state.obra = leaf;
    const btn = $('#obra-btn');
    btn.classList.toggle('empty', !leaf);
    $('#obra-value').textContent = leaf ? leaf.title : 'Elegir obra';
    $('#obra-sub').textContent = leaf?.parent || '';
    if (leaf) {
        setInvalid('f-obra', false);
        store.setRaw(K_LAST_OBRA_KEY, leaf.key);
        store.setRaw(K_LAST_OBRA, `subobra-${leaf.id}`);
        store.setRaw(K_LAST_OBRA_TXT, leaf.path);
    }
}

$('#obra-btn').addEventListener('click', async () => {
    if (!obras.leaves.size) { await cargarCatalogos(); if (!obras.leaves.size) return; }
    const selectedKey = state.obra?.key;
    const expanded = new Set(
        obras.roots.filter(r => r.children.some(c => c.key === selectedKey)).map(r => r.id));
    const leafItem = (leaf, extra = {}) => ({
        key: leaf.key, leaf, title: leaf.title, sub: leaf.parent || undefined, selected: leaf.key === selectedKey, ...extra,
    });

    const picked = await openListSheet({
        title: 'Elegí la obra',
        searchPlaceholder: 'Buscar obra o subobra',
        emptyText: 'No hay obras que coincidan con la búsqueda.',
        render: term => {
            if (term) {
                const words = normalize(term).split(/\s+/).filter(Boolean);
                const hits = [...obras.leaves.values()].filter(l => {
                    const p = normalize(l.path);
                    return words.every(w => p.includes(w));
                });
                return [{ title: hits.length > 100 ? 'Primeros 100 resultados' : `${hits.length} resultado(s)`,
                    items: hits.slice(0, 100).map(l => leafItem(l)) }];
            }
            const recientes = store.get(K_RECENT_OBRAS, [])
                .map(key => obras.leaves.get(key)).filter(Boolean).map(l => leafItem(l));
            const todas = [];
            for (const r of obras.roots) {
                if (!r.children.length) { todas.push(leafItem(obras.leaves.get(obraKey(0, r.id)))); continue; }
                const open = expanded.has(r.id);
                todas.push({ key: `g${r.id}`, root: r, title: r.title, group: true, expanded: open,
                    count: `${r.children.length} subobras` });
                if (open) r.children.forEach(c => todas.push(leafItem(c, { child: true, sub: undefined })));
            }
            return [{ title: 'Recientes', items: recientes }, { title: 'Todas las obras', items: todas }];
        },
        onGroup: item => {
            if (expanded.has(item.root.id)) expanded.delete(item.root.id);
            else expanded.add(item.root.id);
        },
    });
    if (picked) setObra(picked.leaf);
});

// ------------------------------------------------------------ sector
function setSector(s) {
    state.sector = s;
    $('#sector-btn').classList.toggle('empty', !s);
    $('#sector-value').textContent = s ? s.name : 'Elegir sector';
    if (s) {
        setInvalid('f-sector', false);
        store.setRaw(K_LAST_SECTOR, String(s.id));
    }
}

$('#sector-btn').addEventListener('click', async () => {
    if (!sectores.length) { await cargarCatalogos(); if (!sectores.length) return; }
    const selectedId = state.sector?.id;
    const item = s => ({ key: s.id, s, title: s.name, selected: s.id === selectedId });
    const picked = await openListSheet({
        title: 'Elegí el sector',
        searchPlaceholder: 'Buscar sector',
        emptyText: 'No hay sectores que coincidan.',
        render: term => {
            if (term) {
                const w = normalize(term);
                return [{ items: sectores.filter(s => normalize(s.name).includes(w)).map(item) }];
            }
            const recientes = store.get(K_RECENT_SECTORES, [])
                .map(id => sectores.find(s => s.id === id)).filter(Boolean).slice(0, 3).map(item);
            return [{ title: 'Recientes', items: recientes }, { title: 'Todos los sectores', items: sectores.map(item) }];
        },
    });
    if (picked) setSector(picked.s);
});

// ------------------------------------------------------------ carga de catálogos
let catalogos = null;
function cargarCatalogos() {
    catalogos ??= Promise.all([api('/api/obras-jerarquia'), api('/api/sectores')])
        .then(([dataObras, dataSectores]) => {
            obras = indexarObras(dataObras);
            sectores = dataSectores
                .map(s => ({ id: s.id_sistema, name: s.sector }))
                .filter(s => s.name && s.name.trim())
                .sort((a, b) => a.name.localeCompare(b.name, 'es'));
            restaurarUltimos();
        })
        .catch(err => {
            catalogos = null; // se reintenta al tocar el selector
            toast(`No se pudieron cargar obras y sectores. ${err.message}`, 'error');
        });
    return catalogos;
}

function restaurarUltimos() {
    if (!state.obra) {
        let leaf = obras.leaves.get(store.getRaw(K_LAST_OBRA_KEY));
        if (!leaf) {
            // Dato guardado por la pantalla anterior ("subobra-<id>"): solo trae el id.
            // Si el id está repetido, se prefiere la raíz (igual que el servidor).
            const id = Number((store.getRaw(K_LAST_OBRA) || '').split('-')[1]);
            leaf = obras.leaves.get(obraKey(0, id))
                || [...obras.leaves.values()].find(l => l.id === id);
        }
        if (leaf) setObra(leaf);
    }

    const lastSector = Number(store.getRaw(K_LAST_SECTOR));
    const s = sectores.find(x => x.id === lastSector);
    if (!state.sector && s) setSector(s);
}

// ------------------------------------------------------------ validación y envío
function setInvalid(fieldId, invalid) {
    $(`#${fieldId}`).classList.toggle('invalid', invalid);
}

function validar() {
    const errores = [
        ['f-obra', !state.obra],
        ['f-sector', !state.sector],
        ['f-horas', !state.minutos],
    ];
    errores.forEach(([id, bad]) => setInvalid(id, bad));
    const primero = errores.find(([, bad]) => bad);
    if (primero) {
        $(`#${primero[0]}`).scrollIntoView({ behavior: 'smooth', block: 'center' });
        return false;
    }
    return true;
}

$('#form').addEventListener('submit', async e => {
    e.preventDefault();
    if (state.enviando || !validar()) return;

    const submit = $('#submit');
    state.enviando = true;
    submit.disabled = true;
    submit.textContent = 'Cargando…';

    const cargado = { minutos: state.minutos, obra: state.obra, fecha: state.fecha };
    try {
        await api('/api/solicitar', {
            method: 'POST',
            body: {
                obra: state.obra.id,
                obraPadre: state.obra.padreId,
                sector: state.sector.id,
                fecha: state.fecha,
                horas: toHHMM(state.minutos),
                razon: $('#razon').value.trim(),
            },
        });
    } catch (err) {
        toast(err.message, 'error');
        state.enviando = false;
        submit.disabled = false;
        renderHoras();
        return;
    }

    pushRecent(K_RECENT_OBRAS, state.obra.key);
    pushRecent(K_RECENT_SECTORES, state.sector.id);
    state.minutosDia += cargado.minutos;
    state.enviando = false;
    submit.disabled = false;

    const accion = await openActionSheet({
        title: 'Horas cargadas',
        body: `<div class="result">
            <div class="badge">${icon('check')}</div>
            <h3>${fmtMinutes(cargado.minutos)} en ${esc(cargado.obra.title)}</h3>
            <p>${esc(etiquetaFecha(cargado.fecha)[0].toUpperCase() + etiquetaFecha(cargado.fecha).slice(1))}
               llevás <strong>${fmtMinutes(state.minutosDia)}</strong> cargadas.</p>
        </div>`,
        actions: [
            { id: 'inicio', label: 'Volver al inicio', primary: true },
            { id: 'otra', label: 'Cargar otra' },
        ],
    });

    if (accion === 'inicio') {
        location.href = '/empleado_dash.html';
        return;
    }
    // "Cargar otra": se conservan fecha, obra y sector; se limpian horas y observaciones.
    $('#razon').value = '';
    setMinutos(0);
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ------------------------------------------------------------ inicio
renderFechas();
renderHoras();
cargarTotalDia();
cargarCatalogos();
