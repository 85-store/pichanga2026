// Pantalla de login/registro (Firebase Auth por email+contraseña). Se muestra
// tapando todo lo demas hasta que haya sesion (se suscribe a
// window.onAuthStateChange, definido en api-client.js); title.js se suscribe
// a lo mismo para recien ahi arrancar renderTitleScreen.
const authRoot = document.getElementById('auth-root');

// Mientras se completa el registro en 2 pasos, la cuenta de Firebase ya
// existe (y por lo tanto onAuthStateChange ya disparo con user != null), pero
// todavia no hay que dejar que title.js tome el control: esta bandera le dice
// al listener de abajo que no oculte authRoot todavia.
let skipAutoHide = false;

// Carrusel de fondo propio de esta pantalla, independiente del de title.js
// (que usa el mismo markup pero con id="title-bg" dentro de su propio root):
// no se puede reusar window.startBgCarousel aqui porque ambos containers
// coexisten en el DOM mientras dura el registro (title.js ya renderizo su
// pantalla de titulo detras de este overlay en cuanto el usuario quedo
// autenticado) y los ids duplicados harian que getElementById pise uno con
// el otro.
let authBgTimer = null;
async function startAuthBgCarousel() {
  if (authBgTimer) clearInterval(authBgTimer);
  const bg = document.getElementById('auth-bg');
  if (!bg) return;
  let photos = [];
  try {
    const res = await fetch('/bg-photos.json');
    photos = await res.json();
  } catch (e) {
    return;
  }
  if (!Array.isArray(photos) || photos.length === 0) return;

  let idx = 0;
  const makeSlide = (url, active) => {
    const slide = document.createElement('div');
    slide.className = 'title-bg-slide' + (active ? ' active' : '');
    slide.style.backgroundImage = `url('${url}')`;
    return slide;
  };
  bg.innerHTML = '';
  bg.appendChild(makeSlide(photos[idx], true));
  const overlay = document.createElement('div');
  overlay.className = 'title-bg-overlay';
  bg.appendChild(overlay);

  authBgTimer = setInterval(() => {
    idx = (idx + 1) % photos.length;
    const next = makeSlide(photos[idx], false);
    bg.insertBefore(next, overlay);
    requestAnimationFrame(() => next.classList.add('active'));
    const slides = bg.querySelectorAll('.title-bg-slide');
    if (slides.length > 2) slides[0].remove();
  }, 5000);
}

function escAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function authScreenShell(logoText, innerHtml) {
  authRoot.style.display = '';
  authRoot.innerHTML = `
    <div class="title-screen" style="z-index:1000;">
      <div class="title-bg" id="auth-bg"></div>
      <div class="title-foreground">
        <div class="title-logo">${logoText}</div>
        ${innerHtml}
      </div>
    </div>`;
  startAuthBgCarousel();
}

function renderAuthScreen() {
  authScreenShell(
    'PICHANGA',
    `<div class="title-modal" style="width:300px;">
       <label class="field-label">Email</label>
       <input type="email" id="auth-email" autocomplete="username" />
       <label class="field-label">Contraseña</label>
       <input type="password" id="auth-password" autocomplete="current-password" />
       <div class="warn-text" id="auth-error" style="display:none"></div>
       <div class="title-modal-actions" style="justify-content:space-between">
         <button class="title-btn small" id="auth-register-btn">Crear cuenta</button>
         <button class="title-btn small" id="auth-login-btn">Entrar</button>
       </div>
     </div>`
  );

  const emailEl = document.getElementById('auth-email');
  const passwordEl = document.getElementById('auth-password');
  const errorEl = document.getElementById('auth-error');
  const loginBtn = document.getElementById('auth-login-btn');
  const registerBtn = document.getElementById('auth-register-btn');

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.style.display = '';
  };

  const runLogin = async () => {
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) return showError('Completá email y contraseña.');
    loginBtn.disabled = true;
    registerBtn.disabled = true;
    loginBtn.textContent = 'Entrando…';
    try {
      await window.signIn(email, password);
      // onAuthStateChanged se dispara solo y oculta esta pantalla.
    } catch (e) {
      showError(e.message || 'No se pudo iniciar sesión.');
      loginBtn.disabled = false;
      registerBtn.disabled = false;
      loginBtn.textContent = 'Entrar';
    }
  };

  loginBtn.addEventListener('click', runLogin);
  registerBtn.addEventListener('click', () => renderRegisterStep1());
  passwordEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runLogin();
  });
}

