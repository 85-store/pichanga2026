// Pantalla de titulo: PICHANGA 26, con Cargar / Continuar / Nuevo y 3 huecos de
// partida guardada. Se muestra al cargar la pagina y oculta #app hasta que se
// cargue o cree una partida; entonces llama a window.startGame().
const titleRoot = document.getElementById('title-root');

// Playlist del menu. Los archivos de audio NO se incluyen (son canciones con
// derechos de autor): el usuario debe copiar sus propios archivos con estos
// nombres exactos dentro de public/music/. Ver public/music/LEEME.txt.
const MENU_PLAYLIST = [
  { artist: 'Los Miserables', title: 'El Crack', file: 'music/01-los-miserables-el-crack.mp3' },
  { artist: 'Desconocido', title: 'El baile de la gambeta', file: 'music/02-el-baile-de-la-gambeta.mp3' },
  { artist: 'IShowSpeed', title: 'Champions WC2026', file: 'music/03-ishowspeed-champions-wc2026.mp3' },
  { artist: 'MGMT', title: 'Time to Pretend', file: 'music/04-time-to-pretend.mp3' },
  { artist: 'Desconocido', title: 'No me arrepiento de este amor', file: 'music/05-no-me-arrepiento-de-este-amor.mp3' },
  { artist: 'Amar Azul', title: 'Tomo Vino y Cerveza', file: 'music/06-amar-azul-tomo-vino-y-cerveza.mp3' },
];

const menuAudio = new Audio();
menuAudio.volume = 0.6;
let menuTrackIndex = 0;
let menuMusicStarted = false;

// Reproduccion aleatoria "sin repetir": se baraja un orden con todas las
// pistas y se van sacando una a una; cuando se agota, se vuelve a barajar
// completo, asi suenan todas antes de repetir cualquiera.
let shuffleQueue = [];
let playHistory = [];

function refillShuffleQueue() {
  shuffleQueue = MENU_PLAYLIST.map((_, i) => i);
  for (let i = shuffleQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffleQueue[i], shuffleQueue[j]] = [shuffleQueue[j], shuffleQueue[i]];
  }
}

function nextShuffledIndex() {
  if (!shuffleQueue.length) refillShuffleQueue();
  return shuffleQueue.pop();
}

function currentTrackLabel() {
  const t = MENU_PLAYLIST[menuTrackIndex];
  return `${t.artist} — ${t.title}`;
}

// Cajon flotante (arriba a la derecha) que anuncia la cancion actual, con
// animacion de entrada/salida; vive fuera de title-root y match-root para
// no desaparecer cuando esas pantallas cambian.
const musicToastEl = document.createElement('div');
musicToastEl.id = 'music-toast';
musicToastEl.className = 'music-toast';
document.body.appendChild(musicToastEl);
let toastHideTimer = null;

function showMusicToast(text) {
  musicToastEl.textContent = '🎵 ' + text;
  musicToastEl.classList.add('show');
  clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => {
    musicToastEl.classList.remove('show');
  }, 4200);
}

function loadMenuTrack(index) {
  menuTrackIndex = ((index % MENU_PLAYLIST.length) + MENU_PLAYLIST.length) % MENU_PLAYLIST.length;
  menuAudio.src = MENU_PLAYLIST[menuTrackIndex].file;
  updateMusicBarLabel();
}

function updateMusicBarLabel() {
  const label = document.getElementById('music-track-label');
  if (!label) return;
  label.textContent = currentTrackLabel();
}

function playMenuMusic() {
  menuMusicStarted = true;
  menuAudio.play().catch(() => {});
  const btn = document.getElementById('music-toggle-btn');
  if (btn) btn.textContent = '⏸';
  showMusicToast(currentTrackLabel());
}

function pauseMenuMusic() {
  menuAudio.pause();
  const btn = document.getElementById('music-toggle-btn');
  if (btn) btn.textContent = '▶';
}

function nextMenuTrack() {
  playHistory.push(menuTrackIndex);
  loadMenuTrack(nextShuffledIndex());
  if (menuMusicStarted) {
    menuAudio.play().catch(() => {});
    showMusicToast(currentTrackLabel());
  }
}

function prevMenuTrack() {
  const prev = playHistory.pop();
  loadMenuTrack(prev != null ? prev : nextShuffledIndex());
  if (menuMusicStarted) {
    menuAudio.play().catch(() => {});
    showMusicToast(currentTrackLabel());
  }
}

// Al terminar una cancion pasa a la siguiente (orden aleatorio); si un
// archivo no existe (el usuario todavia no copio sus audios) tambien
// avanza, para no trabarse.
menuAudio.addEventListener('ended', nextMenuTrack);
menuAudio.addEventListener('error', () => {
  if (menuMusicStarted) nextMenuTrack();
});

