// Efectos de sonido de Pichanga 2026. Igual que la musica del menu (ver
// title.js / public/music/LEEME.txt), los archivos de audio no se incluyen:
// el usuario debe copiar los suyos con nombres exactos en public/sounds/.
// Ver public/sounds/LEEME.txt. Si un archivo falta, ese sonido simplemente no
// suena (no rompe el juego).
const SFX_FILES = {
  goal: 'sounds/goal.mp3',
  card: 'sounds/card.mp3',
  whistle: 'sounds/whistle.mp3',
  click: 'sounds/click.mp3',
  pifias: 'sounds/pifias.mp3',
};
const AMBIENCE_FILE = 'sounds/crowd-ambience.mp3';
const SFX_MUTE_KEY = 'pichanga-sfx-muted';

// Duracion maxima (ms) de ciertos efectos, por si el archivo que puso el
// usuario es mas largo de lo ideal: las pifias deben ser un abucheo breve,
// no un loop largo tapando el resto del partido.
const MAX_DURATION_MS = {
  pifias: 1800,
};

let sfxMuted = localStorage.getItem(SFX_MUTE_KEY) === '1';

// Pool pequeño por efecto: permite que dos sonidos iguales se superpongan
// (ej. dos tarjetas seguidas) sin cortar el que ya estaba sonando.
const pools = {};
function playSfx(name) {
  if (sfxMuted) return;
  const src = SFX_FILES[name];
  if (!src) return;
  const pool = pools[name] || (pools[name] = []);
  let audio = pool.find((a) => a.paused || a.ended);
  if (!audio) {
    audio = new Audio(src);
    audio.volume = 0.7;
    pool.push(audio);
    if (pool.length > 4) pool.shift();
  } else {
    audio.currentTime = 0;
  }
  if (audio._stopTimer) clearTimeout(audio._stopTimer);
  const maxMs = MAX_DURATION_MS[name];
  if (maxMs) {
    audio._stopTimer = setTimeout(() => {
      audio.pause();
      audio.currentTime = 0;
    }, maxMs);
  }
  audio.play().catch(() => {});
}
window.playSfx = playSfx;

const ambienceAudio = new Audio(AMBIENCE_FILE);
ambienceAudio.loop = true;
ambienceAudio.volume = 0.25;
let ambienceWanted = false;

window.startCrowdAmbience = function startCrowdAmbience() {
  ambienceWanted = true;
  if (sfxMuted) return;
  ambienceAudio.currentTime = 0;
  ambienceAudio.play().catch(() => {});
};
window.stopCrowdAmbience = function stopCrowdAmbience() {
  ambienceWanted = false;
  ambienceAudio.pause();
};

function updateSfxButtons() {
  document.querySelectorAll('.sfx-toggle-btn').forEach((btn) => {
    btn.textContent = sfxMuted ? '🔇' : '🔊';
    btn.title = sfxMuted ? 'Activar efectos de sonido' : 'Silenciar efectos de sonido';
  });
}
window.refreshSfxButtons = updateSfxButtons;

window.toggleSfx = function toggleSfx() {
  sfxMuted = !sfxMuted;
  localStorage.setItem(SFX_MUTE_KEY, sfxMuted ? '1' : '0');
  if (sfxMuted) ambienceAudio.pause();
  else if (ambienceWanted) ambienceAudio.play().catch(() => {});
  updateSfxButtons();
};

// Clic generico de interfaz: cualquier <button> del juego reproduce un clic
// corto, salvo que pida explicitamente silencio (data-no-sfx), p. ej. para no
// duplicar el clic con la musica del menu.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && !btn.disabled && !btn.hasAttribute('data-no-sfx')) playSfx('click');
}, true);

document.addEventListener('DOMContentLoaded', updateSfxButtons);
updateSfxButtons();
