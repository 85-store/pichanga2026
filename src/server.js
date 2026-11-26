const express = require('express');
const path = require('path');
const { openDb } = require('./db');
const buildApiRouter = require('./routes/api');
const buildMatchRouter = require('./routes/match-api');
const buildSavesRouter = require('./routes/saves-api');

const PORT = process.env.PORT || 4026;

async function main() {
  const db = await openDb();

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api/saves', buildSavesRouter(db));
  app.use('/api/match', buildMatchRouter(db));
  app.use('/api', buildApiRouter(db));

  app.listen(PORT, () => {
    console.log(`Pichanga 2026 escuchando en http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
