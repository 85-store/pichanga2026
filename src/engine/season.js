const { ageInSeason } = require('./age');
const { rollRetirement } = require('./retirement');
const { rollInjury } = require('./injuries');
const { generateYouthPlayer, youthCountForClub } = require('./youth');
const { recallDueLoans, simulateAiTransferMarket } = require('./market');
const {
  generateSeasonFixtures,
  isLeagueComplete,
  simulateRemainingLeague,
  applyPromotionRelegation,
} = require('./league');
const { generateCopaDraw, isCopaComplete, simulateRemainingCopa, getCopaChampion } = require('./copa');
const {
  ensureCopaLigaDraw,
  isCopaLigaComplete,
  simulateRemainingCopaLiga,
  getCopaLigaChampion,
} = require('./copa-liga');
const { computeInternationalQualifications } = require('./international');
const { reviewSeason, setNextObjective, generateJobOffers, getCareer } = require('./board');
const { ensureSuperCopa, playSuperCopaIfPending } = require('./super-copa');

async function ensureSeasonCompetitions(db, seasonYear) {
  await generateSeasonFixtures(db, seasonYear);
  await generateCopaDraw(db, seasonYear);
  await ensureCopaLigaDraw(db, seasonYear);
  await ensureSuperCopa(db, seasonYear);
}

const SEASON_WEEKS = 40; // duracion aproximada de una temporada, para consumir semanas de recuperacion

async function getCurrentSeasonYear(db) {
  const row = await db.prepare('SELECT year FROM seasons WHERE is_current = 1').get();
  return row ? row.year : null;
}

async function ensureFirstSeason(db, year) {
  const existing = await db.prepare('SELECT id FROM seasons WHERE year = ?').get(year);
  if (!existing) {
    await db.prepare('INSERT INTO seasons (year, is_current) VALUES (?, 1)').run(year);
  }
}

async function logHistory(db, playerId, seasonYear, eventType, description) {
  await db.prepare(
    `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, ?, ?)`
  ).run(playerId, seasonYear, eventType, description);
}

// Procesa el progreso de lesiones activas: consume semanas y marca recuperados.
async function progressInjuries(db, currentYear) {
  const openInjuries = await db
    .prepare(`SELECT * FROM injuries WHERE recovered = 0`)
    .all();

  for (const inj of openInjuries) {
    const remaining = inj.weeks_remaining - SEASON_WEEKS;
    if (remaining <= 0) {
      await db.prepare('UPDATE injuries SET weeks_remaining = 0, recovered = 1 WHERE id = ?').run(inj.id);
      const player = await db.prepare('SELECT * FROM players WHERE id = ?').get(inj.player_id);
      if (player && player.status === 'lesionado') {
        await db.prepare("UPDATE players SET status = 'activo' WHERE id = ?").run(player.id);
      }
      await logHistory(db, inj.player_id, currentYear, 'recuperacion', `Se recuperó de una lesión ${inj.injury_type.toLowerCase()} (${inj.severity.toLowerCase()}).`);
    } else {
      await db.prepare('UPDATE injuries SET weeks_remaining = ? WHERE id = ?').run(remaining, inj.id);
    }
  }
}

// Determina si un jugador tuvo lesion la temporada pasada (para calcular riesgo de recaida).
async function getLastSeasonInjury(db, playerId, previousYear) {
  return db
    .prepare('SELECT * FROM injuries WHERE player_id = ? AND season_year = ? ORDER BY id DESC LIMIT 1')
    .get(playerId, previousYear);
}

