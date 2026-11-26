// Siembra los 32 clubes reales de Primera A y Primera B de Chile, temporada 2026,
// con su escudo (crest_url) resuelto por scripts/fetch-crests.js.
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');

const CLUB_META = {
  // Primera A
  'Audax Italiano': { city: 'La Florida, Santiago', stadium: 'Bicentenario de La Florida' },
  Cobresal: { city: 'El Salvador', stadium: 'El Cobre' },
  'Colo-Colo': { city: 'Macul, Santiago', stadium: 'Monumental' },
  'Coquimbo Unido': { city: 'Coquimbo', stadium: 'Francisco Sánchez Rumoroso' },
  'Deportes Concepción': { city: 'Concepción', stadium: 'Ester Roa Rebolledo' },
  'Deportes La Serena': { city: 'La Serena', stadium: 'La Portada' },
  'Deportes Limache': { city: 'Limache', stadium: 'Lucio Fariña' },
  'Everton de Viña del Mar': { city: 'Viña del Mar', stadium: 'Sausalito' },
  Huachipato: { city: 'Talcahuano', stadium: 'Huachipato-CAP Acero' },
  Ñublense: { city: 'Chillán', stadium: 'Nelson Oyarzún' },
  "O'Higgins": { city: 'Rancagua', stadium: 'El Teniente' },
  Palestino: { city: 'La Cisterna, Santiago', stadium: 'Municipal de La Cisterna' },
  'Unión La Calera': { city: 'La Calera', stadium: 'Nicolás Chahuán' },
  'Universidad Católica': { city: 'Santiago', stadium: 'Claro Arena' },
  'Universidad de Chile': { city: 'Santiago', stadium: 'Nacional' },
  'Universidad de Concepción': { city: 'Concepción', stadium: 'Ester Roa Rebolledo' },
  // Primera B
  Cobreloa: { city: 'Calama', stadium: 'Zorros del Desierto' },
  'Curicó Unido': { city: 'Curicó', stadium: 'La Granja' },
  'Deportes Antofagasta': { city: 'Antofagasta', stadium: 'Calvo y Bascuñán' },
  'Deportes Copiapó': { city: 'Copiapó', stadium: 'Luis Valenzuela Hermosilla' },
  'Deportes Iquique': { city: 'Iquique', stadium: 'Tierra de Campeones' },
  'Deportes Puerto Montt': { city: 'Puerto Montt', stadium: 'Regional de Chinquihue' },
  'Deportes Recoleta': { city: 'Santiago', stadium: 'Leonel Sánchez' },
  'Deportes Santa Cruz': { city: 'Santa Cruz', stadium: 'Joaquín Muñoz' },
  'Deportes Temuco': { city: 'Temuco', stadium: 'Germán Becker' },
  Magallanes: { city: 'Santiago', stadium: 'Luis Navarro Avilés' },
  'Rangers de Talca': { city: 'Talca', stadium: 'Fiscal de Talca' },
  'San Luis de Quillota': { city: 'Quillota', stadium: 'Lucio Fariña' },
  'San Marcos de Arica': { city: 'Arica', stadium: 'Carlos Dittborn' },
  'Santiago Wanderers': { city: 'Valparaíso', stadium: 'Elías Figueroa Brander' },
  'Unión Española': { city: 'Santiago', stadium: 'Santa Laura' },
  'Unión San Felipe': { city: 'San Felipe', stadium: 'Javier Muñoz Delgado' },
};

// Correcciones manuales para casos donde la busqueda automatica resolvio
// la entidad equivocada (ej. la universidad en vez del club de futbol).
const CREST_OVERRIDES = {
  "O'Higgins": "https://en.wikipedia.org/wiki/Special:FilePath/O'Higgins%20F.C.svg",
  'Universidad Católica': 'https://en.wikipedia.org/wiki/Special:FilePath/Escudo%20Club%20Deportivo%20Universidad%20Cat%C3%B3lica.svg',
  'Universidad de Chile': 'https://en.wikipedia.org/wiki/Special:FilePath/Emblema%20del%20Club%20Universidad%20de%20Chile.png',
  'Universidad de Concepción': 'https://en.wikipedia.org/wiki/Special:FilePath/C.D.%20Universidad%20de%20Concepci%C3%B3n.svg',
  Magallanes: 'https://en.wikipedia.org/wiki/Special:FilePath/CDMagallanes.png',
};

function loadCrests() {
  const p = path.join(__dirname, '..', 'data', 'crests.json');
  if (!fs.existsSync(p)) return new Map();
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  return new Map(arr.map((r) => [r.club, r.crest_url]));
}

// Siembra los clubes en una base ya abierta (reusable desde scripts, tests
// de humo, o el provisionamiento de una base nueva en la Fase 2).
async function seedClubs(db) {
  const crests = loadCrests();

  const sql = `INSERT INTO clubs (name, division, city, stadium, crest_url, active)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(name) DO UPDATE SET division=excluded.division, city=excluded.city,
       stadium=excluded.stadium, crest_url=excluded.crest_url`;

  const PRIMERA_A = Object.keys(CLUB_META).slice(0, 16);
  const PRIMERA_B = Object.keys(CLUB_META).slice(16);
  const names = [...PRIMERA_A, ...PRIMERA_B];

  // Un solo batch en vez de un .run() awaiteado por club: contra una base
  // remota de Turso cada .run() es un viaje de red aparte, y 32 secuenciales
  // se notan; en un batch es un solo viaje.
  const stmts = names.map((name) => {
    const meta = CLUB_META[name];
    const division = PRIMERA_A.includes(name) ? 'Primera A' : 'Primera B';
    const crestUrl = CREST_OVERRIDES[name] || crests.get(name) || null;
    return { sql, args: [name, division, meta.city, meta.stadium, crestUrl] };
  });
  await db.batch(stmts);

  return names.length;
}

async function main() {
  const db = await openDb();
  const count = await seedClubs(db);

  console.log(`Sembrados/actualizados ${count} clubes.`);
  const missing = await db.prepare('SELECT name FROM clubs WHERE crest_url IS NULL').all();
  if (missing.length) {
    console.log('Clubes sin escudo:', missing.map((m) => m.name).join(', '));
  }
  db.close();
}

module.exports = { seedClubs };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
