// Supercopa: partido unico entre el campeon de Primera A y el campeon de Copa
// Chile de la temporada anterior, jugado al inicio de la nueva temporada.
const { simulateMatch, decidePenalties } = require('./match');
const { recordMatchStats } = require('./finalize-match');
const { tickInjuriesOneWeek } = require('./injuries');

async function titleChampion(db, seasonYear, titleName) {
  const row = await db
    .prepare('SELECT club_id FROM club_titles WHERE season_year = ? AND title_name = ? ORDER BY id DESC LIMIT 1')
    .get(seasonYear, titleName);
  return row ? row.club_id : null;
}

// Crea (si corresponde) el cruce de Supercopa para seasonYear, usando los
// campeones de la temporada anterior. No hace nada si ya existe o si todavia
// no hay ambos titulos registrados (ej. primera temporada del juego).
async function ensureSuperCopa(db, seasonYear) {
  const existing = await db.prepare('SELECT id FROM super_copa_matches WHERE season_year = ?').get(seasonYear);
  if (existing) return;

  const previousYear = seasonYear - 1;
  const leagueChamp = await titleChampion(db, previousYear, 'Campeón Primera A');
  const copaChamp = await titleChampion(db, previousYear, 'Campeón Copa Chile');
  if (!leagueChamp || !copaChamp) return;

  if (leagueChamp === copaChamp) {
    await db.prepare(
      `INSERT INTO super_copa_matches (season_year, home_club_id, away_club_id, played, skipped_reason) VALUES (?, ?, ?, 1, ?)`
    ).run(seasonYear, leagueChamp, copaChamp, 'mismo_campeon');
    return;
  }

  await db.prepare(`INSERT INTO super_copa_matches (season_year, home_club_id, away_club_id) VALUES (?, ?, ?)`).run(
    seasonYear,
    leagueChamp,
    copaChamp
  );
}

async function getSuperCopa(db, seasonYear) {
  const row = await db
    .prepare(
      `SELECT sc.*, hc.name as home_name, hc.crest_url as home_crest, hc.short_name as home_short,
              ac.name as away_name, ac.crest_url as away_crest, ac.short_name as away_short,
              wc.name as winner_name
       FROM super_copa_matches sc
       LEFT JOIN clubs hc ON hc.id = sc.home_club_id
       LEFT JOIN clubs ac ON ac.id = sc.away_club_id
       LEFT JOIN clubs wc ON wc.id = sc.winner_club_id
       WHERE sc.season_year = ?`
    )
    .get(seasonYear);
  return row || null;
}

async function isSuperCopaPending(db, seasonYear) {
  const row = await getSuperCopa(db, seasonYear);
  return !!row && !row.played;
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

  await db.prepare(`INSERT INTO club_titles (club_id, season_year, title_name) VALUES (?, ?, ?)`).run(
    winnerClubId,
    seasonYear,
    'Campeón Supercopa'
  );

  await tickInjuriesOneWeek(db, seasonYear);

  return { ...match, winner_club_id: winnerClubId, decided_by_penalties: decidedByPenalties };
}

async function playSuperCopaIfPending(db, seasonYear) {
  const match = await db.prepare('SELECT * FROM super_copa_matches WHERE season_year = ? AND played = 0').get(seasonYear);
  if (!match) return null;
  return playSuperCopaMatch(db, seasonYear, match);
}

module.exports = { ensureSuperCopa, getSuperCopa, isSuperCopaPending, playSuperCopaMatch, playSuperCopaIfPending };
