// Vistas de la Copa de la Liga (grupos + semifinales ida/vuelta + final) y
// de la clasificacion a copas internacionales (Libertadores/Sudamericana).
// Solo se muestra que club chileno ocupa cada cupo y en que fase: no se
// simulan partidos contra clubes extranjeros (no hay planteles reales de
// clubes CONMEBOL en el proyecto).

function clgMatchRowHtml(m) {
  const score = m.played ? `${m.home_goals} - ${m.away_goals}` : 'vs';
  const canWatch = !m.played && (isManagedClub(m.home_club_id) || isManagedClub(m.away_club_id));
  const involves = state.highlightClubId && (m.home_club_id === state.highlightClubId || m.away_club_id === state.highlightClubId);
  return `
    <div class="fixture-row ${m.played ? '' : 'pending'} ${involves ? 'involves' : ''}">
      <div class="fx-team">${crestImg({ crest_url: m.home_crest }, 18)} ${escapeHtml(m.home_name)}</div>
      <div class="fx-score">${score}</div>
      <div class="fx-team away">${escapeHtml(m.away_name)} ${crestImg({ crest_url: m.away_crest }, 18)}</div>
      ${canWatch ? `<button class="watch-btn" data-watch-kind="copa-liga" data-watch-id="${m.id}">▶ Ver</button>` : ''}
    </div>`;
}

function clgGroupTableHtml(group) {
  const rows = group.standings
    .map(
      (r) => `
      <tr class="${state.highlightClubId === r.club_id ? 'highlight-club' : ''}">
        <td>${crestImg({ crest_url: r.crest_url }, 16)} ${escapeHtml(r.name)}</td>
        <td>${r.pj}</td><td>${r.g}</td><td>${r.e}</td><td>${r.p}</td>
        <td>${r.gf}</td><td>${r.gc}</td><td>${r.dif}</td><td><b>${r.pts}</b></td>
      </tr>`
    )
    .join('');
  const matchesHtml = (group.matches || []).map(clgMatchRowHtml).join('');
  return `
    <div class="copa-liga-group">
      <h4>Grupo ${escapeHtml(group.name)}</h4>
      <table class="standings">
        <thead><tr><th>Club</th><th>PJ</th><th>G</th><th>E</th><th>P</th><th>GF</th><th>GC</th><th>DIF</th><th>PTS</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="copa-liga-fixtures">${matchesHtml}</div>
    </div>`;
}

function clgKnockoutMatchHtml(m, label) {
  const home = clubById(m.home_club_id) || { name: m.home_name, crest_url: m.home_crest };
  const away = clubById(m.away_club_id) || { name: m.away_name, crest_url: m.away_crest };
  const homeWin = m.played && m.winner_club_id === m.home_club_id;
  const awayWin = m.played && m.winner_club_id === m.away_club_id;
  const canWatch = !m.played && (isManagedClub(m.home_club_id) || isManagedClub(m.away_club_id));
  return `
    <div class="copa-match">
      ${label ? `<div style="color:var(--text-dim);font-size:11px;margin-bottom:4px">${escapeHtml(label)}</div>` : ''}
      <div class="cm-team ${homeWin ? 'winner' : ''}">${crestImg(home, 16)} ${escapeHtml(home.short_name || home.name)} <span>${m.played ? m.home_goals : ''}</span></div>
      <div class="cm-team ${awayWin ? 'winner' : ''}">${crestImg(away, 16)} ${escapeHtml(away.short_name || away.name)} <span>${m.played ? m.away_goals : ''}</span></div>
      ${m.decided_by_penalties ? '<div style="color:var(--text-dim);font-size:11px;margin-top:4px">Definido por penales</div>' : ''}
      ${canWatch ? `<button class="watch-btn" data-watch-kind="copa-liga" data-watch-id="${m.id}">▶ Ver</button>` : ''}
    </div>`;
}

async function renderCopaLigaView() {
  mainView.innerHTML = partidosTabBarHtml('copa-liga') + '<div class="empty-state">Cargando…</div>';
  try {
    const data = await api('/copa-liga');
    renderCopaLigaData(data);
  } catch (e) {
    mainView.innerHTML = partidosTabBarHtml('copa-liga') + `<div class="empty-state">Error al cargar la Copa de la Liga: ${escapeHtml(e.message)}</div>`;
    wirePartidosTabBar();
  }
}

