// Directorio del club: fija objetivos de temporada para el club que dirige el
// usuario y evalua si se cumplieron al cerrar la temporada (o si corresponde despido).
const { DIVISIONS } = require('./league');

async function clubStrength(db, clubId) {
  const row = await db
    .prepare(
      `SELECT AVG(rating) as avg FROM players WHERE club_id = ? AND status IN ('activo','lesionado') AND is_real_player = 1`
    )
    .get(clubId);
  return row && row.avg != null ? row.avg : 60;
}

async function clubDivision(db, clubId) {
  const row = await db.prepare('SELECT division FROM clubs WHERE id = ?').get(clubId);
  return row ? row.division : 'Primera A';
}

async function clubBudget(db, clubId) {
  const row = await db.prepare('SELECT budget FROM clubs WHERE id = ?').get(clubId);
  return row ? row.budget : 0;
}

function normalizeClubName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Exigencia fija para los clubes historicamente mas grandes de Chile, por
// nombre (no por id, para que sea estable sin importar como se sembro la BD).
const FIXED_EXIGENCE = {
  'colo-colo': 'champion',
  'universidad de chile': 'title_contender',
  'universidad catolica': 'title_contender',
};

// Ubica al club dentro de su division segun plantel + presupuesto (0 = el
// mejor del lote, 1 = el mas debil), para repartir exigencias "a medida" al
// resto de los clubes sin tener que fijarlas una por una.
async function divisionPercentile(db, clubId, division) {
  const clubs = await db.prepare('SELECT id FROM clubs WHERE division = ? AND active = 1').all(division);
  if (clubs.length <= 1) return 0.5;
  const scored = [];
  for (const c of clubs) {
    const score = (await clubStrength(db, c.id)) + (await clubBudget(db, c.id)) / 30;
    scored.push({ id: c.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const idx = scored.findIndex((c) => c.id === clubId);
  return idx === -1 ? 0.5 : idx / (scored.length - 1);
}

// Genera el objetivo de la proxima temporada: exigencia fija para los clubes
// grandes historicos, y a medida (segun presupuesto/plantel) para el resto.
async function generateObjective(db, clubId) {
  const division = await clubDivision(db, clubId);
  const club = await db.prepare('SELECT name FROM clubs WHERE id = ?').get(clubId);
  const fixed = FIXED_EXIGENCE[normalizeClubName(club && club.name)];

  if (fixed === 'champion') {
    return {
      kind: 'champion',
      target: 1,
      text: 'Exigencia máxima: ser campeón del Campeonato Nacional. No basta con clasificar a copas ni quedar segundo.',
    };
  }
  if (fixed === 'title_contender') {
    return {
      kind: 'title_contender',
      target: 3,
      text: 'Exigencia alta: pelear el Campeonato Nacional y hacer un buen papel en la Copa Chile.',
    };
  }

  const percentile = await divisionPercentile(db, clubId, division);

  if (division === 'Primera A') {
    if (percentile <= 0.15) {
      return { kind: 'continental', target: 4, text: 'Pelear los primeros puestos y clasificar a torneos internacionales.' };
    }
    if (percentile >= 0.82) {
      return { kind: 'avoid_relegation', target: null, text: 'Evitar el descenso a Primera B.' };
    }
    return {
      kind: 'top_mid',
      target: null,
      text: 'Terminar en una posición tranquila de la tabla y competir por puestos de copa.',
    };
  }

  if (percentile <= 0.2) {
    return { kind: 'promote', target: 2, text: 'Pelear el ascenso a Primera A (terminar entre los 2 primeros de Primera B).' };
  }
  return { kind: 'competitive_b', target: 8, text: 'Realizar una campaña competitiva en Primera B.' };
}

// Cuanto mueve cada tipo de exigencia la confianza del directorio al cumplirse
// o no: los objetivos mas altos premian/castigan con mas fuerza.
const EXIGENCE_PROFILE = {
  champion: { metGain: 20, missPenalty: 28 },
  title_contender: { metGain: 15, missPenalty: 20 },
  continental: { metGain: 10, missPenalty: 12 },
  top_mid: { metGain: 6, missPenalty: 8 },
  avoid_relegation: { metGain: 8, missPenalty: 30 },
  promote: { metGain: 15, missPenalty: 10 },
  competitive_b: { metGain: 6, missPenalty: 6 },
  top_n: { metGain: 8, missPenalty: 10 }, // compat con guardados antiguos
};

// Cuanto pesa la exigencia del club sobre la tolerancia del directorio a
// tener indicadores bajos: un club grande (Colo-Colo, title_contender, etc.)
// tolera mucho menos que uno chico con expectativas modestas.
const EXIGENCE_TOLERANCE_WEIGHT = {
  champion: 1.5,
  title_contender: 1.3,
  continental: 1.1,
  promote: 1.1,
  top_mid: 1,
  avoid_relegation: 1,
  competitive_b: 0.85,
  top_n: 1,
};

// Evalua la continuidad del entrenador mirando los TRES indicadores a la vez
// (no solo la confianza del directorio): cuantos estan en nivel critico decide
// que tan grave es la situacion. Un solo indicador bajo nunca despide por si
// solo; dos indicadores criticos abren una evaluacion de continuidad (riesgo
// moderado); los tres criticos a la vez disparan un riesgo alto de despido.
// La exigencia del club (clubes grandes = menos paciencia) escala ese riesgo.
function evaluateContinuity(db, career, confidence, morale, fan) {
  const CRITICAL = 30;
  const criticalCount = [confidence, morale, fan].filter((v) => v <= CRITICAL).length;
  if (criticalCount < 2) return false;

  const weight = EXIGENCE_TOLERANCE_WEIGHT[career.objective_kind] || 1;
  const { chance } = require('./random');
  if (criticalCount >= 3) return chance(Math.min(0.92, 0.5 * weight));
  return chance(Math.min(0.5, 0.18 * weight));
}

// Decide si el objetivo de la temporada se cumplio. Para title_contender
// (U. de Chile / U. Católica) tambien cuenta ganar la Copa Chile, ya que el
// objetivo es "pelear" ambos torneos, no solo terminar arriba en la liga.
async function isObjectiveMet(db, career, seasonYear, position, total) {
  const kind = career.objective_kind;
  const target = career.objective_target;

  if (kind === 'champion') return position === 1;
  if (kind === 'title_contender') {
    if (position <= target) return true;
    try {
      const { getCopaChampion } = require('./copa');
      return (await getCopaChampion(db, seasonYear)) === career.club_name;
    } catch {
      return false;
    }
  }
  if (kind === 'avoid_relegation' || kind === 'top_mid') return position <= total - 2;
  if (kind === 'continental' || kind === 'promote' || kind === 'competitive_b' || kind === 'top_n') return position <= target;
  return true;
}

async function createCareer(db, clubId, seasonYear) {
  const objective = await generateObjective(db, clubId);
  await db
    .prepare(
      `INSERT INTO career (id, club_id, status, hired_season, objective_text, objective_season, objective_kind, objective_target,
       board_confidence, locker_room_morale, fan_support, manager_reputation, media_pressure, matches_managed,
       last_reunion_at, last_exigencia_at, last_polemica_at, last_clasico_at, last_hinchada_at, last_prensa_at, team_identity)
     VALUES (1, ?, 'activo', ?, ?, ?, ?, ?, 60, 60, 60, 60, 40, 0, 0, 0, 0, 0, 0, 0, NULL)
     ON CONFLICT(id) DO UPDATE SET club_id=excluded.club_id, status='activo', hired_season=excluded.hired_season,
       objective_text=excluded.objective_text, objective_season=excluded.objective_season,
       objective_kind=excluded.objective_kind, objective_target=excluded.objective_target,
       fired_season=NULL, fired_reason=NULL,
       board_confidence=60, locker_room_morale=60, fan_support=60, manager_reputation=60, media_pressure=40, matches_managed=0,
       last_reunion_at=0, last_exigencia_at=0, last_polemica_at=0, last_clasico_at=0, last_hinchada_at=0, last_prensa_at=0, team_identity=NULL`
    )
    .run(clubId, seasonYear, objective.text, seasonYear, objective.kind, objective.target);
}

async function getCareer(db) {
  const row = await db
    .prepare(
      `SELECT ca.*, c.name as club_name, c.short_name as club_short_name, c.crest_url as club_crest, c.division as club_division
       FROM career ca LEFT JOIN clubs c ON c.id = ca.club_id WHERE ca.id = 1`
    )
    .get();
  return row || null;
}

// Evalua el objetivo de la temporada que recien termino (usando la division en la
// que el club jugo esa temporada, ANTES de aplicar ascenso/descenso) y decide si
// el usuario sigue en el cargo o es despedido. Debe llamarse antes de
// applyPromotionRelegation, y generateObjective (para la proxima temporada) despues.
async function reviewSeason(db, seasonYear) {
  const career = await getCareer(db);
  if (!career || career.status !== 'activo') return null;

  const { getStandings } = require('./league');
  const division = career.club_division;
  const standings = await getStandings(db, seasonYear, division);
  const idx = standings.findIndex((s) => s.club_id === career.club_id);
  const position = idx === -1 ? standings.length : idx + 1;
  const total = standings.length;

  const met = await isObjectiveMet(db, career, seasonYear, position, total);
  const positionText = `Terminaste ${position}° de ${total} en ${division}.`;

  // La exigencia de cada club pesa distinto sobre confianza/reputacion: no
  // cumplir con Colo-Colo golpea mucho mas fuerte que no cumplir con un club
  // de mitad de tabla. Igual que con el sistema de acontecimientos
  // (career-events.js), el despido ya no es automatico al primer tropiezo:
  // se llega a el cuando la confianza del directorio se agota del todo.
  const profile = EXIGENCE_PROFILE[career.objective_kind] || { metGain: 8, missPenalty: 10 };
  const confidenceBefore = career.board_confidence != null ? career.board_confidence : 60;
  const reputationBefore = career.manager_reputation != null ? career.manager_reputation : 60;
  const fanBefore = career.fan_support != null ? career.fan_support : 60;
  const moraleNow = career.locker_room_morale != null ? career.locker_room_morale : 60;
  const confidenceAfter = Math.max(0, Math.min(100, confidenceBefore + (met ? profile.metGain : -profile.missPenalty)));
  const reputationAfter = Math.max(0, Math.min(100, reputationBefore + (met ? 4 : -3)));
  // La hinchada reacciona a la posicion final y al cumplimiento del objetivo,
  // pero con menos fuerza que la dirigencia (ya recibe ajustes partido a
  // partido en onMatchFinished): el cierre de temporada es solo un empujon.
  const positionRatio = total > 1 ? (total - position) / (total - 1) : 1; // 1 = campeon, 0 = ultimo
  const fanSeasonDelta = Math.round((positionRatio - 0.5) * 16 + (met ? 4 : -4));
  const fanAfter = Math.max(0, Math.min(100, fanBefore + fanSeasonDelta));
  await db.prepare('UPDATE career SET board_confidence = ?, manager_reputation = ?, fan_support = ? WHERE id = 1').run(
    confidenceAfter,
    reputationAfter,
    fanAfter
  );

  // Despido: la confianza del directorio agotada por completo siempre destituye
  // (ancla el sistema a algo tangible), y por fuera de eso una evaluacion
  // probabilistica mira los tres indicadores juntos (ver evaluateContinuity).
  const fired = confidenceAfter <= 12 || evaluateContinuity(db, career, confidenceAfter, moraleNow, fanAfter);
  if (fired) {
    await db.prepare("UPDATE career SET status = 'despedido', fired_season = ?, fired_reason = ? WHERE id = 1").run(
      seasonYear,
      met ? 'Pérdida de confianza del directorio' : career.objective_text
    );
  }

  await db.prepare(`INSERT INTO board_meetings (season_year, message, result) VALUES (?, ?, ?)`).run(
    seasonYear,
    met
      ? `Objetivo cumplido: ${career.objective_text} ${positionText} Confianza del directorio: ${confidenceAfter}.`
      : `Objetivo incumplido: ${career.objective_text} ${positionText} Confianza del directorio: ${confidenceAfter}.${fired ? ' Despedido.' : ' El directorio exige mejoras.'}`,
    met ? 'cumplido' : 'incumplido'
  );

  if (met && fired) {
    return {
      met: true,
      fired: true,
      message: `Cumpliste el objetivo (${positionText}), pero el directorio ya no confiaba en tu gestión. Has sido destituido.`,
    };
  }
  if (met) {
    return {
      met: true,
      fired: false,
      message: `El directorio está satisfecho. ${positionText} Objetivo cumplido: ${career.objective_text} (confianza: ${confidenceAfter}).`,
    };
  }
  if (fired) {
    return { met: false, fired: true, message: `El directorio te ha destituido. ${positionText} No se cumplió: ${career.objective_text}` };
  }
  return {
    met: false,
    fired: false,
    message: `No se cumplió el objetivo (${positionText}). ${career.objective_text} El directorio está preocupado y la presión aumenta (confianza: ${confidenceAfter}).`,
  };
}

// Fija el objetivo de la temporada que recien empieza (se llama tras el ascenso/
// descenso, para que use la division ya actualizada).
async function setNextObjective(db, seasonYear) {
  const career = await getCareer(db);
  if (!career || career.status !== 'activo') return null;
  const objective = await generateObjective(db, career.club_id);
  await db
    .prepare(`UPDATE career SET objective_text = ?, objective_season = ?, objective_kind = ?, objective_target = ? WHERE id = 1`)
    .run(objective.text, seasonYear, objective.kind, objective.target);
  return objective;
}

async function expirePendingOffers(db) {
  await db.prepare("UPDATE job_offers SET status = 'expirada' WHERE status = 'pendiente'").run();
}

async function candidatesByStrength(db, excludeClubId) {
  const clubs = await db.prepare('SELECT id FROM clubs WHERE active = 1 AND id != ?').all(excludeClubId);
  const result = [];
  for (const c of clubs) {
    result.push({ id: c.id, strength: await clubStrength(db, c.id) });
  }
  return result;
}

// Genera ofertas de trabajo de otros clubes: si te despidieron, clubes de nivel
// similar o menor se arriesgan a contratarte; si te fue bien, un club mas grande
// puede intentar robarte. Se llama despues de reviewSeason/applyPromotionRelegation.
async function generateJobOffers(db, seasonYear) {
  const career = await getCareer(db);
  if (!career || !career.club_id) return [];

  await expirePendingOffers(db);
  const insertOffer = db.prepare(`INSERT INTO job_offers (season_year, club_id, reason) VALUES (?, ?, ?)`);
  const createdIds = [];

  // La reputacion acumulada via el sistema de acontecimientos (career-events.js)
  // amplia o reduce levemente estas oportunidades; 60 es el valor neutro.
  const reputation = career.manager_reputation != null ? career.manager_reputation : 60;

  if (career.status === 'despedido') {
    const myStrength = await clubStrength(db, career.club_id);
    const reputationMargin = 4 + (reputation - 60) / 20;
    let candidates = (await candidatesByStrength(db, career.club_id)).filter((c) => c.strength <= myStrength + reputationMargin);
    if (!candidates.length) candidates = await candidatesByStrength(db, career.club_id);
    candidates.sort(() => Math.random() - 0.5);

    const count = candidates.length ? 1 + Math.floor(Math.random() * 2) : 0;
    for (const c of candidates.slice(0, count)) {
      const info = await insertOffer.run(seasonYear, c.id, 'despido');
      createdIds.push(info.lastInsertRowid);
    }
  } else if (career.status === 'activo' && Math.random() < 0.18 * Math.max(0.5, Math.min(1.5, reputation / 60))) {
    const myStrength = await clubStrength(db, career.club_id);
    const candidate = (await candidatesByStrength(db, career.club_id))
      .filter((c) => c.strength > myStrength + 3)
      .sort((a, b) => b.strength - a.strength)[0];
    if (candidate) {
      const info = await insertOffer.run(seasonYear, candidate.id, 'buen_trabajo');
      createdIds.push(info.lastInsertRowid);
    }
  }

  if (!createdIds.length) return [];
  const placeholders = createdIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT jo.*, c.name as club_name, c.short_name as club_short_name, c.crest_url as club_crest, c.division as club_division
       FROM job_offers jo JOIN clubs c ON c.id = jo.club_id WHERE jo.id IN (${placeholders})`
    )
    .all(...createdIds);
}

async function getPendingOffers(db) {
  return db
    .prepare(
      `SELECT jo.*, c.name as club_name, c.short_name as club_short_name, c.crest_url as club_crest, c.division as club_division
       FROM job_offers jo JOIN clubs c ON c.id = jo.club_id
       WHERE jo.status = 'pendiente' ORDER BY jo.id DESC`
    )
    .all();
}

async function acceptOffer(db, offerId, seasonYear) {
  const offer = await db.prepare('SELECT * FROM job_offers WHERE id = ?').get(offerId);
  if (!offer || offer.status !== 'pendiente') throw new Error('Esta oferta ya no está disponible.');

  const objective = await generateObjective(db, offer.club_id);
  await db
    .prepare(
      `UPDATE career SET club_id = ?, status = 'activo', hired_season = ?, objective_text = ?, objective_season = ?,
       objective_kind = ?, objective_target = ?, fired_season = NULL, fired_reason = NULL,
       board_confidence = 60, locker_room_morale = 60, fan_support = 60, manager_reputation = 60, media_pressure = 40, matches_managed = 0,
       last_reunion_at = 0, last_exigencia_at = 0, last_polemica_at = 0, last_clasico_at = 0, last_hinchada_at = 0, last_prensa_at = 0,
       team_identity = NULL WHERE id = 1`
    )
    .run(offer.club_id, seasonYear, objective.text, seasonYear, objective.kind, objective.target);

  await db.prepare(`UPDATE job_offers SET status = 'aceptada' WHERE id = ?`).run(offerId);
  await db.prepare(`UPDATE job_offers SET status = 'expirada' WHERE status = 'pendiente' AND id != ?`).run(offerId);

  return getCareer(db);
}

async function declineOffer(db, offerId) {
  const offer = await db.prepare('SELECT * FROM job_offers WHERE id = ?').get(offerId);
  if (!offer || offer.status !== 'pendiente') throw new Error('Esta oferta ya no está disponible.');
  await db.prepare(`UPDATE job_offers SET status = 'rechazada' WHERE id = ?`).run(offerId);
  return getCareer(db);
}

module.exports = {
  clubStrength,
  generateObjective,
  createCareer,
  getCareer,
  reviewSeason,
  setNextObjective,
  generateJobOffers,
  getPendingOffers,
  acceptOffer,
  declineOffer,
  DIVISIONS,
};
