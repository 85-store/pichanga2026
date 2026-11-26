// Registro de estadisticas de temporada y progresion de rating compartido por
// todos los motores que resuelven un partido (liga, copa y el partido en vivo),
// para que las tres vias dejen exactamente el mismo rastro en la base de datos.
const { applyPerformanceProgress } = require('./rating-progress');
const { ageInSeason } = require('./age');
const { onMatchFinished, moraleProgressModifier } = require('./career-events');
const { onMatchFinishedMedia } = require('./media');

async function recordStat(db, seasonYear, player, clubId, field) {
  await db
    .prepare(
      `INSERT INTO player_season_stats (player_id, season_year, club_id, matches_played, goals, assists, yellow_cards, red_cards)
     VALUES (?, ?, ?, 0, 0, 0, 0, 0)
     ON CONFLICT(player_id, season_year) DO NOTHING`
    )
    .run(player.id, seasonYear, clubId);
  if (field) {
    await db
      .prepare(`UPDATE player_season_stats SET ${field} = ${field} + 1 WHERE player_id = ? AND season_year = ?`)
      .run(player.id, seasonYear);
  }
}

// result: { homeGoals, awayGoals, homeLineup, awayLineup, events: { homeScorers, awayScorers, cards } }
// homeLineup/awayLineup: todos los jugadores que participaron (titulares + que entraron de cambio).
async function recordMatchStats(db, seasonYear, homeClubId, awayClubId, result) {
  for (const p of result.homeLineup) await recordStat(db, seasonYear, p, homeClubId, 'matches_played');
  for (const p of result.awayLineup) await recordStat(db, seasonYear, p, awayClubId, 'matches_played');
  for (const { scorer, assister } of result.events.homeScorers) {
    await recordStat(db, seasonYear, scorer, homeClubId, 'goals');
    if (assister) await recordStat(db, seasonYear, assister, homeClubId, 'assists');
  }
  for (const { scorer, assister } of result.events.awayScorers) {
    await recordStat(db, seasonYear, scorer, awayClubId, 'goals');
    if (assister) await recordStat(db, seasonYear, assister, awayClubId, 'assists');
  }
  for (const card of result.events.cards) {
    await recordStat(db, seasonYear, card.player, card.player.club_id, card.type === 'amarilla' ? 'yellow_cards' : 'red_cards');
  }

  const resultTag = (goalsFor, goalsAgainst) =>
    goalsFor > goalsAgainst ? 'win' : goalsFor < goalsAgainst ? 'loss' : 'draw';
  const homeTag = resultTag(result.homeGoals, result.awayGoals);
  const awayTag = resultTag(result.awayGoals, result.homeGoals);

  const scorerIds = new Set([...result.events.homeScorers, ...result.events.awayScorers].map((s) => s.scorer.id));
  const assistIds = new Set(
    [...result.events.homeScorers, ...result.events.awayScorers].filter((s) => s.assister).map((s) => s.assister.id)
  );
  const cardByPlayer = new Map(result.events.cards.map((c) => [c.player.id, c.type]));

  const homeMoraleModifier = await moraleProgressModifier(db, homeClubId);
  const awayMoraleModifier = await moraleProgressModifier(db, awayClubId);

  for (const p of result.homeLineup) {
    await applyPerformanceProgress(db, p, {
      resultTag: homeTag,
      scored: scorerIds.has(p.id),
      assisted: assistIds.has(p.id),
      cardType: cardByPlayer.get(p.id) || null,
      age: ageInSeason(p.birth_date, seasonYear),
    }, homeMoraleModifier);
  }
  for (const p of result.awayLineup) {
    await applyPerformanceProgress(db, p, {
      resultTag: awayTag,
      scored: scorerIds.has(p.id),
      assisted: assistIds.has(p.id),
      cardType: cardByPlayer.get(p.id) || null,
      age: ageInSeason(p.birth_date, seasonYear),
    }, awayMoraleModifier);
  }

  // Sistema de acontecimientos y relaciones: no debe poder romper el registro
  // de estadisticas/progresion si algo falla, asi que va aislado y al final.
  try {
    await onMatchFinished(db, seasonYear, homeClubId, awayClubId, result);
  } catch (err) {
    console.error('career-events onMatchFinished failed:', err);
  }

  // Panel de MEDIOS: igual de aislado, nunca debe poder romper el registro
  // del partido si falla.
  try {
    await onMatchFinishedMedia(db, seasonYear, homeClubId, awayClubId, result);
  } catch (err) {
    console.error('media onMatchFinishedMedia failed:', err);
  }
}

module.exports = { recordStat, recordMatchStats };
