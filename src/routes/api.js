const express = require('express');
const { advanceSeason, getCurrentSeasonYear } = require('../engine/season');
const { ageInSeason } = require('../engine/age');
const {
  getStandings,
  getNextJornada,
  totalJornadas,
  simulateJornada,
  isLeagueComplete,
} = require('../engine/league');
const { getBracket, isCopaComplete, simulateNextCopaRound, getCopaChampion } = require('../engine/copa');
const {
  GROUP_NAMES: COPA_LIGA_GROUP_NAMES,
  ensureCopaLigaDraw,
  getGroupClubs,
  getGroupStandings,
  isGroupStageComplete,
  isCopaLigaComplete,
  advanceCopaLiga,
  getCopaLigaFinalists,
} = require('../engine/copa-liga');
const { getInternationalQualifications } = require('../engine/international');
const { getSuperCopa, isSuperCopaPending, playSuperCopaIfPending } = require('../engine/super-copa');
const { getCareer, getPendingOffers, acceptOffer, declineOffer } = require('../engine/board');
const { listIdentities, setTeamIdentity } = require('../engine/team-identity');
const { getSavedLineup, saveLineup } = require('../engine/tactics');
const { getNextManagedMatch } = require('../engine/next-match');
const { getPendingEvents, getEventHistory, resolveEvent } = require('../engine/career-events');
const { onSigningCompletedMedia, getComments, listPersonas } = require('../engine/media');
const {
  getMarketStatus,
  getFreeAgents,
  signFreeAgent,
  searchablePlayers,
  searchMarket,
  bidForPlayer,
  acceptCounterOffer,
  declineCounterOffer,
  getIncomingOffers,
  acceptIncomingOffer,
  declineIncomingOffer,
  requestLoan,
  offerPlayerOnLoan,
  getSentOffers,
} = require('../engine/market');