function initMenuMusic() {
  refillShuffleQueue();
  loadMenuTrack(nextShuffledIndex());

  // Intenta sonar sola apenas carga la pagina, sin que el usuario tenga que
  // tocar play. Si el navegador bloquea el autoplay con sonido (politica
  // habitual sin interaccion previa), arranca en cuanto el usuario haga el
  // primer clic o tecla en cualquier parte (p. ej. al elegir Continuar).
  menuMusicStarted = true;
  menuAudio.play().then(() => {
    const btn = document.getElementById('music-toggle-btn');
    if (btn) btn.textContent = '⏸';
    showMusicToast(currentTrackLabel());
  }).catch(() => {
    const startOnFirstInteraction = () => {
      document.removeEventListener('click', startOnFirstInteraction);
      document.removeEventListener('keydown', startOnFirstInteraction);
      playMenuMusic();
    };
    document.addEventListener('click', startOnFirstInteraction);
    document.addEventListener('keydown', startOnFirstInteraction);
  });
}
initMenuMusic();

// La musica suena en todo el juego (menu y resto de pantallas); solo se
// pausa mientras se ve un partido en vivo (ver match.js) y se retoma al
// cerrarlo, respetando si estaba sonando o no antes.
let musicWasPlayingBeforeMatch = false;
window.pauseGameMusicForMatch = function pauseGameMusicForMatch() {
  musicWasPlayingBeforeMatch = !menuAudio.paused;
  if (musicWasPlayingBeforeMatch) pauseMenuMusic();
};
window.resumeGameMusicAfterMatch = function resumeGameMusicAfterMatch() {
  if (musicWasPlayingBeforeMatch) playMenuMusic();
};

