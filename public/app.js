const state = {
  season: null,
  clubs: [],
  activeClubId: null,
  activeComp: null,
  highlightClubId: null,
  career: null,
  offers: [],
  transferOffers: [],
  marketStatus: null,
};

const mainView = document.getElementById('main-view');
const clubNav = document.getElementById('club-nav');
const seasonYearEl = document.getElementById('season-year');
const advanceBtn = document.getElementById('advance-btn');
const modalRoot = document.getElementById('modal-root');
const careerBox = document.getElementById('career-box');
const relationsModule = document.getElementById('relations-module');
const compLinks = document.querySelectorAll('.comp-link');

const sfxToggleBtn = document.querySelector('.season-box .sfx-toggle-btn');
if (sfxToggleBtn) sfxToggleBtn.addEventListener('click', () => { if (window.toggleSfx) window.toggleSfx(); });

// Cierra cualquier modal/backdrop con animación de salida antes de quitarlo
// del DOM, en vez de desaparecer en seco; usado por app.js, career-events.js,
// title.js y match.js para todas las ventanas emergentes del juego.
window.closeModal = function closeModal(backdrop, onRemoved) {
  if (!backdrop || backdrop.dataset.closing) return;
  backdrop.dataset.closing = '1';
  backdrop.classList.add('closing');
  setTimeout(() => {
    backdrop.remove();
    if (onRemoved) onRemoved();
  }, 190);
};

function isManagedClub(clubId) {
  return !!(state.career && state.career.club_id === clubId);
}

function clubById(id) {
  return state.clubs.find((c) => c.id === id);
}

function setActiveComp(view) {
  state.activeComp = view;
  state.activeClubId = null;
  compLinks.forEach((el) => el.classList.toggle('active', el.dataset.view === view));
  renderClubNav();
}

async function api(path, opts) {
  const res = await window.apiFetch('/api' + path, opts);
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Formatea montos en miles de USD (la unidad que usa todo el motor de mercado)
// como "US$450K" si son menores a un millon, o "US$2.35M" si son un millon o
// mas, para que presupuestos y precios grandes no salgan como un numero crudo
// de 4+ digitos (ej. "US$4588K").
function formatMoneyK(amountK) {
  if (amountK == null) return '';
  const n = Math.round(amountK);
  if (Math.abs(n) >= 1000) {
    const millions = parseFloat((n / 1000).toFixed(2));
    return `US$${millions}M`;
  }
  return `US$${n}K`;
}

// Permite escribir montos de forma corta en los inputs del mercado: "1.3M" o
// "500K" (o un numero plano, que se sigue interpretando en miles de USD como
// antes). Devuelve NaN si el texto no es un monto valido.
function parseMoneyK(raw) {
  if (raw == null) return NaN;
  const s = String(raw).trim().toUpperCase().replace(',', '.').replace(/^US\$/, '');
  if (!s) return NaN;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(M|K)?$/);
  if (!m) return NaN;
  const num = parseFloat(m[1]);
  return Math.round(m[2] === 'M' ? num * 1000 : num);
}

// Lee un input de filtro de precio (admite sufijos M/K) y lo devuelve como un
// numero plano en miles de USD, listo para mandar al backend; '' si esta vacio
// o no se pudo interpretar.
function readMoneyFilterInput(id) {
  const raw = document.getElementById(id).value.trim();
  if (!raw) return '';
  const n = parseMoneyK(raw);
  return Number.isNaN(n) ? '' : String(n);
}

function crestImg(club, size) {
  const px = size || 20;
  if (!club.crest_url) return `<span style="display:inline-block;width:${px}px;height:${px}px;"></span>`;
  return `<img src="${escapeHtml(club.crest_url)}" alt="" style="width:${px}px;height:${px}px;object-fit:contain" onerror="this.style.visibility='hidden'">`;
}

async function loadSeason() {
  const data = await api('/season');
  state.season = data.year;
  seasonYearEl.textContent = data.year;
}

async function loadClubs() {
  state.clubs = await api('/clubs');
  renderClubNav();
}

async function loadCareer() {
  state.career = await api('/career');
  state.offers = await api('/career/offers');
  try {
    state.marketStatus = await api('/market/status');
    state.transferOffers = state.marketStatus.open ? await api('/market/offers') : [];
  } catch (e) {
    state.marketStatus = null;
    state.transferOffers = [];
  }
  if (state.career && state.career.club_id && state.career.status !== 'despedido') {
    try {
      state.identityOptions = (await api('/team-identity')).options || [];
    } catch (e) {
      state.identityOptions = [];
    }
  } else {
    state.identityOptions = [];
  }
  renderCareerBox();
  maybeShowIdentityPicker();
}

function identityCardHtml(opt) {
  return `
    <div class="identity-card">
      <div class="identity-card-title">${opt.emoji || ''} ${escapeHtml(opt.name)}</div>
      <div class="identity-card-desc">${escapeHtml(opt.description)}</div>
      <div class="identity-card-pro">✅ ${escapeHtml(opt.pros)}</div>
      <div class="identity-card-con">⚠️ ${escapeHtml(opt.cons)}</div>
      <button class="identity-pick-btn" data-identity="${opt.key}">Elegir ${escapeHtml(opt.name)}</button>
    </div>`;
}

// Al llegar a un club sin identidad de camarin elegida (carrera nueva o tras
// cambiar de club), pide elegir una de las tres antes de seguir jugando.
function maybeShowIdentityPicker() {
  const career = state.career;
  if (!career || !career.club_id || career.team_identity || career.status === 'despedido') return;
  if (!state.identityOptions || !state.identityOptions.length) return;
  if (modalRoot.querySelector('.identity-modal')) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'summary-modal-backdrop';
  backdrop.innerHTML = `
    <div class="summary-modal identity-modal">
      <h2>Identidad del camarín</h2>
      <p class="identity-intro">Elige el rasgo principal de tu plantel en ${escapeHtml(
        career.club_short_name || career.club_name
      )}. No garantiza victorias ni reemplaza a los jugadores ni la táctica, pero influye de verdad en los partidos y en el ambiente del vestuario.</p>
      <div class="identity-cards">${state.identityOptions.map(identityCardHtml).join('')}</div>
    </div>`;
  modalRoot.appendChild(backdrop);
  backdrop.querySelectorAll('.identity-pick-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      backdrop.querySelectorAll('.identity-pick-btn').forEach((b) => (b.disabled = true));
      try {
        await api('/team-identity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: btn.dataset.identity }),
        });
        window.closeModal(backdrop, () => loadCareer());
      } catch (e) {
        alert('Error: ' + e.message);
        backdrop.querySelectorAll('.identity-pick-btn').forEach((b) => (b.disabled = false));
      }
    });
  });
}

function transferOfferCardHtml(offer) {
  return `
    <div class="offer-card">
      <div class="offer-club">${crestImg({ crest_url: offer.buyer_club_crest }, 20)} ${escapeHtml(offer.buyer_club_short_name || offer.buyer_club_name)}</div>
      <div class="offer-reason">Ofrece ${formatMoneyK(offer.offer_amount)} por ${escapeHtml(offer.player_name)} (${escapeHtml(offer.position)}, ${offer.rating})</div>
      <div class="offer-actions">
        <button class="offer-btn accept" data-transfer-offer-id="${offer.id}" data-action="accept">Aceptar</button>
        <button class="offer-btn decline" data-transfer-offer-id="${offer.id}" data-action="decline">Rechazar</button>
      </div>
    </div>`;
}

function wireTransferOfferButtons() {
  careerBox.querySelectorAll('[data-transfer-offer-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const offerId = Number(btn.dataset.transferOfferId);
      const action = btn.dataset.action;
      careerBox.querySelectorAll('[data-transfer-offer-id]').forEach((b) => (b.disabled = true));
      try {
        await api(`/market/offers/${offerId}/${action}`, { method: 'POST' });
        await loadCareer();
        if (state.activeClubId) openClub(state.activeClubId);
      } catch (e) {
        alert('Error: ' + e.message);
        await loadCareer();
      }
    });
  });
}

