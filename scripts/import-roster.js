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

  // Una sola consulta para saber que jugadores ya existen, y un solo batch
  // para insertar los nuevos: contra una base remota de Turso, awaitear un
  // exists+insert por jugador (cientos por club) es un viaje de red aparte
  // cada vez y tarda minutos; asi son 2 viajes de red por archivo de plantel.
  const existingRows = await db
    .prepare(`SELECT full_name FROM players WHERE club_id = ? AND is_real_player = 1`)
    .all(club.id);
  const existingNames = new Set(existingRows.map((r) => r.full_name));

  const insertSql = `INSERT INTO players
      (club_id, full_name, birth_date, nationality, position, shirt_number, rating, potential, status, is_real_player, source_url, created_at_season)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'activo', 1, ?, ?)`;

  const stmts = [];
  let skipped = 0;
  for (const p of raw.players) {
    if (existingNames.has(p.full_name)) {
      skipped++;
      continue;
    }
    const birthDate = p.birth_date || birthDateFromAge(p.age, seasonYear);
    const age = ageInSeason(birthDate, seasonYear) ?? p.age ?? null;
    const position = normalizePosition(p.position);
    const rating = estimateRating({ age, baseLevel: raw.base_level ?? 1 });
    const potential = estimatePotential(rating, age);

    stmts.push({
      sql: insertSql,
      args: [
        club.id,
        p.full_name,
        birthDate,
        p.nationality || 'Chile',
        position,
        p.shirt_number ?? null,
        rating,
        potential,
        p.source_url || raw.source_url || null,
        seasonYear,
      ],
    });
  }

  if (stmts.length) await db.batch(stmts);
  const inserted = stmts.length;

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

// Variante para una base recien provisionada (un usuario/slot nuevo en la
// Fase 2): como nunca puede tener jugadores previos, se salta por completo la
// consulta de "ya existe" y se insertan TODOS los planteles en un unico
// batch - en vez de 2 viajes de red por archivo (~64 para 32 clubes), son
// solo 2 en total (un select de clubes + un batch de inserts), lo que baja
// el tiempo de crear una partida nueva de minutos a segundos.
async function importAllRostersFast(db, dir) {
  const rosterDir = dir || path.join(__dirname, '..', 'data', 'rosters');
  const files = fs.existsSync(rosterDir)
    ? fs.readdirSync(rosterDir).filter((f) => f.endsWith('.json')).map((f) => path.join(rosterDir, f))
    : [];
  if (!files.length) return 0;

  const seasonYear = (await getCurrentSeasonYear(db)) || 2026;
  const clubs = await db.prepare('SELECT id, name FROM clubs').all();
  const clubIdByName = new Map(clubs.map((c) => [c.name, c.id]));

  const insertSql = `INSERT INTO players
      (club_id, full_name, birth_date, nationality, position, shirt_number, rating, potential, status, is_real_player, source_url, created_at_season)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'activo', 1, ?, ?)`;

  const stmts = [];
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const clubId = clubIdByName.get(raw.club);
    if (!clubId) {
      console.error(`  [ERROR] Club no encontrado en la BD: "${raw.club}" (archivo ${f})`);
      continue;
    }
    for (const p of raw.players) {
      const birthDate = p.birth_date || birthDateFromAge(p.age, seasonYear);
      const age = ageInSeason(birthDate, seasonYear) ?? p.age ?? null;
      const position = normalizePosition(p.position);
      const rating = estimateRating({ age, baseLevel: raw.base_level ?? 1 });
      const potential = estimatePotential(rating, age);
      stmts.push({
        sql: insertSql,
        args: [
          clubId,
          p.full_name,
          birthDate,
          p.nationality || 'Chile',
          position,
          p.shirt_number ?? null,
          rating,
          potential,
          p.source_url || raw.source_url || null,
          seasonYear,
        ],
      });
    }
  }

  if (stmts.length) await db.batch(stmts);
  return stmts.length;
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

module.exports = { importFile, importAllRosters, importAllRostersFast };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
