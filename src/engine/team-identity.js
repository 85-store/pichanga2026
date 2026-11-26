// Habilidades de equipo y camarin: un rasgo principal que el entrenador elige
// al llegar a un club (o al empezar una carrera nueva), con efecto real y
// acotado tanto en el motor de partidos (match-model.js / live-match.js) como
// en el ambiente del camarin - nunca decide un partido por si solo ni
// reemplaza la calidad del plantel o la tactica, solo inclina el dado.
// La eleccion se guarda en career.team_identity y se resetea a NULL cada vez
// que arranca una nueva etapa (nueva partida o nuevo club tras despido/oferta),
// para que el entrenador vuelva a elegir segun el plantel que recibe.
// require perezoso (no al inicio del archivo): board.js llega a este modulo
// de forma transitiva via league.js -> match.js -> match-model.js, asi que
// requerirlo aqui arriba crearia un ciclo. En tiempo de ejecucion (no en
// tiempo de carga de modulos) board.js ya esta completamente cargado.
function boardModule() {
  return require('./board');
}

const TEAM_IDENTITIES = {
  garra: {
    key: 'garra',
    name: 'Garra',
    emoji: '🔥',
    description:
      'El plantel muestra carácter en los partidos difíciles: lucha hasta el final y rinde mejor en los minutos decisivos cuando el resultado está en contra.',
    pros: 'Más resistencia como underdog y un empuje extra en el tramo final del partido si el equipo va perdiendo.',
    cons: 'Baja algo la concentración defensiva una vez el resultado ya está resuelto a favor.',
  },
  confianza: {
    key: 'confianza',
    name: 'Confianza',
    emoji: '💪',
    description:
      'El plantel juega con más seguridad: se potencia en buena racha y amortigua la caída de rendimiento tras un mal resultado.',
    pros: 'Mayor rendimiento cuando el equipo está en buena racha y menor golpe cuando viene de perder.',
    cons: 'Más frágil como underdog: le cuesta más sobreponerse ante un rival claramente superior.',
  },
  amistad: {
    key: 'amistad',
    name: 'Amistad',
    emoji: '🤝',
    description:
      'Mejor relación entre compañeros: el plantel funciona como un bloque cohesionado sin depender tanto de la antigüedad del equipo.',
    pros: 'Mejor cohesión de plantel (los fichajes nuevos rinden como si llevaran más tiempo juntos).',
    cons: 'Menos hambre competitiva: no recibe el plus de garra cuando el equipo necesita remontar.',
  },
};

const VALID_IDENTITIES = Object.keys(TEAM_IDENTITIES);

function listIdentities() {
  return Object.values(TEAM_IDENTITIES);
}

function getIdentityInfo(key) {
  return TEAM_IDENTITIES[key] || null;
}

// Fija la identidad de camarin del club que dirige el usuario. Solo se puede
// elegir una vez por etapa (createCareer/acceptOffer la resetean a NULL); una
// vez elegida se mantiene durante toda la temporada, como pide el sistema.
async function setTeamIdentity(db, identity) {
  if (!VALID_IDENTITIES.includes(identity)) throw new Error('Identidad de camarín inválida.');
  const career = await boardModule().getCareer(db);
  if (!career || !career.club_id) throw new Error('No hay una carrera activa.');
  if (career.team_identity) throw new Error('Ya elegiste la identidad del camarín para esta etapa en el club.');
  await db.prepare('UPDATE career SET team_identity = ? WHERE id = 1').run(identity);
  return boardModule().getCareer(db);
}

// Identidad del club dirigido por el usuario para este partido: el sistema
// solo aplica efectos al plantel del usuario, nunca a los rivales IA.
async function getManagedIdentity(db, clubId) {
  if (!db || clubId == null) return null;
  const career = await boardModule().getCareer(db);
  if (!career || career.club_id !== clubId || !career.team_identity) return null;
  return career.team_identity;
}

// Ajuste estatico de ataque/defensa segun identidad y si el equipo es
// underdog en este cruce puntual (comparando fuerza propia vs. rival).
// Usado por el motor rapido (un solo tiro, sin minuto a minuto) y como base
// del motor en vivo.
function staticIdentityMod(identity, isUnderdog) {
  if (identity === 'garra') {
    return isUnderdog ? { attack: 0.04, defense: 0.04 } : { attack: 0, defense: -0.02 };
  }
  if (identity === 'confianza') {
    return isUnderdog ? { attack: -0.02, defense: -0.02 } : { attack: 0, defense: 0 };
  }
  return { attack: 0, defense: 0 };
}

// Bonus de cohesion de AMISTAD: achica (sin eliminar) la penalizacion de un
// plantel recien armado, tope moderado para que no se vuelva un bono gratis.
function identityCohesionBonus(identity) {
  return identity === 'amistad' ? 0.04 : 0;
}

// CONFIANZA amplifica el factor de moral/forma reciente: agranda el envion
// en buena racha y amortigua (no elimina) la penalizacion en mala racha -
// "ayuda a recuperarse de malos resultados" sin hacerlo irrelevante.
function identityMoraleAdjust(identity, moraleFactor) {
  if (identity !== 'confianza') return moraleFactor;
  if (moraleFactor >= 1) return 1 + (moraleFactor - 1) * 1.5;
  return 1 - (1 - moraleFactor) * 0.5;
}

// Bonus de "minutos decisivos" de GARRA: solo tiene sentido con marcador y
// minuto reales (motor en vivo) - lucha mas cuando el partido entra en el
// tramo final y el equipo va perdiendo.
function identityClutchMod(identity, minute, goalDiff) {
  if (identity !== 'garra' || minute < 70 || goalDiff >= 0) return { attack: 0, defense: 0 };
  return { attack: 0.08, defense: 0.03 };
}

module.exports = {
  TEAM_IDENTITIES,
  VALID_IDENTITIES,
  listIdentities,
  getIdentityInfo,
  setTeamIdentity,
  getManagedIdentity,
  staticIdentityMod,
  identityCohesionBonus,
  identityMoraleAdjust,
  identityClutchMod,
};
