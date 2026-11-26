const matchRoot = document.getElementById('match-root');

const EVENT_ICON = {
  gol: '⚽', remate: '🎯', atajada: '🧤', falta: '🟨', tarjeta: '🟥',
  penal: '🥅', lesion: '🩹', cambio: '🔄', var: '📺', corner: '🚩',
  penal_pendiente: '🥅',
};

const HALFTIME_LABELS = { motivador: 'Motivador', exigente: 'Exigente', tactico: 'Táctico' };
const HALFTIME_DESC = {
  motivador: 'Levanta el ánimo del plantel con palabras de aliento.',
  exigente: 'Exige más del equipo, sin contemplaciones.',
  tactico: 'Ajusta la cabeza del equipo con un enfoque frío y táctico.',
};

const SPEEDS = [
  { label: '1x', ms: 900 },
  { label: '2x', ms: 450 },
  { label: '4x', ms: 150 },
];

// Estadios personalizados: el club local define el fondo de la cancha 2D.
// Los demas clubes (y cualquier nombre no listado) usan la cancha neutra de siempre.
const STADIUM_BY_CLUB_NAME = {
  'Colo-Colo': 'stadiums/monumental.jpg',
  'Universidad Católica': 'stadiums/claro-arena.jpg',
  'Universidad de Chile': 'stadiums/estadio-nacional.jpg',
  'Unión Española': 'stadiums/santa-laura.jpg',
  'Audax Italiano': 'stadiums/bicentenario-la-florida.jpg',
};

function stadiumImageFor(homeClub) {
  if (!homeClub) return null;
  return STADIUM_BY_CLUB_NAME[homeClub.name] || null;
}

// Cada foto de estadio tiene la cancha de pasto en una zona distinta de la
// imagen (angulo de camara/recorte propio). Estos porcentajes delimitan el
// rectangulo real de pasto dentro de cada foto (medido pixel a pixel sobre
// las imagenes provistas), para que las lineas y los jugadores queden
// encerrados ahi y no se dispersen por la tribuna/pista. Sin estadio
// personalizado se usa el cuadro completo (0/0/100/100), igual que antes.
const STADIUM_FIELD_INSET = {
  'stadiums/monumental.jpg': { left: 5.6, top: 13.9, width: 88.7, height: 71.9 },
  'stadiums/claro-arena.jpg': { left: 3.1, top: 17.7, width: 93.7, height: 79.1 },
  'stadiums/estadio-nacional.jpg': { left: 18.0, top: 22.5, width: 64.0, height: 51.8 },
  'stadiums/santa-laura.jpg': { left: 15.8, top: 23.0, width: 67.9, height: 60.3 },
  'stadiums/bicentenario-la-florida.jpg': { left: 10.0, top: 18.8, width: 79.9, height: 67.0 },
};
const FULL_FIELD_INSET = { left: 0, top: 0, width: 100, height: 100 };

function fieldInsetFor(stadiumUrl) {
  return STADIUM_FIELD_INSET[stadiumUrl] || FULL_FIELD_INSET;
}

function pitchBackgroundMarkup(stadiumUrl) {
  // Capa de fondo: ocupa todo pitch-wrap tal cual la foto del estadio (o la
  // cancha neutra si no hay estadio asignado). No lleva lineas ni fichas: eso
  // va en la capa interior (pitch-field), calibrada al area real de pasto.
  const stadiumImg = stadiumUrl
    ? `<image href="${escHtml(stadiumUrl)}" x="0" y="0" width="100" height="64" preserveAspectRatio="none" onerror="this.setAttribute('display','none')"/>`
    : '';
  return `
    <svg class="pitch" viewBox="0 0 100 64" preserveAspectRatio="none">
      <rect x="0" y="0" width="100" height="64" class="pitch-grass"/>
      ${stadiumImg}
    </svg>`;
}

function pitchFieldLinesMarkup() {
  // Lineas de cancha (vectoriales), sin tocar: su viewBox 100x64 ahora
  // corresponde al rectangulo de pasto calibrado (pitch-field), no a toda la
  // imagen del estadio.
  return `
    <svg class="pitch" viewBox="0 0 100 64" preserveAspectRatio="none">
      <rect x="0.5" y="0.5" width="99" height="63" class="pitch-line"/>
      <line x1="50" y1="0" x2="50" y2="64" class="pitch-line"/>
      <circle cx="50" cy="32" r="8" class="pitch-line"/>
      <rect x="0.5" y="16" width="14" height="32" class="pitch-line"/>
      <rect x="85.5" y="16" width="14" height="32" class="pitch-line"/>
      <rect x="0.5" y="24" width="5" height="16" class="pitch-line"/>
      <rect x="94.5" y="24" width="5" height="16" class="pitch-line"/>
    </svg>`;
}

let mx = null;

