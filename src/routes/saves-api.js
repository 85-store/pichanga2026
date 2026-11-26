const express = require('express');
const saves = require('../saves');
const registry = require('../db/registry');

// Rutas para el menu de inicio (Cargar / Continuar / Nuevo). Fase 2: cada
// usuario autenticado (req.uid, puesto por el middleware de Firebase Auth)
// tiene sus propios slots, cada uno respaldado por su propia base Turso.
function buildSavesRouter() {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      res.json({ slots: await saves.listSaves(req.uid) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Lista de clubes disponibles para elegir al crear una partida nueva.
  router.get('/template-clubs', async (req, res) => {
    try {
      res.json(await registry.getCatalogClubs());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:slot/new', async (req, res) => {
    try {
      const slot = Number(req.params.slot);
      const { clubId, managerName } = req.body;
      if (!clubId) return res.status(400).json({ error: 'Debes elegir un club para dirigir.' });
      await saves.createNewGame(req.uid, slot, Number(clubId), managerName);
      res.json({ slot });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:slot/load', async (req, res) => {
    try {
      const slot = Number(req.params.slot);
      await saves.loadGame(req.uid, slot);
      res.json({ slot });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/:slot', async (req, res) => {
    try {
      const slot = Number(req.params.slot);
      await saves.deleteSave(req.uid, slot);
      res.json({ slot });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = buildSavesRouter;
