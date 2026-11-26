// Simulacion de partidos: fuerza de equipo a partir del rating de los jugadores
// disponibles (ajustada por formacion, tactica, cohesion y moral via
// match-model), goles via distribucion Poisson con medias dependientes de
// calidad real, y reparto de goleadores/asistencias que alimenta las
// estadisticas de temporada y la progresion de rating por rendimiento.
const { chance, randInt, weightedPick } = require('./random');
const { buildTeamProfile, expectedGoals, loadClubTactics } = require('./match-model');

function pickLineup(players) {
  // Titulares: mejor portero disponible + los 10 mejores jugadores de campo por rating.
  const available = players.filter((p) => p.status === 'activo');
  const gks = available.filter((p) => p.position === 'Portero').sort((a, b) => b.rating - a.rating);
  const outfield = available.filter((p) => p.position !== 'Portero').sort((a, b) => b.rating - a.rating);
  const lineup = [];
  if (gks[0]) lineup.push(gks[0]);
  lineup.push(...outfield.slice(0, 10));
  return lineup;
}

function teamStrength(lineup) {
  if (!lineup.length) return 45;
  return lineup.reduce((s, p) => s + p.rating, 0) / lineup.length;
}

// Poisson sampler (algoritmo de Knuth), suficiente para goles de un partido.
function samplePoisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

function pickScorer(lineup) {
  const weighted = lineup.map((p) => {
    const w =
      p.position === 'Delantero' ? 5 : p.position === 'Mediocampista' ? 3 : p.position === 'Defensa' ? 1 : 0.2;
    return { value: p, weight: w * (p.rating / 60) };
  });
  return weightedPick(weighted);
}

function pickAssister(lineup, scorer) {
  if (!chance(0.6)) return null; // no todos los goles tienen asistencia registrada
  const candidates = lineup.filter((p) => p.id !== scorer.id);
  if (!candidates.length) return null;
  const weighted = candidates.map((p) => {
    const w = p.position === 'Mediocampista' ? 4 : p.position === 'Delantero' ? 2 : p.position === 'Defensa' ? 1 : 0.1;
    return { value: p, weight: w };
  });
  return weightedPick(weighted);
}

function maybeCard(lineup) {
  // pequeña probabilidad de tarjeta por jugador en cancha
  const cards = [];
  for (const p of lineup) {
    if (chance(0.06)) cards.push({ player: p, type: chance(0.92) ? 'amarilla' : 'roja' });
  }
  return cards;
}

// Simula un partido entre dos clubes dados sus jugadores activos. `db`,
// `seasonYear`, `homeClubId`/`awayClubId` son opcionales: si se dan, el
// partido usa la tactica persistida de cada club y pondera cohesion/moral;
// si no (uso suelto/tests), cae a tactica neutra sin esos ajustes.
// Devuelve goles, goleadores/asistencias, tarjetas y los titulares de cada lado
// (para aplicar luego la progresion de rating por rendimiento).
async function simulateMatch(homePlayers, awayPlayers, ctx) {
  const { db, seasonYear, homeClubId, awayClubId } = ctx || {};
  const homeLineup = pickLineup(homePlayers);
  const awayLineup = pickLineup(awayPlayers);
  const homeStrength = teamStrength(homeLineup);
  const awayStrength = teamStrength(awayLineup);

  const homeTactics = await loadClubTactics(db, homeClubId);
  const awayTactics = await loadClubTactics(db, awayClubId);
  // Se pide la carrera una sola vez aqui (en vez de que cada lado la vuelva a
  // pedir dentro de buildTeamProfile->getManagedIdentity) y se pasa a ambos
  // perfiles: mismo dato, la mitad de round-trips contra Turso.
  const career = db ? await require('./board').getCareer(db) : null;

  const homeProfile = await buildTeamProfile({
    onFieldPlayers: homeLineup,
    lineupIds: homeLineup.map((p) => p.id),
    tactics: homeTactics,
    oppFormation: awayTactics.formation,
    db,
    clubId: homeClubId,
    seasonYear,
    ownStrength: homeStrength,
    oppStrength: awayStrength,
    career,
  });
  const awayProfile = await buildTeamProfile({
    onFieldPlayers: awayLineup,
    lineupIds: awayLineup.map((p) => p.id),
    tactics: awayTactics,
    oppFormation: homeTactics.formation,
    db,
    clubId: awayClubId,
    seasonYear,
    ownStrength: awayStrength,
    career,
    oppStrength: homeStrength,
  });

  const homeGoals = samplePoisson(expectedGoals(homeProfile, awayProfile, true));
  const awayGoals = samplePoisson(expectedGoals(awayProfile, homeProfile, false));

  const events = { homeScorers: [], awayScorers: [], cards: [] };

  for (let i = 0; i < homeGoals; i++) {
    const scorer = pickScorer(homeLineup);
    if (!scorer) continue;
    const assister = pickAssister(homeLineup, scorer);
    events.homeScorers.push({ scorer, assister });
  }
  for (let i = 0; i < awayGoals; i++) {
    const scorer = pickScorer(awayLineup);
    if (!scorer) continue;
    const assister = pickAssister(awayLineup, scorer);
    events.awayScorers.push({ scorer, assister });
  }

  events.cards.push(...maybeCard(homeLineup), ...maybeCard(awayLineup));

  return {
    homeGoals,
    awayGoals,
    homeLineup,
    awayLineup,
    homeStrength,
    awayStrength,
    events,
  };
}

// Para partidos de eliminacion directa (Copa): si hay empate se define por penales,
// con mayor probabilidad para el equipo de mayor fuerza.
function decidePenalties(homeStrength, awayStrength) {
  const total = homeStrength + awayStrength;
  return chance(homeStrength / total) ? 'home' : 'away';
}

module.exports = { simulateMatch, teamStrength, pickLineup, decidePenalties, randInt };
