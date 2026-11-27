const { ageInSeason } = require('./age');
const { rollRetirement } = require('./retirement');
const { rollInjury, getInjuryProgressStmts } = require('./injuries');
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

// Procesa el progreso de lesiones activas: consume semanas y marca recuperados.
// Batcheado (1 lectura + 1 escritura por avance de temporada en vez de hasta 3
// round-trips awaiteados por lesion abierta): ver el comentario de
// rollNewInjuries mas abajo sobre por que esto importaba para el avance
// automatico de temporada. Esto es ademas de (no en vez de) el avance semana a
// semana que ya ocurre durante la temporada via tickInjuriesOneWeek (ver
// injuries.js): es la red de seguridad que garantiza que ninguna lesion llegue
// sin resolver a la temporada siguiente.
async function progressInjuries(db, currentYear) {
  const stmts = await getInjuryProgressStmts(db, currentYear, SEASON_WEEKS);
  if (stmts.length) await db.batch(stmts);
}

// Trae de una sola vez la ultima lesion de la temporada pasada de CADA
// jugador (antes era 1 consulta awaiteada por jugador activo - con ~700+
// jugadores en toda la liga eso eran ~700 round-trips seguidos contra Turso
// solo para esto, el principal motivo de que el avance de temporada quedara
// colgado muchos segundos (ahora que avanza solo, sin boton, el usuario lo
// nota de inmediato en vez de recien al final de una partida larga).
async function getLastSeasonInjuriesByPlayer(db, previousYear) {
  const rows = await db
    .prepare('SELECT * FROM injuries WHERE season_year = ? ORDER BY id DESC')
    .all(previousYear);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.player_id)) map.set(row.player_id, row);
  }
  return map;
}

