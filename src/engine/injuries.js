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
  let base = 0.06;
  if (age < 23) base -= 0.015;
  else if (age >= 34) base += 0.03;
  else if (age >= 30) base += 0.015;

  if (hadInjuryLastSeason) base += 0.02; // mas propenso tras una lesion reciente (recaida)

  return Math.min(0.1, Math.max(0.015, base));
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

module.exports = { INJURY_TYPES, SEVERITIES, rollInjury, rollMatchInjury, injuryProbability };
