// Motor de liga: calendario, simulacion de jornadas, tabla de posiciones y
// ascenso/descenso real entre Primera A y Primera B al cerrar la temporada.
const { generateRoundRobin } = require('./fixtures');
const { simulateMatch } = require('./match');
const { recordMatchStats } = require('./finalize-match');

const DIVISIONS = ['Primera A', 'Primera B'];
const RELEGATION_SPOTS = 2; // ultimos 2 de Primera A descienden
const PROMOTION_SPOTS = 2; // primeros 2 de Primera B ascienden

async function generateSeasonFixtures(db, seasonYear) {
  for (const division of DIVISIONS) {
    const existingRow = await db
      .prepare('SELECT COUNT(*) as c FROM fixtures WHERE season_year = ? AND division = ?')
      .get(seasonYear, division);
    if (existingRow.c > 0) continue;

    const clubRows = await db.prepare('SELECT id FROM clubs WHERE division = ? AND active = 1 ORDER BY id').all(division);
    const clubs = clubRows.map((c) => c.id);
    if (clubs.length < 2) continue;

    const rounds = generateRoundRobin(clubs);
    const insert = db.prepare(
      `INSERT INTO fixtures (season_year, division, jornada, home_club_id, away_club_id) VALUES (?, ?, ?, ?, ?)`
    );
    for (let idx = 0; idx < rounds.length; idx++) {
      for (const [home, away] of rounds[idx]) {
        await insert.run(seasonYear, division, idx + 1, home, away);
      }
    }
  }
}

async function getStandings(db, seasonYear, division) {
  const clubs = await db.prepare('SELECT id, name, crest_url FROM clubs WHERE division = ? AND active = 1').all(division);
  const table = new Map(
    clubs.map((c) => [
      c.id,
      { club_id: c.id, name: c.name, crest_url: c.crest_url, pj: 0, g: 0, e: 0, p: 0, gf: 0, gc: 0, dif: 0, pts: 0 },
    ])
  );

  const played = await db
    .prepare('SELECT * FROM fixtures WHERE season_year = ? AND division = ? AND played = 1')
    .all(seasonYear, division);

  for (const m of played) {
    const home = table.get(m.home_club_id);
    const away = table.get(m.away_club_id);
    if (!home || !away) continue;
    home.pj++; away.pj++;
    home.gf += m.home_goals; home.gc += m.away_goals;
    away.gf += m.away_goals; away.gc += m.home_goals;
    if (m.home_goals > m.away_goals) { home.g++; home.pts += 3; away.p++; }
    else if (m.home_goals < m.away_goals) { away.g++; away.pts += 3; home.p++; }
    else { home.e++; away.e++; home.pts++; away.pts++; }
  }

  const rows = [...table.values()];
  for (const r of rows) r.dif = r.gf - r.gc;
  rows.sort((a, b) => b.pts - a.pts || b.dif - a.dif || b.gf - a.gf || a.name.localeCompare(b.name));
  return rows;
}

async function getNextJornada(db, seasonYear, division) {
  const row = await db
    .prepare(`SELECT MIN(jornada) as j FROM fixtures WHERE season_year = ? AND division = ? AND played = 0`)
    .get(seasonYear, division);
  return row ? row.j : null;
}

async function totalJornadas(db, seasonYear, division) {
  const row = await db
    .prepare('SELECT MAX(jornada) as j FROM fixtures WHERE season_year = ? AND division = ?')
    .get(seasonYear, division);
  return row ? row.j : 0;
}

async function playMatch(db, seasonYear, fixtureId, homeClubId, awayClubId) {
  const homePlayers = await db
    .prepare("SELECT * FROM players WHERE club_id = ? AND status IN ('activo','lesionado')")
    .all(homeClubId);
  const awayPlayers = await db
    .prepare("SELECT * FROM players WHERE club_id = ? AND status IN ('activo','lesionado')")
    .all(awayClubId);

  const result = await simulateMatch(homePlayers, awayPlayers, { db, seasonYear, homeClubId, awayClubId });

  await db.prepare('UPDATE fixtures SET home_goals = ?, away_goals = ?, played = 1 WHERE id = ?').run(
    result.homeGoals,
    result.awayGoals,
    fixtureId
  );

  await recordMatchStats(db, seasonYear, homeClubId, awayClubId, {
    homeGoals: result.homeGoals,
    awayGoals: result.awayGoals,
    homeLineup: result.homeLineup,
    awayLineup: result.awayLineup,
    events: result.events,
  });

  return { fixtureId, homeClubId, awayClubId, homeGoals: result.homeGoals, awayGoals: result.awayGoals };
}

async function simulateJornada(db, seasonYear) {
  const results = { jornada: null, matches: [] };
  const tx = await db.transaction('write');
  try {
    for (const division of DIVISIONS) {
      const jornada = await getNextJornada(tx, seasonYear, division);
      if (jornada == null) continue;
      if (results.jornada == null) results.jornada = jornada;
      const fixtures = await tx
        .prepare('SELECT * FROM fixtures WHERE season_year = ? AND division = ? AND jornada = ?')
        .all(seasonYear, division, jornada);
      for (const f of fixtures) {
        const match = await playMatch(tx, seasonYear, f.id, f.home_club_id, f.away_club_id);
        results.matches.push({ ...match, division, jornada });
      }
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  return results;
}

async function isLeagueComplete(db, seasonYear) {
  for (const division of DIVISIONS) {
    if ((await getNextJornada(db, seasonYear, division)) != null) return false;
  }
  return true;
}

async function simulateRemainingLeague(db, seasonYear) {
  const all = { jornadas: [] };
  while (!(await isLeagueComplete(db, seasonYear))) {
    all.jornadas.push(await simulateJornada(db, seasonYear));
  }
  return all;
}

// Aplica ascenso/descenso real: ultimos 2 de Primera A bajan, primeros 2 de
// Primera B suben, e inscribe el campeon de cada division en club_titles.
async function applyPromotionRelegation(db, seasonYear) {
  const tableA = await getStandings(db, seasonYear, 'Primera A');
  const tableB = await getStandings(db, seasonYear, 'Primera B');

  const events = { champion: null, relegated: [], promoted: [] };

  if (tableA.length) {
    await db.prepare(`INSERT INTO club_titles (club_id, season_year, title_name) VALUES (?, ?, ?)`).run(
      tableA[0].club_id,
      seasonYear,
      'Campeón Primera A'
    );
    events.champion = tableA[0].name;
  }

  const toRelegate = tableA.slice(-RELEGATION_SPOTS);
  const toPromote = tableB.slice(0, PROMOTION_SPOTS);

  for (const row of toRelegate) {
    await db.prepare("UPDATE clubs SET division = 'Primera B' WHERE id = ?").run(row.club_id);
    events.relegated.push(row.name);
  }
  for (const row of toPromote) {
    await db.prepare("UPDATE clubs SET division = 'Primera A' WHERE id = ?").run(row.club_id);
    events.promoted.push(row.name);
  }

  return events;
}

module.exports = {
  DIVISIONS,
  generateSeasonFixtures,
  getStandings,
  getNextJornada,
  totalJornadas,
  simulateJornada,
  playMatch,
  isLeagueComplete,
  simulateRemainingLeague,
  applyPromotionRelegation,
};
