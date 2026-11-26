// Calendario unificado de partidos pendientes del club que dirige el usuario,
// a traves de las 4 competiciones nacionales (Supercopa, Copa Chile, Copa de
// la Liga, Liga). Alimenta tanto el modulo "Proximo partido" de la barra
// lateral como la pestaña "Calendario" de la sección Partidos. No hay un
// calendario unico entre competiciones en el motor del juego, asi que se
// aproxima uno repartiendo cada competicion en semanas (weekOffset) y
// ordenando los partidos pendientes por esa semana aproximada, no por una
// prioridad fija de competicion: asi la Liga no queda congelada (y con ella
// el resto de los clubes de la liga, que solo avanzan cuando el usuario juega
// su propio partido) esperando a que se agoten todas las rondas pendientes de
// Copa Chile o Copa de la Liga. Solo el primer partido de la lista (el mas
// proximo en el tiempo) es jugable (canWatch); el resto se muestra bloqueado.
const { getCareer } = require('./board');
const { getCurrentSeasonYear } = require('./season');

const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

// Los partidos no tienen fecha propia en el motor (se resuelven por
// jornada/ronda, no por calendario real), asi que se aproxima una fecha
// legible ubicando la temporada desde marzo y espaciando cada jornada/ronda
// aproximadamente una semana.
function approximateDate(seasonYear, weekOffset) {
  const base = new Date(seasonYear, 2, 1); // 1 de marzo
  base.setDate(base.getDate() + weekOffset * 7);
  return `${base.getDate()} de ${MONTHS[base.getMonth()]} de ${base.getFullYear()}`;
}

async function clubRow(db, clubId) {
  return db.prepare('SELECT id, name, short_name, crest_url, stadium FROM clubs WHERE id = ?').get(clubId);
}

async function buildEntry(db, { kind, id, homeClubId, awayClubId, competition, roundLabel, seasonYear, weekOffset }, managedClubId) {
  const home = await clubRow(db, homeClubId);
  const away = await clubRow(db, awayClubId);
  const isHome = homeClubId === managedClubId;
  const rival = isHome ? away : home;
  return {
    kind,
    id,
    competition,
    roundLabel,
    seasonYear,
    weekOffset,
    date: approximateDate(seasonYear, weekOffset),
    stadium: (isHome ? home : away).stadium || null,
    isHome,
    myClub: isHome ? home : away,
    rivalClub: rival,
  };
}

// Desempate cuando dos competiciones caen en la misma semana aproximada (ver
// weekOffset en cada entry mas abajo): orden fijo solo para ese caso.
const COMPETITION_PRIORITY = { supercopa: 0, copa: 1, 'copa-liga': 2, league: 3 };

async function getUpcomingCalendar(db) {
  const career = await getCareer(db);
  if (!career || !career.club_id || career.status === 'despedido') return [];
  const clubId = career.club_id;
  const seasonYear = await getCurrentSeasonYear(db);
  const entries = [];

  const sc = await db.prepare('SELECT * FROM super_copa_matches WHERE season_year = ?').get(seasonYear);
  if (sc && !sc.played && !sc.skipped_reason && (sc.home_club_id === clubId || sc.away_club_id === clubId)) {
    entries.push(
      await buildEntry(
        db,
        {
          kind: 'supercopa', id: sc.id, homeClubId: sc.home_club_id, awayClubId: sc.away_club_id,
          competition: 'Supercopa', roundLabel: 'Final', seasonYear, weekOffset: 0,
        },
        clubId
      )
    );
  }

  const copa = await db
    .prepare(
      `SELECT * FROM copa_matches
       WHERE season_year = ? AND played = 0 AND home_club_id IS NOT NULL AND away_club_id IS NOT NULL
       AND (home_club_id = ? OR away_club_id = ?)
       ORDER BY round_order ASC LIMIT 1`
    )
    .get(seasonYear, clubId, clubId);
  if (copa) {
    entries.push(
      await buildEntry(
        db,
        {
          kind: 'copa', id: copa.id, homeClubId: copa.home_club_id, awayClubId: copa.away_club_id,
          competition: 'Copa Chile', roundLabel: copa.round_name, seasonYear, weekOffset: 1 + copa.round_order * 3,
        },
        clubId
      )
    );
  }

  const clg = await db
    .prepare(
      `SELECT * FROM copa_liga_matches
       WHERE season_year = ? AND played = 0 AND home_club_id IS NOT NULL AND away_club_id IS NOT NULL
       AND (home_club_id = ? OR away_club_id = ?)
       ORDER BY CASE stage WHEN 'grupos' THEN 0 WHEN 'semifinal' THEN 1 ELSE 2 END ASC, tie_slot ASC, leg ASC
       LIMIT 1`
    )
    .get(seasonYear, clubId, clubId);
  if (clg) {
    const roundLabel =
      clg.stage === 'grupos' ? 'Fase de grupos' : clg.stage === 'semifinal' ? `Semifinal · ${clg.leg === 1 ? 'Ida' : 'Vuelta'}` : 'Final';
    const weekOffset = clg.stage === 'grupos' ? 2 : clg.stage === 'semifinal' ? 10 + clg.leg : 14;
    entries.push(
      await buildEntry(
        db,
        {
          kind: 'copa-liga', id: clg.id, homeClubId: clg.home_club_id, awayClubId: clg.away_club_id,
          competition: 'Copa de la Liga', roundLabel, seasonYear, weekOffset,
        },
        clubId
      )
    );
  }

  const fixture = await db
    .prepare(
      `SELECT * FROM fixtures
       WHERE season_year = ? AND division = ? AND played = 0 AND (home_club_id = ? OR away_club_id = ?)
       ORDER BY jornada ASC, id ASC LIMIT 1`
    )
    .get(seasonYear, career.club_division, clubId, clubId);
  if (fixture) {
    entries.push(
      await buildEntry(
        db,
        {
          kind: 'league', id: fixture.id, homeClubId: fixture.home_club_id, awayClubId: fixture.away_club_id,
          competition: `Liga ${career.club_division}`, roundLabel: `Jornada ${fixture.jornada}`, seasonYear, weekOffset: fixture.jornada,
        },
        clubId
      )
    );
  }

  entries.sort((a, b) => a.weekOffset - b.weekOffset || COMPETITION_PRIORITY[a.kind] - COMPETITION_PRIORITY[b.kind]);
  entries.forEach((e, i) => { e.canWatch = i === 0; });
  return entries;
}

async function getNextManagedMatch(db) {
  const entries = await getUpcomingCalendar(db);
  return entries[0] || null;
}

module.exports = { getNextManagedMatch, getUpcomingCalendar };