function offerCardHtml(offer) {
  const reasonTxt =
    offer.reason === 'despido'
      ? 'Te ofrece dirigir el equipo.'
      : 'Quiere robarte como entrenador.';
  return `
    <div class="offer-card">
      <div class="offer-club">${crestImg({ crest_url: offer.club_crest }, 20)} ${escapeHtml(offer.club_short_name || offer.club_name)}</div>
      <div class="offer-reason">${reasonTxt}</div>
      <div class="offer-actions">
        <button class="offer-btn accept" data-offer-id="${offer.id}" data-action="accept">Aceptar</button>
        <button class="offer-btn decline" data-offer-id="${offer.id}" data-action="decline">Rechazar</button>
      </div>
    </div>`;
}

// Las tres relaciones permanentes del entrenador (dirigencia, hinchada,
// camarín), mostradas como barras de progreso en la esquina superior derecha.
// Al pulsar cada una se abre el historial de acontecimientos filtrado por esa
// relacion (ce-show-history-filtered, definido en career-events.js).
function relationBarColor(value) {
  if (value <= 35) return 'var(--danger)';
  if (value <= 65) return 'var(--warn)';
  return '#3fae5a';
}

function relationBarHtml(key, label, emoji, value, groupKey) {
  const v = value != null ? Math.round(value) : 60;
  return `
    <button class="relation-indicator" data-group="${groupKey}" data-label="${escapeHtml(label)}" title="Ver historial de ${escapeHtml(label)}">
      <div class="relation-indicator-head"><span>${emoji} ${escapeHtml(label)}</span><span class="relation-value">${v}</span></div>
      <div class="relation-bar"><div class="relation-bar-fill" style="width:${v}%;background:${relationBarColor(v)}"></div></div>
    </button>`;
}

function renderRelationsModule() {
  if (!relationsModule) return;
  const career = state.career;
  if (!career || !career.club_id || career.status === 'despedido') {
    relationsModule.innerHTML = '';
    return;
  }
  relationsModule.innerHTML = `
    <div class="label">Relaciones del entrenador</div>
    <div class="relations-grid">
      ${relationBarHtml('dirigencia', 'Dirigencia', '🤝', career.board_confidence, 'dirigencia')}
      ${relationBarHtml('hinchada', 'Hinchada', '📣', career.fan_support, 'hinchada')}
      ${relationBarHtml('camarin', 'Camarín', '🏟️', career.locker_room_morale, 'camarin')}
      ${relationBarHtml('prensa', 'Prensa', '📰', 100 - (career.media_pressure != null ? career.media_pressure : 40), 'prensa')}
    </div>`;
  relationsModule.querySelectorAll('.relation-indicator').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (window.ceShowHistoryFiltered) window.ceShowHistoryFiltered(btn.dataset.group, btn.dataset.label);
    });
  });
}
window.renderRelationsModule = renderRelationsModule;

function renderCareerBox() {
  const career = state.career;
  const offers = state.offers || [];
  const transferOffers = state.transferOffers || [];
  const transferOffersHtml = transferOffers.length
    ? `<div class="label" style="margin-top:10px">Ofertas por tus jugadores</div>${transferOffers.map(transferOfferCardHtml).join('')}`
    : '';

  if (!career || !career.club_id) {
    careerBox.innerHTML = offers.length
      ? `<div class="season-box career-box"><div class="label">Ofertas de trabajo</div>${offers.map(offerCardHtml).join('')}</div>`
      : '';
    wireOfferButtons();
    renderRelationsModule();
    return;
  }

  const fired = career.status === 'despedido';
  const identityInfo = career.team_identity ? (state.identityOptions || []).find((o) => o.key === career.team_identity) : null;
  const identityHtml = identityInfo
    ? `<div class="career-identity" title="${escapeHtml(identityInfo.description)} Contra: ${escapeHtml(identityInfo.cons)}">
         ${identityInfo.emoji || ''} ${escapeHtml(identityInfo.name)} · ${escapeHtml(identityInfo.pros)}
       </div>`
    : '';
  const marketBadge =
    !fired && state.marketStatus && state.marketStatus.open
      ? `<div class="career-objective">💰 Mercado de pases abierto (${state.marketStatus.window}) · Presupuesto: ${formatMoneyK(state.marketStatus.budget)}</div>`
      : '';
  careerBox.innerHTML = `
    <div class="season-box career-box ${fired ? 'fired' : ''}">
      <div class="label">Dirigiendo a</div>
      <div class="career-club">${crestImg({ crest_url: career.club_crest }, 22)} ${escapeHtml(career.club_short_name || career.club_name)}</div>
      ${
        fired
          ? `<div class="career-fired">Despedido · ${escapeHtml(career.fired_reason || '')}</div>`
          : `<div class="career-objective">🎯 ${escapeHtml(career.objective_text || '')}</div>`
      }
      ${identityHtml}
      ${marketBadge}
      ${
        !fired && career.board_confidence != null
          ? `<div class="career-relations">
               <span title="Confianza del directorio">🤝 ${career.board_confidence}</span>
               <span title="Ambiente del vestuario">🏟️ ${career.locker_room_morale}</span>
               <span title="Reputación del entrenador">⭐ ${career.manager_reputation}</span>
               <span title="Presión mediática">📰 ${career.media_pressure != null ? career.media_pressure : 40}</span>
             </div>`
          : ''
      }
      ${!fired ? '<button class="ce-history-btn">📜 Historial de acontecimientos</button>' : ''}
      ${offers.length ? `<div class="label" style="margin-top:10px">Ofertas de trabajo</div>${offers.map(offerCardHtml).join('')}` : ''}
      ${!fired ? transferOffersHtml : ''}
    </div>`;
  wireOfferButtons();
  wireTransferOfferButtons();
  advanceBtn.disabled = fired;
  if (fired) advanceBtn.textContent = offers.length ? 'Despedido — responde las ofertas' : 'Despedido — partida terminada';
  else advanceBtn.textContent = 'Avanzar temporada ⚽';
  renderRelationsModule();
}
window.renderCareerBox = renderCareerBox;

function wireOfferButtons() {
  careerBox.querySelectorAll('.offer-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const offerId = Number(btn.dataset.offerId);
      const action = btn.dataset.action;
      careerBox.querySelectorAll('.offer-btn').forEach((b) => (b.disabled = true));
      try {
        await api(`/career/offers/${offerId}/${action}`, { method: 'POST' });
        await loadClubs();
        await loadCareer();
        if (action === 'accept') {
          state.activeClubId = null;
          state.activeComp = null;
          compLinks.forEach((el) => el.classList.remove('active'));
          renderLanding();
        }
      } catch (e) {
        alert('Error: ' + e.message);
        await loadCareer();
      }
    });
  });
}

function renderClubNav() {
  const divisions = ['Primera A', 'Primera B'];
  clubNav.innerHTML = divisions
    .map((div) => {
      const clubs = state.clubs.filter((c) => c.division === div);
      return `
        <div class="division-group">
          <div class="division-title">${div}</div>
          ${clubs
            .map(
              (c) => `
            <div class="club-link ${c.id === state.activeClubId ? 'active' : ''}" data-id="${c.id}">
              ${crestImg(c)}
              <span>${escapeHtml(c.short_name || c.name)}</span>
              <span class="count">${c.active_count}${c.injured_count ? ' · ' + c.injured_count + ' 🩹' : ''}</span>
            </div>`
            )
            .join('')}
        </div>`;
    })
    .join('');

  clubNav.querySelectorAll('.club-link').forEach((el) => {
    el.addEventListener('click', () => openClub(Number(el.dataset.id)));
  });
}

function renderLanding() {
  state.activeClubId = null;
  renderClubNav();
  mainView.innerHTML = `
    <div class="landing">
      <h2>Bienvenido a Pichanga 2026</h2>
      <p>Simulador de gestión del fútbol chileno: Primera División y Primera B, con planteles reales,
      edad y retiro de jugadores, lesiones deportivas, generación de nuevas camadas juveniles e historial
      persistente temporada tras temporada.</p>
      <p>Elige un club en el panel izquierdo para ver su plantel, o presiona <strong>Avanzar temporada</strong>
      para simular el paso del tiempo.</p>
    </div>`;
}

async function openClub(clubId) {
  state.activeClubId = clubId;
  state.activeComp = null;
  compLinks.forEach((el) => el.classList.remove('active'));
  renderClubNav();
  const data = await api(`/clubs/${clubId}`);
  renderClubView(data);
}

function posClass(pos) {
  return 'pos-' + pos.replace(/\s/g, '');
}

