// Mercado de pases: ventanas de verano/invierno, fichaje de agentes libres
// extranjeros, ofertas por jugadores de otros clubes, y ofertas entrantes de
// otros clubes por jugadores del plantel del usuario.
const { pick, randInt, weightedPick, chance } = require('./random');
const { ageInSeason } = require('./age');
const { getNextJornada, totalJornadas } = require('./league');
const { getCareer } = require('./board');

// Nombres por nacionalidad, usados SOLO para generar agentes libres ficticios.
// Nunca se usan para representar a un futbolista real.
const NAME_POOLS = {
  Brasil: {
    first: ['Gabriel', 'Lucas', 'Matheus', 'Rafael', 'Thiago', 'Bruno', 'Everton', 'Wesley', 'Kaio', 'Douglas'],
    last: ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Costa', 'Carvalho', 'Ferreira', 'Ribeiro', 'Almeida'],
  },
  Argentina: {
    first: ['Lautaro', 'Nahuel', 'Facundo', 'Ezequiel', 'Rodrigo', 'Franco', 'Enzo', 'Thiago', 'Valentín', 'Santiago'],
    last: ['Fernández', 'Rodríguez', 'Gómez', 'Romero', 'Acosta', 'Medina', 'Suárez', 'Ibáñez', 'Cabrera', 'Molina'],
  },
  Uruguay: {
    first: ['Federico', 'Maximiliano', 'Nicolás', 'Agustín', 'Darwin', 'Giorgian', 'Facundo', 'Ronald', 'Sebastián', 'Mathías'],
    last: ['Pereira', 'Rodríguez', 'Fernández', 'Núñez', 'Cáceres', 'Olivera', 'Bentancur', 'Araújo', 'Coates', 'Valverde'],
  },
  Colombia: {
    first: ['Juan', 'Santiago', 'Luis', 'Jhon', 'Rafael', 'Édgar', 'Mateo', 'Yerry', 'Jefferson', 'Alexander'],
    last: ['Mina', 'Córdoba', 'Zapata', 'Muriel', 'Cuadrado', 'Lerma', 'Díaz', 'Arias', 'Borré', 'Uribe'],
  },
  España: {
    first: ['Álvaro', 'Pablo', 'Sergio', 'Carlos', 'Mario', 'Rubén', 'Iker', 'Marcos', 'Diego', 'Hugo'],
    last: ['García', 'Fernández', 'López', 'Martín', 'Sánchez', 'Romero', 'Navarro', 'Ortega', 'Serrano', 'Molina'],
  },
  Francia: {
    first: ['Hugo', 'Lucas', 'Antoine', 'Kylian', 'Mathis', 'Theo', 'Nathan', 'Enzo', 'Rayan', 'Jules'],
    last: ['Bernard', 'Dubois', 'Moreau', 'Lefevre', 'Girard', 'Roux', 'Fontaine', 'Rousseau', 'Blanc', 'Guerin'],
  },
  Alemania: {
    first: ['Lukas', 'Jonas', 'Finn', 'Maximilian', 'Felix', 'Niklas', 'Leon', 'Tim', 'Julian', 'Moritz'],
    last: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Becker', 'Hoffmann', 'Wagner', 'Koch', 'Richter'],
  },
  'Estados Unidos': {
    first: ['Tyler', 'Jordan', 'Ethan', 'Mason', 'Caleb', 'Ricardo', 'Diego', 'Andrew', 'Brandon', 'Gio'],
    last: ['Johnson', 'Williams', 'Brown', 'Reyna', 'Pulisic', 'Weah', 'Smith', 'Adams', 'Turner', 'Robinson'],
  },
  Japón: {
    first: ['Takumi', 'Kaoru', 'Daichi', 'Ritsu', 'Hiroki', 'Yuto', 'Kota', 'Sho', 'Ren', 'Yuki'],
    last: ['Tanaka', 'Suzuki', 'Sato', 'Watanabe', 'Ito', 'Yamamoto', 'Nakamura', 'Kobayashi', 'Kato', 'Yoshida'],
  },
};

const NATIONALITY_WEIGHTS = Object.keys(NAME_POOLS).map((n) => ({
  value: n,
  weight: n === 'Brasil' || n === 'Argentina' ? 18 : 10,
}));

const POSITION_WEIGHTS = [
  { value: 'Portero', weight: 10 },
  { value: 'Defensa', weight: 32 },
  { value: 'Mediocampista', weight: 34 },
  { value: 'Delantero', weight: 24 },
];

function generateForeignName(nationality) {
  const pool = NAME_POOLS[nationality];
  return `${pick(pool.first)} ${pick(pool.last)}`;
}

