// Registro de estadisticas de temporada y progresion de rating compartido por
// todos los motores que resuelven un partido (liga, copa y el partido en vivo),
// para que las tres vias dejen exactamente el mismo rastro en la base de datos.
const { computeRatingDelta } = require('./rating-progress');
const { ageInSeason } = require('./age');
const { onMatchFinished, moraleProgressModifier } = require('./career-events');
const { onMatchFinishedMedia } = require('./media');

// Junta, en un solo batch (una llamada HTTP) en vez de 2 round-trips
// awaiteados por jugador/evento, el INSERT ON CONFLICT DO NOTHING que crea la
// fila de stats de cada jugador (si no existe) y los UPDATE que incrementan
// cada contador. Un partido de liga con ~44 jugadores entre ambas alineaciones
// pasaba de ~90+ round-trips contra Turso a 1-2.
async function recordStats(db, seasonYear, entries) {
  if (!entries.length) return;
  const byPlayer = new Map();
  for (const { player, clubId, field } of entries) {
    if (!byPlayer.has(player.id)) byPlayer.set(player.id, clubId);
  }

  const stmts = [];
  for (const [playerId, clubId] of byPlayer) {
    stmts.push({
      sql: `INSERT INTO player_season_stats (player_id, season_year, club_id, matches_played, goals, assists, yellow_cards, red_cards)
            VALUES (?, ?, ?, 0, 0, 0, 0, 0)
            ON CONFLICT(player_id, season_year) DO NOTHING`,
      args: [playerId, seasonYear, clubId],
    });
  }
  for (const { player, field } of entries) {
    if (!field) continue;
    stmts.push({
      sql: `UPDATE player_season_stats SET ${field} = ${field} + 1 WHERE player_id = ? AND season_year = ?`,
      args: [player.id, seasonYear],
    });
  }
  await db.batch(stmts);
}

// result: { homeGoals, awayGoals, homeLineup, awayLineup, events: { homeScorers, awayScorers, cards } }
// homeLineup/awayLineup: todos los jugadores que participaron (titulares + que entraron de cambio).
async function recordMatchStats(db, seasonYear, homeClubId, awayClubId, result) {
  const entries = [];
  for (const p of result.homeLineup) entries.push({ player: p, clubId: homeClubId, field: 'matches_played' });
  for (const p of result.awayLineup) entries.push({ player: p, clubId: awayClubId, field: 'matches_played' });
  for (const { scorer, assister } of result.events.homeScorers) {
    entries.push({ player: scorer, clubId: homeClubId, field: 'goals' });
    if (assister) entries.push({ player: assister, clubId: homeClubId, field: 'assists' });
  }
  for (const { scorer, assister } of result.events.awayScorers) {
    entries.push({ player: scorer, clubId: awayClubId, field: 'goals' });
    if (assister) entries.push({ player: assister, clubId: awayClubId, field: 'assists' });
  }
  for (const card of result.events.cards) {
    entries.push({
      player: card.player,
      clubId: card.player.club_id,
      field: card.type === 'amarilla' ? 'yellow_cards' : 'red_cards',
    });
  }
  await recordStats(db, seasonYear, entries);

  const resultTag = (goalsFor, goalsAgainst) =>
    goalsFor > goalsAgainst ? 'win' : goalsFor < goalsAgainst ? 'loss' : 'draw';
  const homeTag = resultTag(result.homeGoals, result.awayGoals);
  const awayTag = resultTag(result.awayGoals, result.homeGoals);

  const scorerIds = new Set([...result.events.homeScorers, ...result.events.awayScorers].map((s) => s.scorer.id));
  const assistIds = new Set(
    [...result.events.homeScorers, ...result.events.awayScorers].filter((s) => s.assister).map((s) => s.assister.id)
  );
  const cardByPlayer = new Map(result.events.cards.map((c) => [c.player.id, c.type]));

  // Se pide la carrera una sola vez y se pasa a las 4 funciones que antes la
  // volvian a pedir cada una por su cuenta (6 round-trips a Turso por
  // partido entre esta funcion y buildTeamProfile, ahora 1 aqui + 1 alla).
  const career = await require('./board').getCareer(db);

  const homeMoraleModifier = await moraleProgressModifier(db, homeClubId, career);
  const awayMoraleModifier = await moraleProgressModifier(db, awayClubId, career);

  // Un solo batch (una llamada HTTP) para todos los cambios de rating del
  // partido en vez de un UPDATE awaiteado por jugador: ver el comentario de
  // computeRatingDelta en rating-progress.js.
  const ratingStmts = [];
  for (const p of result.homeLineup) {
    const newRating = computeRatingDelta(p, {
      resultTag: homeTag,
      scored: scorerIds.has(p.id),
      assisted: assistIds.has(p.id),
      cardType: cardByPlayer.get(p.id) || null,
      age: ageInSeason(p.birth_date, seasonYear),
    }, homeMoraleModifier);
    if (newRating != null) ratingStmts.push({ sql: 'UPDATE players SET rating = ? WHERE id = ?', args: [newRating, p.id] });
  }
  for (const p of result.awayLineup) {
    const newRating = computeRatingDelta(p, {
      resultTag: awayTag,
      scored: scorerIds.has(p.id),
      assisted: assistIds.has(p.id),
      cardType: cardByPlayer.get(p.id) || null,
      age: ageInSeason(p.birth_date, seasonYear),
    }, awayMoraleModifier);
    if (newRating != null) ratingStmts.push({ sql: 'UPDATE players SET rating = ? WHERE id = ?', args: [newRating, p.id] });
  }
  if (ratingStmts.length) await db.batch(ratingStmts);

  // Sistema de acontecimientos y relaciones: no debe poder romper el registro
  // de estadisticas/progresion si algo falla, asi que va aislado y al final.
  try {
    await onMatchFinished(db, seasonYear, homeClubId, awayClubId, result, career);
  } catch (err) {
    console.error('career-events onMatchFinished failed:', err);
  }

  // Panel de MEDIOS: igual de aislado, nunca debe poder romper el registro
  // del partido si falla.
  try {
    await onMatchFinishedMedia(db, seasonYear, homeClubId, awayClubId, result, undefined, career);
  } catch (err) {
    console.error('media onMatchFinishedMedia failed:', err);
  }
}

module.exports = { recordMatchStats };
