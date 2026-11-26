// Estima una valoracion inicial (1-99) para un jugador real cuando no se dispone
// de una calificacion oficial publica. Es un atributo de juego (como en cualquier
// simulador deportivo), no una afirmacion objetiva sobre el futbolista real.
// Se basa en la curva de edad tipica de rendimiento futbolistico y un rango base
// ajustable segun el nivel conocido del club/division.
const { randInt } = require('./random');

function ageCurveBonus(age) {
  if (age == null) return 0;
  if (age < 19) return -8;
  if (age < 22) return -4;
  if (age < 24) return -1;
  if (age <= 29) return 3; // plenitud
  if (age <= 32) return 0;
  if (age <= 35) return -4;
  return -9;
}

// baseLevel: nivel aproximado del club (0 = Primera B modesto, 1 = Primera A medio, 2 = Primera A grande)
function estimateRating({ age, baseLevel = 1 }) {
  const baseByLevel = { 0: 58, 1: 63, 2: 68 };
  const base = baseByLevel[baseLevel] ?? 63;
  const noise = randInt(-4, 4);
  const rating = base + ageCurveBonus(age) + noise;
  return Math.max(45, Math.min(88, rating));
}

function estimatePotential(rating, age) {
  if (age != null && age <= 23) {
    return Math.min(92, rating + randInt(3, 15));
  }
  return rating; // jugadores experimentados ya estan cerca de su techo
}

module.exports = { estimateRating, estimatePotential };