function renderClubView(data) {
  const { club, roster } = data;
  if (!roster.length) {
    mainView.innerHTML = `
      <div class="view-header">
        ${crestImg(club, 52)}
        <div>
          <h1>${escapeHtml(club.name)}</h1>
          <div class="sub">${escapeHtml(club.division)} · ${escapeHtml(club.city || '')} · ${escapeHtml(club.stadium || '')}</div>
        </div>
      </div>
      <div class="empty-state">Este club todavía no tiene plantel cargado. Los planteles reales se están
      incorporando club por club.</div>`;
    return;
  }

  mainView.innerHTML = `
    <div class="view-header">
      ${crestImg(club, 52)}
      <div>
        <h1>${escapeHtml(club.name)}</h1>
        <div class="sub">${escapeHtml(club.division)} · ${escapeHtml(club.city || '')} · ${escapeHtml(club.stadium || '')} · ${roster.length} jugadores</div>
      </div>
    </div>
    <table class="roster">
      <thead>
        <tr>
          <th>#</th><th>Jugador</th><th>Pos.</th><th>Edad</th><th>Nac.</th><th>Rating</th><th>Estado</th>
        </tr>
      </thead>
      <tbody>
        ${roster
          .map(
            (p) => `
          <tr data-id="${p.id}">
            <td>${p.shirt_number ?? '—'}</td>
            <td>${escapeHtml(p.full_name)}${p.is_real_player ? '' : ' <span style="color:var(--text-dim);font-size:11px">(juvenil)</span>'}</td>
            <td><span class="pos-badge ${posClass(p.position)}">${escapeHtml(p.position)}</span></td>
            <td>${p.age ?? '—'}</td>
            <td>${escapeHtml(p.nationality)}</td>
            <td><span class="rating-pill">${p.rating}</span></td>
            <td><span class="status-tag status-${p.status}">${escapeHtml(p.status)}</span></td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;

  mainView.querySelectorAll('tr[data-id]').forEach((row) => {
    row.addEventListener('click', () => openPlayer(Number(row.dataset.id)));
  });
}

async function openPlayer(playerId) {
  const data = await api(`/players/${playerId}`);
  renderPlayerView(data);
}

function renderPlayerView(data) {
  const { player, club, injuries, history, transfers } = data;
  mainView.innerHTML = `
    <div class="view-header">
      ${club ? crestImg(club, 44) : ''}
      <div>
        <h1>${escapeHtml(player.full_name)}</h1>
        <div class="sub">${escapeHtml(player.position)} · ${club ? escapeHtml(club.name) : 'Sin club'} · ${escapeHtml(player.status)}</div>
      </div>
    </div>
    <div class="player-detail">
      <div class="card">
        <h3>Ficha</h3>
        <div class="field-grid">
          <div><div class="f-label">Edad</div><div class="f-value">${player.age ?? '—'}</div></div>
          <div><div class="f-label">Nacionalidad</div><div class="f-value">${escapeHtml(player.nationality)}</div></div>
          <div><div class="f-label">Dorsal</div><div class="f-value">${player.shirt_number ?? '—'}</div></div>
          <div><div class="f-label">Rating</div><div class="f-value">${player.rating}</div></div>
          <div><div class="f-label">Potencial</div><div class="f-value">${player.potential}</div></div>
          <div><div class="f-label">Origen</div><div class="f-value">${player.is_real_player ? 'Real' : 'Juvenil generado'}</div></div>
          ${player.retired_at_season ? `<div><div class="f-label">Retiro</div><div class="f-value">${player.retired_at_season} (${player.retired_age} años)</div></div>` : ''}
        </div>
      </div>

      <div class="card">
        <h3>Lesiones (${injuries.length})</h3>
        ${
          injuries.length
            ? `<ul class="event-list">${injuries
                .map(
                  (i) => `<li><span class="ev-season">${i.season_year}</span>${escapeHtml(i.injury_type)} — ${escapeHtml(i.severity)}
                  ${i.recovered ? '· recuperado' : `· ${i.weeks_remaining} sem. restantes`}${i.is_relapse ? ' · recaída' : ''}</li>`
                )
                .join('')}</ul>`
            : '<div class="empty-state">Sin lesiones registradas.</div>'
        }
      </div>

      <div class="card">
        <h3>Historial</h3>
        ${
          history.length
            ? `<ul class="event-list">${history
                .map((h) => `<li><span class="ev-season">${h.season_year}</span>${escapeHtml(h.description)}</li>`)
                .join('')}</ul>`
            : '<div class="empty-state">Sin eventos registrados.</div>'
        }
      </div>

      <div class="card">
        <h3>Fichajes / movimientos</h3>
        ${
          transfers.length
            ? `<ul class="event-list">${transfers
                .map(
                  (t) => `<li><span class="ev-season">${t.season_year}</span>${escapeHtml(t.type)}
                  ${t.from_club_name ? ' desde ' + escapeHtml(t.from_club_name) : ''}${t.to_club_name ? ' a ' + escapeHtml(t.to_club_name) : ''}</li>`
                )
                .join('')}</ul>`
            : '<div class="empty-state">Sin movimientos registrados.</div>'
        }
      </div>
    </div>`;
}

function standingsRowClass(idx, total, s) {
  if (idx === 0) return 'zone-champion';
  if (s.division === 'Primera A' && idx >= total - 2) return 'zone-relegate';
  if (s.division === 'Primera B' && idx < 2) return 'zone-promote';
  return '';
}

async function renderLeagueView(division) {
  state.partidosLeagueDivision = division;
  const divKey = division === 'Primera B' ? 'b' : 'a';
  mainView.innerHTML = partidosTabBarHtml('liga') + '<div class="empty-state">Cargando…</div>';
  const data = await api(`/league/${divKey}`);
  renderLeagueData(data);
}

