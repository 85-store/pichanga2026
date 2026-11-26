// Sistema de acontecimientos y relaciones: reuniones con la dirigencia,
// exigencias, polemicas internas y clasicos. Se dispara desde finalize-match.js
// cada vez que termina un partido del club que dirige el usuario (liga, copa,
// supercopa o partido en vivo: las cuatro vias pasan por el mismo gancho), y
// deja consecuencias reales sobre board_confidence / locker_room_morale /
// manager_reputation en la tabla career. Los acontecimientos no son
// completamente aleatorios: cada tipo tiene su propio enfriamiento (espaciado
// minimo en partidos dirigidos) para que no aparezcan todos juntos ni se
// repitan constantemente.
const { chance } = require('./random');

// getCareer se importa de forma diferida (no al cargar el modulo): board.js ->
// league.js -> finalize-match.js -> career-events.js cierra un ciclo, y pedirlo
// al tope dejaria getCareer como undefined cuando el ciclo se cierra por ese lado.
function getCareer(db) {
  return require('./board').getCareer(db);
}

// Clasicos reales del futbol chileno, por nombre de club (normalizado). Se
// detectan comparando los nombres de ambos equipos del partido contra estos
// pares, sin importar el orden ni los ids (que pueden variar entre guardados).
const RIVALRIES = [
  ['colo-colo', 'universidad de chile'],
  ['universidad de chile', 'universidad catolica'],
  ['colo-colo', 'universidad catolica'],
  ['santiago wanderers', 'everton de vina del mar'],
  ['cobreloa', 'cobresal'],
  ['deportes concepcion', 'universidad de concepcion'],
  ['union espanola', 'palestino'],
];

const COOLDOWN = { reunion: 3, exigencia: 6, polemica: 3, clasico: 4, hinchada: 4 };