async function matchApi(kind, id, path, opts) {
  const res = await window.apiFetch(`/api/match/${kind}/${id}${path}`, opts);
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function crest(url, size) {
  if (!url) return `<span style="display:inline-block;width:${size}px;height:${size}px"></span>`;
  return `<img src="${escHtml(url)}" style="width:${size}px;height:${size}px;object-fit:contain" onerror="this.style.visibility='hidden'">`;
}

window.openMatchViewer = async function openMatchViewer(kind, id) {
  if (window.pauseGameMusicForMatch) window.pauseGameMusicForMatch();
  mx = {
    kind, id,
    view: null,
    frame: null,
    events: [],
    playing: false,
    speedIdx: 0,
    timer: null,
    controlSide: 'home',
    subOutId: null,
  };

  matchRoot.innerHTML = `<div class="match-overlay-backdrop"><div class="match-overlay">Cargando partido…</div></div>`;

  try {
    const roster = await matchApi(kind, id, '/roster');
    let saved = null;
    try {
      const tactics = await window.apiFetch('/api/tactics').then((r) => (r.ok ? r.json() : null));
      saved = tactics ? tactics.saved : null;
    } catch {
      // sin preferencia guardada, se usa la seleccion automatica de siempre.
    }
    showLineupPicker(kind, id, roster, saved);
  } catch (e) {
    matchRoot.innerHTML = '';
    alert('No se pudo cargar la planilla: ' + e.message);
  }
};

const LINEUP_FORMATIONS = ['4-4-2', '4-3-3', '3-5-2', '4-2-3-1', '5-3-2'];
const LINEUP_POSITIONS = ['Portero', 'Defensa', 'Mediocampista', 'Delantero'];

function autoPickLineup(players) {
  const byPos = {};
  for (const pos of LINEUP_POSITIONS) byPos[pos] = players.filter((p) => p.position === pos).sort((a, b) => b.rating - a.rating);
  const quota = { Portero: 1, Defensa: 4, Mediocampista: 4, Delantero: 2 };
  const picks = [];
  for (const pos of LINEUP_POSITIONS) picks.push(...byPos[pos].slice(0, quota[pos]));
  if (picks.length < 11) {
    const rest = players.slice().sort((a, b) => b.rating - a.rating).filter((p) => !picks.includes(p));
    for (const p of rest) {
      if (picks.length >= 11) break;
      picks.push(p);
    }
  }
  return new Set(picks.slice(0, 11).map((p) => p.id));
}

function showLineupPicker(kind, id, roster, saved) {
  const players = roster.players;
  const validSaved = saved && saved.playerIds.every((pid) => players.some((p) => p.id === pid));
  let formation = (validSaved && saved.formation) || LINEUP_FORMATIONS[0];
  const selected = validSaved ? new Set(saved.playerIds) : autoPickLineup(players);

  matchRoot.innerHTML = `
  <div class="match-overlay-backdrop">
    <div class="match-overlay lineup-overlay">
      <h2>Planilla: elige tu 11 titular</h2>
      <div class="lineup-body">
        <div class="lineup-board-col">
          <label>Formación <select id="lineup-formation">${LINEUP_FORMATIONS.map((f) => `<option value="${f}" ${f === formation ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
          <div class="pitch-wrap board-wrap">
            <svg class="pitch" viewBox="0 0 100 64" preserveAspectRatio="none">
              <rect x="0" y="0" width="100" height="64" class="pitch-grass"/>
              <rect x="0.5" y="0.5" width="99" height="63" class="pitch-line"/>
              <line x1="50" y1="0" x2="50" y2="64" class="pitch-line"/>
              <circle cx="50" cy="32" r="8" class="pitch-line"/>
            </svg>
            <div class="formation-board" id="lineup-board"></div>
          </div>
          <div class="lineup-count" id="lineup-count"></div>
        </div>
        <div class="lineup-list" id="lineup-list"></div>
      </div>
      <div class="lineup-actions">
        <button class="ctl-btn" id="lineup-auto-btn">Auto-completar</button>
        <button class="ctl-btn primary" id="lineup-start-btn">Iniciar partido</button>
      </div>
    </div>
  </div>`;

  function updateCount() {
    // Si el club no tiene ningun portero disponible (todos lesionados/retirados),
    // no se puede exigir uno: se deja jugar con un jugador de campo bajo el arco,
    // igual que ya tolera el motor de partidos cuando falta un portero en el plantel.
    const hasAvailableGk = players.some((p) => p.position === 'Portero');
    const gkCount = players.filter((p) => selected.has(p.id) && p.position === 'Portero').length;
    const gkRequirement = hasAvailableGk ? 1 : 0;
    const gkLabel = hasAvailableGk
      ? ` (porteros: ${gkCount}/1)`
      : ' (sin portero disponible: jugará un jugador de campo bajo el arco)';
    document.getElementById('lineup-count').textContent = `Seleccionados: ${selected.size}/11${gkLabel}`;
    document.getElementById('lineup-start-btn').disabled = selected.size !== 11 || gkCount !== gkRequirement;
    renderFormationBoard(document.getElementById('lineup-board'), players.filter((p) => selected.has(p.id)), formation);
  }

  function renderList() {
    const list = document.getElementById('lineup-list');
    list.innerHTML = LINEUP_POSITIONS.map((pos) => {
      const arr = players.filter((p) => p.position === pos);
      if (!arr.length) return '';
      return `
      <div class="lineup-group">
        <h4>${pos}</h4>
        ${arr.map((p) => `
          <label class="lineup-row">
            <input type="checkbox" data-pid="${p.id}" ${selected.has(p.id) ? 'checked' : ''}>
            ${escHtml(p.full_name)} (${p.rating})${p.shirt_number != null ? ' #' + p.shirt_number : ''}
          </label>`).join('')}
      </div>`;
    }).join('');
    list.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const pid = Number(cb.dataset.pid);
        if (cb.checked) selected.add(pid); else selected.delete(pid);
        updateCount();
      });
    });
    updateCount();
  }

  document.getElementById('lineup-formation').addEventListener('change', (e) => { formation = e.target.value; updateCount(); });
  document.getElementById('lineup-auto-btn').addEventListener('click', () => {
    selected.clear();
    for (const pid of autoPickLineup(players)) selected.add(pid);
    renderList();
  });
  document.getElementById('lineup-start-btn').addEventListener('click', async () => {
    const startBtn = document.getElementById('lineup-start-btn');
    startBtn.disabled = true;
    startBtn.textContent = 'Iniciando…';
    try {
      const res = await matchApi(kind, id, '/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineup: [...selected], formation }),
      });
      mx.view = res.view;
      mx.frame = res.frames[res.frames.length - 1];
      mx.events = [];
      mx.controlSide = determineControlSide(res.view);
      renderMatchShell();
      applyFrame(mx.frame);
    } catch (e) {
      startBtn.disabled = false;
      startBtn.textContent = 'Iniciar partido';
      alert('No se pudo iniciar el partido: ' + e.message);
    }
  });

  renderList();
}

function determineControlSide(view) {
  // El servidor es la fuente de verdad: managedClubId identifica el club
  // que el usuario dirige en este partido. Evita depender de window.state,
  // que puede no estar listo aun (carrera) y hacer caer al lado equivocado.
  if (view.managedClubId != null) {
    if (view.home.clubId === view.managedClubId) return 'home';
    if (view.away.clubId === view.managedClubId) return 'away';
  }
  if (window.state && window.state.activeClubId === view.away.clubId) return 'away';
  if (window.state && window.state.activeClubId === view.home.clubId) return 'home';
  return 'home';
}

function closeMatchViewer() {
  if (mx && mx.timer) clearInterval(mx.timer);
  mx = null;
  matchRoot.innerHTML = '';
  if (window.stopCrowdAmbience) window.stopCrowdAmbience();
  if (window.resumeGameMusicAfterMatch) window.resumeGameMusicAfterMatch();
}

function renderMatchShell() {
  const { home, away } = mx.view;
  matchRoot.innerHTML = `
  <div class="match-overlay-backdrop">
    <div class="match-overlay">
      <div class="match-scoreboard">
        <div class="ms-team">${crest(home.crestUrl, 36)}<span>${escHtml(home.shortName || home.name)}</span></div>
        <div class="ms-score">
          <span id="ms-goals">0 - 0</span>
          <div class="ms-clock" id="ms-clock">0'</div>
        </div>
        <div class="ms-team away"><span>${escHtml(away.shortName || away.name)}</span>${crest(away.crestUrl, 36)}</div>
        <button class="match-close-btn" id="match-close-btn">✕</button>
      </div>

      <div class="match-body">
        <div class="pitch-col">
          <div class="pitch-wrap">
            ${pitchBackgroundMarkup(stadiumImageFor(home))}
            <div class="pitch-field" style="left:${fieldInsetFor(stadiumImageFor(home)).left}%;top:${fieldInsetFor(stadiumImageFor(home)).top}%;width:${fieldInsetFor(stadiumImageFor(home)).width}%;height:${fieldInsetFor(stadiumImageFor(home)).height}%">
              ${pitchFieldLinesMarkup()}
              <div class="pitch-tokens" id="pitch-tokens"></div>
            </div>
          </div>
          <div class="match-controls">
            <button id="play-pause-btn" class="ctl-btn primary">▶ Jugar</button>
            <div class="speed-group" id="speed-group">
              ${SPEEDS.map((s, i) => `<button class="ctl-btn speed-btn ${i === mx.speedIdx ? 'active' : ''}" data-speed="${i}">${s.label}</button>`).join('')}
            </div>
            <button id="skip-end-btn" class="ctl-btn">⏭ Saltar al final</button>
          </div>
        </div>

        <div class="side-col">
          <div class="stats-panel" id="stats-panel"></div>
          <div class="events-panel"><h4>Eventos</h4><div class="events-feed" id="events-feed"></div></div>
          <div class="tactics-panel">
            <h4>Táctica — ${escHtml(mx.controlSide === 'home' ? (home.shortName || home.name) : (away.shortName || away.name))}</h4>
            <div id="tactics-form"></div>
          </div>
          <div class="subs-panel">
            <h4>Cambios</h4>
            <div id="subs-form"></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  document.getElementById('match-close-btn').addEventListener('click', () => {
    if (mx.playing) togglePlay();
    if (confirm('¿Cerrar la vista del partido? El partido en curso seguirá avanzando si vuelves a entrar.')) closeMatchViewer();
  });
  document.getElementById('play-pause-btn').addEventListener('click', togglePlay);
  document.getElementById('skip-end-btn').addEventListener('click', skipToEnd);
  document.querySelectorAll('.speed-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      mx.speedIdx = Number(btn.dataset.speed);
      document.querySelectorAll('.speed-btn').forEach((b) => b.classList.toggle('active', b === btn));
      if (mx.playing) {
        clearInterval(mx.timer);
        mx.timer = setInterval(tick, SPEEDS[mx.speedIdx].ms);
      }
    });
  });
  renderTacticsForm();
  renderSubsForm();
  renderStats();

  if (window.startCrowdAmbience) window.startCrowdAmbience();
  if (window.playSfx) window.playSfx('whistle');
}