async function rollNewInjuries(db, players, currentYear, previousYear) {
  for (const player of players) {
    if (player.status !== 'activo') continue; // ya esta lesionado o no disponible
    if (player.position === 'Portero') continue; // los porteros no sufren lesiones
    const age = ageInSeason(player.birth_date, currentYear);
    const lastInjury = await getLastSeasonInjury(db, player.id, previousYear);

    const result = rollInjury({
      age,
      hadInjuryLastSeason: !!lastInjury,
      lastInjuryType: lastInjury ? lastInjury.injury_type : null,
    });
    if (!result) continue;

    await db.prepare(
      `INSERT INTO injuries (player_id, season_year, injury_type, severity, weeks_out, weeks_remaining, is_relapse, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(player.id, currentYear, result.injuryType, result.severity, result.weeksOut, result.weeksOut, result.isRelapse ? 1 : 0);

    await db.prepare("UPDATE players SET status = 'lesionado' WHERE id = ?").run(player.id);

    const relapseTxt = result.isRelapse ? ' (recaída)' : '';
    await logHistory(
      db,
      player.id,
      currentYear,
      'lesion',
      `Sufrió una lesión ${result.injuryType.toLowerCase()} de gravedad ${result.severity.toLowerCase()}${relapseTxt}, baja estimada de ${result.weeksOut} semanas.`
    );
  }
}

async function rollRetirements(db, players, currentYear) {
  const retiredByClub = new Map();
  for (const player of players) {
    if (player.status === 'retirado') continue;
    const age = ageInSeason(player.birth_date, currentYear);
    if (age == null) continue;

    if (rollRetirement({ age, position: player.position, rating: player.rating })) {
      await db.prepare(
        `UPDATE players SET status = 'retirado', retired_at_season = ?, retired_age = ? WHERE id = ?`
      ).run(currentYear, age, player.id);

      await db.prepare(
        `INSERT INTO transfers (player_id, season_year, from_club_id, to_club_id, type) VALUES (?, ?, ?, NULL, 'retiro')`
      ).run(player.id, currentYear, player.club_id);

      await logHistory(db, player.id, currentYear, 'retiro', `Se retiró del fútbol profesional a los ${age} años.`);

      if (player.club_id) {
        retiredByClub.set(player.club_id, (retiredByClub.get(player.club_id) || 0) + 1);
      }
    }
  }
  return retiredByClub;
}

async function generateYouthForClubs(db, currentYear, retiredByClub) {
  const clubs = await db.prepare('SELECT id FROM clubs WHERE active = 1').all();
  for (const club of clubs) {
    const retiredCount = retiredByClub.get(club.id) || 0;
    const count = youthCountForClub(retiredCount);
    for (let i = 0; i < count; i++) {
      const youth = generateYouthPlayer({ clubId: club.id, seasonYear: currentYear, db });
      const info = await db.prepare(
        `INSERT INTO players (club_id, full_name, birth_date, nationality, position, shirt_number, rating, potential, status, is_real_player, created_at_season)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        youth.club_id, youth.full_name, youth.birth_date, youth.nationality, youth.position,
        youth.shirt_number, youth.rating, youth.potential, youth.status, youth.is_real_player, youth.created_at_season
      );
      const playerId = info.lastInsertRowid;

      await db.prepare(
        `INSERT INTO transfers (player_id, season_year, from_club_id, to_club_id, type) VALUES (?, ?, NULL, ?, 'generacion_juvenil')`
      ).run(playerId, currentYear, club.id);

      await logHistory(db, playerId, currentYear, 'ascenso_juvenil', `Se incorporó al plantel como juvenil (potencial ${youth.potential}).`);
    }
  }
}

