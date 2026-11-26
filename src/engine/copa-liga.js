// Copa de la Liga: 4 grupos de 4 equipos de Primera A (todos contra todos,
// ida y vuelta), los 4 campeones de grupo pasan a semifinales ida y vuelta,
// y los 2 ganadores juegan una final a partido unico en sede neutral. El
// campeon obtiene el cupo Chile 3 de Copa Libertadores (fase previa); si el
// campeon ya esta clasificado por otra via, el cupo pasa al subcampeon.
const { generateRoundRobin } = require('./fixtures');
const { simulateMatch, decidePenalties } = require('./match');
const { recordMatchStats } = require('./finalize-match');

const GROUP_NAMES = ['A', 'B', 'C', 'D'];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function ensureCopaLigaDraw(db, seasonYear) {
  const existingRow = await db.prepare('SELECT COUNT(*) as c FROM copa_liga_groups WHERE season_year = ?').get(seasonYear);
  if (existingRow.c > 0) return;

  const clubRows = await db.prepare("SELECT id FROM clubs WHERE division = 'Primera A' AND active = 1").all();
  const clubs = shuffle(clubRows.map((c) => c.id));
  if (clubs.length < GROUP_NAMES.length * 2) return; // no hay suficientes equipos (caso degenerado)

  const insertGroup = db.prepare('INSERT INTO copa_liga_groups (season_year, group_name, club_id) VALUES (?, ?, ?)');
  const insertMatch = db.prepare(
    `INSERT INTO copa_liga_matches (season_year, stage, group_name, home_club_id, away_club_id) VALUES (?, 'grupos', ?, ?, ?)`
  );

  const perGroup = Math.floor(clubs.length / GROUP_NAMES.length);
  for (let gi = 0; gi < GROUP_NAMES.length; gi++) {
    const groupName = GROUP_NAMES[gi];
    const groupClubs = clubs.slice(gi * perGroup, gi * perGroup + perGroup);
    for (const clubId of groupClubs) await insertGroup.run(seasonYear, groupName, clubId);

    const rounds = generateRoundRobin(groupClubs);
    for (const round of rounds) {
      for (const [home, away] of round) await insertMatch.run(seasonYear, groupName, home, away);
    }
  }
}

async function getGroupClubs(db, seasonYear, groupName) {
  return db
    .prepare(
      `SELECT c.id as club_id, c.name, c.crest_url
       FROM copa_liga_groups g JOIN clubs c ON c.id = g.club_id
       WHERE g.season_year = ? AND g.group_name = ?`
    )
    .all(seasonYear, groupName);
}

