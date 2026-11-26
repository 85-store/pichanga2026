// Plantillas de formacion: posiciones relativas (0-100) de los 11 titulares,
// orientadas de izquierda (propia valla, x=0) a derecha (valla rival, x=100).
// El equipo visitante se refleja (x' = 100 - x) al calcular posiciones reales.
const FORMATIONS = {
  '4-4-2': {
    slots: [
      { group: 'GK', x: 5, y: 50 },
      { group: 'DEF', x: 18, y: 15 }, { group: 'DEF', x: 18, y: 38 }, { group: 'DEF', x: 18, y: 62 }, { group: 'DEF', x: 18, y: 85 },
      { group: 'MID', x: 45, y: 15 }, { group: 'MID', x: 45, y: 38 }, { group: 'MID', x: 45, y: 62 }, { group: 'MID', x: 45, y: 85 },
      { group: 'FWD', x: 75, y: 38 }, { group: 'FWD', x: 75, y: 62 },
    ],
  },
  '4-3-3': {
    slots: [
      { group: 'GK', x: 5, y: 50 },
      { group: 'DEF', x: 18, y: 15 }, { group: 'DEF', x: 18, y: 38 }, { group: 'DEF', x: 18, y: 62 }, { group: 'DEF', x: 18, y: 85 },
      { group: 'MID', x: 42, y: 30 }, { group: 'MID', x: 42, y: 50 }, { group: 'MID', x: 42, y: 70 },
      { group: 'FWD', x: 78, y: 20 }, { group: 'FWD', x: 78, y: 50 }, { group: 'FWD', x: 78, y: 80 },
    ],
  },
  '3-5-2': {
    slots: [
      { group: 'GK', x: 5, y: 50 },
      { group: 'DEF', x: 18, y: 25 }, { group: 'DEF', x: 18, y: 50 }, { group: 'DEF', x: 18, y: 75 },
      { group: 'MID', x: 42, y: 12 }, { group: 'MID', x: 42, y: 32 }, { group: 'MID', x: 42, y: 50 }, { group: 'MID', x: 42, y: 68 }, { group: 'MID', x: 42, y: 88 },
      { group: 'FWD', x: 78, y: 38 }, { group: 'FWD', x: 78, y: 62 },
    ],
  },
  '4-2-3-1': {
    slots: [
      { group: 'GK', x: 5, y: 50 },
      { group: 'DEF', x: 18, y: 15 }, { group: 'DEF', x: 18, y: 38 }, { group: 'DEF', x: 18, y: 62 }, { group: 'DEF', x: 18, y: 85 },
      { group: 'MID', x: 38, y: 35 }, { group: 'MID', x: 38, y: 65 },
      { group: 'MID', x: 58, y: 20 }, { group: 'MID', x: 58, y: 50 }, { group: 'MID', x: 58, y: 80 },
      { group: 'FWD', x: 82, y: 50 },
    ],
  },
  '5-3-2': {
    slots: [
      { group: 'GK', x: 5, y: 50 },
      { group: 'DEF', x: 16, y: 10 }, { group: 'DEF', x: 16, y: 30 }, { group: 'DEF', x: 16, y: 50 }, { group: 'DEF', x: 16, y: 70 }, { group: 'DEF', x: 16, y: 90 },
      { group: 'MID', x: 45, y: 25 }, { group: 'MID', x: 45, y: 50 }, { group: 'MID', x: 45, y: 75 },
      { group: 'FWD', x: 78, y: 38 }, { group: 'FWD', x: 78, y: 62 },
    ],
  },
};

const FORMATION_NAMES = Object.keys(FORMATIONS);

const MENTALITIES = ['defensivo', 'equilibrado', 'ofensivo'];
const STYLES = ['posesion', 'directo', 'contragolpe'];
const PRESSINGS = ['bajo', 'medio', 'alto'];

function defaultTactics() {
  return { formation: '4-4-2', mentality: 'equilibrado', style: 'posesion', pressing: 'medio' };
}

// Cuenta cuantos jugadores de cada linea tiene una formacion (GK siempre 1).
// Se usa para calcular ventajas/desventajas numericas entre formaciones rivales
// (superioridad en mediocampo, delanteros vs linea defensiva rival, etc).
const groupCountsCache = new Map();
function groupCounts(formationName) {
  if (groupCountsCache.has(formationName)) return groupCountsCache.get(formationName);
  const formation = FORMATIONS[formationName] || FORMATIONS['4-4-2'];
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const slot of formation.slots) counts[slot.group] += 1;
  groupCountsCache.set(formationName, counts);
  return counts;
}

module.exports = { FORMATIONS, FORMATION_NAMES, MENTALITIES, STYLES, PRESSINGS, defaultTactics, groupCounts };
