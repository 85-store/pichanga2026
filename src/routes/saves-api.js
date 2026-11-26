const express = require('express');
const saves = require('../saves');

// Rutas para el menu de inicio (Cargar / Continuar / Nuevo). Fase 1: un solo
// hueco respaldado por la base Turso de prueba compartida (ver src/saves.js).
function buildSavesRouter(db) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      res.json({ slots: await saves.listSaves() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Lista de clubes disponibles para elegir al crear una partida nueva.
  router.get('/template-clubs', async (req, res) => {
    try {
      const clubs = await db
        .prepare('SELECT id, name, short_name, division, crest_url FROM clubs WHERE active = 1 ORDER BY division, name')
        .all();
      res.json(clubs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:slot/new', async (req, res) => {
    try {
      const slot = Number(req.params.slot);
      const { clubId, managerName } = req.body;
      if (!clubId) return res.status(400).json({ error: 'Debes elegir un club para dirigir.' });
      await saves.createNewGame(slot, Number(clubId), managerName);
      res.json({ slot });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:slot/load', async (req, res) => {
    try {
      const slot = Number(req.params.slot);
      await saves.loadGame(slot);
      res.json({ slot });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/:slot', async (req, res) => {
    try {
      const slot = Number(req.params.slot);
      await saves.deleteSave(slot);
      res.json({ slot });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/continue', async (req, res) => {
    try {
      const { slot } = await saves.continueGame();
      res.json({ slot });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = buildSavesRouter;
