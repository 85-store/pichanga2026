// Importa el plantel real de un club desde un archivo JSON (data/rosters/<slug>.json)
// a la base de datos. Cada jugador debe ser real (investigado), nunca inventado.
//
// Formato esperado de cada archivo:
// {
//   "club": "Nombre exacto del club tal como esta en la tabla clubs",
//   "source_url": "https://...",   // referencia general de donde se obtuvo el plantel
//   "base_level": 1,                 // 0, 1 o 2 - usado solo para estimar el rating inicial
//   "players": [
//     { "full_name": "...", "birth_date": "YYYY-MM-DD" | null, "age": 23,
//       "nationality": "Chile", "position": "DF", "shirt_number": 4, "source_url": "..." }
//   ]
// }
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');
const { normalizePosition } = require('./lib/positions');
const { estimateRating, estimatePotential } = require('../src/engine/rating-estimate');
const { ageInSeason } = require('../src/engine/age');
const { getCurrentSeasonYear } = require('../src/engine/season');

function birthDateFromAge(age, seasonYear) {
  if (age == null) return null;
  return `${seasonYear - age}-06-30`; // fecha aproximada: no se conoce el dia exacto
}

async function importFile(db, filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const seasonYear = (await getCurrentSeasonYear(db)) || 2026;

  const club = await db.prepare('SELECT * FROM clubs WHERE name = ?').get(raw.club);
  if (!club) {
    console.error(`  [ERROR] Club no encontrado en la BD: "${raw.club}" (archivo ${filePath})`);
    return { inserted: 0, skipped: 0 };
  }

  let inserted = 0;
  let skipped = 0;

  const insertStmt = db.prepare(
    `INSERT INTO players
      (club_id, full_name, birth_date, nationality, position, shirt_number, rating, potential, status, is_real_player, source_url, created_at_season)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'activo', 1, ?, ?)`
  );
  const existsStmt = db.prepare(
    `SELECT id FROM players WHERE club_id = ? AND full_name = ? AND is_real_player = 1`
  );

  for (const p of raw.players) {
    if (await existsStmt.get(club.id, p.full_name)) {
      skipped++;
      continue;
    }
    const birthDate = p.birth_date || birthDateFromAge(p.age, seasonYear);
    const age = ageInSeason(birthDate, seasonYear) ?? p.age ?? null;
    const position = normalizePosition(p.position);
    const rating = estimateRating({ age, baseLevel: raw.base_level ?? 1 });
    const potential = estimatePotential(rating, age);

    await insertStmt.run(
      club.id,
      p.full_name,
      birthDate,
      p.nationality || 'Chile',
      position,
      p.shirt_number ?? null,
      rating,
      potential,
      p.source_url || raw.source_url || null,
      seasonYear
    );
    inserted++;
  }

  console.log(`  ${raw.club}: +${inserted} jugadores nuevos, ${skipped} ya existentes.`);
  return { inserted, skipped };
}

async function importAllRosters(db, dir) {
  const rosterDir = dir || path.join(__dirname, '..', 'data', 'rosters');
  const files = fs.existsSync(rosterDir)
    ? fs.readdirSync(rosterDir).filter((f) => f.endsWith('.json')).map((f) => path.join(rosterDir, f))
    : [];
  let totalInserted = 0;
  for (const f of files) {
    const r = await importFile(db, f);
    totalInserted += r.inserted;
  }
  return totalInserted;
}

async function main() {
  const db = await openDb();
  const target = process.argv[2];

  if (target) {
    const r = await importFile(db, target);
    console.log(`\nTotal jugadores nuevos importados: ${r.inserted}`);
    db.close();
    return;
  }

  const dir = path.join(__dirname, '..', 'data', 'rosters');
  if (!fs.existsSync(dir)) {
    console.log('No hay archivos de plantel para importar en', dir);
    db.close();
    return;
  }

  const totalInserted = await importAllRosters(db, dir);
  console.log(`\nTotal jugadores nuevos importados: ${totalInserted}`);
  db.close();
}

module.exports = { importFile, importAllRosters };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
