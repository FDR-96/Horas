// Estado compartido del panel: la configuración en edición y el personal activo.
import { $$ } from './ui.js';

export const state = {
    meta: null,
    config: null,      // copia editable
    personal: [],      // [{ id, nombre, usuario, rol }]
};

let savedJson = '';
const listeners = new Set();

export const isDirty = () => state.config !== null && JSON.stringify(state.config) !== savedJson;

export function onConfigChange(fn) { listeners.add(fn); }

export function markChanged() {
    const dirty = isDirty();
    $$('.dirty-flag').forEach(el => el.classList.toggle('hidden', !dirty));
    listeners.forEach(fn => fn());
}

export function setSavedConfig(cfg) {
    state.config = structuredClone(cfg);
    savedJson = JSON.stringify(state.config);
    markChanged();
}

export const personById = id => state.personal.find(p => p.id === id);

/** Mapa id de personal -> nombres de los grupos a los que pertenece. */
export function membership() {
    const map = new Map();
    (state.config?.grupos || []).forEach(g => g.miembros.forEach(id => {
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(g.nombre);
    }));
    return map;
}
