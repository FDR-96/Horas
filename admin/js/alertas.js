// Vista Alertas: umbral, días de control, feriados extra, envío y mensaje.
import { api } from './api.js';
import { markChanged, onConfigChange, state } from './state.js';
import { $, $$, debounce, esc, fmtDate, toast } from './ui.js';

const DIAS_CORTOS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

export function initAlertas() {
    const cfg = () => state.config;
    const change = () => { markChanged(); schedulePreview(); };

    // --- Regla
    const syncUmbral = v => {
        const n = Math.max(1, Math.min(60, Number(v) || 1));
        cfg().umbral_dias = n;
        $('#umbral').value = n;
        $('#umbral-range').value = Math.min(n, 15);
        change();
    };
    $('#umbral').addEventListener('change', e => syncUmbral(e.target.value));
    $('#umbral-range').addEventListener('input', e => syncUmbral(e.target.value));
    $('#no-repetir').addEventListener('change', e => {
        cfg().no_repetir_dias = Math.max(0, Math.min(30, Number(e.target.value) || 0));
        e.target.value = cfg().no_repetir_dias;
        change();
    });

    // --- Días de control
    $('#day-chips').innerHTML = DIAS_CORTOS.map((d, i) =>
        `<button type="button" class="day-chip" data-day="${i}" title="${esc(state.meta.dias_semana[i])}"
            aria-pressed="false">${d}</button>`).join('');
    $('#day-chips').addEventListener('click', e => {
        const btn = e.target.closest('.day-chip');
        if (!btn) return;
        const day = Number(btn.dataset.day);
        const set = new Set(cfg().dias_control);
        if (set.has(day)) {
            if (set.size === 1) { toast('Tiene que haber al menos un día de control.', 'error'); return; }
            set.delete(day);
        } else set.add(day);
        cfg().dias_control = [...set].sort();
        renderDias();
        change();
    });
    $('#excluir-nacionales').addEventListener('change', e => { cfg().excluir_feriados_nacionales = e.target.checked; change(); });

    $('#feriado-add').addEventListener('click', () => {
        const fecha = $('#feriado-fecha').value;
        if (!fecha) { toast('Elegí una fecha.', 'error'); return; }
        if (cfg().feriados_extra.some(f => f.fecha === fecha)) { toast('Esa fecha ya está cargada.', 'error'); return; }
        cfg().feriados_extra.push({ fecha, descripcion: $('#feriado-desc').value.trim() });
        cfg().feriados_extra.sort((a, b) => a.fecha.localeCompare(b.fecha));
        $('#feriado-fecha').value = '';
        $('#feriado-desc').value = '';
        renderFeriados();
        change();
    });
    $('#feriados-extra').addEventListener('click', e => {
        const btn = e.target.closest('button[data-fecha]');
        if (!btn) return;
        cfg().feriados_extra = cfg().feriados_extra.filter(f => f.fecha !== btn.dataset.fecha);
        renderFeriados();
        change();
    });

    // --- Envío (siempre automático, un email por grupo)
    $('#hora-envio').addEventListener('change', e => { if (e.target.value) { cfg().hora_envio = e.target.value; change(); } });

    // --- Mensaje
    $('#asunto').addEventListener('input', e => { cfg().asunto = e.target.value; change(); });
    $('#mensaje').addEventListener('input', e => { cfg().mensaje = e.target.value; change(); });
    let lastField = $('#mensaje');
    ['#asunto', '#mensaje'].forEach(sel => $(sel).addEventListener('focus', e => { lastField = e.target; }));
    $('#placeholders').innerHTML = Object.entries(state.meta.placeholders).map(([k, desc]) =>
        `<button type="button" class="ph-chip" data-ph="${k}" title="${esc(desc)}">{${k}}</button>`).join('');
    $('#placeholders').addEventListener('click', e => {
        const btn = e.target.closest('[data-ph]');
        if (!btn) return;
        const field = lastField;
        const token = `{${btn.dataset.ph}}`;
        const { selectionStart: s = field.value.length, selectionEnd: end = field.value.length } = field;
        field.value = field.value.slice(0, s) + token + field.value.slice(end);
        field.focus();
        field.setSelectionRange(s + token.length, s + token.length);
        field.dispatchEvent(new Event('input'));
    });

    onConfigChange(renderProximoEnvio);
}

/** Vuelca state.config en el formulario (al cargar o descartar cambios). */
export function renderAlertas() {
    const c = state.config;
    $('#umbral').value = c.umbral_dias;
    $('#umbral-range').value = Math.min(c.umbral_dias, 15);
    $('#no-repetir').value = c.no_repetir_dias;
    $('#excluir-nacionales').checked = c.excluir_feriados_nacionales;
    $('#hora-envio').value = c.hora_envio;
    $('#asunto').value = c.asunto;
    $('#mensaje').value = c.mensaje;
    renderDias();
    renderFeriados();
    renderProximoEnvio();
    schedulePreview();
    loadProximosFeriados();
}

function renderDias() {
    $$('.day-chip').forEach(btn => {
        const on = state.config.dias_control.includes(Number(btn.dataset.day));
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
    });
}

function renderFeriados() {
    $('#feriados-extra').innerHTML = state.config.feriados_extra.map(f =>
        `<li class="chip">${fmtDate(f.fecha)}${f.descripcion ? ` · ${esc(f.descripcion)}` : ''}
            <button type="button" data-fecha="${f.fecha}" aria-label="Quitar"><span class="material-symbols-outlined">close</span></button></li>`).join('');
}

function renderProximoEnvio() {
    const el = $('#proximo-envio');
    if (!state.meta.scheduler_activo) {
        el.textContent = 'El envío automático está deshabilitado en la API (SCHEDULER_ENABLED=false); depende de un cron externo.';
    } else if (state.config.hora_envio !== state.meta.hora_programada) {
        el.textContent = 'Guardá los cambios para reprogramar el envío.';
    } else if (state.meta.proximo_envio) {
        const d = new Date(state.meta.proximo_envio);
        el.textContent = `Se envía automáticamente cada día de control. Próxima evaluación: ${fmtDate(state.meta.proximo_envio.slice(0, 10))} ` +
            `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}.`;
    } else {
        el.textContent = 'Se envía automáticamente cada día de control.';
    }
}

export async function loadProximosFeriados() {
    try {
        const cal = await api.calendario();
        // Solo feriados que caen en un día de semana controlado (los de fin de semana no cambian nada).
        const list = cal.feriados.filter(d => state.config.dias_control.includes(state.meta.dias_semana.indexOf(d.dia_semana)));
        $('#proximos-feriados').innerHTML = list.length
            ? list.map(d => `<li><time>${fmtDate(d.fecha)}</time><span>${esc(d.dia_semana)} · ${esc(d.feriado || '')}</span></li>`).join('')
            : '<li class="muted">No hay feriados en los próximos 60 días.</li>';
    } catch (err) {
        $('#proximos-feriados').innerHTML = `<li class="muted">${esc(err.message)}</li>`;
    }
}

const schedulePreview = debounce(async () => {
    try {
        const { asunto, html } = await api.preview(state.config);
        $('#preview-asunto').textContent = asunto;
        $('#preview-frame').srcdoc = html;
    } catch (err) {
        $('#preview-asunto').textContent = `No se pudo generar la vista previa: ${err.message}`;
    }
}, 450);
