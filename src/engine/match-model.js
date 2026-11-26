// Modelo de partido compartido entre el motor rapido (liga/copa/supercopa) y el
// motor en vivo, para que un partido simulado de un vistazo y uno jugado minuto
// a minuto respondan exactamente a las mismas reglas: calidad de plantel,
// formacion, tactica, cohesion de plantel y moral reciente - y no solo al azar.
const { groupCounts, defaultTactics } = require('./formations');
const {
  getManagedIdentity,
  staticIdentityMod,
  identityCohesionBonus,
  identityMoraleAdjust,
} = require('./team-identity');

// Tactica persistida de un club (actualizada cada vez que el usuario aplica
// tactica en un partido en vivo), para que la IA y el motor rapido no usen
// siempre una tactica neutra identica para todos los equipos.
async function loadClubTactics(db, clubId) {
  if (!db || clubId == null) return defaultTactics();
  const row = await db
    .prepare('SELECT pref_formation, pref_mentality, pref_style, pref_pressing FROM clubs WHERE id = ?')
    .get(clubId);
  if (!row || !row.pref_formation) return defaultTactics();
  return { formation: row.pref_formation, mentality: row.pref_mentality, style: row.pref_style, pressing: row.pref_pressing };
}

async function saveClubTactics(db, clubId, tactics) {
  if (!db || clubId == null) return;
  await db.prepare('UPDATE clubs SET pref_formation = ?, pref_mentality = ?, pref_style = ?, pref_pressing = ? WHERE id = ?').run(
    tactics.formation,
    tactics.mentality,
    tactics.style,
    tactics.pressing,
    clubId
  );
}

const HOME_ADVANTAGE = 0.12; // ventaja de localia moderada (antes 0.18-0.22)
const MENTALITY_ATTACK = { defensivo: -0.07, equilibrado: 0, ofensivo: 0.07 };
const MENTALITY_DEFENSE = { defensivo: 0.07, equilibrado: 0, ofensivo: -0.07 };
const STYLE_ATTACK = { posesion: 0.02, directo: 0.04, contragolpe: 0.01 };
const PRESSING_DEFENSE = { bajo: -0.03, medio: 0, alto: 0.03 };

// Ataque y defensa por separado a partir del rating por posicion (no un solo
// promedio general), para que un plantel ofensivo fuerte pero fragil atras se
// comporte distinto de uno equilibrado con el mismo rating promedio.
function teamAttackDefense(onFieldPlayers) {
  const gk = onFieldPlayers.filter((p) => p.position === 'Portero');
  const def = onFieldPlayers.filter((p) => p.position === 'Defensa');
  const mid = onFieldPlayers.filter((p) => p.position === 'Mediocampista');
  const fwd = onFieldPlayers.filter((p) => p.position === 'Delantero');
  const avg = (arr) => (arr.length ? arr.reduce((s, p) => s + p.rating, 0) / arr.length : 55);

  const avgFwd = avg(fwd);
  const avgMid = avg(mid);
  const avgDef = avg(def);
  const avgGk = avg(gk);

  // Ataque: delanteros pesan mas, mediocampo aporta construccion.
  const attack = avgFwd * 0.55 + avgMid * 0.35 + avgDef * 0.1;
  // Defensa: linea defensiva + arquero pesan mas, mediocampo ayuda a contener.
  const defense = avgDef * 0.5 + avgGk * 0.3 + avgMid * 0.2;

  return { attack, defense, avgFwd, avgMid, avgDef, avgGk };
}

// Ventaja/desventaja numerica entre formaciones rivales: superioridad en una
// linea (p.ej. 5 mediocampistas contra 4) da una ventaja moderada en esa zona,
// generico a partir de los conteos de cada formacion (sin matriz fija).
function formationMatchup(ownFormation, oppFormation) {
  const own = groupCounts(ownFormation);
  const opp = groupCounts(oppFormation);
  const midEdge = (own.MID - opp.MID) * 0.012; // control de mediocampo
  const fwdVsDef = (own.FWD - opp.DEF) * 0.01; // sobrecarga ofensiva ante linea corta
  const defVsFwd = (own.DEF - opp.FWD) * 0.01; // linea solida ante pocos delanteros rivales
  return {
    attackMod: midEdge * 0.5 + fwdVsDef,
    defenseMod: midEdge * 0.5 + defVsFwd,
  };
}

