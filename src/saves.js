// Gestion de la partida guardada. Fase 1: una sola base Turso de prueba
// compartida (sin cuentas todavia), asi que por ahora hay un unico "hueco"
// activo respaldado directamente por esa base, en vez de archivos locales por
// hueco (el modo archivo local ya no existe: el cliente usa el transporte web
// de @libsql/client, remoto-only). El menu de varios huecos/usuarios vuelve en
// la Fase 2, respaldado por una base Turso real por usuario+hueco.
const { openDb } = require('./db');
const { ensureFirstSeason, ensureSeasonCompetitions, getCurrentSeasonYear } = require('./engine/season');
const { createCareer, getCareer } = require('./engine/board');

const FIRST_SEASON = 2026;
const SLOT_COUNT = 1;

let dbPromise = null;

function getDb() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

async function describeSlot() {
  const db = await getDb();
  const career = await getCareer(db);
  if (!career) return { slot: 1, exists: false };
  const seasonYear = await getCurrentSeasonYear(db);
  return {
    slot: 1,
    exists: true,
    seasonYear,
    updatedAt: new Date().toISOString(),
    club: { id: career.club_id, name: career.club_name, shortName: career.club_short_name, crestUrl: career.club_crest },
    status: career.status,
    firedReason: career.fired_reason,
  };
}

async function listSaves() {
  return [await describeSlot()];
}

// Crea una partida nueva. Fase 1 no tiene todavia una forma de resetear la
// base de prueba a un estado "pristino" (eso requeriria volver a correr
// seed-clubs/import-roster), asi que solo se permite si todavia no hay
// ninguna carrera activa en la base.
async function createNewGame(slot, clubId, managerName) {
  const db = await getDb();
  const existing = await getCareer(db);
  if (existing) {
    throw new Error(
      'Ya hay una partida en curso en esta base de prueba (Fase 1 soporta una sola partida activa). ' +
        'Para empezar otra hay que resetear la base (scripts/reset-db.js + seed-clubs + import-roster).'
    );
  }
  await ensureFirstSeason(db, FIRST_SEASON);
  await ensureSeasonCompetitions(db, FIRST_SEASON);
  const club = await db.prepare('SELECT id FROM clubs WHERE id = ?').get(clubId);
  if (!club) throw new Error('Club invalido.');
  await createCareer(db, clubId, FIRST_SEASON);
  if (managerName) await db.prepare('UPDATE career SET manager_name = ? WHERE id = 1').run(managerName);
  return db;
}

async function deleteSave(slot) {
  const db = await getDb();
  await db.prepare('DELETE FROM career').run();
}

async function loadGame(slot) {
  const db = await getDb();
  const career = await getCareer(db);
  if (!career) throw new Error('No hay una partida guardada en ese slot.');
  return db;
}

async function continueGame() {
  const db = await loadGame(1);
  return { slot: 1, db };
}

module.exports = { getDb, listSaves, createNewGame, loadGame, deleteSave, continueGame, SLOT_COUNT };
