// Prueba de humo del motor async contra la base Turso real configurada en
// .env: crea una carrera sobre un club existente y confirma que se lee bien.
const { openDb } = require('../src/db');
const { createCareer, getCareer } = require('../src/engine/board');

async function main() {
  const db = await openDb();
  const club = await db.prepare('SELECT id, name FROM clubs ORDER BY id LIMIT 1').get();
  if (!club) throw new Error('No hay clubes sembrados; corré scripts/seed-clubs.js primero.');

  await createCareer(db, club.id, 2026);
  const career = await getCareer(db);
  if (!career) throw new Error('getCareer devolvió null después de createCareer.');
  if (career.club_id !== club.id) throw new Error('club_id no coincide.');

  console.log('OK: carrera creada y leída contra Turso real.');
  console.log({ club: career.club_name, objetivo: career.objective_text, kind: career.objective_kind });
  db.close();
}

main().catch((err) => {
  console.error('FALLO smoke-test:', err);
  process.exit(1);
});
