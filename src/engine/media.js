// MEDIOS: panel de analisis al estilo de los programas de television
// deportiva chilenos, con dos comentaristas de personalidad fija que opinan
// sobre los partidos, fichajes y decisiones del entrenador del club que
// dirige el usuario. Todo el texto es generado por plantillas de la propia
// simulacion (nunca declaraciones reales) y siempre se marca como tal; no
// hay ninguna frase real ni verificada de las personas reales en las que se
// inspiran los personajes.
const { chance, randInt } = require('./random');

// require perezoso: board.js llega a este modulo de forma transitiva via
// finalize-match.js/league.js/live-match.js, asi que requerirlo aqui arriba
// crearia un ciclo (mismo caso que team-identity.js).
function boardModule() {
  return require('./board');
}

const PERSONAS = {
  borghi: {
    key: 'borghi',
    name: 'Claudio Borghi',
    photo: 'media/borghi.jpg',
    role: 'Panelista',
  },
  tezanos: {
    key: 'tezanos',
    name: 'Manuel de Tezanos',
    photo: 'media/tezanos.jpg',
    role: 'Panelista',
  },
};

// Aviso obligatorio en cada comentario generado: estas opiniones son ficticias
// de la simulacion, nunca declaraciones reales de las personas reales en las
// que se inspiran los personajes del juego.
const DISCLAIMER =
  'Opinión ficticia generada por la simulación de Pichanga 2026, no una declaración real.';

function listPersonas() {
  return Object.values(PERSONAS);
}

function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

const MENTALITY_LABEL = { defensivo: 'de atrás', equilibrado: 'equilibrado', ofensivo: 'arriesgado' };

// --- Comentarios de partido ---------------------------------------------
// Borghi: critico y exigente incluso en el triunfo. Tezanos: mas conciliador,
// defiende el proceso y el esfuerzo del plantel - para que ambos puedan
// discrepar sobre el mismo resultado.
function borghiMatchLines(ctx) {
  const { opponentName, forGoals, againstGoals, resultTag, isHome, mentalityLabel } = ctx;
  if (resultTag === 'win') {
    const big = forGoals - againstGoals >= 3;
    return [
      big
        ? `Goleada ante ${opponentName}, pero ojo, no nos volvamos locos: con un planteo ${mentalityLabel} ante un rival así, exijo que esto se repita contra los de arriba.`
        : `Ganaron ${forGoals}-${againstGoals} a ${opponentName}, se suman los tres puntos, pero me quedo con que faltó contundencia para un partido que debió ser más cómodo.`,
      `El técnico puede estar conforme con el resultado, pero el funcionamiento todavía tiene lagunas que un rival más armado va a castigar.`,
    ];
  }
  if (resultTag === 'draw') {
    return [
      `Empate ${forGoals}-${againstGoals} ${isHome ? 'de local' : 'de visita'} ante ${opponentName}: un punto que sabe a poco si la idea es pelear arriba.`,
      `Con un planteamiento ${mentalityLabel} no alcanza para doblegar a un rival directo. El entrenador tiene que repensar algo.`,
    ];
  }
  return [
    `Derrota ${forGoals}-${againstGoals} ante ${opponentName}. Así, con ese funcionamiento, no se le puede exigir nada más al plantel.`,
    `El planteo ${mentalityLabel} quedó expuesto. Si esto se repite, el banco empieza a tambalear.`,
  ];
}

function tezanosMatchLines(ctx) {
  const { opponentName, forGoals, againstGoals, resultTag, isHome, mentalityLabel } = ctx;
  if (resultTag === 'win') {
    return [
      `¡Buen triunfo ${forGoals}-${againstGoals} ante ${opponentName}! El equipo compitió bien y eso hay que destacarlo.`,
      `El planteo ${mentalityLabel} le dio resultado al entrenador. Hay que dejarlo trabajar tranquilo, va por buen camino.`,
    ];
  }
  if (resultTag === 'draw') {
    return [
      `Empate justo ${forGoals}-${againstGoals} ${isHome ? 'en casa' : 'afuera'} frente a ${opponentName}. Sumar de a uno también cuenta en una temporada larga.`,
      `Vi un equipo ordenado con un planteo ${mentalityLabel}. No hay que dramatizar por un punto.`,
    ];
  }
  return [
    `Dolorosa derrota ${forGoals}-${againstGoals} con ${opponentName}, pero hay que tener paciencia con el proceso del entrenador.`,
    `El plantel compitió, no le voy a bajar el pulgar al técnico por un resultado adverso.`,
  ];
}

// Genera y persiste el bloque de comentarios de un partido del club que
// dirige el usuario (nunca para partidos entre rivales IA - solo es
// relevante para el club gestionado).
async function recordMatchComment(db, { seasonYear, clubName, opponentName, isHome, forGoals, againstGoals, mentality, matchLabel }) {
  const resultTag = forGoals > againstGoals ? 'win' : forGoals < againstGoals ? 'loss' : 'draw';
  const mentalityLabel = MENTALITY_LABEL[mentality] || 'equilibrado';
  const ctx = { opponentName, forGoals, againstGoals, resultTag, isHome, mentalityLabel };

  const borghiText = pick(borghiMatchLines(ctx));
  const tezanosText = pick(tezanosMatchLines(ctx));
  const headline = `${clubName} ${forGoals}-${againstGoals} ${opponentName}${matchLabel ? ` · ${matchLabel}` : ''}`;

  await insertComment(db, { seasonYear, kind: 'partido', headline, borghiText, tezanosText });
}

