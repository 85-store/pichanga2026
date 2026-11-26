// Formaciones (mismo layout que src/engine/formations.js) y un renderizador de
// "pizarra tactica" compartido entre la planilla pre-partido y el panel de
// tacticas/cambios durante el partido en vivo.
const CLIENT_FORMATIONS = {
  '4-4-2': {
    slots: [
      { group: 'GK', x: 5, y: 50 },
      { group: 'DEF', x: 18, y: 15 }, { group: 'DEF', x: 18, y: 38 }, { group: 'DEF', x: 18, y: 62 }, { group: 'DEF', x: 18, y: 85 },
      { group: 'MID', x: 45, y: 15 }, { group: 'MID', x: 45, y: 38 }, { group: 'MID', x: 45, y: 62 }, { group: 'MID', x: 45, y: 85 },
      { group: 'FWD', x: 75, y: 38 }, { group: 'FWD', x: 75, y: 62 },
    ],
  },
  '4-3-3': {
    slots: [
      { group: 'GK', x: 5, y: 50 },
      { group: 'DEF', x: 18, y: 15 }, { group: 'DEF', x: 18, y: 38 }, { group: 'DEF', x: 18, y: 62 }, { group: 'DEF', x: 18, y: 85 },
      { group: 'MID', x: 42, y: 30 }, { group: 'MID', x: 42, y: 50 }, { group: 'MID', x: 42, y: 70 },
      { group: 'FWD', x: 78, y: 20 }, { group: 'FWD', x: 78, y: 50 }, { group: 'FWD', x: 78, y: 80 },
    ],
  },
  '3-5-2': {
    slots: [
      { group: 'GK', x: 5, y: 50 },
      { group: 'DEF', x: 18, y: 25 }, { group: 'DEF', x: 18, y: 50 }, { group: 'DEF', x: 18, y: 75 },
      { group: 'MID', x: 42, y: 12 }, { group: 'MID', x: 42, y: 32 }, { group: 'MID', x: 42, y: 50 }, { group: 'MID', x: 42, y: 68 }, { group: 'MID', x: 42, y: 88 },
      { group: 'FWD', x: 78, y: 38 }, { group: 'FWD', x: 78, y: 62 },
    ],
  },
  '4-2-3-1': {
    slots: [
      { group: 'GK', x: 5, y: 50 },
      { group: 'DEF', x: 18, y: 15 }, { group: 'DEF', x: 18, y: 38 }, { group: 'DEF', x: 18, y: 62 }, { group: 'DEF', x: 18, y: 85 },
      { group: 'MID', x: 38, y: 35 }, { group: 'MID', x: 38, y: 65 },
      { group: 'MID', x: 58, y: 20 }, { group: 'MID', x: 58, y: 50 }, { group: 'MID', x: 58, y: 80 },
      { group: 'FWD', x: 82, y: 50 },
    ],
  },
  '5-3-2': {
    slots: [
      { group: 'GK', x: 5, y: 50 },
      { group: 'DEF', x: 16, y: 10 }, { group: 'DEF', x: 16, y: 30 }, { group: 'DEF', x: 16, y: 50 }, { group: 'DEF', x: 16, y: 70 }, { group: 'DEF', x: 16, y: 90 },
      { group: 'MID', x: 45, y: 25 }, { group: 'MID', x: 45, y: 50 }, { group: 'MID', x: 45, y: 75 },
      { group: 'FWD', x: 78, y: 38 }, { group: 'FWD', x: 78, y: 62 },
    ],
  },
};

const CLIENT_POSITION_TO_GROUP = {
  Portero: 'GK',
  Defensa: 'DEF',
  Mediocampista: 'MID',
  Delantero: 'FWD',
};

function escBoardHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function boardShortName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  return parts[parts.length - 1] || fullName || '';
}

// Asigna cada jugador a un puesto de la formacion (agrupado por posicion,
// mejor rating primero) para dibujar la pizarra. No es una asignacion
// persistente, solo una aproximacion visual.
function assignFormationSlots(players, formationName) {
  const formation = CLIENT_FORMATIONS[formationName] || CLIENT_FORMATIONS['4-4-2'];
  const byGroup = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of [...players].sort((a, b) => (b.rating || 0) - (a.rating || 0))) {
    const g = CLIENT_POSITION_TO_GROUP[p.position] || 'MID';
    byGroup[g].push(p);
  }
  const used = new Set();
  const placed = [];
  for (const slot of formation.slots) {
    let player = byGroup[slot.group].find((p) => !used.has(p.id));
    if (!player) {
      for (const g of ['GK', 'DEF', 'MID', 'FWD']) {
        player = byGroup[g].find((p) => !used.has(p.id));
        if (player) break;
      }
    }
    if (!player) continue;
    used.add(player.id);
    placed.push({ player, x: slot.x, y: slot.y });
  }
  return placed;
}

// Pinta la pizarra dentro de containerEl. `onTokenClick(player)` es opcional,
// y si se da, los jugadores en cancha se pueden hacer click (p.ej. para
// elegir a quien sacar en un cambio).
function renderFormationBoard(containerEl, players, formationName, opts) {
  const options = opts || {};
  containerEl.innerHTML = '';
  containerEl.classList.add('formation-board');
  const placed = assignFormationSlots(players, formationName);
  for (const { player, x, y } of placed) {
    const tok = document.createElement('div');
    tok.className = 'board-tok' + (player.position === 'Portero' ? ' gk' : '');
    if (options.selectedId != null && Number(options.selectedId) === Number(player.id)) {
      tok.classList.add('selected');
    }
    tok.style.left = x + '%';
    tok.style.top = y + '%';
    tok.innerHTML = `<span class="board-num">${player.shirt_number ?? ''}</span><span class="board-name">${escBoardHtml(player.full_name ? boardShortName(player.full_name) : '')}</span>`;
    if (options.onTokenClick) {
      tok.classList.add('clickable');
      tok.addEventListener('click', () => options.onTokenClick(player));
    }
    containerEl.appendChild(tok);
  }
}
