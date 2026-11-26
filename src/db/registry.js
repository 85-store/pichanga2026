// Registro de partidas por usuario: mantiene, en una base Turso "meta"
// separada, que base le toca a cada (firebase_uid, slot), y sabe provisionar
// una base nueva (schema + clubes + planteles) cuando un usuario crea una
// partida en un slot que todavia no tiene base asignada.
const { openDb } = require('./index');
const platform = require('./turso-platform');
const { seedClubs } = require('../../scripts/seed-clubs');
const { importAllRosters } = require('../../scripts/import-roster');

const META_DB_NAME = 'pichanga-meta';

let metaDbPromise = null;

// La base meta usa el mismo schema del juego (via openDb) aunque solo
// necesite la tabla clubs (como catalogo de solo lectura para elegir equipo
// antes de tener partida) y la tabla user_saves propia de abajo - mas simple
// que mantener un segundo schema a mano, y el resto de las tablas quedan
// vacias y sin uso.
async function getMetaDb() {
  if (metaDbPromise) return metaDbPromise;
  metaDbPromise = (async () => {
    const info = await platform.ensureDatabase(META_DB_NAME);
    const token = await platform.createDatabaseToken(META_DB_NAME);
    const db = await openDb({ url: `libsql://${info.Hostname}`, authToken: token });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS user_saves (
        firebase_uid TEXT NOT NULL,
        slot INTEGER NOT NULL,
        turso_db_name TEXT NOT NULL,
        turso_db_url TEXT NOT NULL,
        turso_db_token TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (firebase_uid, slot)
      );
    `);
    const clubCount = await db.prepare('SELECT COUNT(*) as n FROM clubs').get();
    if (!clubCount || clubCount.n === 0) await seedClubs(db);
    return db;
  })();
  return metaDbPromise;
}

// Catalogo de clubes para elegir equipo antes de crear una partida (los ids
// coinciden con los de cada base de usuario: seedClubs siempre inserta la
// misma lista, en el mismo orden, en una tabla clubs recien creada).
async function getCatalogClubs() {
  const meta = await getMetaDb();
  return meta
    .prepare('SELECT id, name, short_name, division, crest_url FROM clubs WHERE active = 1 ORDER BY division, name')
    .all();
}

// Nombre de base Turso valido (minusculas, numeros y guiones) y unico por
// usuario+slot, derivado del uid de Firebase.
function dbNameFor(uid, slot) {
  const safeUid = uid.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `pichanga-u-${safeUid}-s${slot}`;
}

async function listUserSaves(uid) {
  const meta = await getMetaDb();
  return meta.prepare('SELECT slot, turso_db_name, created_at FROM user_saves WHERE firebase_uid = ? ORDER BY slot').all(uid);
}

async function getSaveRecord(uid, slot) {
  const meta = await getMetaDb();
  return meta.prepare('SELECT * FROM user_saves WHERE firebase_uid = ? AND slot = ?').get(uid, slot);
}

// Devuelve el handle de la base de un usuario/slot que ya tiene partida
// provisionada, o null si ese slot todavia esta vacio.
async function getUserDbHandle(uid, slot) {
  const record = await getSaveRecord(uid, slot);
  if (!record) return null;
  return openDb({ url: record.turso_db_url, authToken: record.turso_db_token });
}

// Crea una base Turso nueva para este usuario/slot, le corre el schema del
// juego (via openDb) y la siembra con los clubes y planteles reales - el
// equivalente, en Fase 2, a copiar el archivo de base plantilla que usaba el
// sistema de guardado local.
async function provisionUserDb(uid, slot) {
  const existing = await getSaveRecord(uid, slot);
  if (existing) throw new Error(`El slot ${slot} de este usuario ya tiene una partida asignada.`);

  const dbName = dbNameFor(uid, slot);
  const info = await platform.ensureDatabase(dbName);
  const token = await platform.createDatabaseToken(dbName);
  const url = `libsql://${info.Hostname}`;

  const db = await openDb({ url, authToken: token });
  await seedClubs(db);
  await importAllRosters(db);

  const meta = await getMetaDb();
  await meta
    .prepare(
      'INSERT INTO user_saves (firebase_uid, slot, turso_db_name, turso_db_url, turso_db_token) VALUES (?, ?, ?, ?, ?)'
    )
    .run(uid, slot, dbName, url, token);

  return db;
}

async function deleteUserDb(uid, slot) {
  const record = await getSaveRecord(uid, slot);
  if (!record) return;
  await platform.deleteDatabase(record.turso_db_name);
  const meta = await getMetaDb();
  await meta.prepare('DELETE FROM user_saves WHERE firebase_uid = ? AND slot = ?').run(uid, slot);
}

module.exports = { listUserSaves, getSaveRecord, getUserDbHandle, provisionUserDb, deleteUserDb, getCatalogClubs };