function renderLeagueData(data) {
  const { division, standings, nextJornada, totalJornadas: total, complete, fixturesByJornada, seasonYear } = data;
  const total11 = standings.length;

  // El club manejado solo puede jugar sus partidos en orden: se busca el
  // primer partido no jugado (por jornada) que involucre al club.
  let nextManagedFixtureId = null;
  const sortedJornadas = Object.keys(fixturesByJornada)
    .map(Number)
    .sort((a, b) => a - b);
  outer: for (const j of sortedJornadas) {
    for (const f of fixturesByJornada[j]) {
      if (!f.played && (isManagedClub(f.home_club_id) || isManagedClub(f.away_club_id))) {
        nextManagedFixtureId = f.id;
        break outer;
      }
    }
  }

  const clubOptions = state.clubs
    .filter((c) => c.division === division)
    .map((c) => `<option value="${c.id}" ${c.id === state.highlightClubId ? 'selected' : ''}>${escapeHtml(c.short_name || c.name)}</option>`)
    .join('');

  const rows = standings
    .map((s, idx) => {
      const club = clubById(s.club_id) || { crest_url: s.crest_url };
      const zone = standingsRowClass(idx, total11, { division });
      const hl = s.club_id === state.highlightClubId ? 'highlight-club' : '';
      return `
      <tr class="${zone} ${hl}">
        <td>${idx + 1}</td>
        <td class="team-cell">${crestImg(club, 20)} ${escapeHtml(s.name)}</td>
        <td>${s.pj}</td>
        <td>${s.g}</td>
        <td>${s.e}</td>
        <td>${s.p}</td>
        <td>${s.gf}</td>
        <td>${s.gc}</td>
        <td>${s.dif}</td>
        <td class="pts">${s.pts}</td>
      </tr>`;
    })
    .join('');

  const relevantJornadas = state.highlightClubId
    ? Object.keys(fixturesByJornada).filter((j) =>
        fixturesByJornada[j].some((f) => f.home_club_id === state.highlightClubId || f.away_club_id === state.highlightClubId)
      )
    : Object.keys(fixturesByJornada);

  const fixturesHtml = relevantJornadas
    .map((j) => {
      const matches = fixturesByJornada[j]
        .filter((f) => !state.highlightClubId || f.home_club_id === state.highlightClubId || f.away_club_id === state.highlightClubId)
        .map((f) => {
          const involves = state.highlightClubId && (f.home_club_id === state.highlightClubId || f.away_club_id === state.highlightClubId);
          const isManagedMatch = !f.played && (isManagedClub(f.home_club_id) || isManagedClub(f.away_club_id));
          const canWatch = isManagedMatch && f.id === nextManagedFixtureId;
          const isLocked = isManagedMatch && !canWatch;
          const score = f.played ? `${f.home_goals} - ${f.away_goals}` : 'vs';
          return `
          <div class="fixture-row ${f.played ? '' : 'pending'} ${involves ? 'involves' : ''}">
            <div class="fx-team">${crestImg({ crest_url: f.home_crest }, 18)} ${escapeHtml(f.home_name)}</div>
            <div class="fx-score">${score}</div>
            <div class="fx-team away">${escapeHtml(f.away_name)} ${crestImg({ crest_url: f.away_crest }, 18)}</div>
            ${canWatch ? `<button class="watch-btn" data-watch-kind="league" data-watch-id="${f.id}">▶ Ver</button>` : ''}
            ${isLocked ? '<span class="locked-note" title="Debes jugar tus partidos en orden">🔒 Pendiente</span>' : ''}
          </div>`;
        })
        .join('');
      if (!matches) return '';
      return `<div><div class="division-title">Jornada ${j}</div>${matches}</div>`;
    })
    .join('');

  mainView.innerHTML = `
    ${partidosTabBarHtml('liga')}
    <div class="view-header">
      <div>
        <h1>🏆 ${escapeHtml(division)}</h1>
        <div class="sub">Temporada ${seasonYear} · Jornada ${nextJornada ? nextJornada : total} de ${total}</div>
      </div>
      <div class="division-switch">
        <button class="division-switch-btn ${division === 'Primera A' ? 'active' : ''}" data-division="Primera A">Primera A</button>
        <button class="division-switch-btn ${division === 'Primera B' ? 'active' : ''}" data-division="Primera B">Primera B</button>
      </div>
    </div>
    <div class="view-toolbar">
      <select id="club-filter">
        <option value="">— Elegir club —</option>
        ${clubOptions}
      </select>
      ${
        complete
          ? '<span class="badge-complete">Liga completa ✓</span>'
          : '<button class="sim-btn" id="sim-jornada-btn">Simular jornada ' + nextJornada + '</button>'
      }
    </div>
    <table class="standings">
      <thead>
        <tr><th>#</th><th>Club</th><th>PJ</th><th>G</th><th>E</th><th>P</th><th>GF</th><th>GC</th><th>DIF</th><th>PTS</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="legend">
      <span><i style="background:var(--accent)"></i> Campeón</span>
      ${division === 'Primera A' ? '<span><i style="background:var(--danger)"></i> Descenso</span>' : '<span><i style="background:var(--accent-2)"></i> Ascenso</span>'}
    </div>
    <div class="jornada-list">${fixturesHtml || '<div class="empty-state">Sin partidos.</div>'}</div>`;

  document.getElementById('club-filter').addEventListener('change', (e) => {
    state.highlightClubId = e.target.value ? Number(e.target.value) : null;
    renderLeagueData(data);
  });

  wirePartidosTabBar();
  mainView.querySelectorAll('.division-switch-btn').forEach((btn) => {
    btn.addEventListener('click', () => renderLeagueView(btn.dataset.division));
  });

  const simBtn = document.getElementById('sim-jornada-btn');
  if (simBtn) {
    simBtn.addEventListener('click', async () => {
      simBtn.disabled = true;
      simBtn.textContent = 'Simulando…';
      try {
        await api('/league/simulate-jornada', { method: 'POST' });
        const fresh = await api(`/league/${division === 'Primera B' ? 'b' : 'a'}`);
        renderLeagueData(fresh);
        if (window.checkCareerEvents) window.checkCareerEvents();
      } catch (e) {
        alert('Error al simular jornada: ' + e.message);
      }
    });
  }
}

async function renderCopaView() {
  mainView.innerHTML = partidosTabBarHtml('copa') + '<div class="empty-state">Cargando…</div>';
  const data = await api('/copa');
  renderCopaData(data);
}

function renderCopaData(data) {
  const { bracket, complete, champion, seasonYear } = data;

  const bracketHtml = bracket
    .map((round) => {
      const matches = round.matches
        .map((m) => {
          const home = m.home_club_id ? clubById(m.home_club_id) : null;
          const away = m.away_club_id ? clubById(m.away_club_id) : null;
          const involves =
            state.highlightClubId && (m.home_club_id === state.highlightClubId || m.away_club_id === state.highlightClubId);
          const homeWin = m.played && m.winner_club_id === m.home_club_id;
          const awayWin = m.played && m.winner_club_id === m.away_club_id;
          const canWatch = !m.played && home && away && (isManagedClub(m.home_club_id) || isManagedClub(m.away_club_id));
          return `
          <div class="copa-match ${involves ? 'involves' : ''}">
            <div class="cm-team ${homeWin ? 'winner' : ''}">${home ? crestImg(home, 16) + ' ' + escapeHtml(home.short_name || home.name) : 'Por definir'} <span>${m.played ? m.home_goals : ''}</span></div>
            <div class="cm-team ${awayWin ? 'winner' : ''}">${away ? crestImg(away, 16) + ' ' + escapeHtml(away.short_name || away.name) : 'Por definir'} <span>${m.played ? m.away_goals : ''}</span></div>
            ${m.decided_by_penalties ? '<div style="color:var(--text-dim);font-size:11px;margin-top:4px">Definido por penales</div>' : ''}
            ${canWatch ? `<button class="watch-btn" data-watch-kind="copa" data-watch-id="${m.id}">▶ Ver</button>` : ''}
          </div>`;
        })
        .join('');
      return `<div class="copa-round"><h4>${escapeHtml(round.round_name)}</h4>${matches}</div>`;
    })
    .join('');

  mainView.innerHTML = `
    ${partidosTabBarHtml('copa')}
    <div class="view-header">
      <div>
        <h1>🏅 Copa Chile</h1>
        <div class="sub">Temporada ${seasonYear}${champion ? ' · Campeón: ' + escapeHtml(champion) : ''}</div>
      </div>
    </div>
    <div class="view-toolbar">
      ${
        complete
          ? '<span class="badge-complete">Copa completa ✓</span>'
          : '<button class="sim-btn" id="sim-copa-btn">Simular siguiente ronda</button>'
      }
    </div>
    <div class="copa-bracket">${bracketHtml}</div>`;

  wirePartidosTabBar();
  const simBtn = document.getElementById('sim-copa-btn');
  if (simBtn) {
    simBtn.addEventListener('click', async () => {
      simBtn.disabled = true;
      simBtn.textContent = 'Simulando…';
      try {
        await api('/copa/simulate-round', { method: 'POST' });
        const fresh = await api('/copa');
        renderCopaData(fresh);
        if (window.checkCareerEvents) window.checkCareerEvents();
      } catch (e) {
        alert('Error al simular ronda: ' + e.message);
      }
    });
  }
}

async function renderSuperCopaView() {
  mainView.innerHTML = partidosTabBarHtml('supercopa') + '<div class="empty-state">Cargando…</div>';
  const data = await api('/super-copa');
  renderSuperCopaData(data);
}

