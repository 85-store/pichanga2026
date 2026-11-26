const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('./auth/firebase-admin');
const registry = require('./db/registry');
const buildApiRouter = require('./routes/api');
const buildMatchRouter = require('./routes/match-api');
const buildSavesRouter = require('./routes/saves-api');

const PORT = process.env.PORT || 4026;

// Resuelve req.db a partir de req.uid (lo pone requireAuth) y el slot que
// manda el cliente en el header X-Save-Slot. No hay sesion de servidor ni un
// "db activo" global: cada pedido dice de que partida se trata.
async function resolveGameDb(req, res, next) {
  try {
    const slot = Number(req.headers['x-save-slot']);
    if (!slot) return res.status(400).json({ error: 'Falta el header X-Save-Slot.' });
    const db = await registry.getUserDbHandle(req.uid, slot);
    if (!db) return res.status(404).json({ error: 'No hay una partida en ese slot.' });
    req.db = db;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

const BG_PHOTOS_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Lista las fotos que el usuario haya puesto en public/imagenes de fondos/
  // para el fondo rotativo del menu de inicio (sin convencion de nombres: se
  // usa lo que haya, con cualquier nombre y cualquiera de estas extensiones).
  // Es publica (sin requireAuth) porque esas fotos ya son estaticas publicas
  // via express.static de todos modos.
  app.get('/bg-photos.json', (req, res) => {
    const dir = path.join(__dirname, '..', 'public', 'imagenes de fondos');
    fs.readdir(dir, (err, files) => {
      if (err) return res.json([]);
      const photos = files.filter((f) => BG_PHOTOS_EXTS.has(path.extname(f).toLowerCase()));
      res.json(photos.map((f) => `imagenes de fondos/${f}`));
    });
  });

  app.use('/api/saves', requireAuth(), buildSavesRouter());
  app.use('/api/match', requireAuth(), resolveGameDb, buildMatchRouter());
  app.use('/api', requireAuth(), resolveGameDb, buildApiRouter());

  return app;
}

const app = buildApp();

// Vercel detecta Express por el export por defecto del modulo (tiene que ser
// la app/funcion en si, no un objeto) y la corre nativamente; local, se
// arranca con .listen() solo cuando este archivo es el que se ejecuta
// directo (node src/server.js / npm start), no cuando otro modulo lo importa.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Pichanga 2026 escuchando en http://localhost:${PORT}`);
  });
}

module.exports = app;