function renderCopaLigaData(data) {
  const { seasonYear, groups, semifinals, final, complete, champion } = data;

  if (!groups.length) {
    mainView.innerHTML = `
      ${partidosTabBarHtml('copa-liga')}
      <div class="view-header"><div><h1>🏆 Copa de la Liga</h1><div class="sub">Temporada ${seasonYear}</div></div></div>
      <div class="empty-state">El sorteo de grupos todavía no se ha generado para esta temporada.</div>`;
    wirePartidosTabBar();
    return;
  }

  const championClub = champion ? clubById(champion) : null;
  const semisBySlot = [0, 1].map((slot) => semifinals.filter((m) => m.tie_slot === slot));

  const semisHtml = semisBySlot.length
    ? `
    <div class="copa-round">
      <h4>Semifinales (ida y vuelta)</h4>
      ${semisBySlot
        .map((legs, i) =>
          legs.length
            ? `<div class="copa-liga-tie">${legs.map((m, li) => clgKnockoutMatchHtml(m, `Llave ${i + 1} · ${li === 0 ? 'Ida' : 'Vuelta'}`)).join('')}</div>`
            : ''
        )
        .join('')}
    </div>`
    : '';

  const finalHtml = final
    ? `<div class="copa-round"><h4>Final (sede neutral)</h4>${clgKnockoutMatchHtml(final)}</div>`
    : '';

  const simBtn =
    !complete
      ? '<button class="sim-btn" id="sim-copa-liga-btn">Simular siguiente etapa</button>'
      : '<span class="badge-complete">Copa de la Liga completa ✓</span>';

  mainView.innerHTML = `
    ${partidosTabBarHtml('copa-liga')}
    <div class="view-header">
      <div>
        <h1>🏆 Copa de la Liga</h1>
        <div class="sub">Temporada ${seasonYear}${championClub ? ' · Campeón: ' + escapeHtml(championClub.name) : ''}</div>
      </div>
    </div>
    <div class="view-toolbar">${simBtn}</div>
    ${
      complete
        ? ''
        : '<div class="copa-hint">Jugá primero tu partido pendiente (acá abajo o desde el Calendario) para no saltártelo sin verlo. Apretá "Simular siguiente etapa" para avanzar los partidos de los demás clubes, armar semifinales y la final.</div>'
    }
    <div class="copa-liga-groups">${groups.map(clgGroupTableHtml).join('')}</div>
    <div class="copa-bracket">${semisHtml}${finalHtml}</div>`;

  wirePartidosTabBar();
  const btn = document.getElementById('sim-copa-liga-btn');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Simulando…';
      try {
        await api('/copa-liga/simulate-step', { method: 'POST' });
        const fresh = await api('/copa-liga');
        renderCopaLigaData(fresh);
      } catch (e) {
        alert('Error al simular: ' + e.message);
      }
    });
  }
}

const INTL_COMPETITION_ICON = { Libertadores: '🏆', Sudamericana: '🥈' };

function intlSlotRowHtml(q) {
  const club = clubById(q.club_id) || { name: q.club_name, crest_url: q.club_crest };
  const mine = state.highlightClubId === q.club_id;
  return `
    <div class="intl-slot ${mine ? 'intl-slot--mine' : ''}">
      <div class="intl-slot-head">
        <span class="intl-slot-number">${q.competition.slice(0, 3).toUpperCase()} ${q.slot_number}</span>
        <span class="intl-slot-stage">${escapeHtml(q.stage)}</span>
      </div>
      <div class="intl-slot-club">${crestImg(club, 24)} ${escapeHtml(club.short_name || club.name)}</div>
      <div class="intl-slot-path">${escapeHtml(q.qualification_path)}</div>
    </div>`;
}

async function renderInternationalView() {
  mainView.innerHTML = '<div class="empty-state">Cargando…</div>';
  try {
    const data = await api('/international');
    const { seasonYear, qualifications } = data;

    if (!seasonYear || !qualifications.length) {
      mainView.innerHTML = `
        <div class="view-header"><div><h1>🌎 Copas Internacionales</h1></div></div>
        <div class="empty-state">Todavía no hay clasificación generada: se calcula automáticamente al cerrar la
        primera temporada, usando los resultados del Campeonato Nacional, la Copa Chile y la Copa de la Liga.</div>`;
      return;
    }

    const libertadores = qualifications.filter((q) => q.competition === 'Libertadores').sort((a, b) => a.slot_number - b.slot_number);
    const sudamericana = qualifications.filter((q) => q.competition === 'Sudamericana').sort((a, b) => a.slot_number - b.slot_number);

    mainView.innerHTML = `
      <div class="view-header">
        <div>
          <h1>🌎 Copas Internacionales</h1>
          <div class="sub">Clasificación generada en la temporada ${seasonYear}, para las copas ${seasonYear + 1}</div>
        </div>
      </div>
      <div class="intl-note">
        Se muestran los clubes chilenos clasificados y en qué fase ingresan. Por ahora Pichanga 2026 no simula los
        partidos contra los clubes extranjeros de CONMEBOL.
      </div>
      <div class="intl-competition">
        <h3>🏆 Copa Libertadores</h3>
        <div class="intl-slots">${libertadores.map(intlSlotRowHtml).join('')}</div>
      </div>
      <div class="intl-competition">
        <h3>🥈 Copa Sudamericana</h3>
        <div class="intl-slots">${sudamericana.map(intlSlotRowHtml).join('')}</div>
      </div>`;
  } catch (e) {
    mainView.innerHTML = `<div class="empty-state">Error al cargar la clasificación internacional: ${escapeHtml(e.message)}</div>`;
  }
}