function renderSuperCopaData(data) {
  const { match, seasonYear } = data;

  if (!match) {
    mainView.innerHTML = `
      ${partidosTabBarHtml('supercopa')}
      <div class="view-header"><div><h1>⭐ Supercopa</h1><div class="sub">Temporada ${seasonYear}</div></div></div>
      <div class="empty-state">La Supercopa de esta temporada todavía no está definida (se juega una vez que haya
      campeón de Primera A y de Copa Chile de la temporada anterior).</div>`;
    wirePartidosTabBar();
    return;
  }

  if (match.skipped_reason) {
    mainView.innerHTML = `
      ${partidosTabBarHtml('supercopa')}
      <div class="view-header"><div><h1>⭐ Supercopa</h1><div class="sub">Temporada ${seasonYear}</div></div></div>
      <div class="empty-state">Se omitió la Supercopa: ${escapeHtml(match.home_name)} ganó tanto la liga como la
      Copa Chile la temporada anterior.</div>`;
    wirePartidosTabBar();
    return;
  }

  const home = clubById(match.home_club_id) || { crest_url: match.home_crest, name: match.home_name, short_name: match.home_short };
  const away = clubById(match.away_club_id) || { crest_url: match.away_crest, name: match.away_name, short_name: match.away_short };
  const canWatch = !match.played && (isManagedClub(match.home_club_id) || isManagedClub(match.away_club_id));

  mainView.innerHTML = `
    ${partidosTabBarHtml('supercopa')}
    <div class="view-header"><div><h1>⭐ Supercopa</h1><div class="sub">Temporada ${seasonYear}${match.played ? ' · Campeón: ' + escapeHtml(match.winner_name) : ''}</div></div></div>
    <div class="copa-bracket">
      <div class="copa-round">
        <h4>Final</h4>
        <div class="copa-match">
          <div class="cm-team ${match.played && match.winner_club_id === match.home_club_id ? 'winner' : ''}">${crestImg(home, 16)} ${escapeHtml(home.short_name || home.name)} <span>${match.played ? match.home_goals : ''}</span></div>
          <div class="cm-team ${match.played && match.winner_club_id === match.away_club_id ? 'winner' : ''}">${crestImg(away, 16)} ${escapeHtml(away.short_name || away.name)} <span>${match.played ? match.away_goals : ''}</span></div>
          ${match.decided_by_penalties ? '<div style="color:var(--text-dim);font-size:11px;margin-top:4px">Definido por penales</div>' : ''}
          ${canWatch ? `<button class="watch-btn" data-watch-kind="supercopa" data-watch-id="${match.id}">▶ Ver</button>` : ''}
          ${!match.played && !canWatch ? `<button class="sim-btn" id="sim-supercopa-btn">Simular Supercopa</button>` : ''}
        </div>
      </div>
    </div>`;

  wirePartidosTabBar();
  const simBtn = document.getElementById('sim-supercopa-btn');
  if (simBtn) {
    simBtn.addEventListener('click', async () => {
      simBtn.disabled = true;
      simBtn.textContent = 'Simulando…';
      try {
        await api('/super-copa/simulate', { method: 'POST' });
        renderSuperCopaView();
        if (window.checkCareerEvents) window.checkCareerEvents();
      } catch (e) {
        alert('Error al simular la Supercopa: ' + e.message);
      }
    });
  }
}

const MARKET_FILTER_STATE = { q: '', ageMin: '', ageMax: '', nationality: '', position: '', clubId: '', priceMin: '', priceMax: '' };
let marketNationalityOptions = null;

async function renderMarketView() {
  mainView.innerHTML = '<div class="empty-state">Cargando…</div>';
  try {
    const status = await api('/market/status');
    state.marketStatus = status;
    if (!status.open) {
      mainView.innerHTML = `
        <div class="view-header"><div><h1>💰 Mercado de pases</h1><div class="sub">Temporada ${status.seasonYear ?? state.season}</div></div></div>
        <div class="empty-state">No hay ventana de mercado abierta ahora. El mercado se abre al inicio de la
        temporada (ventana de verano) y a mitad de temporada (ventana de invierno).</div>`;
      return;
    }
    const [clubs, ownClub, results, sentOffers] = await Promise.all([
      api('/clubs'),
      api(`/clubs/${status.clubId}`),
      api('/market/search?' + marketQueryString()),
      api('/market/sent-offers'),
    ]);
    if (!marketNationalityOptions) {
      marketNationalityOptions = [...new Set(results.map((p) => p.nationality))].sort();
    }
    renderMarketData(status, clubs, ownClub.roster, results, sentOffers);
  } catch (e) {
    mainView.innerHTML = `<div class="empty-state">Error al cargar el mercado: ${escapeHtml(e.message)}</div>`;
  }
}

function marketQueryString() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(MARKET_FILTER_STATE)) {
    if (value !== '' && value != null) params.set(key, value);
  }
  return params.toString();
}

async function refreshMarketResults(status, clubs, ownRoster, sentOffers) {
  try {
    const results = await api('/market/search?' + marketQueryString());
    renderMarketData(status, clubs, ownRoster, results, sentOffers);
  } catch (e) {
    alert('Error al buscar en el mercado: ' + e.message);
  }
}

