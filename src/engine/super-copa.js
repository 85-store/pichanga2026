// Supercopa: torneo de 4 equipos jugado al inicio de la temporada con los
// campeones de la temporada anterior -
//   Semifinal 1: campeon de Primera A vs campeon de Copa de la Liga
//   Semifinal 2: campeon de Copa Chile vs subcampeon de Primera A
//   Final: los 2 ganadores, en partido neutro (sin ventaja de localia extra)
const { simulateMatch, decidePenalties } = require('./match');
const { recordMatchStats } = require('./finalize-match');
const { tickInjuriesOneWeek } = require('./injuries');
const { getCopaLigaFinalists } = require('./copa-liga');

async function titleChampion(db, seasonYear, titleName) {
  const row = await db
    .prepare('SELECT club_id FROM club_titles WHERE season_year = ? AND title_name = ? ORDER BY id DESC LIMIT 1')
    .get(seasonYear, titleName);
  return row ? row.club_id : null;
}

// Junta los 4 clasificados a la Supercopa de seasonYear, todos salidos de la
// temporada anterior. Devuelve null si falta alguno (ej. primera temporada
// del juego, o alguna competicion de la temporada anterior nunca se cerro).
async function getQualifiers(db, seasonYear) {
  const previousYear = seasonYear - 1;
  const leagueChamp = await titleChampion(db, previousYear, 'Campeón Primera A');
  const leagueRunnerUp = await titleChampion(db, previousYear, 'Subcampeón Primera A');
  const copaChileChamp = await titleChampion(db, previousYear, 'Campeón Copa Chile');
  const copaLigaFinalists = await getCopaLigaFinalists(db, previousYear);
  const copaLigaChamp = copaLigaFinalists ? copaLigaFinalists.championId : null;
  if (!leagueChamp || !leagueRunnerUp || !copaChileChamp || !copaLigaChamp) return null;
  return { leagueChamp, leagueRunnerUp, copaChileChamp, copaLigaChamp };
}

