// Capa fina sobre Chart.js: colores desde tokens CSS (claro/oscuro) y marcas consistentes.
/* global Chart */
import { cssVar, esc, fmtNum } from './ui.js';

const instances = {};

export function palette() {
    return {
        series1: cssVar('--series-1'),
        rest: cssVar('--series-rest'),
        critical: cssVar('--status-critical'),
        grid: cssVar('--grid'),
        axis: cssVar('--axis'),
        muted: cssVar('--muted'),
        text: cssVar('--text'),
        text2: cssVar('--text-2'),
        surface: cssVar('--surface'),
    };
}

function applyDefaults(p) {
    Chart.defaults.font.family = '"Plus Jakarta Sans", system-ui, sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.color = p.muted;
    Chart.defaults.animation.duration = 350;
}

export function baseOptions({ stacked = false, horizontal = false, unit = '' } = {}) {
    const p = palette();
    applyDefaults(p);
    const valueAxis = {
        stacked,
        beginAtZero: true,
        grid: { color: p.grid, drawTicks: false },
        border: { display: false },
        ticks: { padding: 6, precision: 0, maxRotation: 0, autoSkipPadding: 12, callback: v => `${fmtNum(v)}${unit}` },
    };
    const catAxis = {
        stacked,
        grid: { display: false },
        border: { color: p.axis },
        // En horizontal cada barra es una categoría con nombre: no saltear etiquetas.
        ticks: { padding: 4, autoSkip: !horizontal, autoSkipPadding: 10, maxRotation: 0 },
    };
    return {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: horizontal ? 'y' : 'x',
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: false }, // leyenda propia en HTML
            tooltip: {
                backgroundColor: p.text,
                titleColor: p.surface,
                bodyColor: p.surface,
                footerColor: p.surface,
                padding: 10,
                cornerRadius: 8,
                boxPadding: 4,
                usePointStyle: true,
            },
        },
        scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
    };
}

/**
 * Barra anclada a la base (borderSkipped 'start'): 4px redondeado solo en el extremo de datos.
 * En apilados: el segmento inferior lleva `gap` (borde de 2px color superficie) y el
 * superior `rounded`.
 */
export function barDataset(label, data, color, { rounded = true, gap = false } = {}) {
    const p = palette();
    return {
        label,
        data,
        backgroundColor: color,
        hoverBackgroundColor: color,
        borderColor: p.surface,
        borderWidth: gap ? 2 : 0,
        borderSkipped: 'start',
        borderRadius: rounded ? 2 : 0,
        maxBarThickness: 32,
        categoryPercentage: 0.8,
        barPercentage: 0.9,
    };
}

export function draw(canvasId, config, isEmpty = false) {
    instances[canvasId]?.destroy();
    delete instances[canvasId];
    const canvas = document.getElementById(canvasId);
    const box = canvas.parentElement;
    box.querySelector('.empty')?.remove();
    canvas.classList.toggle('hidden', isEmpty);
    if (isEmpty) {
        box.insertAdjacentHTML('beforeend', '<div class="empty">Sin datos para el período</div>');
        return;
    }
    instances[canvasId] = new Chart(canvas, config);
}

export function legend(el, items) {
    el.innerHTML = items.map(i =>
        `<span class="legend-item"><span class="legend-swatch" style="background:${i.color}"></span>${esc(i.label)}</span>`).join('');
}