async function getGroupStandings(db, seasonYear, groupName) {
  const clubs = await getGroupClubs(db, seasonYear, groupName);
  const table = new Map(
    clubs.map((c) => [c.club_id, { club_id: c.club_id, name: c.name, crest_url: c.crest_url, pj: 0, g: 0, e: 0, p: 0, gf: 0, gc: 0, dif: 0, pts: 0 }])
  );

  const played = await db
    .prepare(
      `SELECT * FROM copa_liga_matches WHERE season_year = ? AND stage = 'grupos' AND group_name = ? AND played = 1`
    )
    .all(seasonYear, groupName);

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

async function isGroupStageComplete(db, seasonYear) {
  const row = await db
    .prepare(`SELECT COUNT(*) as c FROM copa_liga_matches WHERE season_year = ? AND stage = 'grupos' AND played = 0`)
    .get(seasonYear);
  return row.c === 0;
}

async function playCopaLigaMatch(db, seasonYear, match, { allowPenalties }) {
  const homePlayers = await db
    .prepare("SELECT * FROM players WHERE club_id = ? AND status IN ('activo','lesionado')")
    .all(match.home_club_id);
  const awayPlayers = await db
    .prepare("SELECT * FROM players WHERE club_id = ? AND status IN ('activo','lesionado')")
    .all(match.away_club_id);

  const result = await simulateMatch(homePlayers, awayPlayers, {
    db,
    seasonYear,
    homeClubId: match.home_club_id,
    awayClubId: match.away_club_id,
  });

  let winnerClubId = null;
  let decidedByPenalties = 0;
  if (allowPenalties) {
    if (result.homeGoals !== result.awayGoals) {
      winnerClubId = result.homeGoals > result.awayGoals ? match.home_club_id : match.away_club_id;
    } else {
      decidedByPenalties = 1;
      const side = decidePenalties(result.homeStrength, result.awayStrength);
      winnerClubId = side === 'home' ? match.home_club_id : match.away_club_id;
    }
  }

  await db
    .prepare(
      `UPDATE copa_liga_matches SET home_goals = ?, away_goals = ?, played = 1, decided_by_penalties = ?, winner_club_id = ? WHERE id = ?`
    )
    .run(result.homeGoals, result.awayGoals, decidedByPenalties, winnerClubId, match.id);

  const progressHomeGoals = decidedByPenalties ? (winnerClubId === match.home_club_id ? 1 : 0) : result.homeGoals;
  const progressAwayGoals = decidedByPenalties ? (winnerClubId === match.away_club_id ? 1 : 0) : result.awayGoals;
  await recordMatchStats(db, seasonYear, match.home_club_id, match.away_club_id, {
    homeGoals: progressHomeGoals,
    awayGoals: progressAwayGoals,
    homeLineup: result.homeLineup,
    awayLineup: result.awayLineup,
    events: result.events,
  });

  return { ...match, home_goals: result.homeGoals, away_goals: result.awayGoals, played: 1, winner_club_id: winnerClubId, decided_by_penalties: decidedByPenalties };
}

async function simulateGroupStage(db, seasonYear) {
  const pending = await db
    .prepare(`SELECT * FROM copa_liga_matches WHERE season_year = ? AND stage = 'grupos' AND played = 0`)
    .all(seasonYear);
  if (!pending.length) return [];

  const results = [];
  const tx = await db.transaction('write');
  try {
    for (const m of pending) results.push(await playCopaLigaMatch(tx, seasonYear, m, { allowPenalties: false }));
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  return results;
}

async function getGroupWinner(db, seasonYear, groupName) {
  const standings = await getGroupStandings(db, seasonYear, groupName);
  return standings.length ? standings[0].club_id : null;
}

// Crea las semifinales (ida y vuelta) una vez que los 4 grupos terminaron,
// emparejando a los campeones de grupo de forma aleatoria. Idempotente.
async function ensureSemifinals(db, seasonYear) {
  const existingRow = await db
    .prepare(`SELECT COUNT(*) as c FROM copa_liga_matches WHERE season_year = ? AND stage = 'semifinal'`)
    .get(seasonYear);
  if (existingRow.c > 0) return;
  if (!(await isGroupStageComplete(db, seasonYear))) return;

  const winners = [];
  for (const g of GROUP_NAMES) {
    const w = await getGroupWinner(db, seasonYear, g);
    if (w != null) winners.push(w);
  }
  if (winners.length < 4) return;

  const shuffled = shuffle(winners);
  const insert = db.prepare(
    `INSERT INTO copa_liga_matches (season_year, stage, tie_slot, leg, home_club_id, away_club_id) VALUES (?, 'semifinal', ?, ?, ?, ?)`
  );
  for (let tie = 0; tie < 2; tie++) {
    const home = shuffled[tie * 2];
    const away = shuffled[tie * 2 + 1];
    await insert.run(seasonYear, tie, 1, home, away); // ida
    await insert.run(seasonYear, tie, 2, away, home); // vuelta (localia invertida)
  }
}

async function isSemifinalStageComplete(db, seasonYear) {
  const row = await db
    .prepare(`SELECT COUNT(*) as c FROM copa_liga_matches WHERE season_year = ? AND stage = 'semifinal' AND played = 0`)
    .get(seasonYear);
  const total = await db
    .prepare(`SELECT COUNT(*) as c FROM copa_liga_matches WHERE season_year = ? AND stage = 'semifinal'`)
    .get(seasonYear);
  return total.c > 0 && row.c === 0;
}

// Juega la siguiente pata de semifinal pendiente (una por llamada, para poder
// resolver el agregado tie por tie una vez jugadas ambas patas).
async function simulateNextSemifinalLeg(db, seasonYear) {
  const next = await db
    .prepare(
      `SELECT * FROM copa_liga_matches WHERE season_year = ? AND stage = 'semifinal' AND played = 0 ORDER BY tie_slot, leg LIMIT 1`
    )
    .get(seasonYear);
  if (!next) return null;
  // Las patas de ida nunca se definen por penales (solo cuenta el agregado).
  return playCopaLigaMatch(db, seasonYear, next, { allowPenalties: false });
}

// Resuelve el ganador de un cruce de semifinal por marcador global una vez
// jugadas ambas patas; si hay igualdad agregada, se define por penales.
async function resolveSemifinalTie(db, seasonYear, tieSlot) {
  const legs = await db
    .prepare(`SELECT * FROM copa_liga_matches WHERE season_year = ? AND stage = 'semifinal' AND tie_slot = ? ORDER BY leg`)
    .all(seasonYear, tieSlot);
  if (legs.length < 2 || legs.some((l) => !l.played)) return null;

  const [leg1, leg2] = legs;
  // leg1: home=A, away=B. leg2: home=B, away=A (localia invertida).
  const teamA = leg1.home_club_id;
  const teamB = leg1.away_club_id;
  const aggA = leg1.home_goals + leg2.away_goals;
  const aggB = leg1.away_goals + leg2.home_goals;

  let winnerClubId;
  let decidedByPenalties = 0;
  if (aggA !== aggB) {
    winnerClubId = aggA > aggB ? teamA : teamB;
  } else {
    decidedByPenalties = 1;
    const side = decidePenalties(50, 50); // sin ventaja deportiva adicional en el agregado
    winnerClubId = side === 'home' ? teamA : teamB;
  }

  if (decidedByPenalties) {
    await db.prepare(`UPDATE copa_liga_matches SET decided_by_penalties = 1 WHERE id = ?`).run(leg2.id);
  }

  return { tieSlot, teamA, teamB, aggA, aggB, winnerClubId, decidedByPenalties };
}

async function getSemifinalResults(db, seasonYear) {
  const results = [];
  for (let tie = 0; tie < 2; tie++) {
    const r = await resolveSemifinalTie(db, seasonYear, tie);
    if (r) results.push(r);
  }
  return results;
}

// Crea la final (partido unico, sede neutral) una vez resueltas ambas
// semifinales. Idempotente.
async function ensureFinal(db, seasonYear) {
  const existingRow = await db
    .prepare(`SELECT COUNT(*) as c FROM copa_liga_matches WHERE season_year = ? AND stage = 'final'`)
    .get(seasonYear);
  if (existingRow.c > 0) return;
  if (!(await isSemifinalStageComplete(db, seasonYear))) return;

  const semis = await getSemifinalResults(db, seasonYear);
  if (semis.length < 2) return;

  await db
    .prepare(`INSERT INTO copa_liga_matches (season_year, stage, home_club_id, away_club_id) VALUES (?, 'final', ?, ?)`)
    .run(seasonYear, semis[0].winnerClubId, semis[1].winnerClubId);
}

async function isCopaLigaComplete(db, seasonYear) {
  const final = await db
    .prepare(`SELECT played FROM copa_liga_matches WHERE season_year = ? AND stage = 'final'`)
    .get(seasonYear);
  return !!final && final.played === 1;
}

// Avanza el torneo lo que se pueda en un solo paso: termina grupos, arma y
// juega semifinales (pata por pata), arma y juega la final. Se puede llamar
// repetidamente hasta que isCopaLigaComplete devuelva true.
async function advanceCopaLiga(db, seasonYear) {
  await ensureCopaLigaDraw(db, seasonYear);

  if (!(await isGroupStageComplete(db, seasonYear))) {
    return { stage: 'grupos', matches: await simulateGroupStage(db, seasonYear) };
  }

  await ensureSemifinals(db, seasonYear);
  if (!(await isSemifinalStageComplete(db, seasonYear))) {
    const leg = await simulateNextSemifinalLeg(db, seasonYear);
    return { stage: 'semifinal', matches: leg ? [leg] : [] };
  }

  await ensureFinal(db, seasonYear);
  const final = await db.prepare(`SELECT * FROM copa_liga_matches WHERE season_year = ? AND stage = 'final'`).get(seasonYear);
  if (final && !final.played) {
    const played = await playCopaLigaMatch(db, seasonYear, final, { allowPenalties: true });
    return { stage: 'final', matches: [played] };
  }

  return { stage: 'completa', matches: [] };
}

async function simulateRemainingCopaLiga(db, seasonYear) {
  const steps = [];
  let guard = 0;
  while (!(await isCopaLigaComplete(db, seasonYear)) && guard < 200) {
    const step = await advanceCopaLiga(db, seasonYear);
    steps.push(step);
    if (step.stage === 'completa') break;
    guard++;
  }
  return steps;
}

async function getCopaLigaFinalists(db, seasonYear) {
  const final = await db
    .prepare(`SELECT * FROM copa_liga_matches WHERE season_year = ? AND stage = 'final' AND played = 1`)
    .get(seasonYear);
  if (!final) return null;
  const loserId = final.winner_club_id === final.home_club_id ? final.away_club_id : final.home_club_id;
  return { championId: final.winner_club_id, runnerUpId: loserId };
}

async function getCopaLigaChampion(db, seasonYear) {
  const finalists = await getCopaLigaFinalists(db, seasonYear);
  if (!finalists) return null;
  const club = await db.prepare('SELECT name FROM clubs WHERE id = ?').get(finalists.championId);
  return club ? club.name : null;
}

module.exports = {
  GROUP_NAMES,
  ensureCopaLigaDraw,
  getGroupClubs,
  getGroupStandings,
  isGroupStageComplete,
  simulateGroupStage,
  playCopaLigaMatch,
  ensureSemifinals,
  getSemifinalResults,
  isSemifinalStageComplete,
  ensureFinal,
  isCopaLigaComplete,
  advanceCopaLiga,
  simulateRemainingCopaLiga,
  getCopaLigaFinalists,
  getCopaLigaChampion,
};
