const express = require('express');
const { getCurrentSeasonYear } = require('../engine/season');
const { getCareer } = require('../engine/board');
const { playMatch } = require('../engine/league');
const { playCopaMatch } = require('../engine/copa');
const liveMatch = require('../engine/live-match');
const { saveLineup } = require('../engine/tactics');
const { playCopaLigaMatch } = require('../engine/copa-liga');
const { getUpcomingCalendar } = require('../engine/next-match');

// Simula de inmediato (motor rapido) el resto de los partidos de la misma
// jornada/ronda que el que el usuario va a ver interactivamente, para que esos
// resultados queden listos y se muestren abajo mientras ve su propio partido.
async function simulateRestOfRound(db, kind, id, seasonYear, managedClubId) {
  if (kind === 'league') {
    const fixture = await db.prepare('SELECT * FROM fixtures WHERE id = ?').get(id);
    if (!fixture) return;
    const siblings = await db
      .prepare(
        `SELECT * FROM fixtures WHERE season_year = ? AND division = ? AND jornada = ? AND played = 0 AND id != ?`
      )
      .all(fixture.season_year, fixture.division, fixture.jornada, id);
    for (const f of siblings) await playMatch(db, seasonYear, f.id, f.home_club_id, f.away_club_id);
  } else if (kind === 'copa') {
    const match = await db.prepare('SELECT * FROM copa_matches WHERE id = ?').get(id);
    if (!match) return;
    const siblings = await db
      .prepare(
        `SELECT * FROM copa_matches WHERE season_year = ? AND round_order = ? AND played = 0 AND id != ?
         AND home_club_id IS NOT NULL AND away_club_id IS NOT NULL`
      )
      .all(match.season_year, match.round_order, id);
    for (const m of siblings) await playCopaMatch(db, seasonYear, m);
  } else if (kind === 'copa-liga') {
    const match = await db.prepare('SELECT * FROM copa_liga_matches WHERE id = ?').get(id);
    if (!match || match.stage !== 'grupos') return;
    // Los partidos de grupo no tienen un numero de jornada propio en la
    // tabla, pero se insertaron ronda por ronda (ver ensureCopaLigaDraw), asi
    // que el orden de id dentro del mismo grupo SI refleja la jornada: se
    // reconstruye agrupando de a (cupos del grupo / 2) partidos consecutivos.
    // Antes esto tomaba TODOS los partidos pendientes del grupo sin filtrar
    // por ronda, asi que el resto de los clubes terminaba de golpe toda la
    // fase de grupos con el primer partido del usuario, mientras el
    // usuario seguia jugando jornada por jornada - quedaban muy adelantados.
    const groupMatches = await db
      .prepare(`SELECT id FROM copa_liga_matches WHERE season_year = ? AND stage = 'grupos' AND group_name = ? ORDER BY id ASC`)
      .all(match.season_year, match.group_name);
    const groupSizeRow = await db
      .prepare('SELECT COUNT(*) as c FROM copa_liga_groups WHERE season_year = ? AND group_name = ?')
      .get(match.season_year, match.group_name);
    const perRound = Math.max(1, Math.floor((groupSizeRow.c || 4) / 2));
    const idx = groupMatches.findIndex((m) => m.id === id);
    const roundStart = Math.floor(idx / perRound) * perRound;
    const roundIds = groupMatches.slice(roundStart, roundStart + perRound).map((m) => m.id);
    // Nunca se simulan de golpe los partidos propios del usuario: deben
    // quedar pendientes y jugarse interactivamente, uno a la vez, cuando les
    // toque en el Calendario. Solo se adelantan (motor rapido) los partidos
    // de la misma ronda que NO involucran al club del usuario.
    const siblings = await db
      .prepare(
        `SELECT * FROM copa_liga_matches WHERE id IN (${roundIds.map(() => '?').join(',')}) AND played = 0 AND id != ?
         AND (? IS NULL OR (home_club_id != ? AND away_club_id != ?))`
      )
      .all(...roundIds, id, managedClubId, managedClubId, managedClubId);
    for (const m of siblings) await playCopaLigaMatch(db, seasonYear, m, { allowPenalties: false });
  }
}

// El usuario debe jugar los partidos de su club en orden (jornada a jornada),
// sin poder saltarse partidos pendientes anteriores.
async function assertPlaysInOrder(db, kind, id, clubId) {
  if (kind === 'league') {
    if (clubId == null) return;
    const fixture = await db.prepare('SELECT * FROM fixtures WHERE id = ?').get(id);
    if (!fixture) return;
    if (fixture.home_club_id !== clubId && fixture.away_club_id !== clubId) return;
    const earlier = await db
      .prepare(
        `SELECT id FROM fixtures
         WHERE season_year = ? AND division = ? AND played = 0 AND id != ?
         AND (home_club_id = ? OR away_club_id = ?)
         AND jornada < ?
         LIMIT 1`
      )
      .get(fixture.season_year, fixture.division, id, clubId, clubId, fixture.jornada);
    if (earlier) {
      throw new Error('Debes jugar antes los partidos pendientes de tu club, en orden.');
    }
  } else if (kind === 'copa-liga') {
    if (clubId == null) return;
    const match = await db.prepare('SELECT * FROM copa_liga_matches WHERE id = ?').get(id);
    if (!match) return;
    if (match.home_club_id !== clubId && match.away_club_id !== clubId) return;
    const entries = await getUpcomingCalendar(db);
    const thisEntry = entries.find((e) => e.kind === 'copa-liga' && e.id === id);
    if (thisEntry && !thisEntry.canWatch) {
      throw new Error('Debes jugar antes los partidos pendientes de tu club, en orden.');
    }
  }
}

