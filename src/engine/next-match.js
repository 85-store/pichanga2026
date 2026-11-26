// Determina, para el club que dirige el usuario, cual es el proximo partido
// a jugar entre las tres competiciones (Supercopa, Copa Chile, Liga), para
// alimentar el modulo "Proximo partido" de la barra lateral. No hay un
// calendario unico entre competiciones en el motor del juego, asi que se usa
// una prioridad fija: Supercopa (partido unico de pretemporada) > Copa Chile
// (rondas espaciadas) > Liga (la jornada semanal, el "pan de cada dia").
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

async function buildResult(db, { kind, id, homeClubId, awayClubId, competition, roundLabel, seasonYear, weekOffset }, managedClubId) {
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
    date: approximateDate(seasonYear, weekOffset),
    stadium: (isHome ? home : away).stadium || null,
    isHome,
    myClub: isHome ? home : away,
    rivalClub: rival,
  };
}

async function getNextManagedMatch(db) {
  const career = await getCareer(db);
  if (!career || !career.club_id || career.status === 'despedido') return null;
  const clubId = career.club_id;
  const seasonYear = await getCurrentSeasonYear(db);

  const sc = await db.prepare('SELECT * FROM super_copa_matches WHERE season_year = ?').get(seasonYear);
  if (sc && !sc.played && !sc.skipped_reason && (sc.home_club_id === clubId || sc.away_club_id === clubId)) {
    return buildResult(
      db,
      {
        kind: 'supercopa', id: sc.id, homeClubId: sc.home_club_id, awayClubId: sc.away_club_id,
        competition: 'Supercopa', roundLabel: 'Final', seasonYear, weekOffset: 0,
      },
      clubId
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
    return buildResult(
      db,
      {
        kind: 'copa', id: copa.id, homeClubId: copa.home_club_id, awayClubId: copa.away_club_id,
        competition: 'Copa Chile', roundLabel: copa.round_name, seasonYear, weekOffset: 1 + copa.round_order * 3,
      },
      clubId
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
    return buildResult(
      db,
      {
        kind: 'league', id: fixture.id, homeClubId: fixture.home_club_id, awayClubId: fixture.away_club_id,
        competition: `Liga ${career.club_division}`, roundLabel: `Jornada ${fixture.jornada}`, seasonYear, weekOffset: fixture.jornada,
      },
      clubId
    );
  }

  return null;
}

module.exports = { getNextManagedMatch };
