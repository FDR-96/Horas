// Invitación a instalar TimeTrack en la pantalla de inicio.
//
// - Si la app ya corre instalada (standalone), no se muestra nada.
// - Chrome/Android con HTTPS: se captura `beforeinstallprompt` y el botón
//   "Instalar" abre el diálogo nativo (instalación en un toque).
// - iPhone/iPad (no existe el evento) y Android sin el evento (p. ej. por http):
//   se muestran los pasos para agregarla a mano desde el navegador.
// - Si el usuario la cierra o la rechaza, no vuelve a aparecer por un tiempo
//   (localStorage). Si la instala, no aparece más.
import { esc, icon, openActionSheet, store } from './app.js';

const KEY = 'tt_install_prompt';            // { until: timestamp | "never" }
const DIA = 24 * 60 * 60 * 1000;
const POSPONER = { cerrar: 7 * DIA, rechazo: 14 * DIA, manual: 30 * DIA };
const ESPERA_EVENTO_MS = 3500;              // margen para que llegue beforeinstallprompt
const DEMORA_MOSTRAR_MS = 1200;             // no interrumpir apenas carga la pantalla

let promptNativo = null;

// Si el usuario ya empezó a usar la pantalla, no se lo interrumpe con el modal
// (un popup que aparece justo al tocar "roba" el toque). Queda para otra visita.
let interactuo = false;
['pointerdown', 'keydown'].forEach(tipo =>
    window.addEventListener(tipo, () => { interactuo = true; }, { capture: true, once: true }));

// Chrome dispara el evento una vez, apenas la página cumple los requisitos:
// hay que escucharlo desde que se carga el módulo.
window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();                     // se muestra nuestro modal en lugar del banner de Chrome
    promptNativo = e;
});
window.addEventListener('appinstalled', () => {
    promptNativo = null;
    store.set(KEY, { until: 'never' });
});

// ------------------------------------------------------------ detección de entorno
export function esStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: fullscreen)').matches
        || window.navigator.standalone === true;  // Safari iOS
}

const ua = navigator.userAgent;
const esIOS = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1); // iPadOS
const esAndroid = /android/i.test(ua);
const esMovil = esIOS || esAndroid || window.matchMedia('(pointer: coarse)').matches;

function pospuesto() {
    const estado = store.get(KEY);
    if (!estado) return false;
    return estado.until === 'never' || Date.now() < estado.until;
}
const posponer = ms => store.set(KEY, { until: Date.now() + ms });

// ------------------------------------------------------------ contenido del modal
const cabecera = (titulo, texto) => `
    <img src="/assets/icons/icon.svg" alt="" class="install-icon" width="72" height="72">
    <h3>${esc(titulo)}</h3>
    <p>${esc(texto)}</p>`;

const beneficios = `
    <ul class="install-list">
        <li>${icon('check')}Abre al instante desde tu pantalla de inicio</li>
        <li>${icon('check')}Pantalla completa, sin la barra del navegador</li>
        <li>${icon('check')}Cargás tus horas en segundos</li>
    </ul>`;

async function modalNativo() {
    const accion = await openActionSheet({
        title: 'Instalar app',
        body: `<div class="install">${cabecera('Instalá TimeTrack', 'Tenela en tu teléfono como una app más.')}${beneficios}</div>`,
        actions: [
            { id: 'instalar', label: 'Instalar', primary: true },
            { id: 'cerrar', label: 'Ahora no' },
        ],
    });
    if (accion !== 'instalar' || !promptNativo) {
        posponer(POSPONER.cerrar);
        return;
    }
    const evento = promptNativo;
    promptNativo = null;                    // el evento solo se puede usar una vez
    evento.prompt();
    const { outcome } = await evento.userChoice;
    if (outcome === 'accepted') store.set(KEY, { until: 'never' });
    else posponer(POSPONER.rechazo);
}

async function modalManual() {
    const pasos = esIOS
        ? `<li><span>Tocá ${icon('share')} <strong>Compartir</strong> en la barra del navegador</span></li>
           <li><span>Elegí ${icon('addSquare')} <strong>Agregar a inicio</strong></span></li>
           <li><span>Tocá <strong>Agregar</strong> arriba a la derecha</span></li>`
        : `<li><span>Tocá el menú ${icon('dots')} arriba a la derecha</span></li>
           <li><span>Elegí <strong>Agregar a la pantalla de inicio</strong> o <strong>Instalar app</strong></span></li>
           <li><span>Confirmá con <strong>Agregar</strong></span></li>`;
    const accion = await openActionSheet({
        title: 'Instalar app',
        body: `<div class="install">${cabecera('Agregá TimeTrack a tu inicio', 'Así la abrís como una app, con un toque.')}
            <ol class="install-steps">${pasos}</ol></div>`,
        actions: [
            { id: 'ok', label: 'Entendido', primary: true },
            { id: 'cerrar', label: 'Ahora no' },
        ],
    });
    posponer(accion === 'ok' ? POSPONER.manual : POSPONER.cerrar);
}

// ------------------------------------------------------------ punto de entrada
/**
 * Muestra la invitación si corresponde. Llamar una vez por página
 * (el tablero la usa al cargar).
 */
export function invitarAInstalar() {
    if (esStandalone() || pospuesto() || !esMovil) return;

    // No interrumpir si el usuario ya está tocando la pantalla o abrió otra hoja.
    const mostrar = fn => setTimeout(() => {
        if (!interactuo && !document.querySelector('.sheet') && !pospuesto()) fn();
    }, DEMORA_MOSTRAR_MS);

    if (promptNativo) { mostrar(modalNativo); return; }
    if (esIOS) { mostrar(modalManual); return; }
    // Sin HTTPS el navegador nunca ofrece la instalación nativa: pasos manuales ya.
    if (!window.isSecureContext) { if (esAndroid) mostrar(modalManual); return; }

    // Android con HTTPS: esperar el evento nativo; si no llega (navegador sin
    // soporte o sin los requisitos), se ofrecen los pasos manuales.
    const inicio = Date.now();
    const esperar = () => {
        if (promptNativo) return mostrar(modalNativo);
        if (Date.now() - inicio < ESPERA_EVENTO_MS) return setTimeout(esperar, 250);
        if (esAndroid) mostrar(modalManual);
    };
    esperar();
}
