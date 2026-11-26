// Clasificacion oficial a copas internacionales (Libertadores/Sudamericana)
// para el futbol chileno, calculada al cierre de cada temporada a partir de:
// el Campeonato Nacional (Primera A), la Copa de la Liga y la Copa Chile.
//
// Cupos Libertadores (4): Chile 1 = campeon Primera A (grupos). Chile 2 =
// subcampeon Primera A (grupos). Chile 3 = campeon Copa de la Liga, con
// reasignacion al subcampeon si el campeon ya clasifico por otra via (fase
// previa). Chile 4 = ganador de una definicion entre el 3er lugar de Primera
// A (o el siguiente puesto libre, segun reasignacion) y el campeon de Copa
// Chile (o su finalista, segun reasignacion) (fase previa).
//
// Cupos Sudamericana (4): los puestos 4,5 y 6 de Primera A que sigan libres,
// y el perdedor de la definicion por Chile 4.
//
// Nunca se simulan partidos contra clubes extranjeros (no hay planteles
// reales de clubes CONMEBOL en el proyecto): este modulo solo decide y
// persiste que club chileno ocupa cada cupo y en que fase ingresa.
const { getStandings } = require('./league');
const { simulateMatch, decidePenalties } = require('./match');
const { recordMatchStats } = require('./finalize-match');
const { getCopaLigaFinalists } = require('./copa-liga');

async function getCopaChileFinalists(db, seasonYear) {
  const final = await db
    .prepare(`SELECT * FROM copa_matches WHERE season_year = ? AND round_name = 'Final' AND played = 1`)
    .get(seasonYear);
  if (!final || final.winner_club_id == null) return null;
  const loserId = final.winner_club_id === final.home_club_id ? final.away_club_id : final.home_club_id;
  return { championId: final.winner_club_id, runnerUpId: loserId };
}

async function hasInternationalQualifications(db, seasonYear) {
  const row = await db
    .prepare('SELECT COUNT(*) as c FROM international_qualifications WHERE season_year = ?')
    .get(seasonYear);
  return row.c > 0;
}

async function clubName(db, clubId) {
  const row = await db.prepare('SELECT name FROM clubs WHERE id = ?').get(clubId);
  return row ? row.name : 'Club desconocido';
}

