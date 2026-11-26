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

  // Perfil del usuario (datos de registro + equipo favorito/rival), guardado
  // en la base meta tras crear la cuenta en Firebase.
  router.get('/profile', async (req, res) => {
    try {
      res.json((await registry.getUserProfile(req.uid)) || null);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/profile', async (req, res) => {
    try {
      const { nombres, apellidos, telefono, tiktok, instagram, equipoFavoritoId, equipoRivalId } = req.body || {};
      if (!nombres || !apellidos || !telefono || !equipoFavoritoId || !equipoRivalId) {
        return res.status(400).json({ error: 'Faltan datos obligatorios del perfil.' });
      }
      await registry.saveUserProfile(req.uid, {
        nombres,
        apellidos,
        telefono,
        tiktok,
        instagram,
        equipoFavoritoId: Number(equipoFavoritoId),
        equipoRivalId: Number(equipoRivalId),
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
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
