// Copa Chile: eliminacion directa con los 32 clubes de Primera A y B,
// sorteada al inicio de temporada. Empates se definen por penales.
const { simulateMatch, decidePenalties, teamStrength, pickLineup } = require('./match');
const { recordMatchStats } = require('./finalize-match');

const ROUND_NAMES = ['Fase 1', 'Octavos de final', 'Cuartos de final', 'Semifinal', 'Final'];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function generateCopaDraw(db, seasonYear) {
  const existingRow = await db.prepare('SELECT COUNT(*) as c FROM copa_matches WHERE season_year = ?').get(seasonYear);
  if (existingRow.c > 0) return;

  const clubRows = await db.prepare('SELECT id FROM clubs WHERE active = 1').all();
  const clubs = shuffle(clubRows.map((c) => c.id));
  const insert = db.prepare(
    `INSERT INTO copa_matches (season_year, round_name, round_order, slot, home_club_id, away_club_id)
     VALUES (?, ?, 0, ?, ?, ?)`
  );
  for (let i = 0; i < clubs.length / 2; i++) {
    await insert.run(seasonYear, ROUND_NAMES[0], i, clubs[i * 2], clubs[i * 2 + 1]);
  }
}

async function getBracket(db, seasonYear) {
  const rows = await db
    .prepare(
      `SELECT cm.*, hc.name as home_name, hc.crest_url as home_crest, ac.name as away_name, ac.crest_url as away_crest,
              wc.name as winner_name
       FROM copa_matches cm
       LEFT JOIN clubs hc ON hc.id = cm.home_club_id
       LEFT JOIN clubs ac ON ac.id = cm.away_club_id
       LEFT JOIN clubs wc ON wc.id = cm.winner_club_id
       WHERE cm.season_year = ?
       ORDER BY cm.round_order, cm.slot`
    )
    .all(seasonYear);

  const rounds = [];
  for (const row of rows) {
    if (!rounds[row.round_order]) rounds[row.round_order] = { round_name: row.round_name, matches: [] };
    rounds[row.round_order].matches.push(row);
  }
  return rounds.filter(Boolean);
}

async function isCopaComplete(db, seasonYear) {
  const row = await db
    .prepare('SELECT round_name FROM copa_matches WHERE season_year = ? ORDER BY round_order DESC LIMIT 1')
    .get(seasonYear);
  if (!row) return false;
  if (row.round_name !== ROUND_NAMES[ROUND_NAMES.length - 1]) return false;
  const pendingRow = await db
    .prepare('SELECT COUNT(*) as c FROM copa_matches WHERE season_year = ? AND played = 0')
    .get(seasonYear);
  return pendingRow.c === 0;
}

async function playCopaMatch(db, seasonYear, match) {
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

  await db
    .prepare(
      `UPDATE copa_matches SET home_goals = ?, away_goals = ?, played = 1, decided_by_penalties = ?, winner_club_id = ? WHERE id = ?`
    )
    .run(result.homeGoals, result.awayGoals, decidedByPenalties, winnerClubId, match.id);

  // Para la progresion de rating, un triunfo en penales cuenta como victoria/derrota
  // (aunque el marcador oficial registrado en la base de datos quede empatado).
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

async function simulateNextCopaRound(db, seasonYear) {
  const pending = await db
    .prepare('SELECT * FROM copa_matches WHERE season_year = ? AND played = 0 ORDER BY round_order, slot')
    .all(seasonYear);
  if (!pending.length) return null;

  const roundOrder = pending[0].round_order;
  const roundMatches = pending.filter((m) => m.round_order === roundOrder);
  const results = [];

  const tx = await db.transaction('write');
  try {
    for (const m of roundMatches) {
      results.push(await playCopaMatch(tx, seasonYear, m));
    }

    const nextRoundOrder = roundOrder + 1;
    if (ROUND_NAMES[nextRoundOrder]) {
      const winners = results.sort((a, b) => a.slot - b.slot).map((m) => m.winner_club_id);
      const insert = tx.prepare(
        `INSERT INTO copa_matches (season_year, round_name, round_order, slot, home_club_id, away_club_id) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (let i = 0; i < winners.length / 2; i++) {
        await insert.run(seasonYear, ROUND_NAMES[nextRoundOrder], nextRoundOrder, i, winners[i * 2], winners[i * 2 + 1]);
      }
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return { round_name: ROUND_NAMES[roundOrder], matches: results };
}

async function simulateRemainingCopa(db, seasonYear) {
  const rounds = [];
  let round;
  while ((round = await simulateNextCopaRound(db, seasonYear))) rounds.push(round);
  return rounds;
}

async function getCopaChampion(db, seasonYear) {
  const final = await db
    .prepare("SELECT * FROM copa_matches WHERE season_year = ? AND round_name = ? AND played = 1")
    .get(seasonYear, ROUND_NAMES[ROUND_NAMES.length - 1]);
  if (!final) return null;
  const club = await db.prepare('SELECT name FROM clubs WHERE id = ?').get(final.winner_club_id);
  return club ? club.name : null;
}

module.exports = {
  ROUND_NAMES,
  generateCopaDraw,
  getBracket,
  isCopaComplete,
  simulateNextCopaRound,
  simulateRemainingCopa,
  playCopaMatch,
  getCopaChampion,
};
