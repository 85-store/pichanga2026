const { pick, randInt, weightedPick, chance } = require('./random');

// Nombres genericos comunes en Chile/Sudamerica, usados SOLO para generar
// juveniles ficticios de reemplazo. Nunca se usan para representar a un
// futbolista real: los jugadores reales vienen siempre de datos investigados.
const FIRST_NAMES = [
  'Matías', 'Benjamín', 'Vicente', 'Cristóbal', 'Joaquín', 'Maximiliano', 'Agustín',
  'Ignacio', 'Tomás', 'Sebastián', 'Felipe', 'Diego', 'Gabriel', 'Franco', 'Nicolás',
  'Martín', 'Lucas', 'Bruno', 'Emilio', 'Rodrigo', 'Esteban', 'Jorge', 'Pablo',
  'Alexis', 'Fabián', 'Gonzalo', 'Yerko', 'Cristopher', 'Dylan', 'Maximiliano',
];
const LAST_NAMES = [
  'González', 'Muñoz', 'Rojas', 'Díaz', 'Pérez', 'Soto', 'Contreras', 'Silva',
  'Martínez', 'Sepúlveda', 'Morales', 'Rodríguez', 'López', 'Fuentes', 'Hernández',
  'Torres', 'Araya', 'Flores', 'Espinoza', 'Valenzuela', 'Castillo', 'Reyes',
  'Gutiérrez', 'Vásquez', 'Carrasco', 'Tapia', 'Vergara', 'Bravo', 'Cárdenas', 'Pizarro',
];

const POSITION_WEIGHTS = [
  { value: 'Portero', weight: 10 },
  { value: 'Defensa', weight: 32 },
  { value: 'Mediocampista', weight: 34 },
  { value: 'Delantero', weight: 24 },
];

const NATIONALITY_WEIGHTS = [
  { value: 'Chile', weight: 82 },
  { value: 'Argentina', weight: 4 },
  { value: 'Colombia', weight: 2 },
  { value: 'Perú', weight: 2 },
  { value: 'Venezuela', weight: 2 },
  { value: 'Uruguay', weight: 2 },
  { value: 'Bolivia', weight: 1.5 },
  { value: 'Paraguay', weight: 1.5 },
  { value: 'Ecuador', weight: 1.5 },
  { value: 'Brasil', weight: 1.5 },
];

// Evita, dentro de lo razonable, generar dos veces el mismo nombre completo
// entre jugadores que siguen activos (no necesariamente perfecto con pools
// chicos, pero reduce bastante las coincidencias visibles). existingNames: un
// Set con los nombres activos ya en uso, traido una sola vez por quien genera
// los juveniles de toda la liga en un mismo avance de temporada - antes esto
// era una consulta awaiteada por cada intento de nombre (hasta 8) por cada
// juvenil generado, cientos de round-trips extra contra Turso en un avance de
// temporada con ~30 clubes.
function generateName(existingNames) {
  for (let i = 0; i < 8; i++) {
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    if (!existingNames || !existingNames.has(name)) return name;
  }
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

// La mayoria de juveniles tiene potencial normal; unos pocos son "promesas".
function generatePotential() {
  if (chance(0.08)) return randInt(78, 92); // gran promesa
  if (chance(0.25)) return randInt(70, 77); // sobre el promedio
  return randInt(52, 69); // potencial normal
}

function generateYouthPlayer({ clubId, seasonYear, existingNames }) {
  const potential = generatePotential();
  const age = randInt(16, 20);
  // A menor edad, mas lejos esta del potencial; a mayor edad, mas cerca.
  const gapMax = Math.max(5, 25 - (age - 16) * 4);
  const rating = Math.max(35, potential - randInt(5, gapMax));

  const full_name = generateName(existingNames);
  if (existingNames) existingNames.add(full_name);

  return {
    full_name,
    birth_date: `${seasonYear - age}-06-15`,
    nationality: weightedPick(NATIONALITY_WEIGHTS),
    position: weightedPick(POSITION_WEIGHTS),
    shirt_number: null,
    rating,
    potential,
    status: 'activo',
    is_real_player: 0,
    club_id: clubId,
    created_at_season: seasonYear,
  };
}

// Cuantos juveniles genera un club esta temporada (1 a 3, mas si hubo retiros).
function youthCountForClub(retiredCount) {
  return randInt(1, 3) + (retiredCount > 2 ? 1 : 0);
}

module.exports = { generateYouthPlayer, youthCountForClub };