// Paso 1 del registro: datos personales + contraseña (repetida, no 2FA real).
// Al confirmar, crea la cuenta en Firebase y pasa al paso 2.
function renderRegisterStep1() {
  authScreenShell(
    'CREAR CUENTA',
    `<div class="title-modal" style="width:340px;">
       <label class="field-label">Nombres</label>
       <input type="text" id="reg-nombres" autocomplete="given-name" />
       <label class="field-label">Apellidos</label>
       <input type="text" id="reg-apellidos" autocomplete="family-name" />
       <label class="field-label">Correo</label>
       <input type="email" id="reg-email" autocomplete="email" />
       <label class="field-label">Teléfono</label>
       <div style="display:flex; gap:6px;">
         <span style="background:var(--panel-2); border:1px solid var(--border); color:var(--text); padding:8px 10px; border-radius:8px; font-size:13px;">+56</span>
         <input type="tel" id="reg-telefono" autocomplete="tel" style="flex:1;" />
       </div>
       <label class="field-label">TikTok (opcional)</label>
       <input type="text" id="reg-tiktok" placeholder="@usuario" />
       <label class="field-label">Instagram (opcional)</label>
       <input type="text" id="reg-instagram" placeholder="@usuario" />
       <label class="field-label">Contraseña</label>
       <input type="password" id="reg-password" autocomplete="new-password" />
       <label class="field-label">Confirmar contraseña</label>
       <input type="password" id="reg-password2" autocomplete="new-password" />
       <div class="warn-text" id="reg-error" style="display:none"></div>
       <div class="title-modal-actions" style="justify-content:space-between">
         <button class="title-btn small" id="reg-back-btn">Volver</button>
         <button class="title-btn small" id="reg-next-btn">Siguiente</button>
       </div>
     </div>`
  );

  const errorEl = document.getElementById('reg-error');
  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.style.display = '';
  };

  document.getElementById('reg-back-btn').addEventListener('click', renderAuthScreen);
  document.getElementById('reg-next-btn').addEventListener('click', async () => {
    const nombres = document.getElementById('reg-nombres').value.trim();
    const apellidos = document.getElementById('reg-apellidos').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const telefonoRaw = document.getElementById('reg-telefono').value.trim();
    const telefono = telefonoRaw ? `+56${telefonoRaw}` : '';
    const tiktok = document.getElementById('reg-tiktok').value.trim();
    const instagram = document.getElementById('reg-instagram').value.trim();
    const password = document.getElementById('reg-password').value;
    const password2 = document.getElementById('reg-password2').value;

    if (!nombres || !apellidos || !email || !telefono || !password) {
      return showError('Completá todos los datos obligatorios.');
    }
    if (password.length < 6) return showError('La contraseña debe tener al menos 6 caracteres.');
    if (password !== password2) return showError('Las contraseñas no coinciden.');

    const btn = document.getElementById('reg-next-btn');
    btn.disabled = true;
    btn.textContent = 'Creando…';
    try {
      skipAutoHide = true;
      await window.signUp(email, password);
      renderRegisterStep2({ nombres, apellidos, telefono, tiktok, instagram });
    } catch (e) {
      skipAutoHide = false;
      showError(e.message || 'No se pudo crear la cuenta.');
      btn.disabled = false;
      btn.textContent = 'Siguiente';
    }
  });
}

// Paso 2 del registro: equipo favorito y equipo rival (ya autenticado, asi
// que puede llamar a /api/saves/template-clubs). Al confirmar, guarda el
// perfil completo y recien ahi deja que title.js tome el control.
async function renderRegisterStep2(profileData) {
  authScreenShell(
    'TU EQUIPO',
    `<div class="title-modal" style="width:340px;">
       <label class="field-label">Equipo favorito</label>
       <select id="reg-club-favorito"><option value="">Cargando…</option></select>
       <label class="field-label">Equipo rival</label>
       <select id="reg-club-rival"><option value="">Cargando…</option></select>
       <div class="warn-text" id="club-error" style="display:none"></div>
       <div class="title-modal-actions" style="justify-content:flex-end">
         <button class="title-btn small" id="club-next-btn">Listo</button>
       </div>
     </div>`
  );

  const errorEl = document.getElementById('club-error');
  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.style.display = '';
  };
  const favSel = document.getElementById('reg-club-favorito');
  const rivalSel = document.getElementById('reg-club-rival');

  let clubs = [];
  try {
    const res = await window.apiFetch('/api/saves/template-clubs');
    clubs = await res.json();
  } catch (e) {
    showError('No se pudo cargar la lista de equipos.');
  }

  const byDivision = {};
  (clubs || []).forEach((c) => {
    (byDivision[c.division] = byDivision[c.division] || []).push(c);
  });
  const optionsHtml = Object.keys(byDivision)
    .map(
      (div) =>
        `<optgroup label="${escAttr(div)}">${byDivision[div]
          .map((c) => `<option value="${c.id}">${escAttr(c.name)}</option>`)
          .join('')}</optgroup>`
    )
    .join('');
  favSel.innerHTML = `<option value="">Elegí un equipo</option>${optionsHtml}`;
  rivalSel.innerHTML = `<option value="">Elegí un equipo</option>${optionsHtml}`;

  document.getElementById('club-next-btn').addEventListener('click', async () => {
    const equipoFavoritoId = favSel.value;
    const equipoRivalId = rivalSel.value;
    if (!equipoFavoritoId || !equipoRivalId) return showError('Elegí ambos equipos.');
    if (equipoFavoritoId === equipoRivalId) return showError('El rival no puede ser el mismo que tu equipo favorito.');

    const btn = document.getElementById('club-next-btn');
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    try {
      const res = await window.apiFetch('/api/saves/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...profileData, equipoFavoritoId, equipoRivalId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'No se pudo guardar el perfil.');
      }
      skipAutoHide = false;
      if (authBgTimer) clearInterval(authBgTimer);
      authRoot.style.display = 'none';
      authRoot.innerHTML = '';
    } catch (e) {
      showError(e.message);
      btn.disabled = false;
      btn.textContent = 'Listo';
    }
  });
}

window.onAuthStateChange((user) => {
  if (user) {
    if (skipAutoHide) return;
    if (authBgTimer) clearInterval(authBgTimer);
    authRoot.style.display = 'none';
    authRoot.innerHTML = '';
  } else {
    skipAutoHide = false;
    renderAuthScreen();
  }
});