function renderMarketData(status, clubs, ownRoster, results, sentOffers) {
  const windowLabel = status.window === 'verano' ? 'Ventana de verano' : 'Ventana de invierno';

  const clubOptions = clubs
    .filter((c) => c.id !== status.clubId)
    .map((c) => `<option value="${c.id}" ${String(MARKET_FILTER_STATE.clubId) === String(c.id) ? 'selected' : ''}>${escapeHtml(c.short_name || c.name)}</option>`)
    .join('');

  const nationalityOptions = (marketNationalityOptions || [])
    .map((n) => `<option value="${escapeHtml(n)}" ${MARKET_FILTER_STATE.nationality === n ? 'selected' : ''}>${escapeHtml(n)}</option>`)
    .join('');

  const positions = ['Portero', 'Defensa', 'Mediocampista', 'Delantero'];
  const positionOptions = positions
    .map((p) => `<option value="${p}" ${MARKET_FILTER_STATE.position === p ? 'selected' : ''}>${p}</option>`)
    .join('');

  const resultsHtml = results.length
    ? results
        .map((p) => {
          const clubLabel = p.is_free_agent ? '🆓 Agente libre' : escapeHtml(p.club_short_name || p.club_name);
          const priceLabel = p.is_free_agent ? formatMoneyK(p.market_value) : `~${formatMoneyK(p.market_value)}`;
          const actions = p.is_free_agent
            ? `<button class="sim-btn sign-agent-btn" data-agent-id="${p.id}" ${p.market_value > status.budget ? 'disabled title="Presupuesto insuficiente"' : ''}>Fichar</button>`
            : `<input type="text" inputmode="decimal" class="bid-input" data-player-id="${p.id}" placeholder="Ej: 1.3M" style="width:90px">
               <button class="sim-btn bid-btn" data-player-id="${p.id}">Ofertar</button>
               <button class="sim-btn loan-btn" data-player-id="${p.id}">Préstamo</button>`;
          return `
      <tr>
        <td>${escapeHtml(p.full_name)}</td>
        <td>${clubLabel}</td>
        <td><span class="pos-badge ${posClass(p.position)}">${escapeHtml(p.position)}</span></td>
        <td>${p.age}</td>
        <td>${escapeHtml(p.nationality)}</td>
        <td><span class="rating-pill">${p.rating}</span></td>
        <td>${p.potential}</td>
        <td>${priceLabel}</td>
        <td>${actions}</td>
      </tr>`;
        })
        .join('')
    : '<tr><td colspan="9" class="empty-state">Sin resultados para estos filtros.</td></tr>';

  const loanableRoster = (ownRoster || []).filter((p) => !p.loaned_from_club_id);
  const ownRosterHtml = loanableRoster.length
    ? loanableRoster
        .map(
          (p) => `
      <tr>
        <td>${escapeHtml(p.full_name)}</td>
        <td><span class="pos-badge ${posClass(p.position)}">${escapeHtml(p.position)}</span></td>
        <td>${p.age}</td>
        <td><span class="rating-pill">${p.rating}</span></td>
        <td><button class="sim-btn loan-out-btn" data-player-id="${p.id}">Ceder a préstamo</button></td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="empty-state">No hay jugadores en tu plantel.</td></tr>';

  const sentOffersHtml = (sentOffers || []).length
    ? sentOffers
        .map((o) => {
          const kindLabel = o.kind === 'agente_libre' ? 'Agente libre' : o.kind === 'prestamo' ? 'Préstamo' : 'Fichaje';
          const amountLabel = o.amount != null ? ` · ${formatMoneyK(o.amount)}` : '';
          const isPendingCounter = o.status === 'contraoferta' && !o.resolved;
          const statusClass = o.status === 'aceptada' ? 'sent-offer-ok' : isPendingCounter ? 'sent-offer-counter' : 'sent-offer-bad';
          const statusLabel = o.status === 'aceptada' ? 'Aceptada' : isPendingCounter ? 'Contraoferta' : 'Rechazada';
          const actionsHtml = isPendingCounter
            ? `<div class="sent-offer-actions">
                 <button class="sim-btn tiny accept-counter-btn" data-offer-id="${o.id}">Aceptar</button>
                 <button class="sim-btn tiny ghost decline-counter-btn" data-offer-id="${o.id}">Rechazar</button>
               </div>`
            : '';
          return `
      <div class="sent-offer-row">
        <div class="sent-offer-main">
          <strong>${escapeHtml(o.player_name)}</strong>
          <span class="sent-offer-badge ${statusClass}">${statusLabel}</span>
        </div>
        <div class="sent-offer-sub">${kindLabel}${o.target_club_name ? ' · ' + escapeHtml(o.target_club_name) : ''}${amountLabel}</div>
        ${actionsHtml}
      </div>`;
        })
        .join('')
    : '<div class="empty-state" style="padding:12px 0">Aún no has enviado ofertas en esta ventana.</div>';

  mainView.innerHTML = `
    <div class="view-header" style="justify-content:space-between">
      <div>
        <h1>💰 Mercado de pases</h1>
        <div class="sub">${windowLabel} · Temporada ${status.seasonYear} · Presupuesto disponible: ${formatMoneyK(status.budget)}</div>
      </div>
      <div class="money-input-hint">Para los montos: escribe <strong>1.3M</strong> (= US$1,3 millones) o <strong>500K</strong> (= US$500 mil)</div>
    </div>

    <div class="market-layout">
      <div class="market-sidebar">
        <div class="card sent-offers-card">
          <h3>Ofertas enviadas</h3>
          <div class="sent-offers-list">${sentOffersHtml}</div>
        </div>
      </div>

      <div class="market-main">
        <div class="card" style="margin-bottom:16px">
          <h3>Buscar jugadores de todo el mundo</h3>
          <div class="view-toolbar" style="flex-wrap:wrap;gap:8px">
            <input type="text" id="mf-q" placeholder="Nombre…" value="${escapeHtml(MARKET_FILTER_STATE.q)}" style="width:160px">
            <input type="number" id="mf-age-min" placeholder="Edad mín." value="${escapeHtml(MARKET_FILTER_STATE.ageMin)}" style="width:90px">
            <input type="number" id="mf-age-max" placeholder="Edad máx." value="${escapeHtml(MARKET_FILTER_STATE.ageMax)}" style="width:90px">
            <select id="mf-nationality"><option value="">Nacionalidad (todas)</option>${nationalityOptions}</select>
            <select id="mf-position"><option value="">Posición (todas)</option>${positionOptions}</select>
            <select id="mf-club">
              <option value="">Club (todos)</option>
              <option value="free_agent" ${MARKET_FILTER_STATE.clubId === 'free_agent' ? 'selected' : ''}>Solo agentes libres</option>
              ${clubOptions}
            </select>
            <input type="text" inputmode="decimal" id="mf-price-min" placeholder="Precio mín. ej: 500K" value="${escapeHtml(MARKET_FILTER_STATE.priceMin)}" style="width:130px">
            <input type="text" inputmode="decimal" id="mf-price-max" placeholder="Precio máx. ej: 1.3M" value="${escapeHtml(MARKET_FILTER_STATE.priceMax)}" style="width:130px">
            <button class="sim-btn" id="market-search-btn">Buscar</button>
          </div>
          <table class="roster">
            <thead><tr><th>Jugador</th><th>Club</th><th>Pos.</th><th>Edad</th><th>Nac.</th><th>Rating</th><th>Pot.</th><th>Precio</th><th>Acciones</th></tr></thead>
            <tbody>${resultsHtml}</tbody>
          </table>
        </div>

        <div class="card">
          <h3>Tu plantel: ceder jugadores a préstamo</h3>
          <table class="roster">
            <thead><tr><th>Jugador</th><th>Pos.</th><th>Edad</th><th>Rating</th><th></th></tr></thead>
            <tbody>${ownRosterHtml}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  document.getElementById('market-search-btn').addEventListener('click', () => {
    MARKET_FILTER_STATE.q = document.getElementById('mf-q').value.trim();
    MARKET_FILTER_STATE.ageMin = document.getElementById('mf-age-min').value;
    MARKET_FILTER_STATE.ageMax = document.getElementById('mf-age-max').value;
    MARKET_FILTER_STATE.nationality = document.getElementById('mf-nationality').value;
    MARKET_FILTER_STATE.position = document.getElementById('mf-position').value;
    MARKET_FILTER_STATE.clubId = document.getElementById('mf-club').value;
    MARKET_FILTER_STATE.priceMin = readMoneyFilterInput('mf-price-min');
    MARKET_FILTER_STATE.priceMax = readMoneyFilterInput('mf-price-max');
    refreshMarketResults(status, clubs, ownRoster, sentOffers);
  });

  mainView.querySelectorAll('.accept-counter-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const result = await api(`/market/sent-offers/${btn.dataset.offerId}/accept-counter`, { method: 'POST' });
        alert('¡Fichaje cerrado por ' + formatMoneyK(result.amount) + '!');
        await loadCareer();
        renderMarketView();
      } catch (e) {
        alert('Error al aceptar la contraoferta: ' + e.message);
        btn.disabled = false;
      }
    });
  });

  mainView.querySelectorAll('.decline-counter-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/market/sent-offers/${btn.dataset.offerId}/decline-counter`, { method: 'POST' });
        renderMarketView();
      } catch (e) {
        alert('Error al rechazar la contraoferta: ' + e.message);
        btn.disabled = false;
      }
    });
  });

  mainView.querySelectorAll('.sign-agent-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/market/free-agents/${btn.dataset.agentId}/sign`, { method: 'POST' });
        await loadCareer();
        renderMarketView();
      } catch (e) {
        alert('Error al fichar: ' + e.message);
        btn.disabled = false;
      }
    });
  });

  mainView.querySelectorAll('.bid-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const playerId = Number(btn.dataset.playerId);
      const input = mainView.querySelector(`.bid-input[data-player-id="${playerId}"]`);
      const amount = parseMoneyK(input.value);
      if (!amount || Number.isNaN(amount) || amount <= 0) {
        alert('Ingresa un monto de oferta válido. Ejemplo: 1.3M o 500K.');
        return;
      }
      btn.disabled = true;
      try {
        const result = await api('/market/bid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId, amount }) });
        if (result.accepted) {
          alert('¡Oferta aceptada! Valor estimado del jugador: ' + formatMoneyK(result.value) + '.');
          await loadCareer();
        } else if (result.countered) {
          alert('El club no aceptó tu oferta, pero propone una contraoferta de ' + formatMoneyK(result.counterAmount) + '. La tienes en "Ofertas enviadas".');
        } else {
          alert('El club rechazó la oferta. Valor estimado del jugador: ' + formatMoneyK(result.value) + '.');
        }
        renderMarketView();
      } catch (e) {
        alert('Error al ofertar: ' + e.message);
        btn.disabled = false;
      }
    });
  });

  mainView.querySelectorAll('.loan-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const playerId = Number(btn.dataset.playerId);
      btn.disabled = true;
      try {
        const result = await api('/market/loan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId }) });
        if (result.accepted) {
          alert('¡El club aceptó cederlo a préstamo por una temporada!');
          await loadCareer();
        } else {
          alert('El club rechazó la solicitud de préstamo.');
        }
        renderMarketView();
      } catch (e) {
        alert('Error al pedir el préstamo: ' + e.message);
        btn.disabled = false;
      }
    });
  });

  mainView.querySelectorAll('.loan-out-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const playerId = Number(btn.dataset.playerId);
      btn.disabled = true;
      try {
        const result = await api('/market/loan-out', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId }) });
        if (result.accepted) {
          alert('Un club aceptó recibirlo a préstamo por una temporada.');
          renderMarketView();
        } else {
          alert('Ningún club quiso recibirlo a préstamo esta vez.');
          btn.disabled = false;
        }
      } catch (e) {
        alert('Error al ofrecerlo a préstamo: ' + e.message);
        btn.disabled = false;
      }
    });
  });
}

compLinks.forEach((el) => {
  el.addEventListener('click', () => {
    const view = el.dataset.view;
    setActiveComp(view);
    if (view === 'partidos') renderPartidosView(state.partidosTab);
    else if (view === 'international') renderInternationalView();
    else if (view === 'market') renderMarketView();
    else if (view === 'medios') renderMediosView();
  });
});

// ---- Seccion "Partidos": calendario unificado + Liga/Copa Chile/Copa de la
// Liga/Supercopa como pestañas de una sola vista, en vez de 5 links aparte en
// el sidebar. Las 4 competiciones nacionales se juegan desde el calendario,
// asi se avanza progresivamente sin tener que andar saltando de sección en
// sección para encontrar el próximo partido pendiente.
const PARTIDOS_TABS = [
  { key: 'calendario', label: '📅 Calendario' },
  { key: 'liga', label: '🏆 Liga' },
  { key: 'copa', label: '🏅 Copa Chile' },
  { key: 'copa-liga', label: '🏆 Copa de la Liga' },
  { key: 'supercopa', label: '⭐ Supercopa' },
];