function togglePlay() {
  mx.playing = !mx.playing;
  const btn = document.getElementById('play-pause-btn');
  if (mx.playing) {
    btn.textContent = '⏸ Pausar';
    mx.timer = setInterval(tick, SPEEDS[mx.speedIdx].ms);
  } else {
    btn.textContent = '▶ Jugar';
    clearInterval(mx.timer);
  }
}

async function tick() {
  if (!mx || mx.view.finished) return;
  try {
    const res = await matchApi(mx.kind, mx.id, '/advance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minutes: 1 }),
    });
    handleAdvanceResult(res);
  } catch (e) {
    clearInterval(mx.timer);
    mx.playing = false;
    alert('Error simulando el partido: ' + e.message);
  }
}

async function skipToEnd() {
  if (!mx) return;
  if (mx.playing) togglePlay();
  const skipBtn = document.getElementById('skip-end-btn');
  skipBtn.disabled = true;
  skipBtn.textContent = 'Saltando…';
  try {
    let res;
    do {
      res = await matchApi(mx.kind, mx.id, '/advance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minutes: 100 }),
      });
      handleAdvanceResult(res, true);
    } while (!res.finished && !res.paused);
  } catch (e) {
    alert('Error simulando el partido: ' + e.message);
  } finally {
    if (skipBtn) {
      skipBtn.disabled = false;
      skipBtn.textContent = '⏭ Saltar al final';
    }
  }
}

