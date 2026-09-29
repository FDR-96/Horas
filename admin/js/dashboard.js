// Vista Dashboard: KPIs, gráficos de actividad/inactividad y tabla de inactivos.
import { api } from './api.js';
import { barDataset, baseOptions, draw, legend, palette } from './charts.js';
import { $, $$, esc, fmtDate, fmtNum, fmtShort, renderTable, toast, withBusy } from './ui.js';

let dias = 30;
let data = null;

export function initDashboard() {
    $$('#period button').forEach(btn => btn.addEventListener('click', () => {
        $$('#period button').forEach(b => b.classList.toggle('active', b === btn));
        dias = Number(btn.dataset.dias);
        loadDashboard();
    }));
    $('#dash-refresh').addEventListener('click', e => withBusy(e.currentTarget, loadDashboard));
    $$('[data-toggle-table]').forEach(btn => btn.addEventListener('click', () =>
        $(`#${btn.dataset.toggleTable}`).classList.toggle('hidden')));
}

export async function loadDashboard() {
    try {
        data = await api.metricas(dias);
        render();
    } catch (err) {
        toast(err.message, 'error');
    }
}

/** Redibuja con los datos en memoria (p. ej. al cambiar el tema). */
export function rerenderDashboard() {
    if (data) render();
}

function render() {
    const k = data.kpis;
    $('#dash-sub').textContent =
        `${fmtDate(data.desde)} al ${fmtDate(data.hasta)} · umbral ${data.umbral_dias} día(s) laborable(s)`;
    renderKpis(k);
    renderDaily();
    renderHours();
    renderDistribution();
    renderGroups();
    renderSectors();
    renderInactiveTable();
}

function kpi({ label, value, foot, alert = false }) {
    return `<div class="kpi ${alert ? 'alert' : ''}">
        <div class="kpi-label">${esc(label)}</div>
        <div class="kpi-value">${value}</div>
        <div class="kpi-foot">${foot}</div>
    </div>`;
}

function renderKpis(k) {
    $('#kpis').innerHTML = [
        kpi({ label: 'Personal', value: fmtNum(k.personal_controlado),
            foot: `${fmtNum(k.sin_registros)} sin ninguna carga` }),
        kpi({ label: 'Inactivos', value: fmtNum(k.inactivos), alert: k.inactivos > 0,
            foot: `≥ ${data.umbral_dias} día(s) sin cargar` }),
        kpi({ label: 'Con carga',
            value: `${fmtNum(k.con_carga_ultimo_dia)}<small> / ${fmtNum(k.personal_controlado)}</small>`,
            foot: k.ultimo_dia_control ? `Día de control ${fmtDate(k.ultimo_dia_control)}` : '—' }),
        kpi({ label: 'Tasa de carga', value: `${fmtNum(k.tasa_promedio, 1)}%`,
            foot: `Promedio de ${k.dias_control_periodo} días` }),
        kpi({ label: 'Horas', value: fmtNum(k.horas_total),
            foot: `${fmtNum(k.horas_por_carga, 1)} h por persona y día` }),
        kpi({ label: 'Alertas', value: fmtNum(k.alertas_enviadas),
            foot: k.alertas_error ? `Enviadas · ${fmtNum(k.alertas_error)} con error` : 'Enviadas sin errores' }),
    ].join('');
}

function renderDaily() {
    const p = palette();
    const serie = data.serie_diaria;
    legend($('#legend-diaria'), [
        { label: 'Con carga', color: p.series1 },
        { label: 'Sin carga', color: p.rest },
    ]);
    const opts = baseOptions({ stacked: true });
    opts.plugins.tooltip.callbacks = {
        title: items => {
            const s = serie[items[0].dataIndex];
            return `${fmtDate(s.fecha)}${s.en_curso ? ' (en curso)' : ''}`;
        },
        footer: items => `Tasa de carga: ${fmtNum(serie[items[0].dataIndex].tasa, 1)}%`,
    };
    draw('chart-diaria', {
        type: 'bar',
        data: {
            labels: serie.map(s => fmtShort(s.fecha)),
            datasets: [
                // El día en curso (no evaluado todavía) se atenúa: su carga es parcial.
                barDataset('Con carga', serie.map(s => s.con_carga),
                    serie.map(s => (s.en_curso ? `${p.series1}66` : p.series1)), { rounded: false, gap: true }),
                barDataset('Sin carga', serie.map(s => s.sin_carga), p.rest),
            ],
        },
        options: opts,
    }, !serie.length);

    renderTable($('#tabla-diaria'), [
        { label: 'Fecha', render: s => fmtDate(s.fecha) + (s.en_curso ? ' <span class="tag">en curso</span>' : '') },
        { label: 'Con carga', key: 'con_carga', num: true },
        { label: 'Sin carga', key: 'sin_carga', num: true },
        { label: 'Tasa', render: s => `${fmtNum(s.tasa, 1)}%`, num: true },
        { label: 'Horas', render: s => fmtNum(s.horas, 1), num: true },
    ], [...serie].reverse());
}

