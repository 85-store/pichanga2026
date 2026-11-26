// Normaliza distintas etiquetas de posicion (español/ingles/abreviadas) a las
// 4 categorias usadas por el esquema: Portero, Defensa, Mediocampista, Delantero.
const MAP = {
  gk: 'Portero', portero: 'Portero', goalkeeper: 'Portero', arquero: 'Portero',

  df: 'Defensa', defensa: 'Defensa', defender: 'Defensa', defensor: 'Defensa',
  cb: 'Defensa', lb: 'Defensa', rb: 'Defensa', 'centre-back': 'Defensa',
  'left-back': 'Defensa', 'right-back': 'Defensa', lateral: 'Defensa',
  'central defender': 'Defensa',

  mf: 'Mediocampista', mediocampista: 'Mediocampista', volante: 'Mediocampista',
  centrocampista: 'Mediocampista', midfielder: 'Mediocampista', 'central midfield': 'Mediocampista',
  'defensive midfield': 'Mediocampista', 'attacking midfield': 'Mediocampista',
  'left midfield': 'Mediocampista', 'right midfield': 'Mediocampista',

  fw: 'Delantero', delantero: 'Delantero', atacante: 'Delantero', forward: 'Delantero',
  striker: 'Delantero', 'centre-forward': 'Delantero', winger: 'Delantero',
  'left winger': 'Delantero', 'right winger': 'Delantero', extremo: 'Delantero',
};

function normalizePosition(raw) {
  if (!raw) return 'Mediocampista';
  const key = String(raw).trim().toLowerCase();
  return MAP[key] || 'Mediocampista';
}

module.exports = { normalizePosition };
