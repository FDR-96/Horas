// Tablero del empleado. Mismos endpoints que la versión anterior:
// GET /api/user, GET /api/solicitudes, GET /api/horas-hoy?fecha, DELETE /api/solicitudes/:id, POST /logout.
import { $, api, esc, fmtMinutes, icon, intervalToMinutes, isoLocal, openActionSheet, toast } from './app.js';
import { invitarAInstalar } from './install.js';

// Referencia para la barra del día: 8 h es la carga más frecuente en la base.
const JORNADA_MIN = 8 * 60;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const hoy = () => isoLocal(new Date());
const soloFecha = v => (v ? String(v).split('T')[0] : null);

function fechaLarga(iso) {
    if (iso === hoy()) return 'hoy';
    const d = new Date(`${iso}T00:00:00`);
    const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
    if (iso === isoLocal(ayer)) return 'ayer';
    return `${DIAS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}

const trabajo = iso => {
    const f = fechaLarga(iso);
    return f === 'hoy' || f === 'ayer' ? `Trabajo de ${f}` : `Trabajo del ${f}`;
};

$('#logout').innerHTML = icon('logout');
$('#cargar').innerHTML = `${icon('plus')}Cargar horas`;

// ------------------------------------------------------------ usuario
async function cargarUsuario() {
    try {
        const u = await api('/api/user');
        if (!u?.usuario) { location.href = '/login.html'; return; }
        const nombre = (u.nombre || u.usuario).trim();
        // "Pérez, Juan" -> "Juan"; "Juan Pérez" -> "Juan"
        const pila = nombre.includes(',') ? nombre.split(',')[1].trim().split(/\s+/)[0] : nombre.split(/\s+/)[0];
        $('#greeting').innerHTML = `Hola, ${esc(pila || u.usuario)}<small>${esc(u.usuario)}</small>`;
    } catch (err) {
        // 401 ya redirige al login desde api(); sin conexión, se queda en la página.
        $('#greeting').textContent = 'Hola';
        if (err.status !== 401) toast(err.message, 'error');
    }
}

// ------------------------------------------------------------ total del día
async function cargarTotal() {
    try {
        const rows = await api(`/api/horas-hoy?fecha=${hoy()}`);
        const total = rows.reduce((acc, r) => acc + intervalToMinutes(r.horas), 0);
        const pct = Math.min(100, Math.round((total / JORNADA_MIN) * 100));
        $('#today-total').innerHTML = total ? esc(fmtMinutes(total)) : '0 h <small>sin cargas</small>';
        const bar = $('#today-progress');
        bar.classList.toggle('done', total >= JORNADA_MIN);
        bar.setAttribute('aria-valuemax', String(JORNADA_MIN));
        bar.setAttribute('aria-valuenow', String(total));
        bar.querySelector('span').style.width = `${pct}%`;
        $('#today-hint').textContent = total >= JORNADA_MIN
            ? 'Completaste la jornada de referencia de 8 h.'
            : `Te faltan ${fmtMinutes(JORNADA_MIN - total)} para la jornada de referencia de 8 h.`;
    } catch (err) {
        $('#today-total').textContent = '—';
        $('#today-hint').textContent = err.message;
    }
}

// ------------------------------------------------------------ cargas
let registros = [];

function estadoTag(estado) {
    const e = String(estado || '').toLowerCase();
    if (!e || e === 'aprobado') return '';
    return e === 'rechazado' ? '<span class="tag bad">Rechazada</span>' : '<span class="tag warn">Pendiente</span>';
}

function renderCargas() {
    const cont = $('#entries');
    if (!registros.length) {
        cont.innerHTML = `<div class="empty-state"><b>Todavía no cargaste horas</b>Tocá “Cargar horas” para registrar tu primera carga.</div>`;
        return;
    }
    // Agrupadas por día de carga (el endpoint trae las de hoy y las del último día anterior).
    const grupos = new Map();
    for (const r of registros) {
        const dia = r.fechaCarga || r.fecha;
        if (!grupos.has(dia)) grupos.set(dia, []);
        grupos.get(dia).push(r);
    }
    const dias = [...grupos.keys()].sort().reverse();
    let html = '';
    if (!grupos.has(hoy())) {
        html += `<div class="list-title"><span>Cargadas hoy</span></div>
            <div class="empty-state"><b>Hoy todavía no cargaste horas</b>Tus cargas de hoy van a aparecer acá.</div>`;
    }
    for (const dia of dias) {
        const items = grupos.get(dia);
        const total = items.reduce((a, r) => a + r.minutos, 0);
        html += `<div class="list-title"><span>Cargadas ${esc(fechaLarga(dia))}</span><span>${esc(fmtMinutes(total))}</span></div>
            <div class="entries">${items.map(r => `
                <div class="entry" data-id="${esc(r.id)}">
                    <div class="t">
                        <b>${esc(r.titulo)}</b>
                        ${r.padre ? `<small class="parent">${esc(r.padre)}</small>` : ''}
                        <small>${esc(trabajo(r.fecha))}${estadoTag(r.estado)}</small>
                    </div>
                    <span class="h">${esc(fmtMinutes(r.minutos))}</span>
                    ${r.borrable
                        ? `<button type="button" class="icon-btn" data-del="${esc(r.id)}" aria-label="Eliminar carga de ${esc(fmtMinutes(r.minutos))} en ${esc(r.obra)}">${icon('trash')}</button>`
                        : ''}
                </div>`).join('')}
            </div>`;
    }
    cont.innerHTML = html;
}

async function cargarCargas() {
    try {
        const rows = await api('/api/solicitudes');
        const h = hoy();
        registros = rows.map(r => {
            const fecha = soloFecha(r.fecha);
            const fechaCarga = soloFecha(r.fecha_carga);
            // El servidor arma "Obra / Subobra": se muestra la subobra como título.
            const obra = r.nombre_obra || 'Obra sin nombre';
            const corte = obra.lastIndexOf(' / ');
            return {
                id: r.id,
                obra,
                titulo: corte > 0 ? obra.slice(corte + 3) : obra,
                padre: corte > 0 ? obra.slice(0, corte) : null,
                estado: r.estado,
                fecha,
                fechaCarga,
                minutos: intervalToMinutes(r.horas_solicitadas),
                // Misma regla que antes: solo se puede borrar lo cargado o trabajado hoy.
                borrable: fechaCarga === h || fecha === h,
            };
        });
        renderCargas();
    } catch (err) {
        $('#entries').innerHTML = `<div class="empty-state"><b>No se pudieron cargar tus horas</b>${esc(err.message)}</div>`;
    }
}

$('#entries').addEventListener('click', async e => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    const r = registros.find(x => String(x.id) === btn.dataset.del);
    if (!r) return;

    const accion = await openActionSheet({
        title: 'Eliminar carga',
        body: `<p>Vas a eliminar <strong>${esc(fmtMinutes(r.minutos))}</strong> en <strong>${esc(r.obra)}</strong>
               (${esc(trabajo(r.fecha).toLowerCase())}). Esta acción no se puede deshacer.</p>`,
        actions: [
            { id: 'eliminar', label: 'Eliminar', danger: true },
            { id: 'cancelar', label: 'Cancelar' },
        ],
    });
    if (accion !== 'eliminar') return;

    const row = document.querySelector(`.entry[data-id="${CSS.escape(String(r.id))}"]`);
    row?.classList.add('removing');
    try {
        await api(`/api/solicitudes/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
        registros = registros.filter(x => x !== r);
        renderCargas();
        cargarTotal();
        toast('Carga eliminada.');
    } catch (err) {
        row?.classList.remove('removing');
        toast(err.message, 'error');
    }
});

// ------------------------------------------------------------ sesión
$('#logout').addEventListener('click', async () => {
    const accion = await openActionSheet({
        title: 'Cerrar sesión',
        body: '<p>¿Querés cerrar tu sesión en este dispositivo?</p>',
        actions: [{ id: 'salir', label: 'Cerrar sesión', primary: true }, { id: 'cancelar', label: 'Cancelar' }],
    });
    if (accion !== 'salir') return;
    try { await fetch('/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* igual se sale */ }
    location.href = '/login.html';
});

// ------------------------------------------------------------ inicio
function refrescar() {
    cargarTotal();
    cargarCargas();
}

cargarUsuario();
refrescar();
invitarAInstalar();
// Al volver desde "Cargar horas" con el botón atrás, el navegador puede restaurar
// la página desde caché: se actualizan los datos.
window.addEventListener('pageshow', e => { if (e.persisted) refrescar(); });