function renderHours() {
    const p = palette();
    const serie = data.serie_diaria;
    const opts = baseOptions({ unit: ' h' });
    opts.plugins.tooltip.callbacks = {
        title: items => {
            const s = serie[items[0].dataIndex];
            return `${fmtDate(s.fecha)}${s.en_curso ? ' (en curso, parcial)' : ''}`;
        },
        label: item => ` ${fmtNum(item.raw, 1)} horas`,
    };
    draw('chart-horas', {
        type: 'line',
        data: {
            labels: serie.map(s => fmtShort(s.fecha)),
            datasets: [{
                label: 'Horas',
                data: serie.map(s => s.horas),
                borderColor: p.series1,
                backgroundColor: p.series1,
                borderWidth: 2,
                tension: 0.25,
                pointRadius: 0,
                pointHoverRadius: 5,
                pointHoverBorderColor: p.surface,
                pointHoverBorderWidth: 2,
                // tramo hacia el día en curso punteado: el total todavía puede crecer
                segment: { borderDash: ctx => (serie[ctx.p1DataIndex]?.en_curso ? [4, 4] : undefined) },
            }],
        },
        options: opts,
    }, !serie.length);
}

function renderDistribution() {
    const p = palette();
    const dist = data.distribucion;
    legend($('#legend-dist'), [
        { label: 'Debajo del umbral', color: p.series1 },
        { label: 'Supera el umbral (alerta)', color: p.critical },
    ]);
    const opts = baseOptions();
    opts.interaction = { mode: 'nearest', intersect: true };
    opts.plugins.tooltip.callbacks = {
        title: items => `${dist[items[0].dataIndex].label} día(s) sin cargar`,
        label: item => ` ${fmtNum(item.raw)} persona(s)`,
    };
    const ds = barDataset('Personas', dist.map(b => b.cantidad), dist.map(b => (b.supera_umbral ? p.critical : p.series1)));
    draw('chart-dist', {
        type: 'bar',
        data: { labels: dist.map(b => b.label), datasets: [ds] },
        options: opts,
    }, !dist.some(b => b.cantidad));
}

function renderGroups() {
    const p = palette();
    const rows = data.por_grupo;
    legend($('#legend-grupos'), [
        { label: 'Al día', color: p.series1 },
        { label: 'Inactivos', color: p.critical },
    ]);
    const opts = baseOptions({ stacked: true, horizontal: true });
    draw('chart-grupos', {
        type: 'bar',
        data: {
            labels: rows.map(r => r.grupo),
            datasets: [
                barDataset('Al día', rows.map(r => r.activos), p.series1, { rounded: false, gap: true }),
                barDataset('Inactivos', rows.map(r => r.inactivos), p.critical),
            ],
        },
        options: opts,
    }, !rows.length);
}

function renderSectors() {
    const p = palette();
    const MAX = 7;
    let rows = data.por_sector;
    if (rows.length > MAX + 1) {
        const otros = rows.slice(MAX).reduce((acc, r) => acc + r.horas, 0);
        rows = [...rows.slice(0, MAX), { sector: 'Otros', horas: Math.round(otros * 10) / 10 }];
    }
    const opts = baseOptions({ horizontal: true, unit: ' h' });
    opts.interaction = { mode: 'nearest', intersect: true, axis: 'y' };
    opts.plugins.tooltip.callbacks = { label: item => ` ${fmtNum(item.raw, 1)} horas` };
    draw('chart-sectores', {
        type: 'bar',
        data: { labels: rows.map(r => r.sector), datasets: [barDataset('Horas', rows.map(r => r.horas), p.series1)] },
        options: opts,
    }, !rows.length);
}

function renderInactiveTable() {
    const rows = data.top_inactivos;
    $('#inactivos-sub').textContent = rows.length
        ? `${data.kpis.inactivos} persona(s) con ${data.umbral_dias} o más días laborables sin cargar horas` +
          (data.kpis.inactivos > rows.length ? ` · se muestran las ${rows.length} con más días` : '')
        : 'Todo el personal está al día.';
    renderTable($('#tabla-inactivos'), [
        { label: 'Nombre', render: u => `<strong>${esc(u.nombre)}</strong>` },
        { label: 'Usuario', key: 'usuario' },
        { label: 'DNI', key: 'dni' },
        { label: 'Grupo', render: u => u.grupos.map(g => `<span class="tag">${esc(g.nombre)}</span>`).join(' ') },
        { label: 'Última carga', render: u => (u.sin_registros
            ? '<span class="tag warn"><span class="material-symbols-outlined">help</span>Sin registros</span>'
            : fmtDate(u.ultima_carga)) },
        { label: 'Días sin cargar', num: true,
            render: u => `<span class="days-pill">${u.dias_es_minimo ? '+' : ''}${u.dias_inactivo}</span>` },
    ], rows, 'Nadie supera el umbral de inactividad.');
}