async function titleApi(path, opts) {
  const res = await window.apiFetch('/api/saves' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function escapeTitleHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Reemplaza al confirm() nativo (bloqueado/sin efecto en algunos navegadores
// embebidos) por un modal propio, con los mismos botones de animación de
// entrada/salida que el resto de la UI. Devuelve una promesa<boolean>.
function confirmDialog(message, confirmLabel) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'title-modal-backdrop confirm-backdrop';
    backdrop.innerHTML = `
      <div class="title-modal confirm-modal">
        <p class="confirm-message">${escapeTitleHtml(message)}</p>
        <div class="title-modal-actions">
          <button class="close-btn" id="confirm-cancel">Cancelar</button>
          <button class="title-btn small danger" id="confirm-ok">${escapeTitleHtml(confirmLabel || 'Confirmar')}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      window.closeModal(backdrop, () => resolve(value));
    };
    document.getElementById('confirm-cancel').addEventListener('click', () => finish(false));
    document.getElementById('confirm-ok').addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(false);
    });
  });
}

function slotLabel(slot) {
  if (!slot.exists) return 'Hueco vacío';
  const clubName = slot.club ? slot.club.name : 'Sin club';
  const statusTxt = slot.status === 'despedido' ? ' · despedido' : '';
  return `Temporada ${slot.seasonYear} · ${escapeTitleHtml(clubName)}${statusTxt}`;
}

function renderTitleScreen() {
  titleRoot.innerHTML = `
    <div class="title-screen">
      <div class="title-bg" id="title-bg"></div>
      <div class="title-foreground">
        <div class="title-logo">PICHANGA</div>
        <div class="title-buttons">
          <button class="title-btn" id="title-continue">Continuar</button>
          <button class="title-btn" id="title-load">Cargar</button>
          <button class="title-btn" id="title-new">Nuevo</button>
        </div>
        <div class="music-bar">
          <button class="music-btn" id="music-prev-btn" title="Canción anterior">⏮</button>
          <button class="music-btn" id="music-toggle-btn" title="Reproducir / pausar">▶</button>
          <button class="music-btn" id="music-next-btn" title="Siguiente canción">⏭</button>
          <span class="music-track-label" id="music-track-label"></span>
          <button class="music-btn sfx-toggle-btn" data-no-sfx title="Silenciar efectos de sonido">🔊</button>
        </div>
      </div>
    </div>`;
  startBgCarousel();

  // No existe mas un "continuar" implicito: desde la Fase 2 cada usuario tiene
  // varios huecos propios (ya no una unica partida global), asi que "Continuar"
  // hace lo mismo que "Cargar" - elegir cual.
  document.getElementById('title-continue').addEventListener('click', () => openSlotPicker('load'));
  document.getElementById('title-load').addEventListener('click', () => openSlotPicker('load'));
  document.getElementById('title-new').addEventListener('click', () => openSlotPicker('new'));

  updateMusicBarLabel();
  document.getElementById('music-toggle-btn').addEventListener('click', () => {
    if (menuAudio.paused) playMenuMusic();
    else pauseMenuMusic();
  });
  document.getElementById('music-prev-btn').addEventListener('click', prevMenuTrack);
  document.getElementById('music-next-btn').addEventListener('click', nextMenuTrack);
  document.querySelector('.music-bar .sfx-toggle-btn').addEventListener('click', () => { if (window.toggleSfx) window.toggleSfx(); });
  if (window.refreshSfxButtons) window.refreshSfxButtons();
}

async function openSlotPicker(mode) {
  const { slots } = await titleApi('/');
  const backdrop = document.createElement('div');
  backdrop.className = 'title-modal-backdrop';
  backdrop.innerHTML = `
    <div class="title-modal">
      <h2>${mode === 'load' ? 'Cargar partida' : 'Nueva partida'}</h2>
      <div class="slot-list">
        ${slots
          .map(
            (s) => `
          <div class="slot-item">
            <button class="slot-select ${!s.exists && mode === 'load' ? 'disabled' : ''}" data-slot="${s.slot}">
              <div class="slot-num">Hueco ${s.slot}</div>
              <div class="slot-desc">${slotLabel(s)}</div>
            </button>
            ${s.exists ? `<button class="slot-delete-btn" data-slot="${s.slot}" title="Borrar esta partida">🗑️</button>` : ''}
          </div>`
          )
          .join('')}
      </div>
      <button class="close-btn" id="title-modal-close">Cancelar</button>
    </div>`;
  document.body.appendChild(backdrop);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) window.closeModal(backdrop);
  });
  document.getElementById('title-modal-close').addEventListener('click', () => window.closeModal(backdrop));

  backdrop.querySelectorAll('.slot-select').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = Number(btn.dataset.slot);
      const slotInfo = slots.find((s) => s.slot === slot);
      if (mode === 'load') {
        if (!slotInfo.exists) return;
        loadSlot(slot, backdrop);
      } else {
        window.closeModal(backdrop, () => openNewGameModal(slot, slotInfo));
      }
    });
  });

  backdrop.querySelectorAll('.slot-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const slot = Number(btn.dataset.slot);
      const slotInfo = slots.find((s) => s.slot === slot);
      const label = slotInfo && slotInfo.club ? slotInfo.club.name : `Hueco ${slot}`;
      const confirmed = await confirmDialog(
        `¿Borrar la partida del Hueco ${slot} (${label})? Esta acción no se puede deshacer.`,
        'Sí, borrar'
      );
      if (!confirmed) return;
      btn.disabled = true;
      try {
        await titleApi(`/${slot}`, { method: 'DELETE' });
        window.closeModal(backdrop, () => openSlotPicker(mode));
      } catch (err) {
        alert('No se pudo borrar la partida: ' + err.message);
        btn.disabled = false;
      }
    });
  });
}

async function loadSlot(slot, backdrop) {
  try {
    await titleApi(`/${slot}/load`, { method: 'POST' });
    window.currentSlot = slot;
    window.closeModal(backdrop, enterGame);
  } catch (e) {
    alert('No se pudo cargar la partida: ' + e.message);
  }
}

async function openNewGameModal(slot, slotInfo) {
  const clubs = await titleApi('/template-clubs');
  const backdrop = document.createElement('div');
  backdrop.className = 'title-modal-backdrop';

  const groupByDivision = (division) =>
    clubs
      .filter((c) => c.division === division)
      .map((c) => `<option value="${c.id}">${escapeTitleHtml(c.short_name || c.name)}</option>`)
      .join('');

  backdrop.innerHTML = `
    <div class="title-modal">
      <h2>Nueva partida — Hueco ${slot}</h2>
      ${slotInfo.exists ? '<div class="warn-text">Este hueco ya tiene una partida guardada. Crear una nueva la reemplazará.</div>' : ''}
      <label class="field-label">Tu nombre de entrenador</label>
      <input type="text" id="new-manager-name" placeholder="Nombre (opcional)" />
      <label class="field-label">Club a dirigir</label>
      <select id="new-club-select">
        <optgroup label="Primera A">${groupByDivision('Primera A')}</optgroup>
        <optgroup label="Primera B">${groupByDivision('Primera B')}</optgroup>
      </select>
      <div class="title-modal-actions">
        <button class="close-btn" id="new-back">← Volver</button>
        <button class="close-btn" id="new-cancel">Cancelar</button>
        <button class="title-btn small" id="new-confirm">Comenzar</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) window.closeModal(backdrop);
  });
  document.getElementById('new-back').addEventListener('click', () => window.closeModal(backdrop, () => openSlotPicker('new')));
  document.getElementById('new-cancel').addEventListener('click', () => window.closeModal(backdrop));
  document.getElementById('new-confirm').addEventListener('click', async () => {
    const clubId = Number(document.getElementById('new-club-select').value);
    const managerName = document.getElementById('new-manager-name').value.trim();
    const confirmBtn = document.getElementById('new-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Creando…';
    try {
      await titleApi(`/${slot}/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clubId, managerName }),
      });
      window.currentSlot = slot;
      window.closeModal(backdrop, enterGame);
    } catch (e) {
      alert('No se pudo crear la partida: ' + e.message);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Comenzar';
    }
  });
}

function enterGame() {
  stopBgCarousel();
  titleRoot.innerHTML = '';
  window.startGame();
}

// ---- Fondo cinematografico del menu: fotos reales de jugadores/estadios/
// momentos historicos, en rotacion con fundido (crossfade) cada 5s. El
// usuario pone sus propias fotos en public/imagenes de fondos/, con
// cualquier nombre y formato (jpg/png/webp/avif) - el servidor las lista
// (GET /bg-photos.json) en vez de exigir nombres fijos. Si la carpeta esta
// vacia, queda solo el degradado oscuro de siempre.
let bgWorkingPhotos = [];
let bgShuffleQueue = [];
let bgPrevIndex = -1;
let bgIntervalId = null;
let bgPreloadedImg = null;

function probeBgImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => resolve(null);
    img.src = encodeURI(src);
  });
}

// Mismo patron de "barajar sin repetir toda la vuelta" que usa la playlist
// del menu (ver refillShuffleQueue mas arriba), para que las fotos roten en
// un orden distinto cada vez en vez de ciclar siempre en el mismo orden.
function refillBgShuffleQueue() {
  bgShuffleQueue = bgWorkingPhotos.map((_, i) => i);
  for (let i = bgShuffleQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bgShuffleQueue[i], bgShuffleQueue[j]] = [bgShuffleQueue[j], bgShuffleQueue[i]];
  }
  if (bgShuffleQueue.length > 1 && bgShuffleQueue[bgShuffleQueue.length - 1] === bgPrevIndex) {
    [bgShuffleQueue[0], bgShuffleQueue[bgShuffleQueue.length - 1]] = [bgShuffleQueue[bgShuffleQueue.length - 1], bgShuffleQueue[0]];
  }
}

function nextBgIndex() {
  if (!bgShuffleQueue.length) refillBgShuffleQueue();
  bgPrevIndex = bgShuffleQueue.pop();
  return bgPrevIndex;
}

function stopBgCarousel() {
  if (bgIntervalId) {
    clearInterval(bgIntervalId);
    bgIntervalId = null;
  }
}

async function startBgCarousel() {
  stopBgCarousel();
  const root = document.getElementById('title-bg');
  if (!root) return;

  let candidates = [];
  try {
    const res = await fetch('/bg-photos.json');
    candidates = res.ok ? await res.json() : [];
  } catch (e) {
    candidates = [];
  }

  const probed = await Promise.all(candidates.map(probeBgImage));
  bgWorkingPhotos = probed.filter(Boolean);
  // No se pego nadie al titulo mientras tanto (puede pasar logout/login).
  if (!document.getElementById('title-bg') || !bgWorkingPhotos.length) return;

  root.innerHTML = `<div class="title-bg-slide active" id="bg-slide-a"></div><div class="title-bg-slide" id="bg-slide-b"></div><div class="title-bg-overlay"></div>`;
  const slideA = document.getElementById('bg-slide-a');
  const slideB = document.getElementById('bg-slide-b');
  let showingA = true;

  slideA.style.backgroundImage = `url("${encodeURI(bgWorkingPhotos[nextBgIndex()])}")`;

  const preloadNext = () => {
    const url = bgWorkingPhotos[nextBgIndex()];
    bgPreloadedImg = new Image();
    bgPreloadedImg.src = encodeURI(url);
    return url;
  };
  let nextUrl = preloadNext();

  bgIntervalId = setInterval(() => {
    const incoming = showingA ? slideB : slideA;
    const outgoing = showingA ? slideA : slideB;
    incoming.style.backgroundImage = `url("${encodeURI(nextUrl)}")`;
    incoming.classList.add('active');
    outgoing.classList.remove('active');
    showingA = !showingA;
    nextUrl = preloadNext();
  }, 5000);
}

// No tiene sentido mostrar el titulo (y menos pegarle a /api/saves) antes de
// que haya una sesion de Firebase: se espera a que haya login, lo que tambien
// cubre loguearse recien despues de que esta pagina ya cargo.
window.onAuthStateChange((user) => {
  if (user) renderTitleScreen();
});