function partidosTabBarHtml(active) {
  return `
    <div class="partidos-tabbar">
      ${PARTIDOS_TABS.map((t) => `<button class="partidos-tab ${t.key === active ? 'active' : ''}" data-partidos-tab="${t.key}">${t.label}</button>`).join('')}
    </div>`;
}

function wirePartidosTabBar() {
  mainView.querySelectorAll('.partidos-tab').forEach((btn) => {
    btn.addEventListener('click', () => renderPartidosView(btn.dataset.partidosTab));
  });
}

function renderPartidosView(tab) {
  state.partidosTab = tab || state.partidosTab || 'calendario';
  if (state.partidosTab === 'liga') {
    renderLeagueView(state.partidosLeagueDivision || (state.career && state.career.club_division) || 'Primera A');
  } else if (state.partidosTab === 'copa') {
    renderCopaView();
  } else if (state.partidosTab === 'copa-liga') {
    renderCopaLigaView();
  } else if (state.partidosTab === 'supercopa') {
    renderSuperCopaView();
  } else {
    state.partidosTab = 'calendario';
    renderCalendarTab();
  }
}

function calendarEntryHtml(entry) {
  return `
    <div class="calendar-entry ${entry.canWatch ? 'next' : 'pending'}">
      <div class="calendar-entry-head">
        <span class="calendar-entry-comp">${escapeHtml(entry.competition)}</span>
        <span class="calendar-entry-round">${escapeHtml(entry.roundLabel)}</span>
      </div>
      <div class="fixture-row">
        <div class="fx-team">${crestImg(entry.myClub, 22)} ${escapeHtml(entry.myClub.short_name || entry.myClub.name)}</div>
        <div class="fx-score">${entry.isHome ? 'Local' : 'Visita'}</div>
        <div class="fx-team away">${escapeHtml(entry.rivalClub.short_name || entry.rivalClub.name)} ${crestImg(entry.rivalClub, 22)}</div>
      </div>
      <div class="calendar-entry-foot">
        <span class="calendar-entry-date">📅 ${escapeHtml(entry.date)}</span>
        ${
          entry.canWatch
            ? `<button class="watch-btn" data-watch-kind="${entry.kind}" data-watch-id="${entry.id}">▶ Ver</button>`
            : '<span class="locked-note" title="Primero debes jugar el partido anterior del calendario">🔒 Pendiente</span>'
        }
      </div>
    </div>`;
}

// Revisa si al club del usuario no le queda nada pendiente en ninguna de las
// 4 competiciones nacionales. Si es asi, /calendar ya avanzo la temporada
// sola (ver el comentario en esa ruta, src/routes/api.js) y devuelve el
// resultado en seasonAdvance: se muestra el mismo balance/resumen de fin de
// temporada que antes solo aparecia con el boton manual "Avanzar temporada",
// sin que el usuario tenga que apretar nada. Se llama tanto al entrar al
// Calendario como justo al terminar cualquier partido del usuario (ver
// window.onMatchFinished), que es el momento en que la temporada realmente
// puede haber quedado sin nada pendiente.
async function checkSeasonAutoAdvance() {
  const calendar = await api('/calendar');
  if (calendar.seasonAdvance) {
    const result = calendar.seasonAdvance;
    await Promise.all([loadSeason(), loadClubs(), loadCareer()]);
    if (window.refreshRightSidebar) window.refreshRightSidebar();
    renderBalanceScreen(result, () => renderSeasonSummary(result));
    return { advanced: true, entries: calendar.entries };
  }
  return { advanced: false, entries: calendar.entries };
}

async function renderCalendarTab() {
  mainView.innerHTML = partidosTabBarHtml('calendario') + '<div class="empty-state">Cargando…</div>';
  try {
    const [calendar, tacticsData] = await Promise.all([checkSeasonAutoAdvance(), api('/tactics')]);
    if (calendar.advanced) return;
    renderCalendarData(calendar.entries, tacticsData);
  } catch (e) {
    mainView.innerHTML = partidosTabBarHtml('calendario') + `<div class="empty-state">Error al cargar el calendario: ${escapeHtml(e.message)}</div>`;
    wirePartidosTabBar();
  }
}

function renderCalendarData(entries, tacticsData) {
  const formation = (tacticsData.saved && tacticsData.saved.formation) || LINEUP_FORMATIONS[0];
  const starterIds = tacticsData.saved ? new Set(tacticsData.saved.playerIds) : autoPickLineup(tacticsData.roster);
  const starters = tacticsData.roster.filter((p) => starterIds.has(p.id));

  mainView.innerHTML = `
    ${partidosTabBarHtml('calendario')}
    <div class="view-header"><div><h1>📅 Calendario</h1><div class="sub">Tus próximos partidos en las 4 competiciones nacionales, en orden.</div></div></div>
    <div class="partidos-calendar-layout">
      <div class="partidos-calendar-col">
        ${entries.length ? entries.map(calendarEntryHtml).join('') : '<div class="empty-state">No tienes partidos pendientes por ahora.</div>'}
      </div>
      <div class="partidos-formation-col card">
        <div class="label">Formación</div>
        <div class="rs-formation-name">${escapeHtml(formation)}</div>
        <div class="pitch-wrap board-wrap">
          <svg class="pitch" viewBox="0 0 100 64" preserveAspectRatio="none">
            <rect x="0" y="0" width="100" height="64" class="pitch-grass"/>
            <rect x="0.5" y="0.5" width="99" height="63" class="pitch-line"/>
            <line x1="50" y1="0" x2="50" y2="64" class="pitch-line"/>
            <circle cx="50" cy="32" r="8" class="pitch-line"/>
          </svg>
          <div class="formation-board" id="cal-formation-board"></div>
        </div>
        <button class="rs-edit-btn" id="cal-edit-formation-btn">EDITAR FORMACIÓN</button>
      </div>
    </div>`;
  renderFormationBoard(document.getElementById('cal-formation-board'), starters, formation);
  document.getElementById('cal-edit-formation-btn').addEventListener('click', () => openTacticsEditor(tacticsData));
  wirePartidosTabBar();
}

