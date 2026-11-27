const express = require('express');
const { getCurrentSeasonYear } = require('../engine/season');
const { getCareer } = require('../engine/board');
const { playMatch } = require('../engine/league');
const { playCopaMatch } = require('../engine/copa');
const liveMatch = require('../engine/live-match');
const { saveLineup } = require('../engine/tactics');
const { simulateGroupRound } = require('../engine/copa-liga');
const { getUpcomingCalendar } = require('../engine/next-match');
const { maybeStadiumFire, forfeitHomeMatch, TABLE_BY_KIND: FIRE_TABLE_BY_KIND } = require('../engine/stadium-incidents');

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

    // Nunca se simula de golpe el partido propio del usuario: debe quedar
    // pendiente y jugarse interactivamente cuando le toque en el Calendario.
    // Solo se adelantan (motor rapido) los demas partidos de su misma ronda.
    await simulateGroupRound(db, seasonYear, match.group_name, { anchorMatchId: id, excludeClubId: managedClubId });

    // Los otros 3 grupos (que nunca tienen al club del usuario) no tienen
    // ningun partido propio que los haga avanzar: sin esto quedaban
    // congelados en 0 partidos jugados mientras el usuario avanzaba jornada
    // a jornada en el suyo. Se les adelanta tambien una ronda (la primera que
    // todavia tengan pendiente) cada vez que el usuario juega la suya, para
    // que los 4 grupos vayan al mismo ritmo.
    const otherGroups = await db
      .prepare(`SELECT DISTINCT group_name FROM copa_liga_matches WHERE season_year = ? AND stage = 'grupos' AND group_name != ?`)
      .all(match.season_year, match.group_name);
    for (const { group_name } of otherGroups) {
      await simulateGroupRound(db, seasonYear, group_name, {});
    }
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

      // Incendio de estadio: solo puede pasar en un partido de LOCAL del
      // propio club del usuario (nunca a equipos manejados por la IA), y solo
      // se evalua si todavia no esta jugado (evita re-chequear un partido ya
      // resuelto si el usuario reabre la planilla).
      const fireTable = FIRE_TABLE_BY_KIND[req.params.kind];
      if (managedClubId && fireTable) {
        const matchRow = await db.prepare(`SELECT * FROM ${fireTable} WHERE id = ?`).get(Number(req.params.id));
        if (matchRow && !matchRow.played && matchRow.home_club_id === managedClubId) {
          if (await maybeStadiumFire(db, career)) {
            await forfeitHomeMatch(db, seasonYear, req.params.kind, matchRow);
            return res.json({
              stadiumFire: true,
              message:
                'Un sector de la hinchada incendió el estadio antes del partido. El encuentro quedó suspendido y se le dio por ganado 3-0 al rival.',
            });
          }
        }
      }

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
      const managedClubId = await liveMatch.getManagedClubId(req.uid, db, req.params.kind, Number(req.params.id));
      const { side, tactics } = req.body;
      const view = await liveMatch.setTactics(req.uid, db, req.params.kind, Number(req.params.id), side, tactics, managedClubId);
      res.json(view);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/substitute', async (req, res) => {
    try {
      const db = req.db;
      const managedClubId = await liveMatch.getManagedClubId(req.uid, db, req.params.kind, Number(req.params.id));
      const { side, outPlayerId, inPlayerId } = req.body;
      const view = await liveMatch.substitute(req.uid, db, req.params.kind, Number(req.params.id), side, outPlayerId, inPlayerId, managedClubId);
      res.json(view);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/penalty', async (req, res) => {
    try {
      const db = req.db;
      const managedClubId = await liveMatch.getManagedClubId(req.uid, db, req.params.kind, Number(req.params.id));
      const { playerId } = req.body;
      const result = await liveMatch.resolvePenalty(req.uid, db, req.params.kind, Number(req.params.id), playerId, managedClubId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/shootout', async (req, res) => {
    try {
      const db = req.db;
      const managedClubId = await liveMatch.getManagedClubId(req.uid, db, req.params.kind, Number(req.params.id));
      const { playerId } = req.body;
      const result = await liveMatch.shootoutKick(req.uid, db, req.params.kind, Number(req.params.id), playerId, managedClubId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/inspire', async (req, res) => {
    try {
      const db = req.db;
      const managedClubId = await liveMatch.getManagedClubId(req.uid, db, req.params.kind, Number(req.params.id));
      const { playerId } = req.body;
      const view = await liveMatch.inspirePlayer(req.uid, db, req.params.kind, Number(req.params.id), playerId, managedClubId);
      res.json(view);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:kind/:id/halftime', async (req, res) => {
    try {
      const db = req.db;
      const managedClubId = await liveMatch.getManagedClubId(req.uid, db, req.params.kind, Number(req.params.id));
      const { message } = req.body;
      const result = await liveMatch.resolveHalftime(req.uid, db, req.params.kind, Number(req.params.id), message, managedClubId);
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

  router.get('/:kind/:id/state', async (req, res) => {
    try {
      const db = req.db;
      const view = await liveMatch.getState(req.uid, db, req.params.kind, Number(req.params.id));
      if (!view) return res.status(404).json({ error: 'No hay partido en curso.' });
      res.json(view);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = buildMatchRouter;
