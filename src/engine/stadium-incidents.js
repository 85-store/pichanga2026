// Incendio de estadio: cuando el ambiente esta muy mal (hinchada muy
// descontenta o vestuario roto), antes de un partido de local hay un 4% de
// probabilidad de que un sector de la hinchada incendie el estadio. El
// partido se suspende y se le da por ganado 3-0 al rival, sin jugarse.
const { chance } = require('./random');
const { recordMatchStats } = require('./finalize-match');

const FIRE_CHANCE = 0.04;
const FAN_THRESHOLD = 35;
const MORALE_THRESHOLD = 30;

const TABLE_BY_KIND = { league: 'fixtures', copa: 'copa_matches', 'copa-liga': 'copa_liga_matches' };
const HAS_WINNER_COLUMN = { copa: true, 'copa-liga': true };

// Solo puede pasar cuando las cosas andan mal: hinchada muy descontenta o
// camarin muy mal (p.ej. tras una protesta o una mala racha de resultados).
function canRiskFire(career) {
  if (!career) return false;
  const fan = career.fan_support != null ? career.fan_support : 60;
  const morale = career.locker_room_morale != null ? career.locker_room_morale : 60;
  return fan <= FAN_THRESHOLD || morale <= MORALE_THRESHOLD;
}

async function maybeStadiumFire(db, career) {
  if (!canRiskFire(career)) return false;
  return chance(FIRE_CHANCE);
}

async function forfeitHomeMatch(db, seasonYear, kind, row) {
  const table = TABLE_BY_KIND[kind];
  if (!table) throw new Error('Tipo de partido no soportado para incendio de estadio.');

  if (HAS_WINNER_COLUMN[kind]) {
    await db
      .prepare(`UPDATE ${table} SET home_goals = 0, away_goals = 3, played = 1, winner_club_id = ? WHERE id = ?`)
      .run(row.away_club_id, row.id);
  } else {
    await db.prepare(`UPDATE ${table} SET home_goals = 0, away_goals = 3, played = 1 WHERE id = ?`).run(row.id);
  }

  // No se jugo el partido: sin lineups ni eventos, no hay progresion de
  // rating ni estadisticas de jugadores que registrar. onMatchFinished
  // (career-events, via recordMatchStats) si corre con el resultado 0-3,
  // reflejando la derrota por abandono sobre confianza/animo/hinchada.
  await recordMatchStats(db, seasonYear, row.home_club_id, row.away_club_id, {
    homeGoals: 0,
    awayGoals: 3,
    homeLineup: [],
    awayLineup: [],
    events: { homeScorers: [], awayScorers: [], cards: [] },
  });
}

module.exports = { maybeStadiumFire, forfeitHomeMatch, FIRE_CHANCE, TABLE_BY_KIND };