// Pantalla de "balance" de fin de temporada: se muestra primero, antes del
// resumen detallado (renderSeasonSummary) — trofeos propios (vacios si no se
// ganó ninguno), goleadores del plantel, reputación con los 4 estamentos del
// club y un titular + música distinta segun si se ganó algo o no. Musica e
// imagenes van en public/balance/ (ver balance/LEEME.txt).
function renderBalanceScreen(result, onContinue) {
  const wonAny = !!result.wonAnyTitle;
  const trophiesWon = result.trophiesWon || {};
  const topScorers = result.topScorers || [];
  const reputation = result.reputation || {};

  const balanceTrophy = (file, emoji, label, won) => `
    <div class="trophy-card ${won ? '' : 'not-won'}">
      <img src="trophies/${file}" alt="${escapeHtml(label)}" onerror="this.outerHTML='<span class=\\'trophy-emoji\\'>${emoji}</span>'" />
      <div class="trophy-label">${label}</div>
      <div class="trophy-winner">${won ? '🏆 Ganado' : '—'}</div>
    </div>`;

  const trophyRow = [
    balanceTrophy('primera-a.png', '🏆', 'Primera A', trophiesWon.primeraA),
    balanceTrophy('primera-b.png', '🥇', 'Primera B', trophiesWon.primeraB),
    balanceTrophy('copa-chile.png', '🏅', 'Copa Chile', trophiesWon.copaChile),
    balanceTrophy('copa-liga.png', '🎗️', 'Copa de la Liga', trophiesWon.copaLiga),
    balanceTrophy('supercopa.png', '⭐', 'Supercopa', trophiesWon.supercopa),
  ].join('');

  const repBar = (label, value) => {
    const v = value == null ? 60 : value;
    return `
      <div class="rep-row">
        <span class="rep-label">${label}</span>
        <div class="rep-bar"><div class="rep-fill" style="width:${v}%"></div></div>
        <span class="rep-value">${v}</span>
      </div>`;
  };

  const musicFile = wonAny ? 'balance/campeon.mp3' : 'balance/nada.mp3';
  const imgFile = wonAny ? 'balance/campeon.jpg' : 'balance/nada.jpg';

  const backdrop = document.createElement('div');
  backdrop.className = 'summary-modal-backdrop';
  backdrop.innerHTML = `
    <div class="summary-modal balance-modal ${wonAny ? 'balance-won' : 'balance-none'}">
      <img class="balance-bg-img" src="${imgFile}" alt="" onerror="this.style.display='none'">
      <h2 class="balance-banner">${wonAny ? '¡DALE CAMPEÓN!' : 'NADAPLETE COMPLETADO'}</h2>
      <div class="trophy-row">${trophyRow}</div>
      <div class="summary-section">
        <h4>Goleadores del plantel</h4>
        ${
          topScorers.length
            ? `<ul>${topScorers.map((s) => `<li>⚽ ${escapeHtml(s.full_name)} — ${s.goals} ${s.goals === 1 ? 'gol' : 'goles'}</li>`).join('')}</ul>`
            : '<div class="empty-state">Nadie anotó esta temporada.</div>'
        }
      </div>
      <div class="summary-section balance-reputation">
        <h4>Reputación</h4>
        ${repBar('Directiva', reputation.boardConfidence)}
        ${repBar('Hinchada', reputation.fanSupport)}
        ${repBar('Medios', reputation.mediaPressure)}
        ${repBar('Camarín', reputation.lockerRoomMorale)}
      </div>
      <button class="close-btn" id="balance-continue-btn">Continuar</button>
    </div>`;
  modalRoot.appendChild(backdrop);

  let audio = null;
  try {
    audio = new Audio(musicFile);
    audio.volume = 0.7;
    audio.play().catch(() => {});
  } catch {
    // sin soporte de audio: la pantalla sigue funcionando igual
  }

  const finish = () => {
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    window.closeModal(backdrop, onContinue);
  };
  document.getElementById('balance-continue-btn').addEventListener('click', finish);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) finish();
  });
}

function renderSeasonSummary(result) {
  const section = (title, items, render) => `
    <div class="summary-section">
      <h4>${title} (${items.length})</h4>
      ${items.length ? `<ul>${items.map(render).join('')}</ul>` : '<div class="empty-state">Ninguno esta temporada.</div>'}
    </div>`;

  const trophy = (file, emoji, label, name) => `
    <div class="trophy-card">
      <img src="trophies/${file}" alt="${escapeHtml(label)}" onerror="this.outerHTML='<span class=\\'trophy-emoji\\'>${emoji}</span>'" />
      <div class="trophy-label">${label}</div>
      <div class="trophy-winner">${escapeHtml(name)}</div>
    </div>`;

  const league = result.league || {};
  const primeraBChampion = (league.promoted || [])[0] || null;
  const trophies = [
    league.champion ? trophy('primera-a.png', '🏆', 'Primera A', league.champion) : '',
    primeraBChampion ? trophy('primera-b.png', '🥇', 'Primera B', primeraBChampion) : '',
    result.copaChampion ? trophy('copa-chile.png', '🏅', 'Copa Chile', result.copaChampion) : '',
    result.copaLigaChampion ? trophy('copa-liga.png', '🎗️', 'Copa de la Liga', result.copaLigaChampion) : '',
    result.superCopaChampion ? trophy('supercopa.png', '⭐', 'Supercopa', result.superCopaChampion) : '',
  ].filter(Boolean).join('');

  const leagueHtml = `
    <div class="summary-section">
      <h4>Liga y Copa</h4>
      ${trophies ? `<div class="trophy-row">${trophies}</div>` : ''}
      <ul>
        ${(league.relegated || []).map((n) => `<li>⬇️ Desciende a Primera B: ${escapeHtml(n)}</li>`).join('')}
        ${(league.promoted || []).map((n) => `<li>⬆️ Asciende a Primera A: ${escapeHtml(n)}</li>`).join('')}
      </ul>
    </div>`;

  const board = result.board;
  const boardHtml = board
    ? `<div class="summary-section board-result ${board.fired ? 'board-fired' : 'board-ok'}">
        <h4>Directorio</h4>
        <ul><li>${escapeHtml(board.message)}</li></ul>
      </div>`
    : '';

  const nextObjective = result.nextObjective;
  const nextObjectiveHtml = nextObjective
    ? `<div class="summary-section">
        <h4>Nuevo objetivo</h4>
        <ul><li>🎯 ${escapeHtml(nextObjective.text)}</li></ul>
      </div>`
    : '';

  const jobOffers = result.jobOffers || [];
  const jobOffersHtml = jobOffers.length
    ? `<div class="summary-section">
        <h4>Ofertas de trabajo</h4>
        <ul>${jobOffers
          .map((o) => `<li>📩 ${escapeHtml(o.club_short_name || o.club_name)} quiere contratarte. Revisa el panel izquierdo para responder.</li>`)
          .join('')}</ul>
      </div>`
    : '';

  const backdrop = document.createElement('div');
  backdrop.className = 'summary-modal-backdrop';
  backdrop.innerHTML = `
    <div class="summary-modal">
      <h2>Temporada ${result.previousYear} → ${result.currentYear}</h2>
      ${boardHtml}
      ${leagueHtml}
      ${nextObjectiveHtml}
      ${jobOffersHtml}
      ${section('Retiros', result.retirements, (r) => `<li>${escapeHtml(r.full_name)} (${escapeHtml(r.club_name || 'sin club')})</li>`)}
      ${section('Lesiones nuevas', result.injuries, (r) => `<li>${escapeHtml(r.full_name)} — ${escapeHtml(r.description)}</li>`)}
      ${section('Recuperaciones', result.recoveries, (r) => `<li>${escapeHtml(r.full_name)}</li>`)}
      ${section('Nuevos juveniles', result.youth, (r) => `<li>${escapeHtml(r.full_name)} (${escapeHtml(r.club_name)})</li>`)}
      <button class="close-btn" id="close-summary">Cerrar</button>
    </div>`;
  modalRoot.appendChild(backdrop);
  const closeAndCheckEvents = () => {
    window.closeModal(backdrop, () => {
      if (window.checkCareerEvents) window.checkCareerEvents();
    });
  };
  document.getElementById('close-summary').addEventListener('click', closeAndCheckEvents);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeAndCheckEvents();
  });
}

advanceBtn.addEventListener('click', async () => {
  advanceBtn.disabled = true;
  advanceBtn.textContent = 'Simulando…';
  try {
    const result = await api('/season/advance', { method: 'POST' });
    await loadSeason();
    await loadClubs();
    await loadCareer();
    if (window.refreshRightSidebar) window.refreshRightSidebar();
    renderBalanceScreen(result, () => renderSeasonSummary(result));
    if (state.activeClubId) openClub(state.activeClubId);
  } catch (e) {
    alert('Error al avanzar temporada: ' + e.message);
  } finally {
    advanceBtn.disabled = false;
    advanceBtn.textContent = 'Avanzar temporada ⚽';
  }
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.watch-btn');
  if (!btn || !window.openMatchViewer) return;
  window.openMatchViewer(btn.dataset.watchKind, Number(btn.dataset.watchId));
});

window.onMatchFinished = async function () {
  // Se revisa primero si con este partido se acabo todo lo pendiente del
  // usuario: si la temporada se avanzo sola, ya se esta mostrando el balance
  // de fin de temporada (ver checkSeasonAutoAdvance) y no corresponde seguir
  // con el refresco normal de partido (la vista de partidos/sidebar/eventos
  // de directorio quedan obsoletos apenas cambia la temporada).
  const { advanced } = await checkSeasonAutoAdvance();
  if (advanced) return;
  if (state.activeComp === 'partidos') renderPartidosView(state.partidosTab);
  if (window.refreshRightSidebar) window.refreshRightSidebar();
  if (window.checkCareerEvents) window.checkCareerEvents();
};

window.startGame = async function () {
  document.getElementById('app').style.display = '';
  state.activeClubId = null;
  state.activeComp = null;
  state.highlightClubId = null;
  compLinks.forEach((el) => el.classList.remove('active'));
  await loadSeason();
  await loadClubs();
  await loadCareer();
  if (window.refreshRightSidebar) window.refreshRightSidebar();
  renderLanding();
};