// Avanza una temporada completa: progresa lesiones, genera nuevas, evalua retiros
// y genera juveniles de reemplazo. Los datos persisten (no hay reinicio de estado).
async function advanceSeason(db) {
  const previousYear = await getCurrentSeasonYear(db);
  if (previousYear == null) throw new Error('No hay temporada actual configurada.');
  const currentYear = previousYear + 1;

  // Si quedan jornadas o rondas de copa sin jugar, se completan automaticamente
  // antes de cerrar la temporada (fuera de la transaccion principal: cada partido
  // ya es atomico dentro del motor de liga/copa).
  await ensureSeasonCompetitions(db, previousYear);
  if (!(await isLeagueComplete(db, previousYear))) await simulateRemainingLeague(db, previousYear);
  if (!(await isCopaComplete(db, previousYear))) await simulateRemainingCopa(db, previousYear);
  if (!(await isCopaLigaComplete(db, previousYear))) await simulateRemainingCopaLiga(db, previousYear);
  const superCopaResult = await playSuperCopaIfPending(db, previousYear);

  const board = await reviewSeason(db, previousYear);
  const leagueEvents = await applyPromotionRelegation(db, previousYear);
  const copaChampion = await getCopaChampion(db, previousYear);
  if (copaChampion) {
    const champClub = await db.prepare('SELECT id FROM clubs WHERE name = ?').get(copaChampion);
    if (champClub) {
      await db.prepare(`INSERT INTO club_titles (club_id, season_year, title_name) VALUES (?, ?, ?)`).run(
        champClub.id,
        previousYear,
        'Campeón Copa Chile'
      );
    }
  }

  // Supercopa: puede haberse jugado recien aqui (auto-resuelta al cerrar la
  // temporada) o antes, de forma interactiva durante la temporada - en ese
  // segundo caso super-copa.js ya dejo el titulo en club_titles y solo hay
  // que leerlo para el resumen.
  let superCopaChampion = null;
  if (superCopaResult && superCopaResult.winner_club_id) {
    const winnerClub = await db.prepare('SELECT name FROM clubs WHERE id = ?').get(superCopaResult.winner_club_id);
    superCopaChampion = winnerClub ? winnerClub.name : null;
  } else {
    const titleRow = await db
      .prepare(
        `SELECT c.name FROM club_titles t JOIN clubs c ON c.id = t.club_id
         WHERE t.season_year = ? AND t.title_name = 'Campeón Supercopa'`
      )
      .get(previousYear);
    superCopaChampion = titleRow ? titleRow.name : null;
  }

  // Copa de la Liga: a diferencia de Copa Chile y Supercopa, su titulo nunca
  // se registraba en club_titles - se agrega aqui siguiendo el mismo patron.
  const copaLigaChampion = await getCopaLigaChampion(db, previousYear);
  if (copaLigaChampion) {
    const champClub = await db.prepare('SELECT id FROM clubs WHERE name = ?').get(copaLigaChampion);
    if (champClub) {
      const alreadyRecorded = await db
        .prepare(
          `SELECT 1 FROM club_titles WHERE club_id = ? AND season_year = ? AND title_name = ?`
        )
        .get(champClub.id, previousYear, 'Campeón Copa de la Liga');
      if (!alreadyRecorded) {
        await db.prepare(`INSERT INTO club_titles (club_id, season_year, title_name) VALUES (?, ?, ?)`).run(
          champClub.id,
          previousYear,
          'Campeón Copa de la Liga'
        );
      }
    }
  }

  // Clasificacion a copas internacionales 2027+ en base a los resultados de
  // previousYear (Primera A, Copa Chile y Copa de la Liga ya estan cerrados
  // en este punto). Idempotente y nunca vuelve a tocar una temporada ya calculada.
  const internationalQualifications = await computeInternationalQualifications(db, previousYear);

  const tx = await db.transaction('write');
  try {
    await progressInjuries(tx, currentYear);
    await recallDueLoans(tx, currentYear);

    const activePlayers = await tx
      .prepare(`SELECT * FROM players WHERE status IN ('activo', 'lesionado')`)
      .all();

    await rollNewInjuries(tx, activePlayers, currentYear, previousYear);

    // Releer tras las lesiones para evaluar retiro con el estado mas reciente.
    const playersForRetirement = await tx
      .prepare(`SELECT * FROM players WHERE status IN ('activo', 'lesionado')`)
      .all();
    const retiredByClub = await rollRetirements(tx, playersForRetirement, currentYear);

    await generateYouthForClubs(tx, currentYear, retiredByClub);

    await tx.prepare('UPDATE seasons SET is_current = 0, closed_at = datetime(\'now\') WHERE year = ?').run(previousYear);
    await tx.prepare('INSERT INTO seasons (year, is_current) VALUES (?, 1)').run(currentYear);

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  // El mercado entre clubes IA se corre fuera de la transaccion principal
  // (abre sus propias transacciones cortas por cada operacion).
  const career = await getCareer(db);
  await simulateAiTransferMarket(db, currentYear, career ? career.club_id : null);

  const jobOffers = await generateJobOffers(db, currentYear);

  await ensureSeasonCompetitions(db, currentYear);
  const nextObjective = await setNextObjective(db, currentYear);

  const summary = await db
    .prepare(
      `SELECT e.event_type, e.description, p.full_name, p.id as player_id, c.name as club_name
       FROM player_history_events e
       JOIN players p ON p.id = e.player_id
       LEFT JOIN clubs c ON c.id = p.club_id
       WHERE e.season_year = ?
       ORDER BY e.event_type, p.full_name`
    )
    .all(currentYear);

  return {
    previousYear,
    currentYear,
    retirements: summary.filter((s) => s.event_type === 'retiro'),
    injuries: summary.filter((s) => s.event_type === 'lesion'),
    recoveries: summary.filter((s) => s.event_type === 'recuperacion'),
    youth: summary.filter((s) => s.event_type === 'ascenso_juvenil'),
    league: leagueEvents,
    copaChampion,
    superCopaChampion,
    copaLigaChampion,
    internationalQualifications,
    board,
    nextObjective,
    jobOffers,
  };
}

module.exports = { advanceSeason, getCurrentSeasonYear, ensureFirstSeason, ensureSeasonCompetitions };
