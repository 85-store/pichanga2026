// Progresion de rating segun rendimiento: los jugadores que participan en un
// partido pueden subir o bajar de valoracion segun edad, resultado del equipo,
// si marcaron/asistieron, y su potencial (tope de crecimiento).
const { chance } = require('./random');

function growthChanceByAge(age) {
  if (age <= 20) return 0.22;
  if (age <= 23) return 0.16;
  if (age <= 27) return 0.1;
  if (age <= 30) return 0.05;
  return 0.02;
}

function declineChanceByAge(age) {
  if (age <= 23) return 0.03;
  if (age <= 27) return 0.05;
  if (age <= 31) return 0.09;
  return 0.16;
}

// resultTag: 'win' | 'draw' | 'loss'
// moraleModifier: ajuste opcional y acotado segun el ambiente del vestuario
// (sistema de acontecimientos), { growthDelta, declineDelta }.
async function applyPerformanceProgress(db, player, { resultTag, scored, assisted, cardType, age }, moraleModifier) {
  if (player.rating >= player.potential && !scored) return; // ya tocó techo, sin un golazo no sube más

  let growth = growthChanceByAge(age);
  let decline = declineChanceByAge(age);

  if (resultTag === 'win') growth += 0.05;
  if (resultTag === 'loss') decline += 0.04;
  if (scored) growth += 0.12;
  if (assisted) growth += 0.06;
  if (cardType === 'roja') decline += 0.08;
  else if (cardType === 'amarilla') decline += 0.02;
  if (moraleModifier) {
    growth = Math.max(0, growth + (moraleModifier.growthDelta || 0));
    decline = Math.max(0, decline + (moraleModifier.declineDelta || 0));
  }

  let delta = 0;
  if (player.rating < player.potential && chance(growth)) delta = 1;
  else if (chance(decline)) delta = -1;

  if (delta === 0) return;

  const newRating = Math.max(35, Math.min(player.potential, player.rating + delta));
  if (newRating === player.rating) return;

  await db.prepare('UPDATE players SET rating = ? WHERE id = ?').run(newRating, player.id);
}

module.exports = { applyPerformanceProgress };
