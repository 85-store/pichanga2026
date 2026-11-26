// Pantalla de login/registro (Firebase Auth por email+contraseña). Se muestra
// tapando todo lo demas hasta que haya sesion (se suscribe a
// window.onAuthStateChange, definido en api-client.js); title.js se suscribe
// a lo mismo para recien ahi arrancar renderTitleScreen.
const authRoot = document.getElementById('auth-root');

function renderAuthScreen() {
  authRoot.style.display = '';
  authRoot.innerHTML = `
    <div class="title-modal-backdrop" style="position:fixed;inset:0;z-index:1000;">
      <div class="title-modal" style="width:300px;margin:auto;">
        <h2>PICHANGA <span style="color:var(--accent)">26</span></h2>
        <label class="field-label">Email</label>
        <input type="email" id="auth-email" autocomplete="username" />
        <label class="field-label">Contraseña</label>
        <input type="password" id="auth-password" autocomplete="current-password" />
        <div class="warn-text" id="auth-error" style="display:none"></div>
        <div class="title-modal-actions" style="justify-content:space-between">
          <button class="title-btn small" id="auth-register-btn">Crear cuenta</button>
          <button class="title-btn small" id="auth-login-btn">Entrar</button>
        </div>
      </div>
    </div>`;

  const emailEl = document.getElementById('auth-email');
  const passwordEl = document.getElementById('auth-password');
  const errorEl = document.getElementById('auth-error');
  const loginBtn = document.getElementById('auth-login-btn');
  const registerBtn = document.getElementById('auth-register-btn');

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.style.display = '';
  };

  const run = async (action, btn, label) => {
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) return showError('Completá email y contraseña.');
    loginBtn.disabled = true;
    registerBtn.disabled = true;
    btn.textContent = label;
    try {
      await action(email, password);
      // onAuthStateChanged se dispara solo y oculta esta pantalla.
    } catch (e) {
      showError(e.message || 'No se pudo iniciar sesión.');
      loginBtn.disabled = false;
      registerBtn.disabled = false;
      loginBtn.textContent = 'Entrar';
      registerBtn.textContent = 'Crear cuenta';
    }
  };

  loginBtn.addEventListener('click', () => run(window.signIn, loginBtn, 'Entrando…'));
  registerBtn.addEventListener('click', () => run(window.signUp, registerBtn, 'Creando…'));
  passwordEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loginBtn.click();
  });
}

window.onAuthStateChange((user) => {
  if (user) {
    authRoot.style.display = 'none';
    authRoot.innerHTML = '';
  } else {
    renderAuthScreen();
  }
});
