// Motor de partido interactivo: simula minuto a minuto (no de una sola vez),
// manteniendo una sesion en memoria por partido para que el usuario pueda
// pausar, acelerar, cambiar tacticas y hacer cambios mientras se juega.
// Al terminar, persiste exactamente igual que el motor rapido de liga/copa.
const { chance, randInt, weightedPick } = require('./random');
const { rollMatchInjury } = require('./injuries');
const { recordMatchStats } = require('./finalize-match');
const { FORMATIONS } = require('./formations');
const { isRivalryPair } = require('./career-events');
const {
  HOME_ADVANTAGE,
  MENTALITY_ATTACK,
  MENTALITY_DEFENSE,
  STYLE_ATTACK,
  PRESSING_DEFENSE,
  teamAttackDefense,
  formationMatchup,
  cohesionFactor,
  moraleFactor,
  loadClubTactics,
  saveClubTactics,
} = require('./match-model');
const {
  getManagedIdentity,
  staticIdentityMod,
  identityCohesionBonus,
  identityMoraleAdjust,
  identityClutchMod,
} = require('./team-identity');

const PRESS_FOUL_BIAS = { bajo: -0.03, medio: 0, alto: 0.05 };
const PHASE_WEIGHTS = {
  defensivo: { defensa: 0.45, armado: 0.4, ataque: 0.15 },
  equilibrado: { defensa: 0.25, armado: 0.4, ataque: 0.35 },
  ofensivo: { defensa: 0.15, armado: 0.35, ataque: 0.5 },
};

// Tipos de incidente dinamico (tribunas/hinchas/seguridad) que pueden pausar
// o, en casos graves, terminar un partido antes de tiempo. "maxSeverityGrave"
// marca los tipos que realistamente pueden escalar a suspension definitiva;
// el resto (objetos, invasion puntual) casi siempre se resuelve en minutos.
const INCIDENT_TYPES = [
  { key: 'tribuna', label: 'Problemas en las tribunas', weight: 3, maxSeverityGrave: true },
  { key: 'objeto', label: 'Lanzamiento de objetos al campo', weight: 3, maxSeverityGrave: false },
  { key: 'hinchas', label: 'Enfrentamientos entre hinchas', weight: 2, maxSeverityGrave: true },
  { key: 'seguridad', label: 'Interrupción por problemas de seguridad', weight: 2, maxSeverityGrave: true },
  { key: 'invasion', label: 'Ingreso indebido de personas al terreno de juego', weight: 1, maxSeverityGrave: false },
];

const HALFTIME_MESSAGES = ['motivador', 'exigente', 'tactico'];

// Boost de "Inspirar jugador": sube el rating EFECTIVO del jugador elegido,
// solo para este partido (se aplica directo sobre su copia en la sesion en
// memoria, nunca se escribe en la tabla players) - un arquero inspirado sube
// mucho mas porque un gran partido suyo (atajadas clave) pesa más en el
// resultado que el de un jugador de campo.
const INSPIRE_BOOST_FIELD = 14;
const INSPIRE_BOOST_GK = 24;
const INSPIRE_RATING_CAP = 99;

const sessions = new Map();
const TABLE_BY_KIND = { league: 'fixtures', copa: 'copa_matches', supercopa: 'super_copa_matches', 'copa-liga': 'copa_liga_matches' };

// Las sesiones en memoria se indexan tambien por uid: dos usuarios distintos
// pueden tener, cada uno en su propia base, un fixture/partido con el mismo
// id (cada base de usuario arranca su autoincrement desde 1), y sin el uid en
// la clave una sesion de un usuario podria leerse o tocarse desde el partido
// de otro.
function sessionKey(uid, kind, id) {
  return `${uid}:${kind}:${id}`;
}

// Cola de ejecucion por partido: advance()/shootoutKick()/resolveIncident()/
// setTactics() hacen escrituras async a la base y pueden terminar el partido
// (finalize()). Sin esto, dos pedidos superpuestos para el mismo partido
// (p.ej. el timer del cliente disparando de nuevo antes de que vuelva la
// respuesta anterior, por latencia de red hacia Turso, o dos pestañas con el
// mismo partido abierto) corren en paralelo sobre el mismo objeto de sesion
// en memoria: ambos pueden ver atEndOfMatch=true y llamar a finalize() dos
// veces a la vez, lo que hace fallar una de las dos escrituras (choque en
// Turso) y deja al partido mostrando "El partido ya terminó" en todo intento
// posterior - la causa real de que el partido quedara pegado en el minuto
// 90 incluso con finalize() arreglado para no marcar session.finished antes
// de tiempo. Esta cola asegura que, para una misma sesion, cada pedido
// espere a que termine (bien o mal) el anterior antes de empezar el suyo.
const sessionQueues = new Map();

function runQueued(key, fn) {
  const prev = sessionQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  sessionQueues.set(key, next.catch(() => {}));
  return next;
}