function buildMatchRouter() {
  const router = express.Router();

  router.get('/:kind/:id/roster', async (req, res) => {
    try {
      const db = req.db;
      const career = await getCareer(db);
      if (!career) return res.status(400).json({ error: 'No hay partida activa.' });
      const table =
        { league: 'fixtures', copa: 'copa_matches', supercopa: 'super_copa_matches', 'copa-liga': 'copa_liga_matches' }[
          req.params.kind
        ] || 'fixtures';
      const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(req.params.id));
      if (!row) return res.status(404).json({ error: 'Partido no encontrado.' });
      const clubId = career.club_id;
      if (row.home_club_id !== clubId && row.away_club_id !== clubId) {
        return res.status(400).json({ error: 'Este partido no es de tu club.' });
      }
      const players = await db
        .prepare("SELECT id, full_name, position, rating, shirt_number FROM players WHERE club_id = ? AND status = 'activo' ORDER BY position, rating DESC")
        .all(clubId);
      res.json({ clubId, players });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/start', async (req, res) => {
    try {
      const db = req.db;
      const career = await getCareer(db);
      if (career && career.status === 'despedido') {
        return res.status(400).json({ error: 'Fuiste despedido. Esta partida terminó.' });
      }
      const seasonYear = await getCurrentSeasonYear(db);
      const { lineup, formation } = req.body || {};
      const managedClubId = career ? career.club_id : null;
      await assertPlaysInOrder(db, req.params.kind, Number(req.params.id), managedClubId);
      const result = await liveMatch.startMatch(req.uid, db, req.params.kind, Number(req.params.id), seasonYear, {
        managedClubId,
        lineup,
        formation,
      });
      // Guarda la alineacion recien usada como la preferida del club (sin
      // romper el partido si por algun motivo no calza con las reglas del
      // editor tactico, p.ej. un cambio en vivo movio la nomina).
      if (managedClubId && Array.isArray(lineup) && formation) {
        try {
          await saveLineup(db, managedClubId, formation, lineup);
        } catch {
          // no critico: el partido ya empezo, simplemente no se actualiza la preferida.
        }
      }
      res.json(result);
      // El resto de los partidos de la jornada/ronda se simulan despues de
      // responder, no antes: el usuario tiene de sobra el tiempo de su propio
      // partido en vivo para que esos terminen, y no tiene sentido hacerlo
      // esperar a que TODOS los demas partidos de la fecha terminen de
      // simularse solo para poder arrancar el suyo (req.db es un handle
      // cacheado por uid+slot, sigue valido despues de responder).
      simulateRestOfRound(db, req.params.kind, Number(req.params.id), seasonYear, managedClubId).catch((err) => {
        console.error('simulateRestOfRound fallo en segundo plano:', err);
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/advance', async (req, res) => {
    try {
      const db = req.db;
      const minutes = Math.max(1, Math.min(200, Number(req.body.minutes) || 1));
      const result = await liveMatch.advance(req.uid, db, req.params.kind, Number(req.params.id), minutes);
      res.json(result);
    } catch (err) {
      console.error('advance:', err.stack || err);
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/tactics', async (req, res) => {
    try {
      const db = req.db;
      const managedClubId = liveMatch.getManagedClubId(req.uid, req.params.kind, Number(req.params.id));
      const { side, tactics } = req.body;
      const view = await liveMatch.setTactics(req.uid, db, req.params.kind, Number(req.params.id), side, tactics, managedClubId);
      res.json(view);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/substitute', (req, res) => {
    try {
      const managedClubId = liveMatch.getManagedClubId(req.uid, req.params.kind, Number(req.params.id));
      const { side, outPlayerId, inPlayerId } = req.body;
      const view = liveMatch.substitute(req.uid, req.params.kind, Number(req.params.id), side, outPlayerId, inPlayerId, managedClubId);
      res.json(view);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/penalty', (req, res) => {
    try {
      const managedClubId = liveMatch.getManagedClubId(req.uid, req.params.kind, Number(req.params.id));
      const { playerId } = req.body;
      const result = liveMatch.resolvePenalty(req.uid, req.params.kind, Number(req.params.id), playerId, managedClubId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/shootout', async (req, res) => {
    try {
      const db = req.db;
      const managedClubId = liveMatch.getManagedClubId(req.uid, req.params.kind, Number(req.params.id));
      const { playerId } = req.body;
      const result = await liveMatch.shootoutKick(req.uid, db, req.params.kind, Number(req.params.id), playerId, managedClubId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/inspire', (req, res) => {
    try {
      const managedClubId = liveMatch.getManagedClubId(req.uid, req.params.kind, Number(req.params.id));
      const { playerId } = req.body;
      const view = liveMatch.inspirePlayer(req.uid, req.params.kind, Number(req.params.id), playerId, managedClubId);
      res.json(view);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/halftime', (req, res) => {
    try {
      const managedClubId = liveMatch.getManagedClubId(req.uid, req.params.kind, Number(req.params.id));
      const { message } = req.body;
      const result = liveMatch.resolveHalftime(req.uid, req.params.kind, Number(req.params.id), message, managedClubId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/incident', async (req, res) => {
    try {
      const db = req.db;
      const { action } = req.body;
      const result = await liveMatch.resolveIncident(req.uid, db, req.params.kind, Number(req.params.id), action);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/:kind/:id/state', (req, res) => {
    const view = liveMatch.getState(req.uid, req.params.kind, Number(req.params.id));
    if (!view) return res.status(404).json({ error: 'No hay partido en curso.' });
    res.json(view);
  });

  return router;
}

module.exports = buildMatchRouter;