async function rollNewInjuries(db, players, currentYear, previousYear) {
  const lastInjuryByPlayer = await getLastSeasonInjuriesByPlayer(db, previousYear);
  const stmts = [];
  for (const player of players) {
    if (player.status !== 'activo') continue; // ya esta lesionado o no disponible
    if (player.position === 'Portero') continue; // los porteros no sufren lesiones
    const age = ageInSeason(player.birth_date, currentYear);
    const lastInjury = lastInjuryByPlayer.get(player.id);

    const result = rollInjury({
      age,
      hadInjuryLastSeason: !!lastInjury,
      lastInjuryType: lastInjury ? lastInjury.injury_type : null,
    });
    if (!result) continue;

    stmts.push({
      sql: `INSERT INTO injuries (player_id, season_year, injury_type, severity, weeks_out, weeks_remaining, is_relapse, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [player.id, currentYear, result.injuryType, result.severity, result.weeksOut, result.weeksOut, result.isRelapse ? 1 : 0],
    });
    stmts.push({ sql: "UPDATE players SET status = 'lesionado' WHERE id = ?", args: [player.id] });

    const relapseTxt = result.isRelapse ? ' (recaída)' : '';
    stmts.push({
      sql: `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, 'lesion', ?)`,
      args: [player.id, currentYear, `Sufrió una lesión ${result.injuryType.toLowerCase()} de gravedad ${result.severity.toLowerCase()}${relapseTxt}, baja estimada de ${result.weeksOut} semanas.`],
    });
  }
  if (stmts.length) await db.batch(stmts);
}

async function rollRetirements(db, players, currentYear) {
  const retiredByClub = new Map();
  const stmts = [];
  for (const player of players) {
    if (player.status === 'retirado') continue;
    const age = ageInSeason(player.birth_date, currentYear);
    if (age == null) continue;

    if (rollRetirement({ age, position: player.position, rating: player.rating })) {
      stmts.push({
        sql: `UPDATE players SET status = 'retirado', retired_at_season = ?, retired_age = ? WHERE id = ?`,
        args: [currentYear, age, player.id],
      });
      stmts.push({
        sql: `INSERT INTO transfers (player_id, season_year, from_club_id, to_club_id, type) VALUES (?, ?, ?, NULL, 'retiro')`,
        args: [player.id, currentYear, player.club_id],
      });
      stmts.push({
        sql: `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, 'retiro', ?)`,
        args: [player.id, currentYear, `Se retiró del fútbol profesional a los ${age} años.`],
      });

      if (player.club_id) {
        retiredByClub.set(player.club_id, (retiredByClub.get(player.club_id) || 0) + 1);
      }
    }
  }
  if (stmts.length) await db.batch(stmts);
  return retiredByClub;
}

// Genera los juveniles de reemplazo de todos los clubes activos (~30) en 2
// llamadas batch en vez de hasta 3 round-trips awaiteados por juvenil (mas los
// que generateName hacia por su cuenta, ver youth.js): se arman todos los
// juveniles en memoria primero, se insertan todos los jugadores en un batch,
// y con los lastInsertRowid que devuelve ese batch se insertan en un segundo
// batch sus filas de transfers/historial.
async function generateYouthForClubs(db, currentYear, retiredByClub) {
  const clubs = await db.prepare('SELECT id FROM clubs WHERE active = 1').all();
  const existingNames = new Set(
    (await db.prepare(`SELECT full_name FROM players WHERE status != 'retirado'`).all()).map((p) => p.full_name)
  );

  const youths = [];
  for (const club of clubs) {
    const retiredCount = retiredByClub.get(club.id) || 0;
    const count = youthCountForClub(retiredCount);
    for (let i = 0; i < count; i++) {
      youths.push(generateYouthPlayer({ clubId: club.id, seasonYear: currentYear, existingNames }));
    }
  }
  if (!youths.length) return;

  const insertStmts = youths.map((youth) => ({
    sql: `INSERT INTO players (club_id, full_name, birth_date, nationality, position, shirt_number, rating, potential, status, is_real_player, created_at_season)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      youth.club_id, youth.full_name, youth.birth_date, youth.nationality, youth.position,
      youth.shirt_number, youth.rating, youth.potential, youth.status, youth.is_real_player, youth.created_at_season,
    ],
  }));
  const insertResults = await db.batch(insertStmts);

  const followUpStmts = [];
  youths.forEach((youth, i) => {
    const playerId = insertResults[i].lastInsertRowid;
    followUpStmts.push({
      sql: `INSERT INTO transfers (player_id, season_year, from_club_id, to_club_id, type) VALUES (?, ?, NULL, ?, 'generacion_juvenil')`,
      args: [playerId, currentYear, youth.club_id],
    });
    followUpStmts.push({
      sql: `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, 'ascenso_juvenil', ?)`,
      args: [playerId, currentYear, `Se incorporó al plantel como juvenil (potencial ${youth.potential}).`],
    });
  });
  await db.batch(followUpStmts);
}

// Evita que dos avances de temporada corran en paralelo sobre la misma base:
// con el avance automatico (ver /calendar en src/routes/api.js) esto puede
// pasar de verdad - el usuario reintentando la pestaña de Calendario, o el
// chequeo al terminar un partido, mientras el avance anterior (lento,
// progresa lesiones/retiros/juveniles/mercado de ~30 clubes) todavia estaba
// corriendo. Sin este guard, un segundo llamado podia alcanzar a leer la
// temporada ya avanzada pero con las competiciones de la nueva temporada
// todavia sin generar, y arrancar OTRO avance mas - saltandose una temporada
// entera sin que el usuario llegara a jugarla.
let advanceSeasonInFlight = null;

// Avanza una temporada completa: progresa lesiones, genera nuevas, evalua retiros
// y genera juveniles de reemplazo. Los datos persisten (no hay reinicio de estado).
function advanceSeason(db) {
  if (advanceSeasonInFlight) return advanceSeasonInFlight;
  advanceSeasonInFlight = doAdvanceSeason(db).finally(() => {
    advanceSeasonInFlight = null;
  });
  return advanceSeasonInFlight;
}

// Presupuesto de tiempo por pedido para terminar de simular lo que falte de
// la temporada anterior (liga/copa/copa de la liga). Completar de una sola
// pasada una temporada recien empezada (cientos de partidos pendientes de
// ~30 clubes) colgaba el pedido por minutos - ver el comentario en
// simulateRemainingLeague (league.js). Si el presupuesto no alcanza, esta
// funcion corta, deja lo ya jugado persistido, y devuelve { pending: true }
// sin tocar lesiones/retiros/juveniles ni avanzar el año: el llamador
// (/api/calendar o /api/season/advance) vuelve a invocarla en el siguiente
// pedido y retoma donde quedo, hasta que de verdad este todo listo para
// cerrar la temporada.
const ADVANCE_SEASON_BUDGET_MS = 8000;

