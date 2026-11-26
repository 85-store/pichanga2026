const { chance } = require('./random');

const FORCED_RETIREMENT_AGE = 43; // nadie sigue jugando profesionalmente mas alla de esto

// Probabilidad base de retiro segun edad. Los porteros suelen jugar mas años.
function retirementProbability(age, position, rating) {
  if (age >= FORCED_RETIREMENT_AGE) return 1;
  if (age < 30) return 0;

  const goalkeeperBonus = position === 'Portero' ? 2 : 0; // retrasa el retiro ~2 años efectivos
  const effectiveAge = age - goalkeeperBonus;

  let base;
  if (effectiveAge < 32) base = 0.02;
  else if (effectiveAge < 34) base = 0.05;
  else if (effectiveAge < 36) base = 0.12;
  else if (effectiveAge < 38) base = 0.25;
  else if (effectiveAge < 40) base = 0.4;
  else if (effectiveAge < 42) base = 0.6;
  else base = 0.8;

  // Un rendimiento bajo empuja al retiro; uno alto permite seguir jugando mas tiempo.
  const ratingAdjustment = (65 - rating) / 200; // rating 80 -> -0.075, rating 50 -> +0.075
  return Math.min(1, Math.max(0, base + ratingAdjustment));
}

// Decide si un jugador se retira esta temporada. Devuelve boolean.
function rollRetirement({ age, position, rating }) {
  const prob = retirementProbability(age, position, rating);
  return chance(prob);
}

module.exports = { retirementProbability, rollRetirement, FORCED_RETIREMENT_AGE };
