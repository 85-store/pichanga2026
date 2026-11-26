// Gestion de partidas por usuario (Fase 2): cada (firebase_uid, slot) tiene
// su propia base Turso, resuelta via src/db/registry.js. Reemplaza la
// simplificacion de la Fase 1 (una sola partida global contra una base de
// prueba compartida).
const registry = require('./db/registry');
const { ensureFirstSeason, ensureSeasonCompetitions, getCurrentSeasonYear } = require('./engine/season');
const { getCareer, createCareer } = require('./engine/board');

const FIRST_SEASON = 2026;
const SLOT_COUNT = 3;

async function describeSlot(uid, slot) {
  const record = await registry.getSaveRecord(uid, slot);
  if (!record) return { slot, exists: false };

  const db = await registry.getUserDbHandle(uid, slot);
  const career = await getCareer(db);
  if (!career) return { slot, exists: false };

  return {
    slot,
    exists: true,
    seasonYear: await getCurrentSeasonYear(db),
    club: career.club_name,
    status: career.status,
    firedReason: career.fired_reason || null,
  };
}

async function listSaves(uid) {
  const slots = [];
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    slots.push(await describeSlot(uid, slot));
  }
  return slots;
}

async function createNewGame(uid, slot, clubId, managerName) {
  const db = await registry.provisionUserDb(uid, slot);

  await ensureFirstSeason(db, FIRST_SEASON);
  await ensureSeasonCompetitions(db, FIRST_SEASON);

  const club = await db.prepare('SELECT id FROM clubs WHERE id = ?').get(clubId);
  if (!club) throw new Error('Club invalido.');

  await createCareer(db, clubId, FIRST_SEASON);
  if (managerName) await db.prepare('UPDATE career SET manager_name = ? WHERE id = 1').run(managerName);

  return db;
}

async function loadGame(uid, slot) {
  const db = await registry.getUserDbHandle(uid, slot);
  if (!db) throw new Error('Ese slot todavía no tiene una partida.');
  return db;
}

async function deleteSave(uid, slot) {
  await registry.deleteUserDb(uid, slot);
}

module.exports = { listSaves, createNewGame, loadGame, deleteSave, SLOT_COUNT };