function buildApiRouter(db) {
  const router = express.Router();

  router.get('/season', async (req, res) => {
    try {
      res.json({ year: await getCurrentSeasonYear(db) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/clubs', async (req, res) => {
    try {
      const clubs = await db
        .prepare(
          `SELECT c.*,
             (SELECT COUNT(*) FROM players p WHERE p.club_id = c.id AND p.status = 'activo') as active_count,
             (SELECT COUNT(*) FROM players p WHERE p.club_id = c.id AND p.status = 'lesionado') as injured_count
           FROM clubs c
           WHERE c.active = 1
           ORDER BY c.division, c.name`
        )
        .all();
      res.json(clubs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/clubs/:id', async (req, res) => {
    try {
      const club = await db.prepare('SELECT * FROM clubs WHERE id = ?').get(req.params.id);
      if (!club) return res.status(404).json({ error: 'Club no encontrado' });

      const seasonYear = await getCurrentSeasonYear(db);
      const rosterRows = await db
        .prepare(
          `SELECT * FROM players WHERE club_id = ? AND status != 'retirado' ORDER BY
           CASE position WHEN 'Portero' THEN 0 WHEN 'Defensa' THEN 1 WHEN 'Mediocampista' THEN 2 ELSE 3 END,
           rating DESC`
        )
        .all(req.params.id);
      const roster = rosterRows.map((p) => ({ ...p, age: ageInSeason(p.birth_date, seasonYear) }));

      res.json({ club, roster, seasonYear });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/players/:id', async (req, res) => {
    try {
      const seasonYear = await getCurrentSeasonYear(db);
      const player = await db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
      if (!player) return res.status(404).json({ error: 'Jugador no encontrado' });

      const club = player.club_id ? await db.prepare('SELECT * FROM clubs WHERE id = ?').get(player.club_id) : null;
      const injuries = await db
        .prepare('SELECT * FROM injuries WHERE player_id = ? ORDER BY season_year DESC, id DESC')
        .all(player.id);
      const history = await db
        .prepare('SELECT * FROM player_history_events WHERE player_id = ? ORDER BY season_year DESC, id DESC')
        .all(player.id);
      const stats = await db
        .prepare('SELECT * FROM player_season_stats WHERE player_id = ? ORDER BY season_year DESC')
        .all(player.id);
      const transfers = await db
        .prepare(
          `SELECT t.*, fc.name as from_club_name, tc.name as to_club_name
           FROM transfers t
           LEFT JOIN clubs fc ON fc.id = t.from_club_id
           LEFT JOIN clubs tc ON tc.id = t.to_club_id
           WHERE t.player_id = ? ORDER BY t.season_year DESC`
        )
        .all(player.id);

      res.json({
        player: { ...player, age: ageInSeason(player.birth_date, seasonYear) },
        club,
        injuries,
        history,
        stats,
        transfers,
        seasonYear,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/players', async (req, res) => {
    try {
      const seasonYear = await getCurrentSeasonYear(db);
      const q = (req.query.q || '').trim();
      let rows;
      if (q) {
        rows = await db
          .prepare(
            `SELECT p.*, c.name as club_name FROM players p LEFT JOIN clubs c ON c.id = p.club_id
             WHERE p.full_name LIKE ? ORDER BY p.rating DESC LIMIT 50`
          )
          .all(`%${q}%`);
      } else {
        rows = await db
          .prepare(
            `SELECT p.*, c.name as club_name FROM players p LEFT JOIN clubs c ON c.id = p.club_id
             WHERE p.status = 'retirado' ORDER BY p.retired_at_season DESC LIMIT 100`
          )
          .all();
      }
      res.json(rows.map((p) => ({ ...p, age: ageInSeason(p.birth_date, seasonYear) })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/league/:division', async (req, res) => {
    try {
      const division = req.params.division === 'b' ? 'Primera B' : 'Primera A';
      const seasonYear = await getCurrentSeasonYear(db);
      const standings = await getStandings(db, seasonYear, division);
      const nextJornada = await getNextJornada(db, seasonYear, division);
      const total = await totalJornadas(db, seasonYear, division);
      const fixturesRows = await db
        .prepare(
          `SELECT f.*, hc.name as home_name, hc.crest_url as home_crest, ac.name as away_name, ac.crest_url as away_crest
           FROM fixtures f
           JOIN clubs hc ON hc.id = f.home_club_id
           JOIN clubs ac ON ac.id = f.away_club_id
           WHERE f.season_year = ? AND f.division = ?
           ORDER BY f.jornada, f.id`
        )
        .all(seasonYear, division);

      const fixturesByJornada = {};
      for (const f of fixturesRows) {
        if (!fixturesByJornada[f.jornada]) fixturesByJornada[f.jornada] = [];
        fixturesByJornada[f.jornada].push(f);
      }

      res.json({
        division,
        seasonYear,
        standings,
        nextJornada,
        totalJornadas: total,
        complete: nextJornada == null,
        fixturesByJornada,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/league/simulate-jornada', async (req, res) => {
    try {
      const seasonYear = await getCurrentSeasonYear(db);
      if (await isLeagueComplete(db, seasonYear)) {
        return res.status(400).json({ error: 'La liga de esta temporada ya terminó.' });
      }
      const result = await simulateJornada(db, seasonYear);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/copa', async (req, res) => {
    try {
      const seasonYear = await getCurrentSeasonYear(db);
      const bracket = await getBracket(db, seasonYear);
      res.json({
        seasonYear,
        bracket,
        complete: await isCopaComplete(db, seasonYear),
        champion: await getCopaChampion(db, seasonYear),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/copa/simulate-round', async (req, res) => {
    try {
      const seasonYear = await getCurrentSeasonYear(db);
      if (await isCopaComplete(db, seasonYear)) {
        return res.status(400).json({ error: 'La Copa Chile de esta temporada ya terminó.' });
      }
      const result = await simulateNextCopaRound(db, seasonYear);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/copa-liga', async (req, res) => {
    try {
      const seasonYear = await getCurrentSeasonYear(db);
      // Partidas ya en curso antes de que existiera esta competicion nunca
      // recibieron su sorteo (solo se genera al crear la carrera o al pasar de
      // temporada). ensureCopaLigaDraw no hace nada si ya existe, asi que es
      // seguro llamarlo aqui para "sanar" esas partidas antiguas.
      await ensureCopaLigaDraw(db, seasonYear);
      const groups = [];
      for (const name of COPA_LIGA_GROUP_NAMES) {
        const clubs = await getGroupClubs(db, seasonYear, name);
        if (!clubs.length) continue;
        const standings = await getGroupStandings(db, seasonYear, name);
        const matches = await db
          .prepare(
            `SELECT gm.*, hc.name as home_name, hc.crest_url as home_crest, hc.short_name as home_short,
                    ac.name as away_name, ac.crest_url as away_crest, ac.short_name as away_short
             FROM copa_liga_matches gm
             LEFT JOIN clubs hc ON hc.id = gm.home_club_id
             LEFT JOIN clubs ac ON ac.id = gm.away_club_id
             WHERE gm.season_year = ? AND gm.stage = 'grupos' AND gm.group_name = ?
             ORDER BY gm.id`
          )
          .all(seasonYear, name);
        groups.push({ name, clubs, standings, matches });
      }
      const knockout = await db
        .prepare(
          `SELECT cm.*, hc.name as home_name, hc.crest_url as home_crest, hc.short_name as home_short,
                  ac.name as away_name, ac.crest_url as away_crest, ac.short_name as away_short,
                  wc.name as winner_name
           FROM copa_liga_matches cm
           LEFT JOIN clubs hc ON hc.id = cm.home_club_id
           LEFT JOIN clubs ac ON ac.id = cm.away_club_id
           LEFT JOIN clubs wc ON wc.id = cm.winner_club_id
           WHERE cm.season_year = ? AND cm.stage IN ('semifinal', 'final')
           ORDER BY cm.stage, cm.tie_slot, cm.leg`
        )
        .all(seasonYear);
      const finalists = await getCopaLigaFinalists(db, seasonYear);
      res.json({
        seasonYear,
        groupStageComplete: await isGroupStageComplete(db, seasonYear),
        groups,
        semifinals: knockout.filter((m) => m.stage === 'semifinal'),
        final: knockout.find((m) => m.stage === 'final') || null,
        complete: await isCopaLigaComplete(db, seasonYear),
        champion: finalists ? finalists.championId : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/copa-liga/simulate-step', async (req, res) => {
    try {
      const seasonYear = await getCurrentSeasonYear(db);
      if (await isCopaLigaComplete(db, seasonYear)) {
        return res.status(400).json({ error: 'La Copa de la Liga de esta temporada ya terminó.' });
      }
      const result = await advanceCopaLiga(db, seasonYear);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clasificacion a copas internacionales: se calcula al cierre de cada
  // temporada (season.js), asi que aqui solo se lee lo ya persistido. Sin
  // parametro, devuelve la clasificacion mas reciente calculada.
  router.get('/international', async (req, res) => {
    try {
      const requestedYear = req.query.season ? Number(req.query.season) : null;
      const maxRow = await db.prepare('SELECT MAX(season_year) as y FROM international_qualifications').get();
      const seasonYear = requestedYear || (maxRow || {}).y || null;
      if (!seasonYear) return res.json({ seasonYear: null, qualifications: [] });
      res.json({ seasonYear, qualifications: await getInternationalQualifications(db, seasonYear) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/season/advance', async (req, res) => {
    try {
      const career = await getCareer(db);
      if (career && career.status === 'despedido') {
        return res.status(400).json({ error: 'Fuiste despedido. Esta partida terminó.' });
      }
      const result = await advanceSeason(db);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/career', async (req, res) => {
    try {
      res.json(await getCareer(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/team-identity', async (req, res) => {
    try {
      const career = await getCareer(db);
      res.json({ options: listIdentities(), current: career ? career.team_identity : null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/team-identity', async (req, res) => {
    try {
      const { identity } = req.body || {};
      const career = await setTeamIdentity(db, identity);
      res.json(career);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/media', async (req, res) => {
    try {
      res.json({ personas: listPersonas(), comments: await getComments(db, Number(req.query.limit) || 30) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/next-match', async (req, res) => {
    try {
      res.json(await getNextManagedMatch(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/tactics', async (req, res) => {
    try {
      const career = await getCareer(db);
      if (!career || !career.club_id) return res.status(400).json({ error: 'No hay partida activa.' });
      const seasonYear = await getCurrentSeasonYear(db);
      const rosterRows = await db
        .prepare(`SELECT * FROM players WHERE club_id = ? AND status = 'activo' ORDER BY
           CASE position WHEN 'Portero' THEN 0 WHEN 'Defensa' THEN 1 WHEN 'Mediocampista' THEN 2 ELSE 3 END,
           rating DESC`)
        .all(career.club_id);
      const roster = rosterRows.map((p) => ({ ...p, age: ageInSeason(p.birth_date, seasonYear) }));
      res.json({ clubId: career.club_id, roster, saved: await getSavedLineup(db, career.club_id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/tactics', async (req, res) => {
    try {
      const career = await getCareer(db);
      if (!career || !career.club_id) return res.status(400).json({ error: 'No hay partida activa.' });
      const { formation, playerIds } = req.body || {};
      const result = await saveLineup(db, career.club_id, formation, playerIds);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/career/offers', async (req, res) => {
    try {
      res.json(await getPendingOffers(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/career/offers/:id/accept', async (req, res) => {
    try {
      const seasonYear = await getCurrentSeasonYear(db);
      const career = await acceptOffer(db, Number(req.params.id), seasonYear);
      res.json(career);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/career/offers/:id/decline', async (req, res) => {
    try {
      const career = await declineOffer(db, Number(req.params.id));
      res.json(career);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/career-events/pending', async (req, res) => {
    try {
      res.json(await getPendingEvents(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/career-events/history', async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 30;
      res.json(await getEventHistory(db, limit));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/career-events/:id/resolve', async (req, res) => {
    try {
      const { optionId } = req.body || {};
      const result = await resolveEvent(db, Number(req.params.id), optionId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/super-copa', async (req, res) => {
    try {
      const seasonYear = await getCurrentSeasonYear(db);
      const match = await getSuperCopa(db, seasonYear);
      res.json({ seasonYear, match });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/super-copa/simulate', async (req, res) => {
    try {
      const seasonYear = await getCurrentSeasonYear(db);
      if (!(await isSuperCopaPending(db, seasonYear))) {
        return res.status(400).json({ error: 'No hay Supercopa pendiente esta temporada.' });
      }
      const result = await playSuperCopaIfPending(db, seasonYear);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/market/status', async (req, res) => {
    try {
      res.json(await getMarketStatus(db));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/market/free-agents', async (req, res) => {
    try {
      const status = await getMarketStatus(db);
      if (!status.open) return res.status(400).json({ error: 'No hay mercado de pases abierto.' });
      res.json(await getFreeAgents(db, status.seasonYear, status.window));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/market/free-agents/:id/sign', async (req, res) => {
    try {
      const status = await getMarketStatus(db);
      if (!status.open) return res.status(400).json({ error: 'No hay mercado de pases abierto.' });
      const result = await signFreeAgent(db, Number(req.params.id), status.clubId, status.seasonYear, status.window);
      try {
        await onSigningCompletedMedia(db, status.seasonYear, status.clubId, result.playerId);
      } catch (err) {
        console.error('media onSigningCompletedMedia failed:', err);
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/market/players', async (req, res) => {
    try {
      const status = await getMarketStatus(db);
      if (!status.open) return res.status(400).json({ error: 'No hay mercado de pases abierto.' });
      res.json(await searchablePlayers(db, status.clubId, status.seasonYear, req.query.q));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Busqueda unificada de "todo el mundo" (agentes libres + jugadores de todos
  // los demas clubes) con filtros combinables por nombre, edad, nacionalidad,
  // posicion, club y precio.
  router.get('/market/search', async (req, res) => {
    try {
      const status = await getMarketStatus(db);
      if (!status.open) return res.status(400).json({ error: 'No hay mercado de pases abierto.' });
      const { q, ageMin, ageMax, nationality, position, clubId, priceMin, priceMax } = req.query;
      const results = await searchMarket(db, status.clubId, status.seasonYear, status.window, {
        q,
        ageMin,
        ageMax,
        nationality,
        position,
        clubId,
        priceMin,
        priceMax,
      });
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/market/loan', async (req, res) => {
    try {
      const status = await getMarketStatus(db);
      if (!status.open) return res.status(400).json({ error: 'No hay mercado de pases abierto.' });
      const { playerId } = req.body;
      const result = await requestLoan(db, Number(playerId), status.clubId, status.seasonYear, status.window);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/market/loan-out', async (req, res) => {
    try {
      const status = await getMarketStatus(db);
      if (!status.open) return res.status(400).json({ error: 'No hay mercado de pases abierto.' });
      const { playerId } = req.body;
      const result = await offerPlayerOnLoan(db, Number(playerId), status.clubId, status.seasonYear);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/market/bid', async (req, res) => {
    try {
      const status = await getMarketStatus(db);
      if (!status.open) return res.status(400).json({ error: 'No hay mercado de pases abierto.' });
      const { playerId, amount } = req.body;
      const result = await bidForPlayer(db, Number(playerId), status.clubId, Number(amount), status.seasonYear, status.window);
      if (result.accepted) {
        try {
          await onSigningCompletedMedia(db, status.seasonYear, status.clubId, Number(playerId));
        } catch (err) {
          console.error('media onSigningCompletedMedia failed:', err);
        }
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/market/offers', async (req, res) => {
    try {
      const status = await getMarketStatus(db);
      if (!status.open || !status.clubId) return res.json([]);
      res.json(await getIncomingOffers(db, status.clubId, status.seasonYear, status.window));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Ofertas que el usuario envio durante la ventana de mercado actual (fichajes,
  // agentes libres, prestamos), para el panel compacto "Ofertas enviadas".
  router.get('/market/sent-offers', async (req, res) => {
    try {
      const status = await getMarketStatus(db);
      if (!status.open) return res.json([]);
      res.json(await getSentOffers(db, status.seasonYear, status.window));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/market/sent-offers/:id/accept-counter', async (req, res) => {
    try {
      const status = await getMarketStatus(db);
      if (!status.open) return res.status(400).json({ error: 'No hay mercado de pases abierto.' });
      const result = await acceptCounterOffer(db, Number(req.params.id), status.clubId, status.seasonYear);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/market/sent-offers/:id/decline-counter', async (req, res) => {
    try {
      const result = await declineCounterOffer(db, Number(req.params.id));
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/market/offers/:id/accept', async (req, res) => {
    try {
      const seasonYear = await getCurrentSeasonYear(db);
      const result = await acceptIncomingOffer(db, Number(req.params.id), seasonYear);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/market/offers/:id/decline', async (req, res) => {
    try {
      const result = await declineIncomingOffer(db, Number(req.params.id));
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = buildApiRouter;
