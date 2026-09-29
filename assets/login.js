// Login de empleados. Mismo contrato que antes: POST /login { username, password }.
import { $, icon } from './app.js';

const form = $('#login-form');
const user = $('#username');
const pass = $('#password');
const toggle = $('#toggle-pass');
const errorBox = $('#error-message');
const submit = $('#submit');

const setToggle = () => {
    const visible = pass.type === 'text';
    toggle.innerHTML = icon(visible ? 'eyeOff' : 'eye');
    toggle.setAttribute('aria-label', visible ? 'Ocultar contraseña' : 'Mostrar contraseña');
};
toggle.addEventListener('click', () => {
    pass.type = pass.type === 'password' ? 'text' : 'password';
    setToggle();
    pass.focus();
});
setToggle();

user.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); pass.focus(); }
});

const showError = message => {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
};

form.addEventListener('submit', async e => {
    e.preventDefault();
    errorBox.classList.add('hidden');
    const username = user.value.trim();
    const password = pass.value.trim();
    if (!username || !password) {
        showError('Ingresá tu usuario y contraseña.');
        (username ? pass : user).focus();
        return;
    }

    submit.disabled = true;
    submit.textContent = 'Ingresando…';
    try {
        const res = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const result = await res.json().catch(() => ({}));
        if (res.ok && result.success) {
            location.href = '/dashboard';
            return;
        }
        showError(result.message || 'No se pudo iniciar sesión.');
    } catch {
        showError('Sin conexión con el servidor. Revisá tu señal e intentá de nuevo.');
    }
    submit.disabled = false;
    submit.textContent = 'Ingresar';
});