// Fraccion del 11 titular con al menos una temporada completa en el club
// (segun su ultima transferencia a este club, si existe), usada como proxy de
// cohesion de plantel. Sin transferencia registrada se asume plantel original
// / formado en casa, por lo tanto ya asentado.
async function cohesionFactor(db, clubId, lineupIds, currentSeasonYear) {
  if (!lineupIds.length) return 1;
  let settled = 0;
  for (const playerId of lineupIds) {
    const lastTransfer = await db
      .prepare(
        `SELECT season_year FROM transfers WHERE player_id = ? AND to_club_id = ? ORDER BY season_year DESC, id DESC LIMIT 1`
      )
      .get(playerId, clubId);
    if (!lastTransfer || lastTransfer.season_year < currentSeasonYear) settled += 1;
  }
  const fraction = settled / lineupIds.length;
  return 0.92 + 0.16 * fraction; // 0.92 (plantel recien armado) .. 1.08 (plantel asentado)
}

// Forma reciente (puntos de los ultimos 5 partidos de liga jugados), usada
// como proxy de moral del equipo.
async function moraleFactor(db, clubId, seasonYear) {
  const rows = await db
    .prepare(
      `SELECT home_club_id, away_club_id, home_goals, away_goals FROM fixtures
       WHERE season_year = ? AND played = 1 AND (home_club_id = ? OR away_club_id = ?)
       ORDER BY jornada DESC LIMIT 5`
    )
    .all(seasonYear, clubId, clubId);
  if (!rows.length) return 1;
  let points = 0;
  for (const r of rows) {
    const isHome = r.home_club_id === clubId;
    const gf = isHome ? r.home_goals : r.away_goals;
    const ga = isHome ? r.away_goals : r.home_goals;
    points += gf > ga ? 3 : gf === ga ? 1 : 0;
  }
  const ppg = points / (rows.length * 3); // 0..1
  return 0.93 + 0.14 * ppg; // 0.93 (mal momento) .. 1.07 (buena racha)
}

// Perfil completo de un equipo para un partido: ataque/defensa ya ajustados
// por tactica propia, formacion rival, cohesion, moral y (si corresponde) la
// identidad de camarin elegida por el usuario para su propio club.
// `ownStrength`/`oppStrength` (rating promedio de cada plantel, ya calculado
// por el caller) solo se usan para decidir si el club es underdog en este
// cruce puntual - un ajuste liviano, nunca decisivo por si solo.
async function buildTeamProfile({ onFieldPlayers, lineupIds, tactics, oppFormation, db, clubId, seasonYear, ownStrength, oppStrength }) {
  const base = teamAttackDefense(onFieldPlayers);
  const matchup = formationMatchup(tactics.formation, oppFormation);
  const mentAtk = MENTALITY_ATTACK[tactics.mentality] || 0;
  const mentDef = MENTALITY_DEFENSE[tactics.mentality] || 0;
  const styleAtk = STYLE_ATTACK[tactics.style] || 0;
  const pressDef = PRESSING_DEFENSE[tactics.pressing] || 0;

  const identity = await getManagedIdentity(db, clubId);
  const cohesionBase = db && clubId != null ? await cohesionFactor(db, clubId, lineupIds, seasonYear) : 1;
  const cohesion = Math.min(1.1, cohesionBase + identityCohesionBonus(identity));
  const moraleBase = db && clubId != null ? await moraleFactor(db, clubId, seasonYear) : 1;
  const morale = identityMoraleAdjust(identity, moraleBase);
  const formTeam = cohesion * morale;

  const isUnderdog = ownStrength != null && oppStrength != null && ownStrength < oppStrength - 1;
  const identityMod = staticIdentityMod(identity, isUnderdog);

  const attack = base.attack * (1 + matchup.attackMod + mentAtk + styleAtk + identityMod.attack) * formTeam;
  const defense = base.defense * (1 + matchup.defenseMod + mentDef + pressDef + identityMod.defense) * formTeam;

  return { attack, defense, cohesion, morale, identity, ...base };
}

// Goles esperados: modelo multiplicativo ataque/defensa (en vez de una resta
// lineal), mucho mas sensible a la diferencia real de calidad entre planteles.
const BASE_GOALS = 1.25;
const GAMMA = 1.5; // que tan decisiva es la brecha de calidad

function expectedGoals(attackerProfile, defenderProfile, isHome) {
  const ratio = attackerProfile.attack / Math.max(25, defenderProfile.defense);
  const homeMult = isHome ? 1 + HOME_ADVANTAGE : 1;
  const lambda = BASE_GOALS * Math.pow(ratio, GAMMA) * homeMult;
  return Math.max(0.12, Math.min(4.2, lambda));
}

module.exports = {
  HOME_ADVANTAGE,
  MENTALITY_ATTACK,
  MENTALITY_DEFENSE,
  STYLE_ATTACK,
  PRESSING_DEFENSE,
  teamAttackDefense,
  formationMatchup,
  cohesionFactor,
  moraleFactor,
  buildTeamProfile,
  expectedGoals,
  loadClubTactics,
  saveClubTactics,
};
