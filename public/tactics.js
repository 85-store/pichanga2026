// Barra lateral derecha (Proximo partido + Formacion) y el editor tactico de
// pantalla completa. No toca nada de app.js/match.js/formations.js: solo los
// usa (crestImg-style helpers propios, CLIENT_FORMATIONS/renderFormationBoard
// de formations.js, y las rutas nuevas /api/next-match y /api/tactics).
const tacticsRoot = document.getElementById('tactics-root');

function tEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function tCrest(club, size) {
  if (!club || !club.crest_url) return `<span style="display:inline-block;width:${size}px;height:${size}px;"></span>`;
  return `<img src="${tEsc(club.crest_url)}" alt="" style="width:${size}px;height:${size}px;object-fit:contain" onerror="this.style.visibility='hidden'">`;
}

function tLastName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  return parts[parts.length - 1] || fullName || '';
}

// ---- Modulo "Proximo partido" ----
async function renderNextMatchModule() {
  const box = document.getElementById('next-match-module');
  if (!box) return;
  box.innerHTML = '<div class="label">Próximo partido</div><div class="empty-state small">Cargando…</div>';
  try {
    const res = await window.apiFetch('/api/next-match');
    const data = res.ok ? await res.json() : null;
    if (!data) {
      box.innerHTML = '<div class="label">Próximo partido</div><div class="empty-state small">No tienes partidos pendientes por ahora.</div>';
      return;
    }
    box.innerHTML = `
      <div class="label">Próximo partido</div>
      <div class="next-match-card">
        <div class="nm-teams">
          <div class="nm-team">${tCrest(data.myClub, 36)}<span>${tEsc(data.myClub.short_name || data.myClub.name)}</span></div>
          <span class="nm-vs">${data.isHome ? 'vs (local)' : 'vs (visita)'}</span>
          <div class="nm-team">${tCrest(data.rivalClub, 36)}<span>${tEsc(data.rivalClub.short_name || data.rivalClub.name)}</span></div>
        </div>
        <div class="nm-info">
          <div>🏆 ${tEsc(data.competition)} · ${tEsc(data.roundLabel)}</div>
          <div>📅 ${tEsc(data.date)}</div>
          <div>🏟️ ${tEsc(data.stadium || 'Por definir')}</div>
        </div>
        <button class="nm-play-btn" id="nm-play-btn">SIGUIENTE PARTIDO</button>
      </div>`;
    document.getElementById('nm-play-btn').addEventListener('click', () => {
      if (window.openMatchViewer) window.openMatchViewer(data.kind, data.id);
    });
  } catch (e) {
    box.innerHTML = '<div class="label">Próximo partido</div><div class="empty-state small">No se pudo cargar.</div>';
  }
}

// ---- Modulo "Formacion" (solo lectura, con boton para abrir el editor) ----
async function renderFormationModule() {
  const box = document.getElementById('formation-module');
  if (!box) return;
  box.innerHTML = '<div class="label">Formación</div><div class="empty-state small">Cargando…</div>';
  try {
    const res = await window.apiFetch('/api/tactics');
    if (!res.ok) {
      box.innerHTML = '';
      return;
    }
    const data = await res.json();
    const formation = (data.saved && data.saved.formation) || LINEUP_FORMATIONS[0];
    const starterIds = data.saved ? new Set(data.saved.playerIds) : autoPickLineup(data.roster);
    const starters = data.roster.filter((p) => starterIds.has(p.id));

    box.innerHTML = `
      <div class="label">Formación</div>
      <div class="rs-formation-name">${tEsc(formation)}</div>
      <div class="pitch-wrap board-wrap">
        <svg class="pitch" viewBox="0 0 100 64" preserveAspectRatio="none">
          <rect x="0" y="0" width="100" height="64" class="pitch-grass"/>
          <rect x="0.5" y="0.5" width="99" height="63" class="pitch-line"/>
          <line x1="50" y1="0" x2="50" y2="64" class="pitch-line"/>
          <circle cx="50" cy="32" r="8" class="pitch-line"/>
        </svg>
        <div class="formation-board" id="rs-formation-board"></div>
      </div>
      <button class="rs-edit-btn" id="rs-edit-formation-btn">EDITAR FORMACIÓN</button>`;
    renderFormationBoard(document.getElementById('rs-formation-board'), starters, formation);
    document.getElementById('rs-edit-formation-btn').addEventListener('click', () => openTacticsEditor(data));
  } catch (e) {
    box.innerHTML = '';
  }
}

async function refreshRightSidebar() {
  renderNextMatchModule();
  renderFormationModule();
}
window.refreshRightSidebar = refreshRightSidebar;