function getSession(uid, kind, id) {
  return sessions.get(sessionKey(uid, kind, id));
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function buildSquad(players, formationName, customLineupIds) {
  const formation = FORMATIONS[formationName] || FORMATIONS['4-4-2'];
  const available = [...players].sort((a, b) => b.rating - a.rating);
  let pool = available;
  if (customLineupIds && customLineupIds.length) {
    const idSet = new Set(customLineupIds.map(Number));
    const chosen = available.filter((p) => idSet.has(p.id));
    if (chosen.length) pool = chosen;
  }
  const byGroup = {
    GK: pool.filter((p) => p.position === 'Portero'),
    DEF: pool.filter((p) => p.position === 'Defensa'),
    MID: pool.filter((p) => p.position === 'Mediocampista'),
    FWD: pool.filter((p) => p.position === 'Delantero'),
  };
  const used = new Set();
  const lineup = [];
  for (const slot of formation.slots) {
    let player = byGroup[slot.group].find((p) => !used.has(p.id));
    if (!player) player = pool.find((p) => !used.has(p.id));
    if (!player) continue;
    used.add(player.id);
    lineup.push({ ...player, slot: { group: slot.group, x: slot.x, y: slot.y }, fatigue: 0, onField: true, yellow: 0 });
  }
  const bench = available.filter((p) => !used.has(p.id)).map((p) => ({ ...p, fatigue: 0 }));
  return { lineup, bench };
}

function publicPlayer(p) {
  return {
    id: p.id,
    full_name: p.full_name,
    position: p.position,
    shirt_number: p.shirt_number,
    rating: p.rating,
    onField: !!p.onField,
    yellow: p.yellow || 0,
    pos: p.pos || null,
    inspired: !!p.inspired,
  };
}

function publicSide(side) {
  return {
    clubId: side.clubId,
    name: side.name,
    shortName: side.shortName,
    crestUrl: side.crestUrl,
    tactics: side.tactics,
    goals: side.goals,
    subsUsed: side.subsUsed,
    aiControlled: side.aiControlled,
    lineup: side.lineup.map(publicPlayer),
    bench: side.bench.map(publicPlayer),
  };
}

function publicShootout(session) {
  const state = session.shootoutState;
  if (!state) return null;
  return {
    turn: state.turn,
    homeScore: state.homeScore,
    awayScore: state.awayScore,
    finished: state.finished,
    winnerClubId: state.winnerClubId,
    humanTurn: sideForClub(session, session.managedClubId) === state.turn,
    kicks: state.kicks.map((k) => ({ side: k.side, player: k.playerName, scored: k.scored })),
  };
}

function publicView(session) {
  return {
    kind: session.kind,
    id: session.id,
    seasonYear: session.seasonYear,
    minute: session.minute,
    half: session.half,
    stoppageTarget: session.secondHalfTarget,
    firstHalfTarget: session.firstHalfTarget,
    finished: session.finished,
    managedClubId: session.managedClubId,
    home: publicSide(session.home),
    away: publicSide(session.away),
    stats: session.stats,
    pause: session.pause || null,
    pendingPenalty: session.pendingPenalty ? { side: session.pendingPenalty.side } : null,
    shootout: publicShootout(session),
    inspiredUsed: !!session.inspiredUsed,
  };
}

// Tension ambiental de la hinchada de un lado para este partido en particular:
// combina la campaña (board_confidence de la carrera, cuando el lado es el
// club que dirige el usuario), si es un clasico, y si el cruce es de
// eliminacion directa (mayor importancia). Un jitter final representa el
// "estado de animo" variable de la gente, para que no sea siempre igual entre
// partidos equivalentes. Se usa solo para escalar que tan probable es un
// incidente dinamico en el partido (nunca para forzarlo).
async function computeCrowdTension(db, session, sideKey) {
  const side = session[sideKey];
  const opp = session[otherSide(sideKey)];
  let tension = 1;
  try {
    const career = await db.prepare('SELECT board_confidence FROM career WHERE id = 1 AND club_id = ?').get(side.clubId);
    if (career && career.board_confidence != null && career.board_confidence < 45) {
      tension += (45 - career.board_confidence) / 35; // mala campaña -> hinchada mas tensa
    }
  } catch {
    // tabla career inexistente u otra situacion rara: se ignora, queda en 1.
  }
  if (isRivalryPair(side.name, opp.name)) tension *= 1.7;
  if (session.kind === 'copa' || session.kind === 'supercopa' || session.clStage === 'final' || session.clStage === 'semifinal') {
    tension *= 1.25;
  }
  tension *= randRange(0.85, 1.15);
  return Math.max(0.5, Math.min(3, tension));
}

async function startMatch(uid, db, kind, id, seasonYear, options) {
  const { managedClubId, lineup, formation } = options || {};
  const key = sessionKey(uid, kind, id);
  if (sessions.has(key)) {
    const existing = sessions.get(key);
    return { view: publicView(existing), frames: [frameAt(existing, 0, null, null, [])] };
  }

  const table = TABLE_BY_KIND[kind] || 'fixtures';
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new Error('Partido no encontrado.');
  if (row.played) throw new Error('Este partido ya fue jugado.');
  if (kind !== 'league' && (!row.home_club_id || !row.away_club_id)) {
    throw new Error('Este cruce todavia no tiene ambos equipos definidos.');
  }

  const homeClub = await db.prepare('SELECT * FROM clubs WHERE id = ?').get(row.home_club_id);
  const awayClub = await db.prepare('SELECT * FROM clubs WHERE id = ?').get(row.away_club_id);
  const homePlayers = await db.prepare("SELECT * FROM players WHERE club_id = ? AND status = 'activo'").all(row.home_club_id);
  const awayPlayers = await db.prepare("SELECT * FROM players WHERE club_id = ? AND status = 'activo'").all(row.away_club_id);

  const homeTactics = await loadClubTactics(db, homeClub.id);
  const awayTactics = await loadClubTactics(db, awayClub.id);
  const homeIsManaged = managedClubId != null && homeClub.id === managedClubId;
  const awayIsManaged = managedClubId != null && awayClub.id === managedClubId;
  if (formation && homeIsManaged) homeTactics.formation = formation;
  if (formation && awayIsManaged) awayTactics.formation = formation;
  // La formacion elegida en la planilla pasa a ser la tactica "de cabecera"
  // del club, para que el motor rapido tambien la use en partidos futuros.
  if (formation && homeIsManaged) await saveClubTactics(db, homeClub.id, homeTactics);
  if (formation && awayIsManaged) await saveClubTactics(db, awayClub.id, awayTactics);
  const homeSquad = buildSquad(homePlayers, homeTactics.formation, homeIsManaged ? lineup : null);
  const awaySquad = buildSquad(awayPlayers, awayTactics.formation, awayIsManaged ? lineup : null);

  const identityCareer = await require('./board').getCareer(db);
  const homeIdentity = await getManagedIdentity(db, homeClub.id, identityCareer);
  const awayIdentity = await getManagedIdentity(db, awayClub.id, identityCareer);
  const homeCohesion = Math.min(1.1, (await cohesionFactor(db, homeClub.id, homeSquad.lineup.map((p) => p.id), seasonYear)) + identityCohesionBonus(homeIdentity));
  const awayCohesion = Math.min(1.1, (await cohesionFactor(db, awayClub.id, awaySquad.lineup.map((p) => p.id), seasonYear)) + identityCohesionBonus(awayIdentity));
  const homeMorale = identityMoraleAdjust(homeIdentity, await moraleFactor(db, homeClub.id, seasonYear));
  const awayMorale = identityMoraleAdjust(awayIdentity, await moraleFactor(db, awayClub.id, seasonYear));
  const avgRating = (players) => (players.length ? players.reduce((s, p) => s + p.rating, 0) / players.length : 55);
  const homeRating = avgRating(homeSquad.lineup);
  const awayRating = avgRating(awaySquad.lineup);
  const homeIsUnderdog = homeRating < awayRating - 1;
  const awayIsUnderdog = awayRating < homeRating - 1;

  const session = {
    key,
    kind,
    id,
    rowId: row.id,
    seasonYear,
    clStage: kind === 'copa-liga' ? row.stage : null,
    managedClubId: managedClubId != null ? managedClubId : null,
    minute: 0,
    half: 1,
    firstHalfTarget: null,
    secondHalfTarget: null,
    pause: null,
    pendingPenalty: null,
    shootoutState: null,
    inspiredUsed: false,
    inspiredPlayerId: null,
    halfEventCount: { 1: 0, 2: 0 },
    incidentCooldownUntil: 8, // casi nunca en los primeros minutos del partido
    finished: false,
    home: {
      clubId: homeClub.id,
      name: homeClub.name,
      shortName: homeClub.short_name,
      crestUrl: homeClub.crest_url,
      tactics: homeTactics,
      lineup: homeSquad.lineup,
      bench: homeSquad.bench,
      goals: 0,
      subsUsed: 0,
      formFactor: homeCohesion * homeMorale,
      identity: homeIdentity,
      staticIdentityMod: staticIdentityMod(homeIdentity, homeIsUnderdog),
      aiControlled: !homeIsManaged,
      everPlayed: new Map(homeSquad.lineup.map((p) => [p.id, p])),
    },
    away: {
      clubId: awayClub.id,
      name: awayClub.name,
      shortName: awayClub.short_name,
      crestUrl: awayClub.crest_url,
      tactics: awayTactics,
      lineup: awaySquad.lineup,
      bench: awaySquad.bench,
      goals: 0,
      subsUsed: 0,
      formFactor: awayCohesion * awayMorale,
      identity: awayIdentity,
      staticIdentityMod: staticIdentityMod(awayIdentity, awayIsUnderdog),
      aiControlled: !awayIsManaged,
      everPlayed: new Map(awaySquad.lineup.map((p) => [p.id, p])),
    },
    stats: {
      home: { shots: 0, onTarget: 0, corners: 0, fouls: 0, yellow: 0, red: 0, possession: 0 },
      away: { shots: 0, onTarget: 0, corners: 0, fouls: 0, yellow: 0, red: 0, possession: 0 },
    },
    scorers: { home: [], away: [] },
    cards: [],
    injuries: [],
  };

  session.crowdTension = {
    home: await computeCrowdTension(db, session, 'home'),
    away: await computeCrowdTension(db, session, 'away'),
  };

  computePositions(session, null, 'armado');
  sessions.set(key, session);
  return { view: publicView(session), frames: [frameAt(session, 0, null, null, [])] };
}

function effectiveStrength(side) {
  const onField = side.lineup.filter((p) => p.onField);
  if (!onField.length) return 40;
  const sum = onField.reduce((s, p) => s + p.rating * (1 - p.fatigue / 260), 0);
  return sum / onField.length;
}

// Perfil de ataque/defensa de un lado para el minuto actual: calidad real del
// 11 en cancha (con el cansancio acumulado restando), ajustada por la ventaja
// numerica de su formacion frente a la rival, su mentalidad/estilo/presion, y
// la cohesion+moral fijadas al inicio del partido. Esto es lo que hace que
// formacion y tactica, y no solo el azar, decidan remates y posesion.
function sideProfile(session, sideKey) {
  const side = session[sideKey];
  const opp = session[otherSide(sideKey)];
  const onField = side.lineup.filter((p) => p.onField).map((p) => ({ ...p, rating: p.rating * (1 - p.fatigue / 260) }));
  const base = teamAttackDefense(onField);
  const matchup = formationMatchup(side.tactics.formation, opp.tactics.formation);
  const mentAtk = MENTALITY_ATTACK[side.tactics.mentality] || 0;
  const mentDef = MENTALITY_DEFENSE[side.tactics.mentality] || 0;
  const styleAtk = STYLE_ATTACK[side.tactics.style] || 0;
  const pressDef = PRESSING_DEFENSE[side.tactics.pressing] || 0;
  const form = side.formFactor || 1;
  const staticMod = side.staticIdentityMod || { attack: 0, defense: 0 };
  const goalDiff = side.goals - opp.goals;
  const clutchMod = identityClutchMod(side.identity, session.minute, goalDiff);
  return {
    attack: base.attack * (1 + matchup.attackMod + mentAtk + styleAtk + staticMod.attack + clutchMod.attack) * form,
    defense: base.defense * (1 + matchup.defenseMod + mentDef + pressDef + staticMod.defense + clutchMod.defense) * form,
  };
}

// Reaccion simple de la IA (equipos que el usuario no controla): si va
// perdiendo por 2+ pasado el minuto 60 se vuelve mas ofensiva; si va ganando
// comodo pasado el minuto 75, protege el resultado.
function applyAiAdjustments(session) {
  for (const sideKey of ['home', 'away']) {
    const side = session[sideKey];
    if (!side.aiControlled) continue;
    const opp = session[otherSide(sideKey)];
    const diff = side.goals - opp.goals;
    if (session.minute === 61 && diff <= -2 && side.tactics.mentality !== 'ofensivo') {
      side.tactics = { ...side.tactics, mentality: 'ofensivo', pressing: 'alto' };
    } else if (session.minute === 76 && diff >= 2 && side.tactics.mentality !== 'defensivo') {
      side.tactics = { ...side.tactics, mentality: 'defensivo', pressing: 'bajo' };
    }
  }
}

function weightedSide(sidePlayers, groupWeights, fallbackWeight) {
  const options = sidePlayers
    .filter((p) => p.onField && p.position !== 'Portero')
    .map((p) => ({ value: p, weight: (groupWeights[p.position] ?? fallbackWeight) * (p.rating / 60) }));
  if (!options.length) return null;
  return weightedPick(options);
}

function absX(side, relX) {
  return side === 'home' ? relX : 100 - relX;
}

function computePositions(session, possessionSide, phase) {
  for (const sideKey of ['home', 'away']) {
    const side = session[sideKey];
    const isPossession = possessionSide === sideKey;
    const localPhase = isPossession ? phase : phase === 'ataque' ? 'defensa' : phase === 'defensa' ? 'ataque' : 'armado';
    for (const p of side.lineup) {
      if (!p.onField) continue;
      let shiftX = 0;
      if (localPhase === 'ataque') shiftX = 13;
      else if (localPhase === 'armado') shiftX = 5;
      else shiftX = -6;
      const jitterX = (Math.random() - 0.5) * 5;
      const jitterY = (Math.random() - 0.5) * 7;
      const relX = Math.max(3, Math.min(97, p.slot.x + shiftX + jitterX));
      const relY = Math.max(4, Math.min(96, p.slot.y + jitterY));
      p.pos = { x: Math.round(absX(sideKey, relX) * 10) / 10, y: Math.round(relY * 10) / 10 };
    }
  }
}

function ballPosition(session, possessionSide, focusPlayer) {
  if (focusPlayer && focusPlayer.pos) return { ...focusPlayer.pos };
  if (!possessionSide) return { x: 50, y: 50 };
  const side = session[possessionSide];
  const advanced = side.lineup
    .filter((p) => p.onField && p.position !== 'Portero')
    .sort((a, b) => (possessionSide === 'home' ? b.pos.x - a.pos.x : a.pos.x - b.pos.x))
    .slice(0, 3);
  if (!advanced.length) return { x: 50, y: 50 };
  const x = advanced.reduce((s, p) => s + p.pos.x, 0) / advanced.length;
  const y = advanced.reduce((s, p) => s + p.pos.y, 0) / advanced.length;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

function otherSide(sideKey) {
  return sideKey === 'home' ? 'away' : 'home';
}

function tryAutoSubstitute(session, sideKey, outPlayer) {
  const side = session[sideKey];
  if (side.subsUsed >= 5) return null;
  const pool = side.bench.filter((p) => !p.used);
  if (!pool.length) return null;
  let replacement = pool.find((p) => p.position === outPlayer.position);
  if (!replacement) replacement = pool[0];
  replacement.used = true;
  replacement.onField = true;
  replacement.fatigue = 0;
  replacement.yellow = 0;
  replacement.slot = outPlayer.slot;
  replacement.pos = outPlayer.pos;
  outPlayer.onField = false;
  side.lineup = side.lineup.map((p) => (p.id === outPlayer.id ? outPlayer : p));
  side.lineup.push(replacement);
  side.everPlayed.set(replacement.id, replacement);
  side.subsUsed += 1;
  return replacement;
}

// Ejecuta un penal ya con lanzador definido (elegido por el usuario o, para
// el lado que controla la IA, por weightedSide) y aplica el resultado al
// marcador. Se usa tanto en jugadas vivas como al resolver un penal pendiente.
function resolvePenaltyKick(session, side, taker, minute, events) {
  const defSide = otherSide(side);
  const keeper = session[defSide].lineup.find((p) => p.onField && p.position === 'Portero');
  const keeperRating = keeper ? keeper.rating : 45;
  const goalProb = Math.max(0.45, Math.min(0.9, 0.68 + (taker.rating - keeperRating) / 300));
  const scored = chance(goalProb);
  if (scored) {
    events.push({ minute, type: 'penal', team: side, playerId: taker.id, player: taker.full_name, result: 'gol' });
    registerGoal(session, side, taker, events, minute, true);
  } else {
    events.push({ minute, type: 'penal', team: side, playerId: taker.id, player: taker.full_name, result: 'fallado' });
  }
  return scored;
}

function simulateMinute(session) {
  session.minute += 1;
  const minute = session.minute;
  const events = [];

  for (const sideKey of ['home', 'away']) {
    for (const p of session[sideKey].lineup) {
      if (!p.onField) continue;
      const wear = p.position === 'Delantero' || p.position === 'Mediocampista' ? 1.05 : 0.8;
      p.fatigue = Math.min(100, p.fatigue + wear);
    }
  }

  applyAiAdjustments(session);

  const homeProfile = sideProfile(session, 'home');
  const awayProfile = sideProfile(session, 'away');

  // Posesion: controla el lado que combina mejor ataque+defensa (localia
  // moderada solo para el local), no el promedio de rating en bruto.
  const homeOverall = (homeProfile.attack + homeProfile.defense) / 2;
  const awayOverall = (awayProfile.attack + awayProfile.defense) / 2;
  const weightHome = Math.max(5, homeOverall * (1 + HOME_ADVANTAGE));
  const weightAway = Math.max(5, awayOverall);
  const possessionSide = chance(weightHome / (weightHome + weightAway)) ? 'home' : 'away';
  const defSide = otherSide(possessionSide);

  const possProfile = possessionSide === 'home' ? homeProfile : awayProfile;
  const defProfile = possessionSide === 'home' ? awayProfile : homeProfile;
  const possStrength = possProfile.attack;
  const defStrength = defProfile.defense;
  const mentality = session[possessionSide].tactics.mentality;
  const weights = PHASE_WEIGHTS[mentality] || PHASE_WEIGHTS.equilibrado;
  // Ademas de la mentalidad, un ataque claramente superior a la defensa rival
  // gana algo mas de peso para llegar a fase de ataque (no solo depende de
  // la actitud elegida, tambien de si la calidad real lo respalda).
  const qualityTilt = Math.max(-0.5, Math.min(0.5, (possStrength - defStrength) / 160));
  const phase = weightedPick([
    { value: 'defensa', weight: Math.max(0.05, weights.defensa - qualityTilt * 0.3) },
    { value: 'armado', weight: weights.armado },
    { value: 'ataque', weight: Math.max(0.05, weights.ataque + qualityTilt * 0.3) },
  ]);

  computePositions(session, possessionSide, phase);
  session.stats[possessionSide].possession += 1;

  let focusPlayer = null;

  if (phase === 'ataque') {
    const style = session[possessionSide].tactics.style;
    const styleBonus = style === 'directo' ? 0.05 : style === 'contragolpe' ? 0.03 : 0.015;
    let shotChance = 0.2 + (possStrength - defStrength) / 140 + styleBonus;
    shotChance = Math.max(0.05, Math.min(0.62, shotChance));

    if (chance(shotChance)) {
      const shooter = weightedSide(
        session[possessionSide].lineup,
        { Delantero: 5, Mediocampista: 3, Defensa: 1 },
        0.5
      );
      if (shooter) {
        focusPlayer = shooter;
        session.stats[possessionSide].shots += 1;
        const onTarget = chance(0.5 + (shooter.rating - 60) / 300);
        if (!onTarget) {
          events.push({ minute, type: 'remate', team: possessionSide, playerId: shooter.id, player: shooter.full_name, detail: 'afuera' });
        } else {
          session.stats[possessionSide].onTarget += 1;
          const keeper = session[defSide].lineup.find((p) => p.onField && p.position === 'Portero');
          const keeperRating = keeper ? keeper.rating : 45;
          const saveProb = Math.max(0.08, Math.min(0.65, 0.3 + (keeperRating - shooter.rating) / 160));
          if (chance(saveProb)) {
            events.push({ minute, type: 'atajada', team: defSide, playerId: keeper ? keeper.id : null, player: keeper ? keeper.full_name : 'Portero', shooter: shooter.full_name });
          } else {
            let goalStands = true;
            if (chance(0.04)) {
              const confirmed = chance(0.8);
              events.push({ minute, type: 'var', team: possessionSide, result: confirmed ? 'confirmado' : 'anulado', player: shooter.full_name });
              goalStands = confirmed;
            }
            if (goalStands) {
              registerGoal(session, possessionSide, shooter, events, minute);
            }
          }
        }
      }
    } else if (chance(0.07)) {
      session.stats[possessionSide].corners += 1;
      events.push({ minute, type: 'corner', team: possessionSide });
    }
  }

  const pressing = session[defSide].tactics.pressing;
  let foulChance = 0.09 + (PRESS_FOUL_BIAS[pressing] || 0);
  if (chance(Math.max(0.02, foulChance))) {
    const fouler = weightedSide(session[defSide].lineup, { Defensa: 4, Mediocampista: 3, Delantero: 1 }, 0.8);
    if (fouler) {
      focusPlayer = focusPlayer || fouler;
      session.stats[defSide].fouls += 1;
      events.push({ minute, type: 'falta', team: defSide, playerId: fouler.id, player: fouler.full_name });

      if (phase === 'ataque' && chance(0.05)) {
        // Penal cobrado: si el lado atacante lo dirige el usuario, se pausa de
        // inmediato el partido para que elija quien lo patea; si lo controla
        // la IA, se resuelve enseguida igual que antes.
        if (!session[possessionSide].aiControlled) {
          session.pendingPenalty = { side: possessionSide, minute };
          events.push({ minute, type: 'penal_pendiente', team: possessionSide });
          return { frame: frameAt(session, minute, possessionSide, phase, events), events, pause: { type: 'penalty' } };
        }
        const taker = weightedSide(session[possessionSide].lineup, { Delantero: 5, Mediocampista: 2 }, 0.5) || focusPlayer;
        resolvePenaltyKick(session, possessionSide, taker, minute, events);
      } else if (chance(0.015)) {
        sendOff(session, defSide, fouler, events, minute, true);
      } else if (chance(0.16)) {
        fouler.yellow += 1;
        if (fouler.yellow >= 2) {
          sendOff(session, defSide, fouler, events, minute, false);
        } else {
          session.stats[defSide].yellow += 1;
          session.cards.push({ player: fouler, type: 'amarilla' });
          events.push({ minute, type: 'tarjeta', card: 'amarilla', team: defSide, playerId: fouler.id, player: fouler.full_name });
        }
      }
    }
  }

  for (const sideKey of ['home', 'away']) {
    for (const p of session[sideKey].lineup) {
      if (!p.onField) continue;
      // Los porteros no sufren lesiones durante el partido: al haber uno solo
      // por plantel (normalmente), una lesion lo deja fuera de la posicion por
      // semanas y rompe la alineacion del club. Se excluyen de este chequeo.
      if (p.position === 'Portero') continue;
      if (chance(0.00055)) {
        const injury = rollMatchInjury();
        session.injuries.push({ player: p, injury, minute });
        session.halfEventCount[session.half] = (session.halfEventCount[session.half] || 0) + 1;
        p.onField = false;
        events.push({
          minute,
          type: 'lesion',
          team: sideKey,
          playerId: p.id,
          player: p.full_name,
          detail: `${injury.injuryType} (${injury.severity})`,
        });
        const replacement = tryAutoSubstitute(session, sideKey, p);
        if (replacement) {
          events.push({ minute, type: 'cambio', team: sideKey, outId: p.id, out: p.full_name, inId: replacement.id, in: replacement.full_name, forced: true });
        }
        break;
      }
    }
  }

  const ball = ballPosition(session, possessionSide, focusPlayer);
  return { frame: frameAt(session, minute, possessionSide, phase, events, ball), events };
}

function registerGoal(session, side, scorer, events, minute, isPenalty) {
  session[side].goals += 1;
  session.halfEventCount[session.half] = (session.halfEventCount[session.half] || 0) + 1;
  let assister = null;
  if (!isPenalty && chance(0.58)) {
    const candidates = session[side].lineup.filter((p) => p.onField && p.id !== scorer.id && p.position !== 'Portero');
    if (candidates.length) {
      const weighted = candidates.map((p) => ({
        value: p,
        weight: (p.position === 'Mediocampista' ? 4 : p.position === 'Delantero' ? 2 : 1) * (p.rating / 60),
      }));
      assister = weightedPick(weighted);
    }
  }
  session.scorers[side].push({ scorer, assister });
  events.push({
    minute,
    type: 'gol',
    team: side,
    playerId: scorer.id,
    player: scorer.full_name,
    assistId: assister ? assister.id : null,
    assist: assister ? assister.full_name : null,
    scoreHome: session.home.goals,
    scoreAway: session.away.goals,
  });
}

function sendOff(session, sideKey, player, events, minute, straight) {
  player.onField = false;
  session.stats[sideKey].red += 1;
  session.halfEventCount[session.half] = (session.halfEventCount[session.half] || 0) + 1;
  session.cards.push({ player, type: 'roja' });
  events.push({
    minute,
    type: 'tarjeta',
    card: 'roja',
    team: sideKey,
    playerId: player.id,
    player: player.full_name,
    detail: straight ? 'directa' : 'doble amarilla',
  });
}

function frameAt(session, minute, possessionSide, phase, events, ballOverride) {
  const ball = ballOverride || ballPosition(session, possessionSide, null);
  return {
    minute,
    phase,
    possession: possessionSide,
    ball,
    scoreHome: session.home.goals,
    scoreAway: session.away.goals,
    home: session.home.lineup.filter((p) => p.onField).map((p) => ({ id: p.id, x: p.pos.x, y: p.pos.y, num: p.shirt_number, pos: p.position })),
    away: session.away.lineup.filter((p) => p.onField).map((p) => ({ id: p.id, x: p.pos.x, y: p.pos.y, num: p.shirt_number, pos: p.position })),
    events: events || [],
  };
}

// Tiempo de descuento (45+N / 90+N): no es un rango fijo, depende de cuantas
// interrupciones (goles, lesiones, rojas, incidentes) hubo en esa mitad -
// mientras mas pasó, mas minutos agrega el arbitro.
function computeStoppage(session, half) {
  const count = session.halfEventCount[half] || 0;
  const extra = Math.min(5, Math.floor(count / 1.5));
  return randInt(1, 2) + extra;
}

function baseHalfMinute(session) {
  return session.half === 1 ? 45 : 90;
}

function currentHalfTarget(session) {
  return session.half === 1 ? session.firstHalfTarget : session.secondHalfTarget;
}

function isKnockout(session) {
  return session.kind === 'copa' || session.kind === 'supercopa' || (session.kind === 'copa-liga' && session.clStage === 'final');
}

function pickAiHalftimeMessage(session, sideKey) {
  const side = session[sideKey];
  const opp = session[otherSide(sideKey)];
  const diff = side.goals - opp.goals;
  if (diff < 0) return 'motivador';
  if (diff === 0) return chance(0.5) ? 'exigente' : 'tactico';
  return 'tactico';
}

// Mensaje de camarin al entretiempo: el efecto (sobre el formFactor del lado,
// que ya combina cohesion+moral) depende del tipo de mensaje, el resultado
// parcial y la calidad relativa del plantel, con un componente de azar para
// que nunca este garantizado que funcione (puede incluso ser contraproducente).
function applyHalftimeTalk(session, sideKey, messageType) {
  const side = session[sideKey];
  const opp = session[otherSide(sideKey)];
  const diff = side.goals - opp.goals;
  const favorite = effectiveStrength(side) >= effectiveStrength(opp);
  let delta;

  if (messageType === 'motivador') {
    if (diff < 0) delta = chance(0.7) ? randRange(0.03, 0.09) : -randRange(0, 0.02);
    else if (diff === 0) delta = chance(0.6) ? randRange(0.02, 0.06) : -randRange(0, 0.015);
    else delta = chance(0.35) ? randRange(0.01, 0.03) : -randRange(0, 0.03); // riesgo de relajo si ya se ganaba
  } else if (messageType === 'exigente') {
    if (favorite && diff <= 0) delta = chance(0.6) ? randRange(0.04, 0.1) : -randRange(0.01, 0.05);
    else delta = chance(0.45) ? randRange(0.02, 0.05) : -randRange(0.01, 0.04); // puede generar ansiedad
  } else {
    // tactico: efecto mas chico pero mas confiable, no depende del marcador.
    delta = chance(0.75) ? randRange(0.015, 0.045) : -randRange(0, 0.015);
  }

  side.formFactor = Math.max(0.7, Math.min(1.35, side.formFactor + delta));
  return { messageType, delta: Math.round(delta * 1000) / 1000 };
}

// Entra al entretiempo: aplica automaticamente el mensaje del lado que
// controla la IA, y deja pendiente (pausando el partido) el mensaje del lado
// que dirige el usuario, si hay uno en este partido.
function startHalftime(session) {
  const humanSide = sideForClub(session, session.managedClubId);
  for (const sideKey of ['home', 'away']) {
    if (sideKey !== humanSide) applyHalftimeTalk(session, sideKey, pickAiHalftimeMessage(session, sideKey));
  }
  session.half = 2;
  if (humanSide) session.pause = { type: 'halftime', side: humanSide };
}

// Posible incidente dinamico (tribunas, objetos, hinchas, seguridad,
// invasion) para este minuto. Muy poco frecuente en un partido neutro; sube
// con la tension ambiental (clasico, campaña mala, importancia del cruce),
// pero nunca se fuerza. Solo aplica si hay un club dirigido por el usuario en
// el partido (es parte de la experiencia interactiva del "Ver", no del motor
// rapido de IA vs IA).
function maybeTriggerIncident(session) {
  if (session.managedClubId == null) return null;
  if (session.minute < session.incidentCooldownUntil) return null;
  const tension = Math.max(session.crowdTension.home, session.crowdTension.away);
  const baseProb = 0.00025;
  const prob = Math.min(0.0035, baseProb * tension);
  if (!chance(prob)) return null;

  const incidentDef = weightedPick(INCIDENT_TYPES.map((t) => ({ value: t, weight: t.weight })));
  const graveChance = incidentDef.maxSeverityGrave ? 0.12 * Math.min(1.6, tension) : 0.03;
  const severity = chance(graveChance) ? 'grave' : 'leve';
  const minutesLost = severity === 'grave' ? 0 : randInt(2, 5);
  session.incidentCooldownUntil = session.minute + 20;
  session.halfEventCount[session.half] = (session.halfEventCount[session.half] || 0) + 1;

  return {
    type: 'incident',
    payload: {
      incidentType: incidentDef.key,
      label: incidentDef.label,
      severity,
      minutesLost,
      refereeNote:
        severity === 'grave'
          ? 'El árbitro consulta con seguridad y evalúa la suspensión definitiva del encuentro.'
          : 'El árbitro detiene el juego mientras el personal de seguridad controla la situación.',
    },
  };
}

// Determina si la tanda de penales ya tiene ganador segun sus reglas: primero
// 5 lanzamientos por lado (con corte anticipado si ya es matematicamente
// imposible empatar), luego muerte subita de 1 en 1 hasta que se rompa el
// empate tras igual numero de lanzamientos por lado.
function shootoutWinner(state, session) {
  const homeTaken = state.kicks.filter((k) => k.side === 'home').length;
  const awayTaken = state.kicks.filter((k) => k.side === 'away').length;
  if (homeTaken <= 5 || awayTaken <= 5) {
    const homeRemaining = Math.max(0, 5 - homeTaken);
    const awayRemaining = Math.max(0, 5 - awayTaken);
    if (state.homeScore > state.awayScore + awayRemaining) return session.home.clubId;
    if (state.awayScore > state.homeScore + homeRemaining) return session.away.clubId;
    if (homeTaken === 5 && awayTaken === 5 && state.homeScore !== state.awayScore) {
      return state.homeScore > state.awayScore ? session.home.clubId : session.away.clubId;
    }
    return null;
  }
  if (homeTaken === awayTaken && state.homeScore !== state.awayScore) {
    return state.homeScore > state.awayScore ? session.home.clubId : session.away.clubId;
  }
  return null;
}

// Arranca la tanda de penales interactiva para definir un cruce de eliminacion
// que termino empatado. Solo se usa si hay un club dirigido por el usuario en
// el partido (si no, finalize() recurre al desenlace aleatorio de siempre).
function initShootout(session) {
  const firstSide = chance(0.5) ? 'home' : 'away';
  session.shootoutState = {
    turn: firstSide,
    kicks: [],
    homeScore: 0,
    awayScore: 0,
    takenIds: { home: new Set(), away: new Set() },
    finished: false,
    winnerClubId: null,
  };
  session.pause = { type: 'shootout' };
}

async function finalize(db, session, opts) {
  // OJO: session.finished se marca recien al final (justo antes de borrar la
  // sesion), no aca arriba. Si se marcara aca y despues fallara alguna de las
  // escrituras de abajo (por ejemplo un corte de red momentaneo hablando con
  // Turso), la sesion quedaba "terminada" en memoria para siempre sin haberse
  // guardado nada: todo intento de avanzar despues chocaba con "El partido ya
  // terminó" (el chequeo de mas abajo en advance()) en vez de poder
  // reintentar, dejando el partido pegado sin forma de recuperarlo.
  const homeEver = [...session.home.everPlayed.values()];
  const awayEver = [...session.away.everPlayed.values()];

  // recordMatchStats() dispara, como efecto de lado, el sistema de
  // acontecimientos (career-events.js: reuniones con el gerente, polemicas,
  // etc.), que incrementa el contador de partidos dirigidos y crea eventos
  // nuevos cada vez que se llama. Si finalize() fallaba MAS ADELANTE (p.ej.
  // al guardar el resultado del fixture, por un corte de red) y se
  // reintentaba, este bloque se volvia a ejecutar desde cero y generaba una
  // reunion (u otro acontecimiento) duplicada cada vez - el motivo real de
  // "me cita todo el rato a las mismas reuniones". Se marca con un flag en la
  // sesion para que, aunque finalize() se reintente, esto corra una sola vez.
  if (!session.statsRecorded) {
    await recordMatchStats(db, session.seasonYear, session.home.clubId, session.away.clubId, {
      homeGoals: session.home.goals,
      awayGoals: session.away.goals,
      homeLineup: homeEver,
      awayLineup: awayEver,
      events: {
        homeScorers: session.scorers.home,
        awayScorers: session.scorers.away,
        cards: session.cards,
      },
    });
    session.statsRecorded = true;
  }

  const knockout = isKnockout(session);
  let decidedByPenalties = 0;
  let winnerClubId = null;
  if (session.shootoutState && session.shootoutState.finished) {
    decidedByPenalties = 1;
    winnerClubId = session.shootoutState.winnerClubId;
  } else if (knockout && session.home.goals === session.away.goals) {
    // Sin tanda interactiva disponible (p.ej. partido sin club dirigido por el
    // usuario): se mantiene el desenlace rapido de siempre.
    decidedByPenalties = 1;
    const hs = effectiveStrength(session.home);
    const as = effectiveStrength(session.away);
    winnerClubId = chance(hs / (hs + as)) ? session.home.clubId : session.away.clubId;
  } else if (knockout) {
    winnerClubId = session.home.goals > session.away.goals ? session.home.clubId : session.away.clubId;
  }

  // Escritura final del resultado + lesiones en un solo batch (una llamada a
  // Turso) en vez de 2-3 round-trips awaiteados por lesion mas la del
  // resultado: esto era lo que hacia sentir "pegado" el partido justo al
  // llegar al minuto final, mientras el cliente esperaba esta respuesta.
  const finalizeStmts = [];
  if (session.kind === 'supercopa') {
    finalizeStmts.push({
      sql: `UPDATE super_copa_matches SET home_goals = ?, away_goals = ?, played = 1, decided_by_penalties = ?, winner_club_id = ? WHERE id = ?`,
      args: [session.home.goals, session.away.goals, decidedByPenalties, winnerClubId, session.rowId],
    });
    finalizeStmts.push({
      sql: `INSERT INTO club_titles (club_id, season_year, title_name) VALUES (?, ?, ?)`,
      args: [winnerClubId, session.seasonYear, 'Campeón Supercopa'],
    });
  } else if (session.kind === 'copa') {
    finalizeStmts.push({
      sql: `UPDATE copa_matches SET home_goals = ?, away_goals = ?, played = 1, decided_by_penalties = ?, winner_club_id = ? WHERE id = ?`,
      args: [session.home.goals, session.away.goals, decidedByPenalties, winnerClubId, session.rowId],
    });
  } else if (session.kind === 'copa-liga') {
    finalizeStmts.push({
      sql: `UPDATE copa_liga_matches SET home_goals = ?, away_goals = ?, played = 1, decided_by_penalties = ?, winner_club_id = ? WHERE id = ?`,
      args: [session.home.goals, session.away.goals, decidedByPenalties, winnerClubId, session.rowId],
    });
  } else {
    finalizeStmts.push({
      sql: 'UPDATE fixtures SET home_goals = ?, away_goals = ?, played = 1 WHERE id = ?',
      args: [session.home.goals, session.away.goals, session.rowId],
    });
  }

  for (const inj of session.injuries) {
    finalizeStmts.push({
      sql: `INSERT INTO injuries (player_id, season_year, injury_type, severity, weeks_out, weeks_remaining, is_relapse, started_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`,
      args: [inj.player.id, session.seasonYear, inj.injury.injuryType, inj.injury.severity, inj.injury.weeksOut, inj.injury.weeksOut],
    });
    finalizeStmts.push({
      sql: "UPDATE players SET status = 'lesionado' WHERE id = ?",
      args: [inj.player.id],
    });
    finalizeStmts.push({
      sql: `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, 'lesion', ?)`,
      args: [
        inj.player.id,
        session.seasonYear,
        `Se lesionó durante un partido (minuto ${inj.minute}): ${inj.injury.injuryType.toLowerCase()} de gravedad ${inj.injury.severity.toLowerCase()}.`,
      ],
    });
  }
  await db.batch(finalizeStmts);

  const summary = {
    homeGoals: session.home.goals,
    awayGoals: session.away.goals,
    decidedByPenalties: !!decidedByPenalties,
    winnerClubId,
    scorers: {
      home: session.scorers.home.map((s) => ({ scorer: s.scorer.full_name, assist: s.assister ? s.assister.full_name : null })),
      away: session.scorers.away.map((s) => ({ scorer: s.scorer.full_name, assist: s.assister ? s.assister.full_name : null })),
    },
    cards: session.cards.map((c) => ({ player: c.player.full_name, type: c.type })),
    injuries: session.injuries.map((i) => ({ player: i.player.full_name, injury: i.injury.injuryType, severity: i.injury.severity })),
    stats: session.stats,
    shootout: session.shootoutState && session.shootoutState.finished ? publicShootout(session) : null,
    suspended: !!(opts && opts.suspended),
    suspensionReason: (opts && opts.suspensionReason) || null,
  };

  session.finished = true;
  sessions.delete(session.key);
  return summary;
}

// Si el minuto actual ya llego al limite de la mitad en curso (incluyendo el
// descuento variable), resuelve la transicion correspondiente: entretiempo
// al cerrar la primera mitad, o el inicio de la tanda de penales al cerrar la
// segunda si el cruce es de eliminacion directa y sigue empatado. Ambas
// ramas son naturalmente idempotentes (startHalftime solo actua si
// session.half === 1; initShootout solo si no hay ya un session.shootoutState),
// asi que es seguro llamarla mas de una vez sobre el mismo limite.
function maybeAdvanceHalf(session) {
  const base = baseHalfMinute(session);
  if (session.minute >= base && currentHalfTarget(session) == null) {
    const target = base + computeStoppage(session, session.half);
    if (session.half === 1) session.firstHalfTarget = target;
    else session.secondHalfTarget = target;
  }
  const limit = currentHalfTarget(session) != null ? currentHalfTarget(session) : base;
  if (session.minute < limit) return false;
  if (session.half === 1) {
    startHalftime(session);
    return true;
  }
  if (isKnockout(session) && session.home.goals === session.away.goals && !session.shootoutState) {
    if (sideForClub(session, session.managedClubId) != null) initShootout(session);
    // si no hay club dirigido por el usuario en el cruce, no se pausa:
    // finalize() recurre al desenlace aleatorio de siempre.
    return true;
  }
  // Fin del tiempo reglamentario sin tanda de penales pendiente (liga, o
  // cruce de eliminacion ya decidido): hay que frenar el bucle de advance()
  // aqui tambien. Si no, un "Saltar al final" (minutes:100 en un solo
  // pedido) seguia simulando minutos fantasma de mas hasta agotar esos 100,
  // inflando el marcador bien por encima de lo que da un partido real.
  return true;
}

function advance(uid, db, kind, id, minutes) {
  return runQueued(sessionKey(uid, kind, id), () => advanceNow(uid, db, kind, id, minutes));
}

async function advanceNow(uid, db, kind, id, minutes) {
  const session = getSession(uid, kind, id);
  if (!session) throw new Error('No hay un partido en curso para este fixture.');
  if (session.finished) throw new Error('El partido ya terminó.');

  // Ya esta pausado (penal pendiente, entretiempo, incidente o tanda de
  // penales): no se avanza mas hasta que se resuelva con su endpoint propio.
  if (session.pause) {
    return { frames: [], finished: false, summary: null, view: publicView(session), paused: session.pause };
  }

  const frames = [];
  let remaining = minutes;
  while (remaining > 0 && !session.pause) {
    if (maybeAdvanceHalf(session)) break;

    const { frame, pause } = simulateMinute(session);
    frames.push(frame);
    remaining -= 1;
    if (pause) {
      session.pause = pause;
      break;
    }
    const incident = maybeTriggerIncident(session);
    if (incident) {
      session.pause = incident;
      break;
    }
  }

  // El minuto simulado en la ultima vuelta del bucle puede haber llegado
  // justo al limite de la mitad sin que el bucle vuelva a entrar a
  // comprobarlo (remaining llego a 0 antes de volver al tope). Se comprueba
  // una vez mas aqui para que entretiempo/tanda de penales se resuelvan en
  // cuanto corresponde, antes de que finalize() se dispare por error con el
  // desenlace de empate de siempre.
  if (!session.pause) maybeAdvanceHalf(session);

  const base = baseHalfMinute(session);
  const limit = currentHalfTarget(session) != null ? currentHalfTarget(session) : base;
  const atEndOfMatch = session.half === 2 && session.minute >= limit && !session.pause && !session.shootoutState;
  let summary = null;
  let finished = false;
  if (atEndOfMatch) {
    summary = await finalize(db, session);
    finished = true;
  }

  return { frames, finished, summary, view: finished ? null : publicView(session), paused: session.pause || null };
}

// Resuelve un penal pendiente (jugada en vivo, no tanda) con el jugador
// elegido por el usuario; reanuda el partido de inmediato despues.
function resolvePenalty(uid, kind, id, playerId, managedClubId) {
  const session = getSession(uid, kind, id);
  if (!session) throw new Error('No hay un partido en curso para este fixture.');
  if (!session.pendingPenalty) throw new Error('No hay un penal pendiente para patear.');
  const { side, minute } = session.pendingPenalty;
  assertControlsSide(session, side, managedClubId);
  const taker = session[side].lineup.find((p) => p.id === Number(playerId) && p.onField);
  if (!taker) throw new Error('Jugador no disponible para patear.');

  const events = [];
  resolvePenaltyKick(session, side, taker, minute, events);
  session.pendingPenalty = null;
  session.pause = null;

  return { frame: frameAt(session, minute, side, 'ataque', events), view: publicView(session) };
}

// Procesa un lanzamiento de la tanda de penales: si es turno del lado que
// dirige el usuario, requiere playerId; si es turno de la IA, elige ella
// misma a quien patea (ignorando playerId). Si la tanda termina, finaliza el
// partido de inmediato y devuelve el resumen final.
function shootoutKick(uid, db, kind, id, playerId, managedClubId) {
  return runQueued(sessionKey(uid, kind, id), () => shootoutKickNow(uid, db, kind, id, playerId, managedClubId));
}

async function shootoutKickNow(uid, db, kind, id, playerId, managedClubId) {
  const session = getSession(uid, kind, id);
  if (!session) throw new Error('No hay un partido en curso para este fixture.');
  const state = session.shootoutState;
  if (!state || state.finished) throw new Error('No hay una tanda de penales en curso.');

  const turnSide = state.turn;
  const side = session[turnSide];
  const onField = side.lineup.filter((p) => p.onField && p.position !== 'Portero').length
    ? side.lineup.filter((p) => p.onField && p.position !== 'Portero')
    : side.lineup.filter((p) => p.onField);
  let taker;
  if (!side.aiControlled) {
    assertControlsSide(session, turnSide, managedClubId);
    if (playerId == null) throw new Error('Debes elegir quién patea.');
    taker = side.lineup.find((p) => p.id === Number(playerId) && p.onField);
    if (!taker) throw new Error('Jugador no disponible para patear.');
    const allTaken = state.takenIds[turnSide].size >= onField.length;
    if (!allTaken && state.takenIds[turnSide].has(taker.id)) {
      throw new Error('Ese jugador ya pateó: debe patear otro primero.');
    }
  } else {
    const fresh = onField.filter((p) => !state.takenIds[turnSide].has(p.id));
    const pool = fresh.length ? fresh : onField;
    taker = weightedPick(pool.map((p) => ({ value: p, weight: Math.max(1, p.rating) })));
  }

  state.takenIds[turnSide].add(taker.id);
  const keeper = session[otherSide(turnSide)].lineup.find((p) => p.onField && p.position === 'Portero');
  const keeperRating = keeper ? keeper.rating : 45;
  const goalProb = Math.max(0.55, Math.min(0.92, 0.78 + (taker.rating - keeperRating) / 350));
  const scored = chance(goalProb);
  if (scored) {
    if (turnSide === 'home') state.homeScore += 1;
    else state.awayScore += 1;
  }
  state.kicks.push({ side: turnSide, playerId: taker.id, playerName: taker.full_name, scored });

  const winner = shootoutWinner(state, session);
  let summary = null;
  let finished = false;
  if (winner != null) {
    state.finished = true;
    state.winnerClubId = winner;
    session.pause = null;
    summary = await finalize(db, session);
    finished = true;
  } else {
    state.turn = otherSide(turnSide);
  }

  return { shootout: finished ? summary.shootout : publicShootout(session), finished, summary, view: finished ? null : publicView(session) };
}

// Resuelve un entretiempo pendiente: aplica el mensaje elegido por el usuario
// para su lado y reanuda el partido (ya quedo en la segunda mitad).
function resolveHalftime(uid, kind, id, message, managedClubId) {
  const session = getSession(uid, kind, id);
  if (!session) throw new Error('No hay un partido en curso para este fixture.');
  if (!session.pause || session.pause.type !== 'halftime') throw new Error('No hay entretiempo pendiente.');
  const side = sideForClub(session, managedClubId);
  if (!side) throw new Error('No controlas a ningún equipo en este partido.');
  if (!HALFTIME_MESSAGES.includes(message)) throw new Error('Mensaje inválido.');

  const result = applyHalftimeTalk(session, side, message);
  session.pause = null;
  return { view: publicView(session), talkResult: result };
}

// Resuelve un incidente dinamico pendiente: "reanudar" devuelve el tiempo
// perdido como descuento adicional (no se pierde del todo); "suspender" (solo
// disponible en incidentes graves) termina el partido ya mismo, ratificando
// el resultado al momento de la suspension como resolucion de la competicion.
function resolveIncident(uid, db, kind, id, action) {
  return runQueued(sessionKey(uid, kind, id), () => resolveIncidentNow(uid, db, kind, id, action));
}

async function resolveIncidentNow(uid, db, kind, id, action) {
  const session = getSession(uid, kind, id);
  if (!session) throw new Error('No hay un partido en curso para este fixture.');
  if (!session.pause || session.pause.type !== 'incident') throw new Error('No hay un incidente pendiente.');
  const payload = session.pause.payload;

  if (action === 'suspender') {
    if (payload.severity !== 'grave') throw new Error('Este incidente no es grave: solo puede reanudarse.');
    session.pause = null;
    const summary = await finalize(db, session, { suspended: true, suspensionReason: payload.label });
    return { finished: true, summary, view: null };
  }

  session.halfEventCount[session.half] = (session.halfEventCount[session.half] || 0) + Math.ceil((payload.minutesLost || 0) / 2);
  session.pause = null;
  return { finished: false, summary: null, view: publicView(session) };
}

function sideForClub(session, clubId) {
  if (clubId == null) return null;
  if (session.home.clubId === clubId) return 'home';
  if (session.away.clubId === clubId) return 'away';
  return null;
}

// El cliente siempre debe operar sobre el lado que corresponde a su club
// (managedClubId). Si no hay club dirigido en este partido, o el lado
// pedido no es el suyo, se rechaza: nunca se permite tocar al rival.
function assertControlsSide(session, side, managedClubId) {
  const mSide = sideForClub(session, managedClubId);
  if (side !== mSide) {
    throw new Error('Solo puedes controlar a tu propio equipo.');
  }
}

function setTactics(uid, db, kind, id, side, tactics, managedClubId) {
  return runQueued(sessionKey(uid, kind, id), () => setTacticsNow(uid, db, kind, id, side, tactics, managedClubId));
}

async function setTacticsNow(uid, db, kind, id, side, tactics, managedClubId) {
  const session = getSession(uid, kind, id);
  if (!session) throw new Error('No hay un partido en curso para este fixture.');
  if (session.finished) throw new Error('El partido ya terminó.');
  const target = session[side];
  if (!target) throw new Error('Equipo invalido.');
  assertControlsSide(session, side, managedClubId);
  target.tactics = { ...target.tactics, ...tactics };
  // La tactica aplicada en vivo pasa a ser la tactica de cabecera del club,
  // para que el motor rapido la siga usando en partidos futuros.
  await saveClubTactics(db, target.clubId, target.tactics);
  return publicView(session);
}

function substitute(uid, kind, id, side, outPlayerId, inPlayerId, managedClubId) {
  const session = getSession(uid, kind, id);
  if (!session) throw new Error('No hay un partido en curso para este fixture.');
  if (session.finished) throw new Error('El partido ya terminó.');
  const target = session[side];
  if (!target) throw new Error('Equipo invalido.');
  assertControlsSide(session, side, managedClubId);
  if (target.subsUsed >= 5) throw new Error('Ya se usaron los 5 cambios permitidos.');

  const outPlayer = target.lineup.find((p) => p.id === Number(outPlayerId) && p.onField);
  const inPlayer = target.bench.find((p) => p.id === Number(inPlayerId) && !p.used);
  if (!outPlayer || !inPlayer) throw new Error('Jugador no disponible para el cambio.');

  outPlayer.onField = false;
  inPlayer.used = true;
  inPlayer.onField = true;
  inPlayer.fatigue = 0;
  inPlayer.yellow = 0;
  inPlayer.slot = outPlayer.slot;
  inPlayer.pos = outPlayer.pos;
  target.lineup.push(inPlayer);
  target.everPlayed.set(inPlayer.id, inPlayer);
  target.subsUsed += 1;

  return publicView(session);
}

// "Inspirar jugador": el usuario elige, una sola vez por partido, a un
// jugador de su propio equipo para que tenga un partidazo. Sube su rating
// EFECTIVO (el que usan todas las formulas del motor: remates, atajadas,
// duelos) solo en esta sesion en memoria - nunca toca la tabla players, asi
// que el efecto termina con el partido. Si es arquero, el boost es mayor.
function inspirePlayer(uid, kind, id, playerId, managedClubId) {
  const session = getSession(uid, kind, id);
  if (!session) throw new Error('No hay un partido en curso para este fixture.');
  if (session.finished) throw new Error('El partido ya terminó.');
  if (session.inspiredUsed) throw new Error('Ya usaste tu inspiración en este partido.');

  const side = sideForClub(session, managedClubId);
  if (!side) throw new Error('No controlas a ningún equipo en este partido.');
  const target = session[side];
  const player = target.lineup.find((p) => p.id === Number(playerId) && p.onField);
  if (!player) throw new Error('Jugador no disponible para inspirar.');

  const boost = player.position === 'Portero' ? INSPIRE_BOOST_GK : INSPIRE_BOOST_FIELD;
  player.rating = Math.min(INSPIRE_RATING_CAP, player.rating + boost);
  player.inspired = true;

  session.inspiredUsed = true;
  session.inspiredPlayerId = player.id;

  return publicView(session);
}

function getState(uid, kind, id) {
  const session = getSession(uid, kind, id);
  if (!session) return null;
  return publicView(session);
}

// managedClubId ya quedo fijo en la sesion al arrancar el partido (startMatch)
// y no cambia durante el mismo: los botones del partido en vivo (tactica,
// cambios, penal, tanda, entretiempo) pueden usar este valor en vez de volver
// a pedir la carrera a la base en cada click, ahorrando un round-trip contra
// Turso por cada boton apretado durante el partido.
function getManagedClubId(uid, kind, id) {
  const session = getSession(uid, kind, id);
  return session ? session.managedClubId : null;
}

module.exports = {
  startMatch,
  advance,
  setTactics,
  substitute,
  getState,
  resolvePenalty,
  shootoutKick,
  resolveHalftime,
  resolveIncident,
  inspirePlayer,
  getManagedClubId,
};