function handleAdvanceResult(res, skipAnimation) {
  for (const frame of res.frames) {
    mx.frame = frame;
    applyFrame(frame, skipAnimation);
  }
  if (res.view) mx.view = res.view;
  renderStats();

  if (res.finished) {
    clearInterval(mx.timer);
    mx.playing = false;
    mx.view = { ...mx.view, finished: true };
    if (window.playSfx) window.playSfx('whistle');
    showSummary(res.summary);
    return;
  }

  if (res.paused) {
    clearInterval(mx.timer);
    mx.playing = false;
    const btn = document.getElementById('play-pause-btn');
    if (btn) btn.textContent = '▶ Jugar';
    showPauseOverlay(res.paused);
  }
}

// Reanuda el juego automatico (si el usuario tenia play activo antes de la
// pausa) una vez resuelto un penal/entretiempo/incidente.
function resumeIfWasPlaying(wasPlaying) {
  const overlay = document.querySelector('.match-overlay');
  const pauseEl = overlay && overlay.querySelector('.pause-modal-backdrop');
  if (pauseEl) pauseEl.remove();
  if (wasPlaying && mx && !mx.view.finished) togglePlay();
}

function showPauseOverlay(paused) {
  if (paused.type === 'penalty') return showPenaltyModal();
  if (paused.type === 'halftime') return showHalftimeModal(paused);
  if (paused.type === 'shootout') return showShootoutModal();
  if (paused.type === 'incident') return showIncidentModal(paused.payload);
}

function pauseModalContainer(innerHtml) {
  const overlay = document.querySelector('.match-overlay');
  if (!overlay) return null;
  const old = overlay.querySelector('.pause-modal-backdrop');
  if (old) old.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'pause-modal-backdrop';
  backdrop.innerHTML = `<div class="pause-modal">${innerHtml}</div>`;
  overlay.appendChild(backdrop);
  return backdrop;
}

function showPenaltyModal() {
  const side = mx.view.pendingPenalty ? mx.view.pendingPenalty.side : null;
  if (side !== mx.controlSide) {
    // El penal lo cobra el rival (controlado por la IA): no hay nada que
    // elegir, el servidor ya lo resolvio al recibir /penalty sin jugador.
    // No deberia llegar aqui (startMatch solo pausa para el lado humano),
    // pero por seguridad simplemente no se muestra modal.
    return;
  }
  const onField = mx.view[mx.controlSide].lineup.filter((p) => p.onField && p.pos !== 'Portero');
  const sorted = onField.slice().sort((a, b) => b.rating - a.rating);
  pauseModalContainer(`
    <h2>¡Penal a favor!</h2>
    <p class="sub">Elige quién lo patea.</p>
    <div class="pause-player-list">
      ${sorted.map((p) => `<button class="ctl-btn pause-pick-btn" data-pid="${p.id}">${escHtml(p.full_name)} (${p.rating})</button>`).join('')}
    </div>`);
  document.querySelectorAll('.pause-pick-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const wasPlaying = mx.playing;
      document.querySelectorAll('.pause-pick-btn').forEach((b) => (b.disabled = true));
      try {
        const result = await matchApi(mx.kind, mx.id, '/penalty', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId: btn.dataset.pid }),
        });
        applyFrame(result.frame);
        mx.view = result.view;
        renderStats();
        resumeIfWasPlaying(wasPlaying);
      } catch (e) {
        alert('No se pudo patear el penal: ' + e.message);
        document.querySelectorAll('.pause-pick-btn').forEach((b) => (b.disabled = false));
      }
    });
  });
}

