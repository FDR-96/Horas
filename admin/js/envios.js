// Vista Envíos: disparo manual / simulación, email de prueba, pendientes e historial.
import { api } from './api.js';
import { isDirty } from './state.js';
import { $, EMAIL_RE, esc, fmtDate, fmtDateTime, renderTable, toast, withBusy } from './ui.js';

const ESTADOS = {
    enviado: { cls: 'good', icon: 'check_circle', label: 'Enviado' },
    simulado: { cls: '', icon: 'science', label: 'Simulado' },
    error: { cls: 'critical', icon: 'error', label: 'Error' },
    sin_destinatario: { cls: 'warn', icon: 'person_off', label: 'Sin destinatario' },
};

const estadoTag = estado => {
    const e = ESTADOS[estado] || { cls: '', icon: 'help', label: estado };
    return `<span class="tag ${e.cls}"><span class="material-symbols-outlined">${e.icon}</span>${esc(e.label)}</span>`;
};

export function initEnvios() {
    $('#run-dry').addEventListener('click', e => withBusy(e.currentTarget, () => run(true)));
    $('#run-real').addEventListener('click', e => {
        const warn = isDirty() ? '\n\nAtención: hay cambios sin guardar; se usará la configuración guardada.' : '';
        if (!confirm(`¿Enviar ahora las alertas de inactividad a los encargados?${warn}`)) return;
        withBusy(e.currentTarget, () => run(false));
    });
    $('#test-send').addEventListener('click', e => {
        const to = $('#test-to').value.trim();
        if (!EMAIL_RE.test(to)) { toast('Ingresá un email válido.', 'error'); return; }
        withBusy(e.currentTarget, async () => {
            try {
                await api.testEmail(to);
                toast(`Email de prueba enviado a ${to}.`);
            } catch (err) { toast(err.message, 'error'); }
        });
    });
    $('#pendientes-refresh').addEventListener('click', e => withBusy(e.currentTarget, loadPendientes));
    $('#hist-estado').addEventListener('change', loadHistorial);
}

export function loadEnvios() {
    loadPendientes();
    loadHistorial();
}

async function run(dryRun) {
    const out = $('#run-result');
    try {
        const r = await api.ejecutar(dryRun, $('#forzar').checked);
        if (!r.ejecutado) {
            out.innerHTML = `<div class="run-summary"><div class="run-line"><span class="material-symbols-outlined">event_busy</span>
                <span>${esc(r.motivo)}</span></div></div>`;
            return;
        }
        const lines = r.emails.map(m => `<div class="run-line">${estadoTag(m.estado)}
            <span><strong>${esc(m.grupo)}</strong>${esc(m.usuarios.join(', '))}
            <br><span class="muted small">${m.destinatarios.length ? esc(m.destinatarios.join(', ')) : 'sin destinatarios'}
            ${m.detalle ? ` · ${esc(m.detalle)}` : ''}</span></span></div>`).join('');
        out.innerHTML = `<div class="run-summary">
            <div class="muted small">${dryRun ? 'Simulación' : 'Ejecución'} · evaluado hasta ${fmtDate(r.fecha_referencia)} ·
                ${r.evaluados} controlados · ${r.inactivos} inactivos · ${r.omitidos_por_repeticion} omitidos por no repetir</div>
            ${lines || '<div class="run-line"><span class="material-symbols-outlined">task_alt</span><span>No hay alertas para enviar.</span></div>'}
        </div>`;
        if (!dryRun) {
            const errores = r.emails.filter(m => m.estado !== 'enviado').length;
            toast(errores ? `${errores} envío(s) con problemas.` : 'Alertas enviadas.', errores ? 'error' : 'ok');
            loadHistorial();
        }
    } catch (err) {
        toast(err.message, 'error');
    }
}

async function loadPendientes() {
    try {
        const r = await api.inactivos(true);
        $('#pendientes-sub').textContent =
            `Umbral ${r.umbral_dias} día(s) laborable(s), contando hoy · ` +
            (r.es_dia_control_hoy ? 'hoy es día de control' : 'hoy NO es día de control (el envío automático no corre)');
        renderTable($('#tabla-pendientes'), [
            { label: 'Nombre', render: u => `<strong>${esc(u.nombre)}</strong>` },
            { label: 'DNI', key: 'dni' },
            { label: 'Grupo(s)', render: u => u.grupos.map(g => `<span class="tag">${esc(g.nombre)}</span>`).join(' ') },
            { label: 'Última carga', render: u => (u.sin_registros ? 'Sin registros' : fmtDate(u.ultima_carga)) },
            { label: 'Días', num: true, render: u => `<span class="days-pill">${u.dias_es_minimo ? '+' : ''}${u.dias_inactivo}</span>` },
        ], r.usuarios, 'Nadie supera el umbral: no se enviarían alertas.');
    } catch (err) {
        $('#tabla-pendientes').innerHTML = `<p class="muted small">${esc(err.message)}</p>`;
    }
}

async function loadHistorial() {
    try {
        const rows = await api.historial($('#hist-estado').value);
        renderTable($('#tabla-historial'), [
            { label: 'Fecha', render: r => fmtDateTime(r.fecha_envio) },
            { label: 'Disparo', key: 'disparo' },
            { label: 'Persona', render: r => `${esc(r.nombre)}<br><span class="muted small">DNI ${esc(r.dni)}</span>` },
            { label: 'Grupo', key: 'grupo' },
            { label: 'Días', key: 'dias_inactivo', num: true },
            { label: 'Destinatarios', render: r => `<span class="small">${esc(r.destinatarios || '—')}</span>` },
            { label: 'Estado', render: r => estadoTag(r.estado) + (r.detalle ? `<br><span class="muted small">${esc(r.detalle)}</span>` : '') },
        ], rows, 'Todavía no se enviaron alertas.');
    } catch (err) {
        $('#tabla-historial').innerHTML = `<p class="muted small">${esc(err.message)}</p>`;
    }
}