async function doAdvanceSeason(db) {
  const previousYear = await getCurrentSeasonYear(db);
  if (previousYear == null) throw new Error('No hay temporada actual configurada.');
  const currentYear = previousYear + 1;
  const deadline = Date.now() + ADVANCE_SEASON_BUDGET_MS;

  // Si quedan jornadas o rondas de copa sin jugar, se completan automaticamente
  // antes de cerrar la temporada (fuera de la transaccion principal: cada partido
  // ya es atomico dentro del motor de liga/copa).
  await ensureSeasonCompetitions(db, previousYear);
  if (!(await isLeagueComplete(db, previousYear))) await simulateRemainingLeague(db, previousYear, { deadline });
  if (Date.now() < deadline && !(await isCopaComplete(db, previousYear))) {
    await simulateRemainingCopa(db, previousYear, { deadline });
  }
  if (Date.now() < deadline && !(await isCopaLigaComplete(db, previousYear))) {
    await simulateRemainingCopaLiga(db, previousYear, { deadline });
  }

  if (
    !(await isLeagueComplete(db, previousYear)) ||
    !(await isCopaComplete(db, previousYear)) ||
    !(await isCopaLigaComplete(db, previousYear))
  ) {
    return { previousYear, pending: true };
  }

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

  // Pantalla de "balance" de fin de temporada: trofeos propios (solo cuenta
  // si el campeon/ascendido es el club que dirige el usuario), goleadores del
  // plantel y reputacion actual con los 4 estamentos del club.
  const userClub = career ? await db.prepare('SELECT id, name FROM clubs WHERE id = ?').get(career.club_id) : null;
  const primeraBChampionName = (leagueEvents.promoted || [])[0] || null;
  const trophiesWon = {
    primeraA: !!(userClub && leagueEvents.champion === userClub.name),
    primeraB: !!(userClub && primeraBChampionName === userClub.name),
    copaChile: !!(userClub && copaChampion === userClub.name),
    copaLiga: !!(userClub && copaLigaChampion === userClub.name),
    supercopa: !!(userClub && superCopaChampion === userClub.name),
  };
  const wonAnyTitle = Object.values(trophiesWon).some(Boolean);

  const topScorers = userClub
    ? await db
        .prepare(
          `SELECT p.full_name, s.goals, s.assists
           FROM player_season_stats s
           JOIN players p ON p.id = s.player_id
           WHERE s.season_year = ? AND s.club_id = ? AND s.goals > 0
           ORDER BY s.goals DESC, s.assists DESC
           LIMIT 5`
        )
        .all(previousYear, userClub.id)
    : [];

  const reputation = career
    ? {
        boardConfidence: career.board_confidence,
        fanSupport: career.fan_support,
        mediaPressure: career.media_pressure,
        lockerRoomMorale: career.locker_room_morale,
      }
    : null;

  await ensureSeasonCompetitions(db, currentYear);
  const nextObjective = await setNextObjective(db, currentYear);

  // El resumen de fin de temporada es sobre "mi plantel": si se mostraran los
  // eventos de los ~30 clubes de la liga sin filtrar, una lesion/retiro/juvenil
  // de cualquier otro club apareceria mezclado en la lista y daria la falsa
  // impresion de que el propio plantel se desmorono.
  const summary = await db
    .prepare(
      `SELECT e.event_type, e.description, p.full_name, p.id as player_id, c.name as club_name
       FROM player_history_events e
       JOIN players p ON p.id = e.player_id
       LEFT JOIN clubs c ON c.id = p.club_id
       WHERE e.season_year = ? AND p.club_id = ?
       ORDER BY e.event_type, p.full_name`
    )
    .all(currentYear, career ? career.club_id : null);

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
    trophiesWon,
    wonAnyTitle,
    topScorers,
    reputation,
  };
}

module.exports = { advanceSeason, getCurrentSeasonYear, ensureFirstSeason, ensureSeasonCompetitions };