// Valor de mercado estimado (en miles de USD), funcion pura: nunca se guarda,
// se recalcula siempre con el rating/potencial/edad actuales para no quedar
// desactualizado a medida que un jugador progresa o envejece.
function estimateMarketValue(rating, potential, age) {
  const base = Math.pow(Math.max(0, rating - 40), 2.1) * 2.4;
  const potentialBonus = age <= 23 ? Math.max(0, potential - rating) * 18 : 0;
  let ageFactor = 1;
  if (age >= 30) ageFactor = Math.max(0.3, 1 - (age - 29) * 0.14);
  else if (age <= 20) ageFactor = 1.1;
  return Math.max(15, Math.round((base + potentialBonus) * ageFactor));
}

const SUMMER_WINDOW_SPAN = 5; // cuantas jornadas dura la ventana de verano
const HALF_WINDOW_SPAN = 6; // cuantas jornadas dura la ventana de invierno

// Determina si hay una ventana de mercado abierta para la division del club
// que dirige el usuario, usando el avance real del calendario de liga (sin
// necesidad de guardar estado nuevo de "ventana" en la base de datos).
async function getMarketWindow(db, seasonYear, division) {
  const nextJornada = await getNextJornada(db, seasonYear, division);
  const total = await totalJornadas(db, seasonYear, division);
  if (!total) return null;

  if (nextJornada == null || nextJornada <= SUMMER_WINDOW_SPAN) return 'verano';

  const halfPoint = Math.floor(total / 2);
  if (nextJornada >= halfPoint - 3 && nextJornada <= halfPoint + HALF_WINDOW_SPAN) return 'invierno';

  return null;
}

async function getMarketStatus(db) {
  const career = await getCareer(db);
  if (!career || !career.club_id) return { open: false, window: null };

  const seasonYear = await require('./season').getCurrentSeasonYear(db);
  const club = await db.prepare('SELECT * FROM clubs WHERE id = ?').get(career.club_id);
  const window = await getMarketWindow(db, seasonYear, club.division);

  // Solo se vuelve a pedir el club si ensureBudgetTopup pudo haber cambiado el
  // presupuesto; sin ventana abierta el SELECT de arriba ya sirve, evitando
  // un segundo round-trip idéntico en cada carga de esta pantalla.
  let finalClub = club;
  if (window) {
    await ensureBudgetTopup(db, club, seasonYear, window);
    finalClub = await db.prepare('SELECT * FROM clubs WHERE id = ?').get(career.club_id);
  }

  return {
    open: window != null,
    window,
    seasonYear,
    budget: finalClub.budget,
    clubId: finalClub.id,
  };
}

// Refuerza el presupuesto del club del usuario una sola vez por ventana
// (temporada+ventana), para que el jugador siempre tenga algo con que operar
// sin acumular presupuesto infinito abriendo/cerrando pantallas.
async function ensureBudgetTopup(db, club, seasonYear, window) {
  const key = `${seasonYear}-${window}`;
  if (club.last_budget_topup === key) return;

  const row = await db
    .prepare(
      `SELECT AVG(rating) as avg FROM players WHERE club_id = ? AND status IN ('activo','lesionado') AND is_real_player = 1`
    )
    .get(club.id);
  const avgRating = row && row.avg != null ? row.avg : 60;
  const base = club.division === 'Primera A' ? 90 : 35;
  const scale = club.division === 'Primera A' ? 4 : 2;
  const topup = Math.max(20, Math.round(base + Math.max(0, avgRating - 55) * scale));

  await db.prepare('UPDATE clubs SET budget = budget + ?, last_budget_topup = ? WHERE id = ?').run(topup, key, club.id);
}