function showHalftimeModal(paused) {
  if (paused.side !== mx.controlSide) return;
  pauseModalContainer(`
    <h2>Entretiempo</h2>
    <p class="sub">¿Qué mensaje le das al plantel?</p>
    <div class="pause-halftime-list">
      ${Object.keys(HALFTIME_LABELS).map((key) => `
        <button class="ctl-btn pause-halftime-btn" data-msg="${key}">
          <strong>${HALFTIME_LABELS[key]}</strong>
          <span>${HALFTIME_DESC[key]}</span>
        </button>`).join('')}
    </div>`);
  document.querySelectorAll('.pause-halftime-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const wasPlaying = mx.playing;
      document.querySelectorAll('.pause-halftime-btn').forEach((b) => (b.disabled = true));
      try {
        const result = await matchApi(mx.kind, mx.id, '/halftime', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: btn.dataset.msg }),
        });
        mx.view = result.view;
        renderStats();
        renderTacticsForm();
        resumeIfWasPlaying(wasPlaying);
      } catch (e) {
        alert('No se pudo dar el mensaje: ' + e.message);
        document.querySelectorAll('.pause-halftime-btn').forEach((b) => (b.disabled = false));
      }
    });
  });
}

function shootoutHistoryHtml(shootout, home, away) {
  if (!shootout) return '';
  return `
    <div class="shootout-score">${shootout.homeScore} - ${shootout.awayScore}</div>
    <div class="shootout-history">
      ${shootout.kicks.map((k) => `<span class="shootout-kick ${k.scored ? 'scored' : 'missed'}" title="${escHtml(k.player)} (${k.side === 'home' ? escHtml(home.shortName || home.name) : escHtml(away.shortName || away.name)})">${k.scored ? '●' : '✕'}</span>`).join('') || '<span class="empty-note">Sin lanzamientos aún.</span>'}
    </div>`;
}

function showShootoutModal() {
  const { home, away } = mx.view;
  const shootout = mx.view.shootout;
  if (!shootout) return;

  if (shootout.humanTurn) {
    const turnSideKey = shootout.turn;
    const onField = mx.view[turnSideKey].lineup.filter((p) => p.onField && p.pos !== 'Portero');
    const alreadyKicked = new Set(shootout.kicks.filter((k) => k.side === turnSideKey).map((k) => k.player));
    const sameClub = turnSideKey === mx.controlSide;
    if (!sameClub) {
      // La tanda incluye un lado que no controla el usuario (no deberia pasar
      // si siempre se usa initShootout con un club humano en el cruce, pero
      // por seguridad se omite el picker).
      return;
    }
    const pool = onField.filter((p) => !alreadyKicked.has(p.full_name));
    const candidates = (pool.length ? pool : onField).slice().sort((a, b) => b.rating - a.rating);
    pauseModalContainer(`
      <h2>Tanda de penales</h2>
      ${shootoutHistoryHtml(shootout, home, away)}
      <p class="sub">Elige quién patea.</p>
      <div class="pause-player-list">
        ${candidates.map((p) => `<button class="ctl-btn pause-pick-btn" data-pid="${p.id}">${escHtml(p.full_name)} (${p.rating})</button>`).join('')}
      </div>`);
    document.querySelectorAll('.pause-pick-btn').forEach((btn) => {
      btn.addEventListener('click', () => submitShootoutKick(btn.dataset.pid));
    });
  } else {
    pauseModalContainer(`
      <h2>Tanda de penales</h2>
      ${shootoutHistoryHtml(shootout, home, away)}
      <p class="sub">Le toca patear al rival.</p>
      <button class="ctl-btn primary" id="shootout-continue-btn">Continuar</button>`);
    document.getElementById('shootout-continue-btn').addEventListener('click', () => submitShootoutKick(null));
  }
}

async function submitShootoutKick(playerId) {
  document.querySelectorAll('.pause-pick-btn, #shootout-continue-btn').forEach((b) => (b.disabled = true));
  try {
    const result = await matchApi(mx.kind, mx.id, '/shootout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId }),
    });
    if (result.finished) {
      const overlay = document.querySelector('.match-overlay');
      const pauseEl = overlay && overlay.querySelector('.pause-modal-backdrop');
      if (pauseEl) pauseEl.remove();
      mx.view = { ...mx.view, finished: true };
      if (window.playSfx) window.playSfx('whistle');
      showSummary(result.summary);
      return;
    }
    mx.view = result.view;
    showShootoutModal();
  } catch (e) {
    alert('No se pudo patear: ' + e.message);
    document.querySelectorAll('.pause-pick-btn, #shootout-continue-btn').forEach((b) => (b.disabled = false));
  }
}