async function insertStageMatch(db, seasonYear, stage, homeClubId, awayClubId) {
  if (homeClubId === awayClubId) {
    // Mismo club clasificado dos veces a la misma llave (ej. gano la liga y
    // tambien la Copa de la Liga): pasa directo, no hay partido que jugar.
    await db
      .prepare(
        `INSERT INTO super_copa_matches (season_year, stage, home_club_id, away_club_id, played, winner_club_id, skipped_reason) VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
      .run(seasonYear, stage, homeClubId, awayClubId, homeClubId, 'mismo_campeon');
    return;
  }
  await db
    .prepare(`INSERT INTO super_copa_matches (season_year, stage, home_club_id, away_club_id) VALUES (?, ?, ?, ?)`)
    .run(seasonYear, stage, homeClubId, awayClubId);
}

// Crea (si corresponde) las 2 semifinales de seasonYear. No hace nada si ya
// existen o si todavia no estan los 4 clasificados de la temporada anterior.
async function ensureSuperCopaSemis(db, seasonYear) {
  const existing = await db
    .prepare(`SELECT COUNT(*) as c FROM super_copa_matches WHERE season_year = ? AND stage IN ('semifinal1', 'semifinal2')`)
    .get(seasonYear);
  if (existing.c > 0) return;

  const qualifiers = await getQualifiers(db, seasonYear);
  if (!qualifiers) return;

  await insertStageMatch(db, seasonYear, 'semifinal1', qualifiers.leagueChamp, qualifiers.copaLigaChamp);
  await insertStageMatch(db, seasonYear, 'semifinal2', qualifiers.copaChileChamp, qualifiers.leagueRunnerUp);
}

async function isSemisComplete(db, seasonYear) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as c FROM super_copa_matches WHERE season_year = ? AND stage IN ('semifinal1', 'semifinal2') AND played = 0`
    )
    .get(seasonYear);
  const total = await db
    .prepare(`SELECT COUNT(*) as c FROM super_copa_matches WHERE season_year = ? AND stage IN ('semifinal1', 'semifinal2')`)
    .get(seasonYear);
  return total.c === 2 && row.c === 0;
}

// Crea (si corresponde) la final, una vez jugadas ambas semifinales.
async function ensureSuperCopaFinal(db, seasonYear) {
  const existingRow = await db
    .prepare(`SELECT COUNT(*) as c FROM super_copa_matches WHERE season_year = ? AND stage = 'final'`)
    .get(seasonYear);
  if (existingRow.c > 0) return;
  if (!(await isSemisComplete(db, seasonYear))) return;

  const semis = await db
    .prepare(`SELECT stage, winner_club_id FROM super_copa_matches WHERE season_year = ? AND stage IN ('semifinal1', 'semifinal2')`)
    .all(seasonYear);
  const semi1 = semis.find((s) => s.stage === 'semifinal1');
  const semi2 = semis.find((s) => s.stage === 'semifinal2');
  if (!semi1 || !semi2 || !semi1.winner_club_id || !semi2.winner_club_id) return;

  await insertStageMatch(db, seasonYear, 'final', semi1.winner_club_id, semi2.winner_club_id);
}

async function getSuperCopa(db, seasonYear) {
  const rows = await db
    .prepare(
      `SELECT sc.*, hc.name as home_name, hc.crest_url as home_crest, hc.short_name as home_short,
              ac.name as away_name, ac.crest_url as away_crest, ac.short_name as away_short,
              wc.name as winner_name
       FROM super_copa_matches sc
       LEFT JOIN clubs hc ON hc.id = sc.home_club_id
       LEFT JOIN clubs ac ON ac.id = sc.away_club_id
       LEFT JOIN clubs wc ON wc.id = sc.winner_club_id
       WHERE sc.season_year = ?
       ORDER BY CASE sc.stage WHEN 'semifinal1' THEN 1 WHEN 'semifinal2' THEN 2 ELSE 3 END`
    )
    .all(seasonYear);
  return {
    semifinal1: rows.find((r) => r.stage === 'semifinal1') || null,
    semifinal2: rows.find((r) => r.stage === 'semifinal2') || null,
    final: rows.find((r) => r.stage === 'final') || null,
  };
}

async function isSuperCopaComplete(db, seasonYear) {
  const final = await db.prepare(`SELECT played FROM super_copa_matches WHERE season_year = ? AND stage = 'final'`).get(seasonYear);
  return !!final && final.played === 1;
}

async function isSuperCopaPending(db, seasonYear) {
  const { semifinal1, semifinal2, final } = await getSuperCopa(db, seasonYear);
  if (!semifinal1 || !semifinal2) return false;
  if (!semifinal1.played || !semifinal2.played) return true;
  return !!final && !final.played;
}

async function playSuperCopaMatch(db, seasonYear, match) {
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
  let winnerClubId;
  let decidedByPenalties = 0;
  if (result.homeGoals !== result.awayGoals) {
    winnerClubId = result.homeGoals > result.awayGoals ? match.home_club_id : match.away_club_id;
  } else {
    decidedByPenalties = 1;
    const side = decidePenalties(result.homeStrength, result.awayStrength);
    winnerClubId = side === 'home' ? match.home_club_id : match.away_club_id;
  }

  await db.prepare(
    `UPDATE super_copa_matches SET home_goals = ?, away_goals = ?, played = 1, decided_by_penalties = ?, winner_club_id = ? WHERE id = ?`
  ).run(result.homeGoals, result.awayGoals, decidedByPenalties, winnerClubId, match.id);

  const progressHomeGoals = decidedByPenalties ? (winnerClubId === match.home_club_id ? 1 : 0) : result.homeGoals;
  const progressAwayGoals = decidedByPenalties ? (winnerClubId === match.away_club_id ? 1 : 0) : result.awayGoals;
  await recordMatchStats(db, seasonYear, match.home_club_id, match.away_club_id, {
    homeGoals: progressHomeGoals,
    awayGoals: progressAwayGoals,
    homeLineup: result.homeLineup,
    awayLineup: result.awayLineup,
    events: result.events,
  });

  if (match.stage === 'final') {
    await db.prepare(`INSERT INTO club_titles (club_id, season_year, title_name) VALUES (?, ?, ?)`).run(
      winnerClubId,
      seasonYear,
      'Campeón Supercopa'
    );
  }

  await tickInjuriesOneWeek(db, seasonYear);

  return { ...match, winner_club_id: winnerClubId, decided_by_penalties: decidedByPenalties };
}

// Idempotente: crea el cruce de Supercopa de seasonYear si corresponde (misma
// funcion de siempre, mantenida por compatibilidad con ensureSeasonCompetitions).
async function ensureSuperCopa(db, seasonYear) {
  await ensureSuperCopaSemis(db, seasonYear);
}

// Avanza la Supercopa lo que se pueda en un solo paso: crea semifinales, juega
// la siguiente semifinal pendiente, crea la final, juega la final. Se puede
// llamar repetidamente hasta que isSuperCopaComplete devuelva true.
async function advanceSuperCopa(db, seasonYear) {
  await ensureSuperCopaSemis(db, seasonYear);

  const nextSemi = await db
    .prepare(`SELECT * FROM super_copa_matches WHERE season_year = ? AND stage IN ('semifinal1', 'semifinal2') AND played = 0 ORDER BY stage LIMIT 1`)
    .get(seasonYear);
  if (nextSemi) {
    const played = await playSuperCopaMatch(db, seasonYear, nextSemi);
    return { stage: nextSemi.stage, matches: [played] };
  }
  if (!(await isSemisComplete(db, seasonYear))) {
    return { stage: 'sin_datos', matches: [] };
  }

  await ensureSuperCopaFinal(db, seasonYear);
  const final = await db.prepare(`SELECT * FROM super_copa_matches WHERE season_year = ? AND stage = 'final'`).get(seasonYear);
  if (final && !final.played) {
    const played = await playSuperCopaMatch(db, seasonYear, final);
    return { stage: 'final', matches: [played] };
  }

  return { stage: 'completa', matches: [] };
}

async function simulateRemainingSuperCopa(db, seasonYear) {
  const steps = [];
  let guard = 0;
  while (!(await isSuperCopaComplete(db, seasonYear)) && guard < 20) {
    const step = await advanceSuperCopa(db, seasonYear);
    steps.push(step);
    if (step.stage === 'completa' || step.stage === 'sin_datos') break;
    guard++;
  }
  return steps;
}

// Resuelve de punta a punta la Supercopa de seasonYear si hay algo pendiente
// (usado al cerrar la temporada, para no dejar nada sin jugar). Devuelve el
// resultado de la final (con winner_club_id) o null si no hubo Supercopa esta
// temporada (ej. primera temporada del juego) o ya estaba completa.
async function playSuperCopaIfPending(db, seasonYear) {
  await simulateRemainingSuperCopa(db, seasonYear);
  const final = await db.prepare(`SELECT * FROM super_copa_matches WHERE season_year = ? AND stage = 'final'`).get(seasonYear);
  if (!final || !final.played) return null;
  return final;
}

module.exports = {
  ensureSuperCopa,
  ensureSuperCopaSemis,
  ensureSuperCopaFinal,
  getSuperCopa,
  isSuperCopaPending,
  isSuperCopaComplete,
  playSuperCopaMatch,
  playSuperCopaIfPending,
  advanceSuperCopa,
  simulateRemainingSuperCopa,
};
