const { chance, weightedPick, randInt } = require('./random');

const INJURY_TYPES = ['Muscular', 'Esguince', 'Rodilla', 'Fractura'];
const SEVERITIES = ['Leve', 'Moderada', 'Grave', 'Muy grave'];

const WEEKS_BY_SEVERITY = {
  Leve: [1, 3],
  Moderada: [4, 8],
  Grave: [9, 16],
  'Muy grave': [17, 30],
};

// Cada tipo de lesion tiene una distribucion distinta de gravedad.
const SEVERITY_WEIGHTS_BY_TYPE = {
  Muscular: [
    { value: 'Leve', weight: 55 },
    { value: 'Moderada', weight: 35 },
    { value: 'Grave', weight: 9 },
    { value: 'Muy grave', weight: 1 },
  ],
  Esguince: [
    { value: 'Leve', weight: 45 },
    { value: 'Moderada', weight: 40 },
    { value: 'Grave', weight: 13 },
    { value: 'Muy grave', weight: 2 },
  ],
  Rodilla: [
    { value: 'Leve', weight: 15 },
    { value: 'Moderada', weight: 30 },
    { value: 'Grave', weight: 35 },
    { value: 'Muy grave', weight: 20 },
  ],
  Fractura: [
    { value: 'Leve', weight: 5 },
    { value: 'Moderada', weight: 35 },
    { value: 'Grave', weight: 45 },
    { value: 'Muy grave', weight: 15 },
  ],
};

// Probabilidad base de sufrir (al menos) una lesion relevante en la temporada,
// ajustada por edad y estado fisico (aproximado por edad + historial reciente).
function injuryProbability({ age, hadInjuryLastSeason }) {
  let base = 0.035;
  if (age < 23) base -= 0.01;
  else if (age >= 34) base += 0.02;
  else if (age >= 30) base += 0.01;

  if (hadInjuryLastSeason) base += 0.012; // mas propenso tras una lesion reciente (recaida)

  return Math.min(0.06, Math.max(0.008, base));
}

function rollInjury({ age, hadInjuryLastSeason, lastInjuryType }) {
  if (!chance(injuryProbability({ age, hadInjuryLastSeason }))) return null;

  // Tras una lesion reciente del mismo tipo, hay chance de recaida especifica.
  const isRelapse = hadInjuryLastSeason && lastInjuryType && chance(0.3);
  const injuryType = isRelapse ? lastInjuryType : INJURY_TYPES[randInt(0, INJURY_TYPES.length - 1)];
  const severity = weightedPick(SEVERITY_WEIGHTS_BY_TYPE[injuryType]);
  const [min, max] = WEEKS_BY_SEVERITY[severity];
  const weeksOut = randInt(min, max) + (isRelapse ? randInt(1, 4) : 0); // recaidas se recuperan mas lento

  return { injuryType, severity, weeksOut, isRelapse: !!isRelapse };
}

// Lesion puntual durante un partido (la probabilidad de que ocurra la decide
// el motor de partido en vivo; aqui solo se resuelve tipo/gravedad/duracion).
function rollMatchInjury() {
  const injuryType = INJURY_TYPES[randInt(0, INJURY_TYPES.length - 1)];
  const severity = weightedPick(SEVERITY_WEIGHTS_BY_TYPE[injuryType]);
  const [min, max] = WEEKS_BY_SEVERITY[severity];
  const weeksOut = randInt(min, max);
  return { injuryType, severity, weeksOut };
}

// Arma (sin ejecutar) las escrituras que hacen avanzar "weeks" semanas las
// lesiones abiertas (de CUALQUIER club, no solo el del usuario): resta
// semanas y marca recuperados + reactiva el status del jugador a los que
// llegan a 0. Se devuelve como statements en vez de escribirse directo para
// que el llamador los pueda sumar a su propio batch (live-match.js, que ya
// junta todo el cierre del partido en una sola escritura) o ejecutarlos
// sueltos (los motores rapidos de liga/copa/copa de la liga/supercopa).
async function getInjuryProgressStmts(db, currentYear, weeks) {
  const openInjuries = await db.prepare('SELECT * FROM injuries WHERE recovered = 0').all();
  const stmts = [];
  for (const inj of openInjuries) {
    const remaining = inj.weeks_remaining - weeks;
    if (remaining <= 0) {
      stmts.push({ sql: 'UPDATE injuries SET weeks_remaining = 0, recovered = 1 WHERE id = ?', args: [inj.id] });
      stmts.push({ sql: "UPDATE players SET status = 'activo' WHERE id = ? AND status = 'lesionado'", args: [inj.player_id] });
      stmts.push({
        sql: `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, 'recuperacion', ?)`,
        args: [inj.player_id, currentYear, `Se recuperó de una lesión ${inj.injury_type.toLowerCase()} (${inj.severity.toLowerCase()}).`],
      });
    } else {
      stmts.push({ sql: 'UPDATE injuries SET weeks_remaining = ? WHERE id = ?', args: [remaining, inj.id] });
    }
  }
  return stmts;
}

// Antes las lesiones solo avanzaban una vez por temporada (ver
// progressInjuries en season.js), asi que un jugador lesionado a mitad de
// temporada quedaba "lesionado" en la base el resto de la temporada entera
// sin importar que su baja estimada fuera de pocas semanas - recien se curaba
// de un salto grande (por diseño) al cerrar la temporada. Esto hace avanzar 1
// semana cada vez que se juega una fecha/ronda de cualquier competicion (en
// vivo o con el motor rapido), que es la unica nocion de "tiempo" que existe
// hoy en el motor.
async function tickInjuriesOneWeek(db, currentYear) {
  const stmts = await getInjuryProgressStmts(db, currentYear, 1);
  if (stmts.length) await db.batch(stmts);
}

module.exports = {
  INJURY_TYPES,
  SEVERITIES,
  rollInjury,
  rollMatchInjury,
  injuryProbability,
  getInjuryProgressStmts,
  tickInjuriesOneWeek,
};