// Juega el partido unico (sede neutral) de la definicion por el cupo Chile 4.
async function playChile4Playoff(db, seasonYear, homeClubId, awayClubId) {
  const homePlayers = await db
    .prepare("SELECT * FROM players WHERE club_id = ? AND status IN ('activo','lesionado')")
    .all(homeClubId);
  const awayPlayers = await db
    .prepare("SELECT * FROM players WHERE club_id = ? AND status IN ('activo','lesionado')")
    .all(awayClubId);

  const result = await simulateMatch(homePlayers, awayPlayers, { db, seasonYear, homeClubId, awayClubId });

  let winnerClubId;
  let decidedByPenalties = 0;
  if (result.homeGoals !== result.awayGoals) {
    winnerClubId = result.homeGoals > result.awayGoals ? homeClubId : awayClubId;
  } else {
    decidedByPenalties = 1;
    const side = decidePenalties(result.homeStrength, result.awayStrength);
    winnerClubId = side === 'home' ? homeClubId : awayClubId;
  }

  const info = await db
    .prepare(
      `INSERT INTO chile4_playoffs (season_year, home_club_id, away_club_id, home_goals, away_goals, played, decided_by_penalties, winner_club_id)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(seasonYear, homeClubId, awayClubId, result.homeGoals, result.awayGoals, decidedByPenalties, winnerClubId);

  const progressHomeGoals = decidedByPenalties ? (winnerClubId === homeClubId ? 1 : 0) : result.homeGoals;
  const progressAwayGoals = decidedByPenalties ? (winnerClubId === awayClubId ? 1 : 0) : result.awayGoals;
  await recordMatchStats(db, seasonYear, homeClubId, awayClubId, {
    homeGoals: progressHomeGoals,
    awayGoals: progressAwayGoals,
    homeLineup: result.homeLineup,
    awayLineup: result.awayLineup,
    events: result.events,
  });

  const loserClubId = winnerClubId === homeClubId ? awayClubId : homeClubId;
  return { id: info.lastInsertRowid, winnerClubId, loserClubId, decidedByPenalties, homeGoals: result.homeGoals, awayGoals: result.awayGoals };
}

// Calcula y persiste la clasificacion a copas internacionales para
// seasonYear (se usara en las copas de seasonYear + 1). Es idempotente: si
// ya existe una clasificacion para esa temporada, no vuelve a calcularla ni
// la modifica (nunca se tocan temporadas ya cerradas).
async function computeInternationalQualifications(db, seasonYear) {
  if (await hasInternationalQualifications(db, seasonYear)) {
    return getInternationalQualifications(db, seasonYear);
  }

  const tableA = await getStandings(db, seasonYear, 'Primera A');
  if (tableA.length < 6) return []; // temporada degenerada (muy pocos clubes), no hay nada que calcular

  const used = new Set();
  const rows = []; // { competition, slot_number, stage, club_id, qualification_path }

  function assign(competition, slotNumber, stage, clubId, path) {
    used.add(clubId);
    rows.push({ competition, slot_number: slotNumber, stage, club_id: clubId, qualification_path: path });
  }

  function nextFreeTableIndex(fromIndex) {
    for (let i = fromIndex; i < tableA.length; i++) {
      if (!used.has(tableA[i].club_id)) return i;
    }
    return -1;
  }

  // Chile 1 y 2: campeon y subcampeon del Campeonato Nacional, van a fase de grupos.
  assign('Libertadores', 1, 'Fase de grupos', tableA[0].club_id, `Campeón del Campeonato Nacional ${seasonYear}`);
  assign('Libertadores', 2, 'Fase de grupos', tableA[1].club_id, `Subcampeón del Campeonato Nacional ${seasonYear}`);

  // Chile 3: campeon de la Copa de la Liga; si ya clasifico por otra via, pasa al subcampeon.
  const copaLiga = await getCopaLigaFinalists(db, seasonYear);
  if (copaLiga) {
    if (!used.has(copaLiga.championId)) {
      assign('Libertadores', 3, 'Fase previa', copaLiga.championId, `Campeón de la Copa de la Liga ${seasonYear}`);
    } else if (!used.has(copaLiga.runnerUpId)) {
      assign(
        'Libertadores',
        3,
        'Fase previa',
        copaLiga.runnerUpId,
        `Subcampeón de la Copa de la Liga ${seasonYear} (el campeón ya había clasificado por otra vía)`
      );
    }
    // Si ambos finalistas de la Copa de la Liga ya estaban clasificados, el cupo Chile 3
    // queda sin asignar esta temporada (caso extremo, ambos ya eran campeon/subcampeon de liga).
  }

  // Definicion por Chile 4: 3er lugar libre de la tabla contra el campeon de Copa Chile
  // (o su finalista, si el campeon ya clasifico por otra via).
  const ligaIdx = nextFreeTableIndex(0); // la tabla ya tiene usados los puestos 1 y 2
  const ligaCandidate = ligaIdx >= 0 ? tableA[ligaIdx] : null;

  const copaChile = await getCopaChileFinalists(db, seasonYear);
  let copaChileSideId = null;
  let copaChileSidePath = null;
  if (copaChile) {
    if (!used.has(copaChile.championId)) {
      copaChileSideId = copaChile.championId;
      copaChileSidePath = `Campeón de la Copa Chile ${seasonYear}`;
    } else if (!used.has(copaChile.runnerUpId)) {
      copaChileSideId = copaChile.runnerUpId;
      copaChileSidePath = `Finalista de la Copa Chile ${seasonYear} (el campeón ya había clasificado por otra vía)`;
    }
  }

  let chile4WinnerId = null;
  let chile4WinnerPath = null;
  let sudamericana4Id = null;
  let sudamericana4Path = null;

  if (ligaCandidate && copaChileSideId != null && ligaCandidate.club_id === copaChileSideId) {
    // El mismo club es a la vez el puesto libre de la tabla y el representante
    // de Copa Chile: no hay definicion posible (jugaria contra si mismo).
    // Clasifica directo a Chile 4 y Sudamericana 4 queda para el siguiente
    // puesto libre de la tabla (no hay "perdedor" de un partido que no existio).
    const ligaLabel = `${ligaIdx + 1}° lugar del Campeonato Nacional ${seasonYear}`;
    chile4WinnerId = ligaCandidate.club_id;
    chile4WinnerPath = `Clasifica directo al cupo Chile 4: es a la vez el ${ligaLabel} y ${copaChileSidePath.toLowerCase()} (no hay definición posible contra sí mismo)`;
  } else if (ligaCandidate && copaChileSideId != null) {
    const ligaLabel = `${ligaIdx + 1}° lugar del Campeonato Nacional ${seasonYear}`;
    const playoff = await playChile4Playoff(db, seasonYear, ligaCandidate.club_id, copaChileSideId);
    const winnerIsLiga = playoff.winnerClubId === ligaCandidate.club_id;
    chile4WinnerId = playoff.winnerClubId;
    chile4WinnerPath = winnerIsLiga
      ? `Ganó la definición por el cupo Chile 4 ante el representante de Copa Chile (como ${ligaLabel})`
      : `Ganó la definición por el cupo Chile 4 ante el ${ligaLabel} (como ${copaChileSidePath.toLowerCase()})`;
    sudamericana4Id = playoff.loserClubId;
    sudamericana4Path = winnerIsLiga
      ? `Perdió la definición por el cupo Chile 4 (representante de Copa Chile)`
      : `Perdió la definición por el cupo Chile 4 (${ligaLabel})`;
  } else if (ligaCandidate && copaChileSideId == null) {
    // No quedaba ningun finalista de Copa Chile disponible: pasa directo.
    chile4WinnerId = ligaCandidate.club_id;
    chile4WinnerPath = `Clasifica directo al cupo Chile 4: ${ligaIdx + 1}° lugar del Campeonato Nacional ${seasonYear} (ningún finalista de Copa Chile quedaba disponible)`;
  } else if (!ligaCandidate && copaChileSideId != null) {
    chile4WinnerId = copaChileSideId;
    chile4WinnerPath = `Clasifica directo al cupo Chile 4: ${copaChileSidePath} (no quedaba ningún puesto libre en la tabla)`;
  }

  // Se marcan como usados de inmediato (antes de repartir Sudamericana 1-3):
  // tanto el ganador como el perdedor de la definicion por Chile 4 ya tienen
  // destino (Libertadores 4 o Sudamericana 4) y no deben volver a aparecer
  // como "siguiente puesto libre de la tabla".
  if (chile4WinnerId != null) used.add(chile4WinnerId);
  if (sudamericana4Id != null) used.add(sudamericana4Id);

  if (chile4WinnerId != null) {
    assign('Libertadores', 4, 'Fase previa', chile4WinnerId, chile4WinnerPath);
  }

  // Sudamericana 1, 2 y 3: siguientes puestos libres de la tabla.
  for (let slot = 1; slot <= 3; slot++) {
    const idx = nextFreeTableIndex(0);
    if (idx < 0) break;
    assign('Sudamericana', slot, 'Fase de grupos', tableA[idx].club_id, `${idx + 1}° lugar del Campeonato Nacional ${seasonYear}`);
  }

  // Sudamericana 4: perdedor de la definicion por Chile 4 (si hubo partido real).
  if (sudamericana4Id != null) {
    assign('Sudamericana', 4, 'Fase de grupos', sudamericana4Id, sudamericana4Path);
  } else {
    const idx = nextFreeTableIndex(0);
    if (idx >= 0) {
      assign('Sudamericana', 4, 'Fase de grupos', tableA[idx].club_id, `${idx + 1}° lugar del Campeonato Nacional ${seasonYear} (no hubo definición disputada por Chile 4)`);
    }
  }

  const tx = await db.transaction('write');
  try {
    const insert = tx.prepare(
      `INSERT INTO international_qualifications (season_year, competition, slot_number, stage, club_id, qualification_path)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const r of rows) {
      await insert.run(seasonYear, r.competition, r.slot_number, r.stage, r.club_id, r.qualification_path);
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return getInternationalQualifications(db, seasonYear);
}

async function getInternationalQualifications(db, seasonYear) {
  return db
    .prepare(
      `SELECT q.*, c.name as club_name, c.crest_url as club_crest
       FROM international_qualifications q
       JOIN clubs c ON c.id = q.club_id
       WHERE q.season_year = ?
       ORDER BY q.competition DESC, q.slot_number`
    )
    .all(seasonYear);
}

module.exports = {
  computeInternationalQualifications,
  getInternationalQualifications,
  hasInternationalQualifications,
};