// ---- Editor tactico de pantalla completa ----
function tacAssignSlots(players, formationName) {
  const formation = CLIENT_FORMATIONS[formationName] || CLIENT_FORMATIONS['4-4-2'];
  const byGroup = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of [...players].sort((a, b) => (b.rating || 0) - (a.rating || 0))) {
    byGroup[CLIENT_POSITION_TO_GROUP[p.position] || 'MID'].push(p);
  }
  const used = new Set();
  return formation.slots.map((slot) => {
    let player = byGroup[slot.group].find((p) => !used.has(p.id));
    if (!player) {
      for (const g of ['GK', 'DEF', 'MID', 'FWD']) {
        player = byGroup[g].find((p) => !used.has(p.id));
        if (player) break;
      }
    }
    if (!player) return null;
    used.add(player.id);
    return player.id;
  });
}

function openTacticsEditor(data) {
  const roster = data.roster;
  const validSaved = data.saved && data.saved.playerIds.every((pid) => roster.some((p) => p.id === pid));

  const ed = {
    roster,
    formation: (validSaved && data.saved.formation) || LINEUP_FORMATIONS[0],
    slotAssignment: null,
    selected: null, // { type: 'slot', index } | { type: 'bench', playerId }
  };
  ed.slotAssignment = validSaved
    ? tacAssignSlots(roster.filter((p) => data.saved.playerIds.includes(p.id)), ed.formation)
    : tacAssignSlots(roster.filter((p) => autoPickLineup(roster).has(p.id)), ed.formation);

  tacticsRoot.innerHTML = `
    <div class="match-overlay-backdrop">
      <div class="match-overlay tac-editor-overlay">
        <h2>Editor táctico</h2>
        <div class="tac-editor-body">
          <div class="tac-editor-board-col">
            <label>Formación <select id="tac-formation">${LINEUP_FORMATIONS.map((f) => `<option value="${f}" ${f === ed.formation ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
            <div class="pitch-wrap board-wrap">
              <svg class="pitch" viewBox="0 0 100 64" preserveAspectRatio="none">
                <rect x="0" y="0" width="100" height="64" class="pitch-grass"/>
                <rect x="0.5" y="0.5" width="99" height="63" class="pitch-line"/>
                <line x1="50" y1="0" x2="50" y2="64" class="pitch-line"/>
                <circle cx="50" cy="32" r="8" class="pitch-line"/>
              </svg>
              <div class="formation-board" id="tac-board"></div>
            </div>
            <div class="tac-editor-hint">Arrastra un jugador (titular o de la lista) sobre otro para intercambiar su posición,
            o selecciona uno en la cancha y luego haz clic en un jugador de la lista para hacerlo entrar.</div>
            <div class="tac-editor-detail" id="tac-detail">Selecciona un jugador para ver sus datos.</div>
          </div>
          <div class="tac-editor-bench-col">
            <h4>Plantel disponible</h4>
            <div class="tac-editor-bench-list" id="tac-bench"></div>
          </div>
        </div>
        <div class="lineup-actions">
          <button class="ctl-btn" id="tac-cancel-btn">Cancelar</button>
          <button class="ctl-btn primary" id="tac-save-btn">Guardar formación</button>
        </div>
      </div>
    </div>`;

  function playerById(id) {
    return roster.find((p) => p.id === id) || null;
  }

  function renderDetail(player) {
    const detail = document.getElementById('tac-detail');
    if (!player) {
      detail.innerHTML = 'Selecciona un jugador para ver sus datos.';
      return;
    }
    detail.innerHTML = `
      <div class="td-name">${tEsc(player.full_name)}</div>
      <div>${tEsc(player.position)} · ${player.age} años · Valoración ${player.rating}${player.potential ? ' (potencial ' + player.potential + ')' : ''}</div>`;
  }

  function handleDrop(target) {
    const source = ed.selected;
    if (!source) return;
    if (target.type === 'slot' && source.type === 'slot') {
      const tmp = ed.slotAssignment[target.index];
      ed.slotAssignment[target.index] = ed.slotAssignment[source.index];
      ed.slotAssignment[source.index] = tmp;
    } else if (target.type === 'slot' && source.type === 'bench') {
      if (ed.slotAssignment.includes(source.playerId)) {
        ed.slotAssignment[ed.slotAssignment.indexOf(source.playerId)] = ed.slotAssignment[target.index];
      }
      ed.slotAssignment[target.index] = source.playerId;
    } else if (target.type === 'bench' && source.type === 'slot') {
      ed.slotAssignment[source.index] = null;
    }
    ed.selected = null;
    refresh();
  }

  function refresh() {
    const board = document.getElementById('tac-board');
    board.innerHTML = '';
    board.classList.add('formation-board');
    const formation = CLIENT_FORMATIONS[ed.formation];
    formation.slots.forEach((slot, i) => {
      const player = ed.slotAssignment[i] != null ? playerById(ed.slotAssignment[i]) : null;
      const tok = document.createElement('div');
      tok.className =
        'board-tok editor-tok clickable' +
        (player && player.position === 'Portero' ? ' gk' : '') +
        (!player ? ' empty' : '') +
        (ed.selected && ed.selected.type === 'slot' && ed.selected.index === i ? ' selected' : '');
      tok.style.left = slot.x + '%';
      tok.style.top = slot.y + '%';
      tok.draggable = !!player;
      tok.innerHTML = player
        ? `<span class="board-num">${player.shirt_number ?? ''}</span><span class="board-name">${tEsc(tLastName(player.full_name))}</span>`
        : '<span class="board-num">?</span>';
      tok.addEventListener('click', () => {
        if (ed.selected && !(ed.selected.type === 'slot' && ed.selected.index === i)) {
          handleDrop({ type: 'slot', index: i });
          return;
        }
        ed.selected = ed.selected && ed.selected.type === 'slot' && ed.selected.index === i ? null : { type: 'slot', index: i };
        renderDetail(player);
        refresh();
      });
      tok.addEventListener('dragstart', () => { ed.selected = { type: 'slot', index: i }; });
      tok.addEventListener('dragover', (e) => e.preventDefault());
      tok.addEventListener('drop', (e) => { e.preventDefault(); handleDrop({ type: 'slot', index: i }); });
      board.appendChild(tok);
    });

    const bench = document.getElementById('tac-bench');
    const sorted = [...roster].sort((a, b) => {
      const order = { Portero: 0, Defensa: 1, Mediocampista: 2, Delantero: 3 };
      return (order[a.position] ?? 9) - (order[b.position] ?? 9) || b.rating - a.rating;
    });
    bench.innerHTML = '';
    for (const p of sorted) {
      const isStarter = ed.slotAssignment.includes(p.id);
      const row = document.createElement('div');
      row.className = 'tac-editor-bench-row' + (isStarter ? ' is-starter' : '') + (ed.selected && ed.selected.type === 'bench' && ed.selected.playerId === p.id ? ' selected' : '');
      row.draggable = true;
      row.innerHTML = `<span>${isStarter ? '⭐ ' : ''}${tEsc(p.full_name)} <span class="be-pos">${tEsc(p.position)} · ${p.age}a · ${p.rating}</span></span>`;
      row.addEventListener('click', () => {
        if (ed.selected && ed.selected.type === 'slot') {
          // Hay una casilla seleccionada: este jugador de banca entra ahi.
          const slotIndex = ed.selected.index;
          ed.selected = { type: 'bench', playerId: p.id };
          handleDrop({ type: 'slot', index: slotIndex });
          return;
        }
        ed.selected = ed.selected && ed.selected.type === 'bench' && ed.selected.playerId === p.id ? null : { type: 'bench', playerId: p.id };
        renderDetail(p);
        refresh();
      });
      row.addEventListener('dragstart', () => { ed.selected = { type: 'bench', playerId: p.id }; });
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => { e.preventDefault(); handleDrop({ type: 'bench' }); });
      bench.appendChild(row);
    }
  }

  document.getElementById('tac-formation').addEventListener('change', (e) => {
    const currentStarterIds = ed.slotAssignment.filter((id) => id != null);
    ed.formation = e.target.value;
    ed.slotAssignment = tacAssignSlots(roster.filter((p) => currentStarterIds.includes(p.id)), ed.formation);
    ed.selected = null;
    refresh();
  });

  document.getElementById('tac-cancel-btn').addEventListener('click', () => { tacticsRoot.innerHTML = ''; });
  document.getElementById('tac-save-btn').addEventListener('click', async () => {
    const ids = ed.slotAssignment.filter((id) => id != null);
    if (ids.length !== 11) {
      alert('Debes completar los 11 puestos de la formación antes de guardar.');
      return;
    }
    const saveBtn = document.getElementById('tac-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Guardando…';
    try {
      await window.apiFetch('/api/tactics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formation: ed.formation, playerIds: ids }),
      }).then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error || 'Error al guardar.');
      });
      tacticsRoot.innerHTML = '';
      renderFormationModule();
    } catch (e) {
      alert('No se pudo guardar la formación: ' + e.message);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar formación';
    }
  });

  refresh();
}
