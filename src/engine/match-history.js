// Historial de partidos ya jugados por el club del usuario, unificando las
// mismas 4 competiciones nacionales que el calendario (next-match.js), pero
// mirando para atras (played = 1) en vez de para adelante. Usa el mismo
// weekOffset aproximado que next-match.js para poder ordenar los partidos de
// distintas competiciones de una misma temporada en un solo historial
// cronologico razonable, de mas reciente a mas antiguo.
const { getCareer } = require('./board');
const { clubRow, approximateDate } = require('./next-match');

async function buildHistoryEntry(db, row, managedClubId) {
  const home = await clubRow(db, row.home_club_id);
  const away = await clubRow(db, row.away_club_id);
  const isHome = row.home_club_id === managedClubId;
  const rival = isHome ? away : home;
  const myGoals = isHome ? row.home_goals : row.away_goals;
  const rivalGoals = isHome ? row.away_goals : row.home_goals;
  const result = myGoals > rivalGoals ? 'G' : myGoals < rivalGoals ? 'P' : 'E';
  return {
    kind: row.kind,
    id: row.id,
    competition: row.competition,
    roundLabel: row.roundLabel,
    seasonYear: row.seasonYear,
    weekOffset: row.weekOffset,
    date: approximateDate(row.seasonYear, row.weekOffset),
    isHome,
    myClub: isHome ? home : away,
    rivalClub: rival,
    myGoals,
    rivalGoals,
    result,
    decidedByPenalties: !!row.decided_by_penalties,
  };
}

const COMPETITION_PRIORITY = { supercopa: 0, copa: 1, 'copa-liga': 2, league: 3 };

async function getMatchHistory(db, { limit } = {}) {
  const career = await getCareer(db);
  if (!career || !career.club_id) return [];
  const clubId = career.club_id;

  const rows = [];

  const scRows = await db
    .prepare(`SELECT * FROM super_copa_matches WHERE played = 1 AND (home_club_id = ? OR away_club_id = ?)`)
    .all(clubId, clubId);
  for (const r of scRows) {
    rows.push({ ...r, kind: 'supercopa', competition: 'Supercopa', roundLabel: 'Final', weekOffset: 0 });
  }

  const copaRows = await db
    .prepare(`SELECT * FROM copa_matches WHERE played = 1 AND (home_club_id = ? OR away_club_id = ?)`)
    .all(clubId, clubId);
  for (const r of copaRows) {
    rows.push({ ...r, kind: 'copa', competition: 'Copa Chile', roundLabel: r.round_name, weekOffset: 1 + r.round_order * 3 });
  }

  const clgRows = await db
    .prepare(`SELECT * FROM copa_liga_matches WHERE played = 1 AND (home_club_id = ? OR away_club_id = ?)`)
    .all(clubId, clubId);
  for (const r of clgRows) {
    const roundLabel =
      r.stage === 'grupos' ? 'Fase de grupos' : r.stage === 'semifinal' ? `Semifinal · ${r.leg === 1 ? 'Ida' : 'Vuelta'}` : 'Final';
    const weekOffset = r.stage === 'grupos' ? 2 : r.stage === 'semifinal' ? 10 + r.leg : 14;
    rows.push({ ...r, kind: 'copa-liga', competition: 'Copa de la Liga', roundLabel, weekOffset });
  }

  const fixtureRows = await db
    .prepare(`SELECT * FROM fixtures WHERE played = 1 AND (home_club_id = ? OR away_club_id = ?)`)
    .all(clubId, clubId);
  for (const r of fixtureRows) {
    rows.push({ ...r, kind: 'league', competition: `Liga ${r.division}`, roundLabel: `Jornada ${r.jornada}`, weekOffset: r.jornada });
  }

  rows.sort(
    (a, b) =>
      b.season_year - a.season_year ||
      b.weekOffset - a.weekOffset ||
      (COMPETITION_PRIORITY[b.kind] ?? 0) - (COMPETITION_PRIORITY[a.kind] ?? 0)
  );

  const limited = limit ? rows.slice(0, limit) : rows;
  const entries = [];
  for (const r of limited) {
    entries.push(await buildHistoryEntry(db, { ...r, seasonYear: r.season_year }, clubId));
  }
  return entries;
}

module.exports = { getMatchHistory };