// Genera (una sola vez por temporada+ventana) la bolsa de agentes libres
// extranjeros disponibles para fichar.
async function ensureFreeAgentPool(db, seasonYear, window) {
  const existingRow = await db
    .prepare('SELECT COUNT(*) as c FROM free_agents WHERE season_year = ? AND window = ?')
    .get(seasonYear, window);
  if (existingRow.c > 0) return;

  const insert = db.prepare(
    `INSERT INTO free_agents (season_year, window, full_name, birth_date, nationality, position, rating, potential, asking_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const count = randInt(16, 22);
  for (let i = 0; i < count; i++) {
    const nationality = weightedPick(NATIONALITY_WEIGHTS);
    const potential = chance(0.1) ? randInt(80, 93) : chance(0.3) ? randInt(70, 79) : randInt(55, 69);
    const age = randInt(18, 33);
    const gapMax = age <= 23 ? randInt(5, 15) : randInt(2, 8);
    const rating = Math.max(40, Math.min(potential, potential - gapMax + (age >= 29 ? randInt(0, 4) : 0)));
    const position = weightedPick(POSITION_WEIGHTS);
    const askingPrice = Math.round(estimateMarketValue(rating, potential, age) * (0.7 + Math.random() * 0.3));

    await insert.run(
      seasonYear,
      window,
      generateForeignName(nationality),
      `${seasonYear - age}-03-10`,
      nationality,
      position,
      rating,
      potential,
      askingPrice
    );
  }
}

async function getFreeAgents(db, seasonYear, window) {
  await ensureFreeAgentPool(db, seasonYear, window);
  const rows = await db
    .prepare(
      `SELECT * FROM free_agents WHERE season_year = ? AND window = ? AND signed = 0 ORDER BY rating DESC`
    )
    .all(seasonYear, window);
  return rows.map((p) => ({ ...p, age: ageInSeason(p.birth_date, seasonYear) }));
}

async function logSentOffer(db, { seasonYear, window, playerName, targetClubName, amount, kind, status, playerId, resolved }) {
  if (!window) return null;
  const info = await db
    .prepare(
      `INSERT INTO sent_offers (season_year, window, player_id, player_name, target_club_name, amount, kind, status, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      seasonYear,
      window,
      playerId != null ? playerId : null,
      playerName,
      targetClubName || null,
      amount != null ? amount : null,
      kind,
      status,
      resolved != null ? resolved : 1
    );
  return info.lastInsertRowid;
}

// Mueve un jugador de un club a otro contra pago, dentro de una transaccion:
// usada tanto por una oferta aceptada al instante como por la aceptacion
// posterior de una contraoferta. No hace ningun chequeo de negocio (budget,
// disponibilidad): eso es responsabilidad de quien llama.
async function executeTransfer(db, { playerId, buyerClubId, sellerClubId, amount, seasonYear }) {
  const tx = await db.transaction('write');
  try {
    await tx.prepare('UPDATE clubs SET budget = budget - ? WHERE id = ?').run(amount, buyerClubId);
    await tx.prepare('UPDATE clubs SET budget = budget + ? WHERE id = ?').run(amount, sellerClubId);
    await tx.prepare('UPDATE players SET club_id = ? WHERE id = ?').run(buyerClubId, playerId);

    await tx.prepare(
      `INSERT INTO transfers (player_id, season_year, from_club_id, to_club_id, type, fee_text) VALUES (?, ?, ?, ?, 'fichaje', ?)`
    ).run(playerId, seasonYear, sellerClubId, buyerClubId, `US$${amount}K`);

    await tx.prepare(
      `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, 'fichaje', ?)`
    ).run(playerId, seasonYear, `Transferido por US$${amount}K.`);

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// Ultimas ofertas que el usuario envio en la ventana de mercado actual, para
// el panel "Ofertas enviadas" (mas recientes primero).
async function getSentOffers(db, seasonYear, window, limit) {
  if (!window) return [];
  return db
    .prepare(`SELECT * FROM sent_offers WHERE season_year = ? AND window = ? ORDER BY id DESC LIMIT ?`)
    .all(seasonYear, window, limit || 20);
}

async function signFreeAgent(db, agentId, clubId, seasonYear, window) {
  const agent = await db.prepare('SELECT * FROM free_agents WHERE id = ?').get(agentId);
  if (!agent || agent.signed) throw new Error('Este jugador ya no está disponible.');

  const club = await db.prepare('SELECT * FROM clubs WHERE id = ?').get(clubId);
  if (!club) throw new Error('Club no encontrado.');
  if (club.budget < agent.asking_price) {
    throw new Error('El presupuesto no alcanza para este fichaje.');
  }

  const tx = await db.transaction('write');
  try {
    await tx.prepare('UPDATE clubs SET budget = budget - ? WHERE id = ?').run(agent.asking_price, clubId);
    await tx.prepare('UPDATE free_agents SET signed = 1 WHERE id = ?').run(agentId);
    const info = await tx
      .prepare(
        `INSERT INTO players (club_id, full_name, birth_date, nationality, position, rating, potential, status, is_real_player, created_at_season)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'activo', 0, ?)`
      )
      .run(clubId, agent.full_name, agent.birth_date, agent.nationality, agent.position, agent.rating, agent.potential, seasonYear);

    await tx.prepare(
      `INSERT INTO transfers (player_id, season_year, from_club_id, to_club_id, type, fee_text) VALUES (?, ?, NULL, ?, 'fichaje', ?)`
    ).run(info.lastInsertRowid, seasonYear, clubId, `Agente libre, US$${agent.asking_price}K`);

    await tx.prepare(
      `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, 'fichaje', ?)`
    ).run(info.lastInsertRowid, seasonYear, `Fichado como agente libre por US$${agent.asking_price}K.`);

    await tx.commit();
    await logSentOffer(db, {
      seasonYear,
      window,
      playerName: agent.full_name,
      targetClubName: 'Agente libre',
      amount: agent.asking_price,
      kind: 'agente_libre',
      status: 'aceptada',
    });
    return { playerId: info.lastInsertRowid, price: agent.asking_price };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// Busqueda unificada de "todo el mundo": agentes libres (de paises extranjeros)
// + jugadores de todos los demas clubes, con filtros combinables por nombre,
// edad, nacionalidad, posicion, club (o 'free_agent' para solo agentes libres)
// y rango de precio. No reemplaza a searchablePlayers/getFreeAgents (que se
// mantienen para no romper nada existente); es la base de la pantalla de
// mercado ampliada.
async function searchMarket(db, excludeClubId, seasonYear, window, filters = {}) {
  const { q, ageMin, ageMax, nationality, position, clubId, priceMin, priceMax } = filters;

  if (window) await ensureFreeAgentPool(db, seasonYear, window);

  let agents = [];
  if (window) {
    const rows = await db
      .prepare(`SELECT * FROM free_agents WHERE season_year = ? AND window = ? AND signed = 0`)
      .all(seasonYear, window);
    agents = rows.map((p) => ({
      ...p,
      age: ageInSeason(p.birth_date, seasonYear),
      market_value: p.asking_price,
      club_id: null,
      club_name: 'Agente libre',
      club_short_name: 'Libre',
      is_free_agent: true,
    }));
  }

  const clubPlayerRows = await db
    .prepare(
      `SELECT p.*, c.name as club_name, c.short_name as club_short_name
       FROM players p JOIN clubs c ON c.id = p.club_id
       WHERE p.club_id != ? AND p.status IN ('activo','lesionado') AND c.active = 1`
    )
    .all(excludeClubId);
  const clubPlayers = clubPlayerRows.map((p) => {
    const age = ageInSeason(p.birth_date, seasonYear);
    return { ...p, age, market_value: estimateMarketValue(p.rating, p.potential, age), is_free_agent: false };
  });

  let all = [...agents, ...clubPlayers];

  const needle = (q || '').trim().toLowerCase();
  if (needle) all = all.filter((p) => p.full_name.toLowerCase().includes(needle));
  if (ageMin != null && ageMin !== '') all = all.filter((p) => p.age >= Number(ageMin));
  if (ageMax != null && ageMax !== '') all = all.filter((p) => p.age <= Number(ageMax));
  if (nationality) all = all.filter((p) => p.nationality === nationality);
  if (position) all = all.filter((p) => p.position === position);
  if (clubId === 'free_agent') all = all.filter((p) => p.is_free_agent);
  else if (clubId != null && clubId !== '') all = all.filter((p) => p.club_id === Number(clubId));
  if (priceMin != null && priceMin !== '') all = all.filter((p) => p.market_value >= Number(priceMin));
  if (priceMax != null && priceMax !== '') all = all.filter((p) => p.market_value <= Number(priceMax));

  all.sort((a, b) => b.rating - a.rating);
  return all.slice(0, 150);
}

// Jugadores reales de otros clubes que se pueden buscar para ofertar por ellos.
async function searchablePlayers(db, excludeClubId, seasonYear, q) {
  const query = (q || '').trim();
  const rows = await db
    .prepare(
      `SELECT p.*, c.name as club_name, c.short_name as club_short_name
       FROM players p JOIN clubs c ON c.id = p.club_id
       WHERE p.club_id != ? AND p.status IN ('activo','lesionado') AND c.active = 1
       ${query ? 'AND p.full_name LIKE ?' : ''}
       ORDER BY p.rating DESC LIMIT 60`
    )
    .all(...(query ? [excludeClubId, `%${query}%`] : [excludeClubId]));

  return rows.map((p) => {
    const age = ageInSeason(p.birth_date, seasonYear);
    return { ...p, age, market_value: estimateMarketValue(p.rating, p.potential, age) };
  });
}

// Resuelve al instante una oferta por un jugador de otro club, con probabilidad
// de aceptacion segun cuanto supera (o no) la oferta al valor estimado. Si la
// oferta no alcanza pero tampoco es una burla, el club vendedor puede responder
// con una contraoferta (en vez de un simple rechazo) que el usuario puede luego
// aceptar o rechazar desde el panel "Ofertas enviadas".
async function bidForPlayer(db, playerId, buyerClubId, amount, seasonYear, window) {
  const player = await db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player || !player.club_id) throw new Error('Jugador no disponible.');
  if (player.club_id === buyerClubId) throw new Error('Ese jugador ya es tuyo.');

  const sellerClub = await db.prepare('SELECT name FROM clubs WHERE id = ?').get(player.club_id);
  const club = await db.prepare('SELECT * FROM clubs WHERE id = ?').get(buyerClubId);
  if (amount > club.budget) throw new Error('El presupuesto no alcanza para esta oferta.');

  const age = ageInSeason(player.birth_date, seasonYear);
  const value = estimateMarketValue(player.rating, player.potential, age);
  const ratio = amount / value;
  let acceptProb = ratio >= 1.3 ? 0.9 : ratio >= 1 ? 0.55 : ratio >= 0.8 ? 0.2 : 0.05;
  const accepted = chance(acceptProb);

  if (!accepted) {
    const canCounter = ratio >= 0.5;
    if (canCounter && chance(0.5)) {
      let counterAmount = Math.round(value * (0.95 + Math.random() * 0.2));
      if (counterAmount <= amount) counterAmount = amount + Math.max(10, Math.round(value * 0.1));
      const offerId = await logSentOffer(db, {
        seasonYear,
        window,
        playerId,
        playerName: player.full_name,
        targetClubName: sellerClub ? sellerClub.name : null,
        amount: counterAmount,
        kind: 'fichaje',
        status: 'contraoferta',
        resolved: 0,
      });
      return { accepted: false, countered: true, counterAmount, value, offerId };
    }
    await logSentOffer(db, {
      seasonYear,
      window,
      playerId,
      playerName: player.full_name,
      targetClubName: sellerClub ? sellerClub.name : null,
      amount,
      kind: 'fichaje',
      status: 'rechazada',
    });
    return { accepted: false, countered: false, value };
  }

  await executeTransfer(db, { playerId, buyerClubId, sellerClubId: player.club_id, amount, seasonYear });
  await logSentOffer(db, {
    seasonYear,
    window,
    playerId,
    playerName: player.full_name,
    targetClubName: sellerClub ? sellerClub.name : null,
    amount,
    kind: 'fichaje',
    status: 'aceptada',
  });
  return { accepted: true, countered: false, value };
}

// Acepta una contraoferta pendiente (fila 'contraoferta' no resuelta en
// sent_offers): revalida que el jugador siga disponible y que el presupuesto
// actual alcance para el monto que pidio el club vendedor.
async function acceptCounterOffer(db, offerId, buyerClubId, seasonYear) {
  const offer = await db.prepare('SELECT * FROM sent_offers WHERE id = ?').get(offerId);
  if (!offer || offer.kind !== 'fichaje' || offer.status !== 'contraoferta' || offer.resolved) {
    throw new Error('Esta contraoferta ya no esta disponible.');
  }
  const player = await db.prepare('SELECT * FROM players WHERE id = ?').get(offer.player_id);
  if (!player || !player.club_id) throw new Error('El jugador ya no esta disponible.');
  if (player.club_id === buyerClubId) throw new Error('Ese jugador ya es tuyo.');

  const club = await db.prepare('SELECT * FROM clubs WHERE id = ?').get(buyerClubId);
  if (offer.amount > club.budget) throw new Error('El presupuesto no alcanza para aceptar esta contraoferta.');

  await executeTransfer(db, { playerId: player.id, buyerClubId, sellerClubId: player.club_id, amount: offer.amount, seasonYear });
  await db.prepare("UPDATE sent_offers SET status = 'aceptada', resolved = 1 WHERE id = ?").run(offerId);
  return { accepted: true, amount: offer.amount };
}

// Rechaza una contraoferta pendiente: la deja marcada como resuelta para que
// desaparezcan sus botones de accion del panel "Ofertas enviadas".
async function declineCounterOffer(db, offerId) {
  const offer = await db.prepare('SELECT * FROM sent_offers WHERE id = ?').get(offerId);
  if (!offer || offer.kind !== 'fichaje' || offer.status !== 'contraoferta' || offer.resolved) {
    throw new Error('Esta contraoferta ya no esta disponible.');
  }
  await db.prepare("UPDATE sent_offers SET status = 'rechazada', resolved = 1 WHERE id = ?").run(offerId);
  return { ok: true };
}

// Ofertas entrantes de otros clubes por jugadores del plantel del usuario,
// generadas una vez por ventana, en el mismo espiritu que los job_offers.
async function ensureIncomingOffers(db, seasonYear, window, myClubId) {
  const existingRow = await db
    .prepare('SELECT COUNT(*) as c FROM transfer_offers WHERE season_year = ? AND window = ?')
    .get(seasonYear, window);
  if (existingRow.c > 0) return;

  const myPlayers = await db
    .prepare(
      `SELECT * FROM players WHERE club_id = ? AND status IN ('activo','lesionado') AND is_real_player = 1 ORDER BY rating DESC`
    )
    .all(myClubId);
  if (!myPlayers.length) return;

  const otherClubRows = await db.prepare('SELECT id FROM clubs WHERE active = 1 AND id != ?').all(myClubId);
  const otherClubs = otherClubRows.map((c) => c.id);
  if (!otherClubs.length) return;

  const insert = db.prepare(
    `INSERT INTO transfer_offers (season_year, window, player_id, buyer_club_id, offer_amount) VALUES (?, ?, ?, ?, ?)`
  );

  const offerCount = randInt(0, 3);
  const candidates = myPlayers.filter((p) => p.rating >= 58).sort(() => Math.random() - 0.5);
  for (const player of candidates.slice(0, offerCount)) {
    const age = ageInSeason(player.birth_date, seasonYear);
    const value = estimateMarketValue(player.rating, player.potential, age);
    const amount = Math.round(value * (0.85 + Math.random() * 0.5));
    await insert.run(seasonYear, window, player.id, pick(otherClubs), amount);
  }
}

async function getIncomingOffers(db, myClubId, seasonYear, window) {
  await ensureIncomingOffers(db, seasonYear, window, myClubId);
  return db
    .prepare(
      `SELECT tof.*, p.full_name as player_name, p.rating, p.position,
              c.name as buyer_club_name, c.short_name as buyer_club_short_name, c.crest_url as buyer_club_crest
       FROM transfer_offers tof
       JOIN players p ON p.id = tof.player_id
       JOIN clubs c ON c.id = tof.buyer_club_id
       WHERE p.club_id = ? AND tof.status = 'pendiente'
       ORDER BY tof.id DESC`
    )
    .all(myClubId);
}

async function acceptIncomingOffer(db, offerId, seasonYear) {
  const offer = await db.prepare('SELECT * FROM transfer_offers WHERE id = ?').get(offerId);
  if (!offer || offer.status !== 'pendiente') throw new Error('Esta oferta ya no está disponible.');
  const player = await db.prepare('SELECT * FROM players WHERE id = ?').get(offer.player_id);
  if (!player) throw new Error('Jugador no encontrado.');

  const tx = await db.transaction('write');
  try {
    await tx.prepare('UPDATE clubs SET budget = budget + ? WHERE id = ?').run(offer.offer_amount, player.club_id);
    await tx.prepare('UPDATE clubs SET budget = budget - ? WHERE id = ?').run(offer.offer_amount, offer.buyer_club_id);
    await tx.prepare('UPDATE players SET club_id = ? WHERE id = ?').run(offer.buyer_club_id, player.id);
    await tx.prepare(`UPDATE transfer_offers SET status = 'aceptada' WHERE id = ?`).run(offerId);

    await tx.prepare(
      `INSERT INTO transfers (player_id, season_year, from_club_id, to_club_id, type, fee_text) VALUES (?, ?, ?, ?, 'venta', ?)`
    ).run(player.id, seasonYear, player.club_id, offer.buyer_club_id, `US$${offer.offer_amount}K`);

    await tx.prepare(
      `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, 'fichaje', ?)`
    ).run(player.id, seasonYear, `Vendido por US$${offer.offer_amount}K.`);

    await tx.commit();
    return { ok: true };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function declineIncomingOffer(db, offerId) {
  const offer = await db.prepare('SELECT * FROM transfer_offers WHERE id = ?').get(offerId);
  if (!offer || offer.status !== 'pendiente') throw new Error('Esta oferta ya no está disponible.');
  await db.prepare(`UPDATE transfer_offers SET status = 'rechazada' WHERE id = ?`).run(offerId);
  return { ok: true };
}

// Mueve a un jugador a préstamo de fromClubId a toClubId, dejando registro en
// transfers/historial. Vuelve automaticamente a su club dueño al cierre de la
// siguiente temporada (ver recallDueLoans).
async function doLoanMove(db, playerId, fromClubId, toClubId, seasonYear, note) {
  const tx = await db.transaction('write');
  try {
    await tx.prepare(
      `UPDATE players SET club_id = ?, loaned_from_club_id = ?, loan_return_season = ? WHERE id = ?`
    ).run(toClubId, fromClubId, seasonYear + 1, playerId);

    await tx.prepare(
      `INSERT INTO transfers (player_id, season_year, from_club_id, to_club_id, type, fee_text) VALUES (?, ?, ?, ?, 'prestamo', ?)`
    ).run(playerId, seasonYear, fromClubId, toClubId, note || 'Cedido a préstamo por una temporada.');

    await tx.prepare(
      `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, 'prestamo', ?)`
    ).run(playerId, seasonYear, note || 'Cedido a préstamo por una temporada.');

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// El club del usuario pide prestado a un jugador de otro club. Se resuelve al
// instante con probabilidad segun el valor del jugador (los mas valiosos son
// mas dificiles de conseguir a préstamo).
async function requestLoan(db, playerId, borrowerClubId, seasonYear, window) {
  const player = await db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player || !player.club_id) throw new Error('Jugador no disponible.');
  if (player.club_id === borrowerClubId) throw new Error('Ese jugador ya es tuyo.');
  if (player.loaned_from_club_id) throw new Error('Este jugador ya está a préstamo en otro club.');

  const ownerClub = await db.prepare('SELECT name FROM clubs WHERE id = ?').get(player.club_id);
  const age = ageInSeason(player.birth_date, seasonYear);
  const value = estimateMarketValue(player.rating, player.potential, age);
  const prob = value > 400 ? 0.15 : value > 150 ? 0.35 : 0.6;
  if (!chance(prob)) {
    await logSentOffer(db, {
      seasonYear,
      window,
      playerName: player.full_name,
      targetClubName: ownerClub ? ownerClub.name : null,
      amount: null,
      kind: 'prestamo',
      status: 'rechazada',
    });
    return { accepted: false, value };
  }

  await doLoanMove(db, playerId, player.club_id, borrowerClubId, seasonYear, `Cedido a préstamo por una temporada.`);
  await logSentOffer(db, {
    seasonYear,
    window,
    playerName: player.full_name,
    targetClubName: ownerClub ? ownerClub.name : null,
    amount: null,
    kind: 'prestamo',
    status: 'aceptada',
  });
  return { accepted: true, value };
}

// El club del usuario ofrece a préstamo a uno de sus propios jugadores; se
// busca un club receptor al azar entre los demas clubes activos.
async function offerPlayerOnLoan(db, playerId, ownerClubId, seasonYear) {
  const player = await db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player || player.club_id !== ownerClubId) throw new Error('Ese jugador no es tuyo.');
  if (player.loaned_from_club_id) throw new Error('Este jugador ya está a préstamo.');

  const candidateRows = await db.prepare('SELECT id FROM clubs WHERE active = 1 AND id != ?').all(ownerClubId);
  const candidates = candidateRows.map((c) => c.id);
  if (!candidates.length) throw new Error('No hay clubes disponibles para recibirlo a préstamo.');

  const age = ageInSeason(player.birth_date, seasonYear);
  const prob = age <= 23 ? 0.55 : 0.3;
  if (!chance(prob)) return { accepted: false };

  const toClubId = pick(candidates);
  await doLoanMove(db, playerId, ownerClubId, toClubId, seasonYear, `Cedido a préstamo por una temporada.`);
  return { accepted: true, toClubId };
}

// Al cierre de temporada, devuelve a su club dueño a todos los jugadores cuyo
// préstamo ya vencio.
async function recallDueLoans(db, currentYear) {
  const due = await db
    .prepare('SELECT * FROM players WHERE loaned_from_club_id IS NOT NULL AND loan_return_season <= ?')
    .all(currentYear);

  for (const p of due) {
    await db.prepare(
      `UPDATE players SET club_id = ?, loaned_from_club_id = NULL, loan_return_season = NULL WHERE id = ?`
    ).run(p.loaned_from_club_id, p.id);

    await db.prepare(
      `INSERT INTO transfers (player_id, season_year, from_club_id, to_club_id, type, fee_text) VALUES (?, ?, ?, ?, 'prestamo', 'Retorno de préstamo')`
    ).run(p.id, currentYear, p.club_id, p.loaned_from_club_id);

    await db.prepare(
      `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, 'prestamo', 'Regresó a su club de origen tras finalizar el préstamo.')`
    ).run(p.id, currentYear);
  }
}

// Actividad automatica de mercado entre clubes dirigidos por la IA (el usuario
// no participa aqui): fichajes de agentes libres, compraventas entre clubes y
// algunos préstamos de juveniles de bajo protagonismo. Se corre una vez por
// temporada (desde season.js), para que el mundo del futbol siga moviendose
// aunque el usuario no entre al mercado.
async function simulateAiTransferMarket(db, seasonYear, userClubId) {
  const clubs = await db.prepare('SELECT * FROM clubs WHERE active = 1').all();
  const aiClubs = clubs.filter((c) => c.id !== userClubId);
  if (aiClubs.length < 2) return;

  await ensureFreeAgentPool(db, seasonYear, 'verano');

  // 1) Fichajes de agentes libres.
  for (const club of aiClubs) {
    if (!chance(0.5)) continue;
    const freshClub = await db.prepare('SELECT * FROM clubs WHERE id = ?').get(club.id);
    const agents = await db
      .prepare(`SELECT * FROM free_agents WHERE season_year = ? AND window = 'verano' AND signed = 0 AND asking_price <= ?`)
      .all(seasonYear, freshClub.budget);
    if (!agents.length) continue;
    try {
      await signFreeAgent(db, pick(agents).id, club.id, seasonYear);
    } catch {
      // presupuesto cambio entre la consulta y la operacion; se omite sin romper el resto.
    }
  }

  // 2) Compraventas entre clubes (el club con plantel largo vende un suplente).
  for (const club of aiClubs) {
    if (!chance(0.35)) continue;
    const squad = await db
      .prepare(
        `SELECT * FROM players WHERE club_id = ? AND status IN ('activo','lesionado') AND loaned_from_club_id IS NULL AND is_real_player = 1`
      )
      .all(club.id);
    if (squad.length <= 16) continue;

    const sellable = squad.filter((p) => p.rating < 75);
    if (!sellable.length) continue;
    const seller = pick(sellable);

    const buyerCandidates = aiClubs.filter((c) => c.id !== club.id);
    if (!buyerCandidates.length) continue;
    const buyer = await db.prepare('SELECT * FROM clubs WHERE id = ?').get(pick(buyerCandidates).id);

    const age = ageInSeason(seller.birth_date, seasonYear);
    const value = estimateMarketValue(seller.rating, seller.potential, age);
    const amount = Math.round(value * (0.8 + Math.random() * 0.4));
    if (amount > buyer.budget) continue;

    const tx = await db.transaction('write');
    try {
      await tx.prepare('UPDATE clubs SET budget = budget - ? WHERE id = ?').run(amount, buyer.id);
      await tx.prepare('UPDATE clubs SET budget = budget + ? WHERE id = ?').run(amount, club.id);
      await tx.prepare('UPDATE players SET club_id = ? WHERE id = ?').run(buyer.id, seller.id);
      await tx.prepare(
        `INSERT INTO transfers (player_id, season_year, from_club_id, to_club_id, type, fee_text) VALUES (?, ?, ?, ?, 'venta', ?)`
      ).run(seller.id, seasonYear, club.id, buyer.id, `US$${amount}K`);
      await tx.prepare(
        `INSERT INTO player_history_events (player_id, season_year, event_type, description) VALUES (?, ?, 'fichaje', ?)`
      ).run(seller.id, seasonYear, `Transferido por US$${amount}K.`);
      await tx.commit();
    } catch {
      await tx.rollback();
    }
  }

  // 3) Préstamos de juveniles de bajo protagonismo entre clubes IA.
  for (const club of aiClubs) {
    if (!chance(0.25)) continue;
    const youngBenchRows = await db
      .prepare(
        `SELECT * FROM players WHERE club_id = ? AND status = 'activo' AND loaned_from_club_id IS NULL AND rating < 65`
      )
      .all(club.id);
    const youngBench = youngBenchRows.filter((p) => ageInSeason(p.birth_date, seasonYear) <= 23);
    if (!youngBench.length) continue;

    const player = pick(youngBench);
    const borrowerCandidates = aiClubs.filter((c) => c.id !== club.id);
    if (!borrowerCandidates.length) continue;

    try {
      await doLoanMove(db, player.id, club.id, pick(borrowerCandidates).id, seasonYear, 'Cedido a préstamo por una temporada.');
    } catch {
      // se omite sin romper el resto de la simulacion.
    }
  }
}

module.exports = {
  estimateMarketValue,
  getMarketWindow,
  getMarketStatus,
  getFreeAgents,
  signFreeAgent,
  searchablePlayers,
  searchMarket,
  bidForPlayer,
  acceptCounterOffer,
  declineCounterOffer,
  getSentOffers,
  getIncomingOffers,
  acceptIncomingOffer,
  declineIncomingOffer,
  requestLoan,
  offerPlayerOnLoan,
  recallDueLoans,
  simulateAiTransferMarket,
};