function normalizeClubName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function isRivalryPair(nameA, nameB) {
  const a = normalizeClubName(nameA);
  const b = normalizeClubName(nameB);
  return RIVALRIES.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

function clamp(value) {
  return Math.max(0, Math.min(100, value));
}

async function getClubName(db, clubId) {
  const row = await db.prepare('SELECT name FROM clubs WHERE id = ?').get(clubId);
  return row ? row.name : null;
}

async function randomActivePlayer(db, clubId) {
  return db
    .prepare(`SELECT * FROM players WHERE club_id = ? AND status = 'activo' ORDER BY RANDOM() LIMIT 1`)
    .get(clubId);
}

async function recentManagedResults(db, seasonYear, clubId, limit) {
  const rows = await db
    .prepare(
      `SELECT home_club_id, away_club_id, home_goals, away_goals FROM (
         SELECT home_club_id, away_club_id, home_goals, away_goals, id FROM fixtures
           WHERE season_year = ? AND played = 1 AND (home_club_id = ? OR away_club_id = ?)
         UNION ALL
         SELECT home_club_id, away_club_id, home_goals, away_goals, id FROM copa_matches
           WHERE season_year = ? AND played = 1 AND (home_club_id = ? OR away_club_id = ?)
         UNION ALL
         SELECT home_club_id, away_club_id, home_goals, away_goals, id FROM super_copa_matches
           WHERE season_year = ? AND played = 1 AND (home_club_id = ? OR away_club_id = ?)
       ) ORDER BY id DESC LIMIT ?`
    )
    .all(seasonYear, clubId, clubId, seasonYear, clubId, clubId, seasonYear, clubId, clubId, limit);

  let wins = 0;
  let draws = 0;
  let losses = 0;
  for (const r of rows) {
    const forGoals = r.home_club_id === clubId ? r.home_goals : r.away_goals;
    const againstGoals = r.home_club_id === clubId ? r.away_goals : r.home_goals;
    if (forGoals > againstGoals) wins += 1;
    else if (forGoals < againstGoals) losses += 1;
    else draws += 1;
  }
  return { wins, draws, losses, played: rows.length };
}

async function insertEvent(db, { seasonYear, matchCount, kind, subtype, title, description, options }) {
  const info = await db
    .prepare(
      `INSERT INTO career_events (season_year, match_count, kind, subtype, title, description, options)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(seasonYear, matchCount, kind, subtype || null, title, description, JSON.stringify(options));
  return getEventById(db, info.lastInsertRowid);
}

async function getEventById(db, id) {
  const row = await db.prepare('SELECT * FROM career_events WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, options: JSON.parse(row.options) };
}

async function getPendingEvents(db) {
  const rows = await db.prepare(`SELECT * FROM career_events WHERE status = 'pendiente' ORDER BY id ASC`).all();
  return rows.map((row) => ({ ...row, options: JSON.parse(row.options) }));
}

async function getEventHistory(db, limit) {
  const rows = await db.prepare(`SELECT * FROM career_events ORDER BY id DESC LIMIT ?`).all(limit || 30);
  return rows.map((row) => ({ ...row, options: JSON.parse(row.options) }));
}

// Evita que el mismo subtipo (dentro de un kind dado) se repita dos veces
// seguidas, para que las conversaciones no se sientan siempre iguales.
async function lastSubtypeOfKind(db, kind) {
  const row = await db.prepare('SELECT subtype FROM career_events WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind);
  return row ? row.subtype : null;
}

function pickVaried(options, lastSubtype) {
  const pool = options.length > 1 ? options.filter((o) => o !== lastSubtype) : options;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function buildReunionEvent(db, career, seasonYear, matchCount) {
  const form = await recentManagedResults(db, seasonYear, career.club_id, 3);
  const formText = `${form.wins}V ${form.draws}E ${form.losses}D en los últimos ${form.played} partidos`;
  const budgetRow = await db.prepare('SELECT budget FROM clubs WHERE id = ?').get(career.club_id);
  const economyText = `Presupuesto de fichajes actual: $${(budgetRow || {}).budget || 0} mil.`;
  const confidence = career.board_confidence != null ? career.board_confidence : 60;

  // Con confianza muy baja, la dirigencia cita derecho a hablar del futuro del
  // entrenador; con confianza muy alta, puede ofrecer renovar. En el resto de
  // los casos es una revision periodica normal.
  let subtype = 'revision_periodica';
  if (confidence <= 35) subtype = 'cita_futuro';
  else if (confidence >= 80 && chance(0.4)) subtype = 'oferta_renovacion';

  if (subtype === 'cita_futuro') {
    return {
      seasonYear,
      matchCount,
      kind: 'reunion',
      subtype,
      title: 'La dirigencia te cita para hablar de tu futuro',
      description: `El directorio te convoca con un tono serio: quieren conversar sobre tu continuidad. Resultados: ${formText}. Objetivo de temporada: ${career.objective_text || 'sin definir'}.`,
      options: [
        { id: 'plan_de_mejora', label: 'Presentar un plan concreto de mejora', confidenceDelta: 7, moraleDelta: 1, reputationDelta: 1 },
        { id: 'pedir_tiempo', label: 'Pedir que te midan en los próximos partidos', confidenceDelta: 2, moraleDelta: 0, reputationDelta: -1 },
        { id: 'defender_gestion', label: 'Defender tu gestión con firmeza', confidenceDelta: -3, moraleDelta: 3, reputationDelta: 1 },
      ],
    };
  }
  if (subtype === 'oferta_renovacion') {
    return {
      seasonYear,
      matchCount,
      kind: 'reunion',
      subtype,
      title: 'La directiva te ofrece renovar',
      description: `Conforme con tu trabajo, el directorio te plantea extender tu contrato antes de que termine la temporada. Resultados: ${formText}.`,
      options: [
        { id: 'aceptar_renovar', label: 'Aceptar la renovación de inmediato', confidenceDelta: 5, moraleDelta: 3, reputationDelta: 2 },
        { id: 'pedir_mejoras', label: 'Pedir mejores condiciones antes de firmar', confidenceDelta: -1, moraleDelta: 0, reputationDelta: 1 },
        { id: 'dejar_pendiente', label: 'Dejarla pendiente para evaluar más adelante', confidenceDelta: -2, moraleDelta: 0, reputationDelta: 0 },
      ],
    };
  }

  return {
    seasonYear,
    matchCount,
    kind: 'reunion',
    subtype: 'revision_periodica',
    title: 'Reunión con el gerente deportivo',
    description: `El gerente deportivo te convoca a una reunión de seguimiento. Resultados: ${formText}. Objetivo de temporada: ${career.objective_text || 'sin definir'}. ${economyText}`,
    options: [
      { id: 'comprometerse', label: 'Comprometerte a mejorar los resultados', confidenceDelta: 4, moraleDelta: 0, reputationDelta: 1 },
      { id: 'defender_plan', label: 'Defender el plan de trabajo actual', confidenceDelta: 1, moraleDelta: 2, reputationDelta: 0 },
      { id: 'pedir_paciencia', label: 'Pedir paciencia y más tiempo', confidenceDelta: -2, moraleDelta: 1, reputationDelta: -1 },
    ],
  };
}

async function buildExigenciaEvent(db, career, seasonYear, matchCount) {
  return {
    seasonYear,
    matchCount,
    kind: 'exigencia',
    subtype: 'presion_directorio',
    title: 'La dirigencia sube la exigencia',
    description: `Viendo el nivel del plantel, la dirigencia considera que el club está en condiciones de exigir más. Quieren saber si aceptas el nuevo desafío.`,
    options: [
      { id: 'aceptar', label: 'Aceptar el desafío sin condiciones', confidenceDelta: 6, moraleDelta: -2, reputationDelta: 3 },
      { id: 'negociar', label: 'Negociar objetivos y pedir recursos a cambio', confidenceDelta: 2, moraleDelta: 2, reputationDelta: 1 },
      { id: 'cuestionar', label: 'Cuestionar que la exigencia es excesiva', confidenceDelta: -6, moraleDelta: 3, reputationDelta: -1 },
    ],
  };
}

const POLEMICA_SUBTYPES = [
  'conflicto_jugadores',
  'declaracion_polemica',
  'reclamo_minutos',
  'discusion_entrenador',
  'problema_interno',
  'capitan_respalda',
  'cuestionamiento_tactico',
  'peticion_reunion_plantel',
];

async function buildPolemicaEvent(db, career, seasonYear, matchCount, resultTag) {
  const subtype = pickVaried(POLEMICA_SUBTYPES, await lastSubtypeOfKind(db, 'polemica'));
  const player = await randomActivePlayer(db, career.club_id);
  const playerName = player ? player.full_name : 'un jugador del plantel';

  const byType = {
    conflicto_jugadores: {
      title: 'Conflicto entre jugadores',
      description: `Se reportan roces entre ${playerName} y otro compañero en los entrenamientos.`,
      options: [
        { id: 'mediar', label: 'Mediar personalmente entre ambos', moraleDelta: 5, confidenceDelta: 1, reputationDelta: 1 },
        { id: 'sancionar', label: 'Sancionar a los involucrados', moraleDelta: -3, confidenceDelta: 2, reputationDelta: 2 },
        { id: 'ignorar', label: 'Dejar que se resuelva solo', moraleDelta: -4, confidenceDelta: -1, reputationDelta: -1 },
      ],
    },
    declaracion_polemica: {
      title: 'Declaración polémica',
      description: `${playerName} hizo declaraciones polémicas a la prensa tras el partido.`,
      options: [
        { id: 'respaldar', label: 'Respaldar públicamente al jugador', moraleDelta: 4, confidenceDelta: -2, reputationDelta: -1 },
        { id: 'llamar_atencion', label: 'Llamarle la atención en privado', moraleDelta: -1, confidenceDelta: 2, reputationDelta: 1 },
        { id: 'desautorizar', label: 'Desautorizarlo públicamente', moraleDelta: -5, confidenceDelta: 3, reputationDelta: -1 },
      ],
    },
    reclamo_minutos: {
      title: 'Reclamo por minutos',
      description: `${playerName} reclama no estar teniendo los minutos que esperaba.`,
      options: [
        { id: 'explicar', label: 'Explicarle el plan de rotación', moraleDelta: 2, confidenceDelta: 0, reputationDelta: 1 },
        { id: 'prometer', label: 'Prometerle más oportunidades', moraleDelta: 4, confidenceDelta: -1, reputationDelta: 0 },
        { id: 'cortar', label: 'Cortar la conversación de forma tajante', moraleDelta: -5, confidenceDelta: 1, reputationDelta: -1 },
      ],
    },
    discusion_entrenador: {
      title: 'Discusión con el entrenador',
      description: `Un cruce de palabras entre el cuerpo técnico y ${playerName} se filtró a la prensa.`,
      options: [
        { id: 'apoyar_cuerpo_tecnico', label: 'Apoyar al cuerpo técnico', moraleDelta: -2, confidenceDelta: 2, reputationDelta: 1 },
        { id: 'apoyar_jugador', label: 'Ponerte del lado del jugador', moraleDelta: 3, confidenceDelta: -2, reputationDelta: -1 },
        { id: 'reunion_privada', label: 'Pedir una reunión privada para aclarar todo', moraleDelta: 1, confidenceDelta: 1, reputationDelta: 1 },
      ],
    },
    problema_interno: {
      title: 'Problema interno en el camarín',
      description: `Hay tensión en el camarín por el reparto de responsabilidades dentro del plantel.`,
      options: [
        { id: 'charla_grupal', label: 'Convocar una charla grupal', moraleDelta: 5, confidenceDelta: 0, reputationDelta: 1 },
        { id: 'liderazgo', label: 'Apoyarte en los líderes del plantel', moraleDelta: 2, confidenceDelta: 1, reputationDelta: 0 },
        { id: 'no_intervenir', label: 'No intervenir por ahora', moraleDelta: -3, confidenceDelta: -1, reputationDelta: 0 },
      ],
    },
    capitan_respalda: {
      title: 'El capitán sale a respaldarte',
      description: `${playerName}, capitán del plantel, salió públicamente a respaldar tu trabajo frente a la prensa.`,
      options: [
        { id: 'agradecer_publico', label: 'Agradecerle públicamente el respaldo', moraleDelta: 4, confidenceDelta: 2, reputationDelta: 2 },
        { id: 'agradecer_privado', label: 'Agradecerle en privado, sin hacer ruido', moraleDelta: 2, confidenceDelta: 1, reputationDelta: 0 },
        { id: 'restar_importancia', label: 'Restarle importancia frente al grupo', moraleDelta: -2, confidenceDelta: 0, reputationDelta: -1 },
      ],
    },
    cuestionamiento_tactico: {
      title: 'Un jugador cuestiona las decisiones tácticas',
      description: `${playerName} cuestionó en los entrenamientos algunas decisiones tácticas recientes.`,
      options: [
        { id: 'explicar_tactica', label: 'Explicarle en persona el plan de juego', moraleDelta: 3, confidenceDelta: 1, reputationDelta: 1 },
        { id: 'imponer_autoridad', label: 'Imponer tu autoridad sin dar explicaciones', moraleDelta: -4, confidenceDelta: 2, reputationDelta: 0 },
        { id: 'escuchar_sugerencia', label: 'Escuchar su sugerencia y evaluarla', moraleDelta: 2, confidenceDelta: -1, reputationDelta: 1 },
      ],
    },
    peticion_reunion_plantel: {
      title: 'Los jugadores piden una reunión',
      description: `Un grupo de jugadores pidió una reunión con el cuerpo técnico para plantear inquietudes del plantel.`,
      options: [
        { id: 'reunirse_de_inmediato', label: 'Reunirte con ellos de inmediato', moraleDelta: 4, confidenceDelta: 0, reputationDelta: 1 },
        { id: 'postergar_reunion', label: 'Postergar la reunión por ahora', moraleDelta: -3, confidenceDelta: 0, reputationDelta: -1 },
        { id: 'delegar_cuerpo_tecnico', label: 'Delegarla en tu cuerpo técnico', moraleDelta: -1, confidenceDelta: 1, reputationDelta: 0 },
      ],
    },
  };

  const base = byType[subtype];
  const severity = resultTag === 'loss' ? ' El mal resultado reciente no ayuda al ambiente.' : '';
  return {
    seasonYear,
    matchCount,
    kind: 'polemica',
    subtype,
    title: base.title,
    description: base.description + severity,
    options: base.options,
  };
}

async function buildClasicoEvent(db, career, seasonYear, matchCount, opponentName, resultTag) {
  const resultText =
    resultTag === 'win'
      ? 'El triunfo deja a la hinchada feliz, pero también envalentonada.'
      : resultTag === 'loss'
      ? 'La derrota en el clásico duele el doble y la presión sube.'
      : 'El empate dejó un sabor amargo para ambos lados.';

  return {
    seasonYear,
    matchCount,
    kind: 'clasico',
    subtype: 'repercusiones',
    title: `Clásico ante ${opponentName}`,
    description: `La previa del clásico contra ${opponentName} ya venía con provocaciones y tensión, y tras el partido siguen las polémicas arbitrales y las declaraciones. ${resultText}`,
    options: [
      { id: 'reclamar_arbitraje', label: 'Reclamar públicamente por el arbitraje', moraleDelta: 3, confidenceDelta: -2, reputationDelta: -1 },
      { id: 'declaraciones_mesuradas', label: 'Dar declaraciones mesuradas', moraleDelta: 0, confidenceDelta: 2, reputationDelta: 2 },
      { id: 'celebrar_rivalidad', label: 'Celebrar la rivalidad sin polemizar', moraleDelta: 2, confidenceDelta: 1, reputationDelta: 1 },
    ],
  };
}

const HINCHADA_SUBTYPES_LOW = ['protesta_resultados', 'criticas_prensa'];
const HINCHADA_SUBTYPES_HIGH = ['reconocimiento_hinchas', 'identificacion_club'];
const HINCHADA_SUBTYPES_MID = ['exigencia_refuerzos'];

// Acontecimientos propios de la hinchada: con apoyo bajo, protestas y criticas;
// con apoyo alto, reconocimiento; en niveles medios, presion por refuerzos
// (tipicamente durante la ventana de mercado) o por identificacion con el club.
async function buildHinchadaEvent(db, career, seasonYear, matchCount, marketOpen) {
  const fan = career.fan_support != null ? career.fan_support : 60;
  let pool;
  if (fan <= 35) pool = HINCHADA_SUBTYPES_LOW;
  else if (fan >= 75) pool = HINCHADA_SUBTYPES_HIGH;
  else pool = marketOpen ? HINCHADA_SUBTYPES_MID.concat(HINCHADA_SUBTYPES_HIGH.slice(0, 1)) : HINCHADA_SUBTYPES_HIGH;

  const subtype = pickVaried(pool, await lastSubtypeOfKind(db, 'hinchada'));

  const byType = {
    protesta_resultados: {
      title: 'Protestas de la hinchada',
      description: `Un sector de los hinchas protestó a las afueras del estadio, descontento con el nivel del equipo.`,
      options: [
        { id: 'dar_la_cara', label: 'Dar la cara en conferencia de prensa', fanDelta: 5, confidenceDelta: 1, reputationDelta: 1 },
        { id: 'pedir_apoyo', label: 'Pedir públicamente el apoyo de la hinchada', fanDelta: 3, confidenceDelta: 0, reputationDelta: 0 },
        { id: 'ignorar_protesta', label: 'No hacer declaraciones al respecto', fanDelta: -4, confidenceDelta: 0, reputationDelta: -1 },
      ],
    },
    criticas_prensa: {
      title: 'Críticas en la prensa',
      description: `La prensa deportiva y los hinchas en redes sociales critican duramente el funcionamiento del equipo.`,
      options: [
        { id: 'responder_criticas', label: 'Responder con autocrítica y un plan claro', fanDelta: 4, confidenceDelta: 1, reputationDelta: 1 },
        { id: 'defender_al_plantel', label: 'Salir a defender al plantel públicamente', fanDelta: 2, moraleDelta: 3, reputationDelta: 0 },
        { id: 'no_responder', label: 'No entrar en polémicas con la prensa', fanDelta: -2, confidenceDelta: 0, reputationDelta: 0 },
      ],
    },
    exigencia_refuerzos: {
      title: 'La hinchada exige refuerzos',
      description: `Con el mercado de pases abierto, la hinchada presiona pidiendo incorporaciones de peso para el plantel.`,
      options: [
        { id: 'prometer_refuerzos', label: 'Prometer que llegarán refuerzos', fanDelta: 5, confidenceDelta: -1, reputationDelta: 0 },
        { id: 'pedir_paciencia_mercado', label: 'Pedir paciencia con el mercado', fanDelta: -2, confidenceDelta: 1, reputationDelta: 0 },
        { id: 'confiar_en_plantel', label: 'Decir que confías en el plantel actual', fanDelta: -3, moraleDelta: 3, reputationDelta: 1 },
      ],
    },
    reconocimiento_hinchas: {
      title: 'Los hinchas reconocen el trabajo del entrenador',
      description: `Los hinchas reconocen públicamente el nivel mostrado por el equipo en los últimos partidos.`,
      options: [
        { id: 'agradecer_hinchada', label: 'Agradecer públicamente el apoyo', fanDelta: 4, confidenceDelta: 1, reputationDelta: 1 },
        { id: 'compartir_con_plantel', label: 'Compartir el reconocimiento con el plantel', fanDelta: 2, moraleDelta: 3, reputationDelta: 1 },
        { id: 'mantener_perfil_bajo', label: 'Mantener un perfil bajo', fanDelta: 0, confidenceDelta: 0, reputationDelta: 0 },
      ],
    },
    identificacion_club: {
      title: 'La hinchada se identifica con el equipo',
      description: `El estilo de juego y la entrega del equipo generaron una fuerte identificación con la hinchada.`,
      options: [
        { id: 'potenciar_identidad', label: 'Reforzar ese estilo de juego', fanDelta: 5, confidenceDelta: 1, reputationDelta: 1 },
        { id: 'destacar_entrega', label: 'Destacar la entrega del plantel', fanDelta: 3, moraleDelta: 2, reputationDelta: 0 },
        { id: 'enfocarse_resultados', label: 'Enfocarte solo en los resultados', fanDelta: -1, confidenceDelta: 1, reputationDelta: 0 },
      ],
    },
  };

  const base = byType[subtype];
  return {
    seasonYear,
    matchCount,
    kind: 'hinchada',
    subtype,
    title: base.title,
    description: base.description,
    options: base.options,
  };
}

// Se llama desde finalize-match.js al terminar CUALQUIER partido (liga, copa,
// supercopa o en vivo). Si el partido no involucra al club que dirige el
// usuario, no hace nada. Devuelve la lista de acontecimientos nuevos creados.
async function onMatchFinished(db, seasonYear, homeClubId, awayClubId, result) {
  const career = await getCareer(db);
  if (!career || career.status !== 'activo' || !career.club_id) return [];
  if (career.club_id !== homeClubId && career.club_id !== awayClubId) return [];

  const isHome = career.club_id === homeClubId;
  const forGoals = isHome ? result.homeGoals : result.awayGoals;
  const againstGoals = isHome ? result.awayGoals : result.homeGoals;
  const resultTag = forGoals > againstGoals ? 'win' : forGoals < againstGoals ? 'loss' : 'draw';
  const opponentClubId = isHome ? awayClubId : homeClubId;
  const opponentName = (await getClubName(db, opponentClubId)) || 'el rival';

  const matchCount = career.matches_managed + 1;
  const createdEvents = [];

  const myName = await getClubName(db, career.club_id);
  if (isRivalryPair(myName, opponentName) && matchCount - career.last_clasico_at >= COOLDOWN.clasico) {
    createdEvents.push(await buildClasicoEvent(db, career, seasonYear, matchCount, opponentName, resultTag));
    career.last_clasico_at = matchCount;
  }

  if (matchCount % COOLDOWN.reunion === 0 && matchCount !== career.last_reunion_at) {
    createdEvents.push(await buildReunionEvent(db, career, seasonYear, matchCount));
    career.last_reunion_at = matchCount;

    if (
      career.board_confidence >= 65 &&
      matchCount - career.last_exigencia_at >= COOLDOWN.exigencia &&
      chance(0.4)
    ) {
      createdEvents.push(await buildExigenciaEvent(db, career, seasonYear, matchCount));
      career.last_exigencia_at = matchCount;
    }
  }

  let polemicaChance = 0.12;
  if (resultTag === 'loss') polemicaChance += 0.08;
  if (resultTag === 'win') polemicaChance -= 0.05;
  if (career.locker_room_morale < 40) polemicaChance += 0.1;
  if (matchCount - career.last_polemica_at >= COOLDOWN.polemica && chance(Math.max(0.03, polemicaChance))) {
    createdEvents.push(await buildPolemicaEvent(db, career, seasonYear, matchCount, resultTag));
    career.last_polemica_at = matchCount;
  }

  // HINCHADA: ademas de los acontecimientos puntuales, el apoyo de la
  // hinchada reacciona de forma pasiva (y acotada) a cada resultado, igual que
  // pasaria en la vida real partido a partido: una victoria sube, una derrota
  // baja, y los clasicos pesan el doble en cualquiera de los dos sentidos.
  const isDerby = isRivalryPair(myName, opponentName);
  const fanBefore = career.fan_support != null ? career.fan_support : 60;
  let fanDrift = resultTag === 'win' ? 2 : resultTag === 'loss' ? -3 : -0.5;
  if (isDerby) fanDrift *= 2;
  const fanAfterDrift = clamp(fanBefore + fanDrift);

  let marketOpen = false;
  try {
    const status = await require('./market').getMarketStatus(db);
    marketOpen = !!status.open;
  } catch {
    marketOpen = false;
  }

  let hinchadaChance = 0.1;
  if (fanAfterDrift <= 35 || fanAfterDrift >= 75) hinchadaChance += 0.08;
  if (matchCount - career.last_hinchada_at >= COOLDOWN.hinchada && chance(hinchadaChance)) {
    createdEvents.push(
      await buildHinchadaEvent(db, { ...career, fan_support: fanAfterDrift }, seasonYear, matchCount, marketOpen)
    );
    career.last_hinchada_at = matchCount;
  }

  await db
    .prepare(
      `UPDATE career SET matches_managed = ?, fan_support = ?, last_reunion_at = ?, last_exigencia_at = ?, last_polemica_at = ?, last_clasico_at = ?, last_hinchada_at = ? WHERE id = 1`
    )
    .run(
      matchCount,
      fanAfterDrift,
      career.last_reunion_at,
      career.last_exigencia_at,
      career.last_polemica_at,
      career.last_clasico_at,
      career.last_hinchada_at
    );

  const inserted = [];
  for (const evt of createdEvents) {
    inserted.push(await insertEvent(db, evt));
  }
  return inserted;
}

async function resolveEvent(db, eventId, optionId) {
  const event = await getEventById(db, eventId);
  if (!event) throw new Error('Acontecimiento no encontrado.');
  if (event.status !== 'pendiente') throw new Error('Este acontecimiento ya fue resuelto.');

  const option = event.options.find((o) => o.id === optionId);
  if (!option) throw new Error('Opción no válida.');

  const career = await getCareer(db);
  if (!career) throw new Error('No hay partida activa.');

  const newConfidence = clamp(career.board_confidence + (option.confidenceDelta || 0));
  const newMorale = clamp(career.locker_room_morale + (option.moraleDelta || 0));
  const newFan = clamp((career.fan_support != null ? career.fan_support : 60) + (option.fanDelta || 0));
  const newReputation = clamp(career.manager_reputation + (option.reputationDelta || 0));

  await db
    .prepare(
      `UPDATE career SET board_confidence = ?, locker_room_morale = ?, fan_support = ?, manager_reputation = ? WHERE id = 1`
    )
    .run(newConfidence, newMorale, newFan, newReputation);

  const resultText = `Elegiste: "${option.label}". Confianza del directorio: ${newConfidence}, hinchada: ${newFan}, ambiente del vestuario: ${newMorale}, reputación: ${newReputation}.`;

  await db
    .prepare(
      `UPDATE career_events SET status = 'resuelto', chosen_option = ?, result_text = ?, resolved_at = datetime('now') WHERE id = ?`
    )
    .run(optionId, resultText, eventId);

  return { event: await getEventById(db, eventId), career: await getCareer(db) };
}

// Pequeño ajuste (acotado) a la progresion de rating segun el ambiente del
// vestuario, solo para los jugadores del club que dirige el usuario: un buen
// ambiente favorece levemente el crecimiento, uno malo favorece la baja.
async function moraleProgressModifier(db, clubId) {
  const career = await getCareer(db);
  if (!career || career.club_id !== clubId) return { growthDelta: 0, declineDelta: 0 };
  const morale = career.locker_room_morale;
  const offset = (morale - 60) / 400; // entre -0.15 y +0.1 aprox.
  return { growthDelta: offset, declineDelta: -offset };
}

module.exports = {
  onMatchFinished,
  resolveEvent,
  getPendingEvents,
  getEventHistory,
  moraleProgressModifier,
  isRivalryPair,
};
