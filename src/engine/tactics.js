// Alineacion/formacion "por defecto" del club que dirige el usuario: se usa
// para pintar el modulo "Formacion" de la barra lateral y para precargar el
// editor tactico y la planilla pre-partido. Es solo una preferencia (no
// afecta la simulacion de otros clubes), y se actualiza automaticamente cada
// vez que el usuario confirma una alineacion al iniciar un partido.
const { FORMATION_NAMES, FORMATIONS } = require('./formations');

async function getSavedLineup(db, clubId) {
  const career = await db.prepare('SELECT lineup_formation, lineup_players FROM career WHERE id = 1 AND club_id = ?').get(clubId);
  if (!career || !career.lineup_players) return null;
  let playerIds;
  try {
    playerIds = JSON.parse(career.lineup_players);
  } catch {
    return null;
  }
  if (!Array.isArray(playerIds) || playerIds.length !== 11) return null;
  return { formation: career.lineup_formation || FORMATION_NAMES[0], playerIds };
}

// Valida y guarda la alineacion: 11 jugadores unicos, activos, del club, con
// exactamente 1 portero. No exige que respeten la cantidad por linea de la
// formacion elegida (el usuario puede jugar con lineas atipicas a proposito).
async function saveLineup(db, clubId, formation, playerIds) {
  if (!FORMATIONS[formation]) throw new Error('Formación no válida.');
  const ids = Array.from(new Set((playerIds || []).map(Number)));
  if (ids.length !== 11) throw new Error('Debes seleccionar exactamente 11 jugadores.');

  const players = await db
    .prepare(`SELECT id, position FROM players WHERE club_id = ? AND status = 'activo' AND id IN (${ids.map(() => '?').join(',')})`)
    .all(clubId, ...ids);
  if (players.length !== 11) throw new Error('Alguno de los jugadores no pertenece a tu plantel activo.');
  const gkCount = players.filter((p) => p.position === 'Portero').length;
  // Si el club no tiene ningun portero activo disponible (todos lesionados o sin
  // plantel), no se puede exigir uno en la alineacion: se permite jugar con un
  // jugador de campo bajo el arco, igual que ya tolera el motor de partidos.
  const gkRow = await db
    .prepare(`SELECT COUNT(*) as c FROM players WHERE club_id = ? AND status = 'activo' AND position = 'Portero'`)
    .get(clubId);
  const hasAnyAvailableGk = gkRow.c > 0;
  const requiredGk = hasAnyAvailableGk ? 1 : 0;
  if (gkCount !== requiredGk) {
    throw new Error(
      hasAnyAvailableGk
        ? 'Debes incluir exactamente 1 portero.'
        : 'No tienes ningún portero disponible: debes dejar el arco sin un portero de profesión.'
    );
  }

  await db.prepare('UPDATE career SET lineup_formation = ?, lineup_players = ? WHERE id = 1 AND club_id = ?').run(
    formation,
    JSON.stringify(ids),
    clubId
  );
  return { formation, playerIds: ids };
}

module.exports = { getSavedLineup, saveLineup };