// --- Comentarios de fichaje ----------------------------------------------
function borghiSigningLines(ctx) {
  const { playerName, position, fee } = ctx;
  return [
    `¿${playerName} por ${fee}? Vamos a ver si rinde, porque en el papel los números no siempre se traducen en la cancha.`,
    `Un ${position?.toLowerCase() || 'jugador'} más para el plantel. El mercado está para reforzar donde realmente duele, espero que no sea un gasto más.`,
  ];
}

function tezanosSigningLines(ctx) {
  const { playerName, position, fee } = ctx;
  return [
    `Lindo fichaje, ${playerName} le da variantes al entrenador en ${position ? position.toLowerCase() : 'el plantel'}. Buena jugada de la dirigencia por ${fee}.`,
    `Hay que darle la bienvenida a ${playerName}, siempre suma competencia interna y eso le hace bien al grupo.`,
  ];
}

async function recordSigningComment(db, { seasonYear, clubName, playerName, position, fee }) {
  const ctx = { playerName, position, fee: fee || 'un monto reservado' };
  const borghiText = pick(borghiSigningLines(ctx));
  const tezanosText = pick(tezanosSigningLines(ctx));
  const headline = `${clubName} ficha a ${playerName}`;
  await insertComment(db, { seasonYear, kind: 'fichaje', headline, borghiText, tezanosText });
}

async function insertComment(db, { seasonYear, kind, headline, borghiText, tezanosText }) {
  await db.prepare(
    `INSERT INTO media_comments (season_year, kind, headline, borghi_text, tezanos_text, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(seasonYear, kind, headline, borghiText, tezanosText);
}

// Partido terminado: solo genera comentario si el club gestionado jugo este
// partido (aislado - nunca debe poder romper el registro de un partido).
async function onMatchFinishedMedia(db, seasonYear, homeClubId, awayClubId, result, matchLabel, career) {
  career = career !== undefined ? career : await boardModule().getCareer(db);
  if (!career || career.status !== 'activo' || !career.club_id) return;
  if (career.club_id !== homeClubId && career.club_id !== awayClubId) return;
  // Las opiniones no se generan en cada partido: solo a veces, como pasaria
  // en un programa real que no cubre absolutamente todos los partidos.
  if (!chance(0.65)) return;

  const isHome = career.club_id === homeClubId;
  const forGoals = isHome ? result.homeGoals : result.awayGoals;
  const againstGoals = isHome ? result.awayGoals : result.homeGoals;
  const opponentClubId = isHome ? awayClubId : homeClubId;
  const clubRow = await db.prepare('SELECT name FROM clubs WHERE id = ?').get(career.club_id);
  const clubName = clubRow.name;
  const opponentRow = await db.prepare('SELECT name FROM clubs WHERE id = ?').get(opponentClubId);
  const opponentName = (opponentRow || {}).name || 'el rival';
  const tactics = await db.prepare('SELECT pref_mentality FROM clubs WHERE id = ?').get(career.club_id);

  try {
    await recordMatchComment(db, {
      seasonYear,
      clubName,
      opponentName,
      isHome,
      forGoals,
      againstGoals,
      mentality: tactics ? tactics.pref_mentality : null,
      matchLabel,
    });
  } catch (err) {
    console.error('media onMatchFinishedMedia failed:', err);
  }
}

// Fichaje completado para el club gestionado (llamado desde las rutas de
// mercado, que ya actuan siempre sobre status.clubId = career.club_id).
async function onSigningCompletedMedia(db, seasonYear, clubId, playerId) {
  try {
    const career = await boardModule().getCareer(db);
    if (!career || career.club_id !== clubId) return;
    const player = await db.prepare('SELECT full_name, position FROM players WHERE id = ?').get(playerId);
    if (!player) return;
    const clubRow = await db.prepare('SELECT name FROM clubs WHERE id = ?').get(clubId);
    const clubName = clubRow.name;
    const transfer = await db
      .prepare('SELECT fee_text FROM transfers WHERE player_id = ? AND to_club_id = ? ORDER BY id DESC LIMIT 1')
      .get(playerId, clubId);
    await recordSigningComment(db, {
      seasonYear,
      clubName,
      playerName: player.full_name,
      position: player.position,
      fee: transfer ? transfer.fee_text : null,
    });
  } catch (err) {
    console.error('media onSigningCompletedMedia failed:', err);
  }
}

async function getComments(db, limit) {
  const rows = await db.prepare('SELECT * FROM media_comments ORDER BY id DESC LIMIT ?').all(limit || 30);
  return rows.map((row) => ({ ...row, disclaimer: DISCLAIMER }));
}

module.exports = {
  PERSONAS,
  DISCLAIMER,
  listPersonas,
  onMatchFinishedMedia,
  onSigningCompletedMedia,
  getComments,
};