function showIncidentModal(payload) {
  pauseModalContainer(`
    <h2>⚠ Incidente en el estadio</h2>
    <p class="sub">${escHtml(payload.label)}</p>
    <p>${escHtml(payload.refereeNote)}</p>
    <div class="pause-incident-actions">
      <button class="ctl-btn primary" id="incident-resume-btn">Reanudar partido</button>
      ${payload.severity === 'grave' ? '<button class="ctl-btn danger" id="incident-suspend-btn">Suspender definitivamente</button>' : ''}
    </div>`);
  document.getElementById('incident-resume-btn').addEventListener('click', () => submitIncidentAction('reanudar'));
  const suspendBtn = document.getElementById('incident-suspend-btn');
  if (suspendBtn) {
    suspendBtn.addEventListener('click', () => {
      if (confirm('¿Suspender el partido en forma definitiva? El resultado quedará sujeto a resolución posterior según las reglas de la competición.')) {
        submitIncidentAction('suspender');
      }
    });
  }
}

async function submitIncidentAction(action) {
  document.querySelectorAll('#incident-resume-btn, #incident-suspend-btn').forEach((b) => (b.disabled = true));
  const wasPlaying = mx.playing;
  try {
    const result = await matchApi(mx.kind, mx.id, '/incident', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (result.finished) {
      const overlay = document.querySelector('.match-overlay');
      const pauseEl = overlay && overlay.querySelector('.pause-modal-backdrop');
      if (pauseEl) pauseEl.remove();
      mx.view = { ...mx.view, finished: true };
      showSummary(result.summary);
      return;
    }
    mx.view = result.view;
    resumeIfWasPlaying(wasPlaying);
  } catch (e) {
    alert('No se pudo resolver el incidente: ' + e.message);
    document.querySelectorAll('#incident-resume-btn, #incident-suspend-btn').forEach((b) => (b.disabled = false));
  }
}

// Que efecto de sonido corresponde a cada tipo de evento del partido (ver
// EVENT_ICON arriba). Los eventos sin entrada aqui (remate, atajada, lesion,
// cambio, corner) no tienen sonido propio, para no saturar de ruido cada
// minuto simulado.
const EVENT_SFX = {
  tarjeta: 'card',
  falta: 'whistle',
};

// Gol, penal fallado y gol anulado por VAR dependen de a quien le pasa, no
// solo del tipo de evento: si es a favor de tu club suena gol (festejo); si
// es en contra (el rival anota, o a TU equipo le fallan el penal / le anulan
// el gol), suenan pifias de la hinchada. Un penal convertido ya dispara su
// propio evento 'gol' aparte, asi que aqui solo marca el silbato del cobro.
function eventSfxFor(ev) {
  const mine = mx && ev.team === mx.controlSide;
  if (ev.type === 'gol') return mine ? 'goal' : 'pifias';
  if (ev.type === 'penal') return ev.result === 'gol' ? 'whistle' : (mine ? 'pifias' : null);
  if (ev.type === 'var') return ev.result === 'anulado' && mine ? 'pifias' : null;
  return EVENT_SFX[ev.type] || null;
}

function applyFrame(frame, skipAnimation) {
  document.getElementById('ms-goals').textContent = `${frame.scoreHome} - ${frame.scoreAway}`;
  const clockEl = document.getElementById('ms-clock');
  if (clockEl) clockEl.textContent = frame.minute > 90 ? `90+${frame.minute - 90}'` : `${frame.minute}'`;

  renderTokens(frame, skipAnimation);

  for (const ev of frame.events) {
    mx.events.push(ev);
    pushEventToFeed(ev, skipAnimation);
  }
}

function renderTokens(frame, skipAnimation) {
  const wrap = document.getElementById('pitch-tokens');
  if (!wrap) return;
  const tokens = [];
  for (const p of frame.home) tokens.push({ ...p, side: 'home' });
  for (const p of frame.away) tokens.push({ ...p, side: 'away' });

  const seen = new Set();
  for (const t of tokens) {
    seen.add(`p${t.id}`);
    let el = wrap.querySelector(`[data-tok="p${t.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = `tok player ${t.side}${t.pos === 'Portero' ? ' gk' : ''}`;
      el.dataset.tok = `p${t.id}`;
      el.innerHTML = `<span>${t.num ?? ''}</span>`;
      wrap.appendChild(el);
    }
    if (skipAnimation) el.style.transition = 'none'; else el.style.transition = '';
    el.style.left = t.x + '%';
    el.style.top = t.y + '%';
  }

  let ballEl = wrap.querySelector('[data-tok="ball"]');
  if (!ballEl) {
    ballEl = document.createElement('div');
    ballEl.className = 'tok ball';
    ballEl.dataset.tok = 'ball';
    wrap.appendChild(ballEl);
  }
  if (skipAnimation) ballEl.style.transition = 'none'; else ballEl.style.transition = '';
  ballEl.style.left = frame.ball.x + '%';
  ballEl.style.top = frame.ball.y + '%';

  wrap.querySelectorAll('[data-tok]').forEach((el) => {
    const key = el.dataset.tok;
    if (key !== 'ball' && !seen.has(key)) el.remove();
  });
}

function eventText(ev) {
  switch (ev.type) {
    case 'gol': return `¡GOL! ${ev.player}${ev.assist ? ' (asist. ' + ev.assist + ')' : ''} — ${ev.scoreHome}-${ev.scoreAway}`;
    case 'remate': return `Remate de ${ev.player}, se va ${ev.detail}.`;
    case 'atajada': return `Gran atajada de ${ev.player} a remate de ${ev.shooter}.`;
    case 'falta': return `Falta de ${ev.player}.`;
    case 'tarjeta': return `Tarjeta ${ev.card} para ${ev.player}${ev.detail ? ' (' + ev.detail + ')' : ''}.`;
    case 'penal': return `Penal: ${ev.player} — ${ev.result === 'gol' ? '¡anotado!' : 'fallado'}.`;
    case 'lesion': return `Lesión de ${ev.player}: ${ev.detail}.`;
    case 'cambio': return `Cambio: entra ${ev.in} por ${ev.out}${ev.forced ? ' (forzado)' : ''}.`;
    case 'var': return `VAR revisa el gol de ${ev.player}: ${ev.result}.`;
    case 'corner': return 'Tiro de esquina.';
    case 'penal_pendiente': return 'Penal cobrado: el partido se detiene para elegir al lanzador.';
    default: return ev.type;
  }
}

function pushEventToFeed(ev, skipAnimation) {
  const feed = document.getElementById('events-feed');
  if (!feed) return;
  const row = document.createElement('div');
  row.className = `ev-row ev-${ev.type}`;
  row.innerHTML = `<span class="ev-min">${ev.minute}'</span><span class="ev-icon">${EVENT_ICON[ev.type] || '•'}</span><span class="ev-text">${escHtml(eventText(ev))}</span>`;
  feed.appendChild(row);
  feed.scrollTop = feed.scrollHeight;

  // Al "saltar al final" se procesan de golpe todos los eventos restantes:
  // no reproducir sonido por cada uno (seria un alud de audio superpuesto).
  if (skipAnimation) return;
  const sfx = eventSfxFor(ev);
  if (sfx && window.playSfx) window.playSfx(sfx);
}

function renderStats() {
  const panel = document.getElementById('stats-panel');
  if (!panel || !mx.view) return;
  const s = mx.view.stats;
  const totalPoss = (s.home.possession || 0) + (s.away.possession || 0);
  const homePct = totalPoss ? Math.round((s.home.possession / totalPoss) * 100) : 50;
  const row = (label, h, a) => `
    <div class="stat-row">
      <span class="stat-val">${h}</span><span class="stat-label">${label}</span><span class="stat-val">${a}</span>
    </div>`;
  panel.innerHTML = `
    <h4>Estadísticas</h4>
    <div class="stat-row poss"><span class="stat-val">${homePct}%</span><span class="stat-label">Posesión</span><span class="stat-val">${100 - homePct}%</span></div>
    ${row('Remates', s.home.shots, s.away.shots)}
    ${row('Al arco', s.home.onTarget, s.away.onTarget)}
    ${row('Córners', s.home.corners, s.away.corners)}
    ${row('Faltas', s.home.fouls, s.away.fouls)}
    ${row('Amarillas', s.home.yellow, s.away.yellow)}
    ${row('Rojas', s.home.red, s.away.red)}`;
}

function renderTacticsForm() {
  const box = document.getElementById('tactics-form');
  if (!box || !mx.view) return;
  const side = mx.view[mx.controlSide];
  const opts = (arr, cur) => arr.map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v}</option>`).join('');
  box.innerHTML = `
    <div class="pitch-wrap board-wrap">
      <svg class="pitch" viewBox="0 0 100 64" preserveAspectRatio="none">
        <rect x="0" y="0" width="100" height="64" class="pitch-grass"/>
        <rect x="0.5" y="0.5" width="99" height="63" class="pitch-line"/>
        <line x1="50" y1="0" x2="50" y2="64" class="pitch-line"/>
        <circle cx="50" cy="32" r="8" class="pitch-line"/>
      </svg>
      <div class="formation-board" id="control-board"></div>
    </div>
    <label>Formación <select id="tf-formation">${opts(['4-4-2', '4-3-3', '3-5-2', '4-2-3-1', '5-3-2'], side.tactics.formation)}</select></label>
    <label>Mentalidad <select id="tf-mentality">${opts(['defensivo', 'equilibrado', 'ofensivo'], side.tactics.mentality)}</select></label>
    <label>Estilo <select id="tf-style">${opts(['posesion', 'directo', 'contragolpe'], side.tactics.style)}</select></label>
    <label>Presión <select id="tf-pressing">${opts(['bajo', 'medio', 'alto'], side.tactics.pressing)}</select></label>
    <button class="ctl-btn primary" id="tf-apply">Aplicar</button>`;

  renderControlBoard(document.getElementById('tf-formation').value);
  document.getElementById('tf-formation').addEventListener('change', (e) => renderControlBoard(e.target.value));

  document.getElementById('tf-apply').addEventListener('click', async () => {
    const tactics = {
      formation: document.getElementById('tf-formation').value,
      mentality: document.getElementById('tf-mentality').value,
      style: document.getElementById('tf-style').value,
      pressing: document.getElementById('tf-pressing').value,
    };
    try {
      mx.view = await matchApi(mx.kind, mx.id, '/tactics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side: mx.controlSide, tactics }),
      });
      renderTacticsForm();
    } catch (e) {
      alert('No se pudo aplicar la táctica: ' + e.message);
    }
  });
}

function renderControlBoard(formationName) {
  const boardEl = document.getElementById('control-board');
  if (!boardEl || !mx.view) return;
  const side = mx.view[mx.controlSide];
  const onField = side.lineup.filter((p) => p.onField);
  renderFormationBoard(boardEl, onField, formationName, {
    selectedId: mx.subOutId,
    onTokenClick: (player) => {
      mx.subOutId = mx.subOutId === player.id ? null : player.id;
      renderControlBoard(formationName);
      renderSubsForm();
    },
  });
}

function renderSubsForm() {
  const box = document.getElementById('subs-form');
  if (!box || !mx.view) return;
  const side = mx.view[mx.controlSide];
  if (side.subsUsed >= 5) {
    box.innerHTML = '<div class="empty-note">Ya se usaron los 5 cambios.</div>';
    return;
  }
  const bench = side.bench.filter((p) => !p.onField);
  if (!bench.length) {
    box.innerHTML = '<div class="empty-note">No hay jugadores disponibles en el banco.</div>';
    return;
  }
  const outPlayer = mx.subOutId != null ? side.lineup.find((p) => p.id === mx.subOutId && p.onField) : null;
  if (!outPlayer) {
    mx.subOutId = null;
    box.innerHTML = `<div class="empty-note">Click en un jugador de la pizarra para elegir a quién sacar (${side.subsUsed}/5 cambios usados).</div>`;
    return;
  }
  box.innerHTML = `
    <div class="sub-out-label">Sale: <strong>${escHtml(outPlayer.full_name)}</strong> — elige quién entra:</div>
    <div class="sub-bench-list">
      ${bench.map((p) => `<button class="ctl-btn bench-btn" data-pid="${p.id}">${escHtml(p.full_name)} (${p.position})</button>`).join('')}
    </div>
    <button class="ctl-btn" id="sub-cancel-btn">Cancelar</button>`;
  document.getElementById('sub-cancel-btn').addEventListener('click', () => {
    mx.subOutId = null;
    renderSubsForm();
    renderControlBoard(side.tactics.formation);
  });
  box.querySelectorAll('.bench-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        mx.view = await matchApi(mx.kind, mx.id, '/substitute', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ side: mx.controlSide, outPlayerId: outPlayer.id, inPlayerId: btn.dataset.pid }),
        });
        mx.subOutId = null;
        renderSubsForm();
        renderTacticsForm();
      } catch (e) {
        alert('No se pudo hacer el cambio: ' + e.message);
      }
    });
  });
}

function showSummary(summary) {
  const overlay = document.querySelector('.match-overlay');
  const backdrop = document.createElement('div');
  backdrop.className = 'summary-modal-backdrop';
  const { home, away } = mx.view;
  const scorerLine = (s) => `${escHtml(s.scorer)}${s.assist ? ' (asist. ' + escHtml(s.assist) + ')' : ''}`;
  backdrop.innerHTML = `
    <div class="summary-modal">
      <h2>${escHtml(home.shortName || home.name)} ${summary.homeGoals} - ${summary.awayGoals} ${escHtml(away.shortName || away.name)}</h2>
      ${summary.decidedByPenalties ? '<div class="sub">Definido por penales</div>' : ''}
      <div class="summary-section">
        <h4>Goles</h4>
        <ul>
          ${summary.scorers.home.map((s) => `<li>${escHtml(home.shortName)}: ${scorerLine(s)}</li>`).join('')}
          ${summary.scorers.away.map((s) => `<li>${escHtml(away.shortName)}: ${scorerLine(s)}</li>`).join('')}
        </ul>
        ${!summary.scorers.home.length && !summary.scorers.away.length ? '<div class="empty-state">Sin goles.</div>' : ''}
      </div>
      <div class="summary-section">
        <h4>Tarjetas (${summary.cards.length})</h4>
        ${summary.cards.length ? `<ul>${summary.cards.map((c) => `<li>${escHtml(c.player)} — ${c.type}</li>`).join('')}</ul>` : '<div class="empty-state">Ninguna.</div>'}
      </div>
      <div class="summary-section">
        <h4>Lesiones (${summary.injuries.length})</h4>
        ${summary.injuries.length ? `<ul>${summary.injuries.map((i) => `<li>${escHtml(i.player)} — ${escHtml(i.injury)} (${escHtml(i.severity)})</li>`).join('')}</ul>` : '<div class="empty-state">Ninguna.</div>'}
      </div>
      <button class="close-btn" id="match-summary-close">Cerrar</button>
    </div>`;
  overlay.appendChild(backdrop);
  document.getElementById('match-summary-close').addEventListener('click', () => {
    closeMatchViewer();
    if (window.onMatchFinished) window.onMatchFinished();
  });
}
