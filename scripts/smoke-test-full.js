// Prueba de humo "partida completa" contra la base Turso real configurada en
// .env: simula una temporada entera (liga, Copa Chile, Copa de la Liga,
// mercado de pases, avance de temporada) para confirmar que la conversion
// async no rompio ninguna ruta del motor bajo latencia de red real.
const { openDb } = require('../src/db');
const { getCareer } = require('../src/engine/board');
const { getCurrentSeasonYear, advanceSeason, ensureFirstSeason, ensureSeasonCompetitions } = require('../src/engine/season');
const { simulateRemainingLeague, isLeagueComplete } = require('../src/engine/league');
const { generateCopaDraw, simulateRemainingCopa, isCopaComplete } = require('../src/engine/copa');
const { ensureCopaLigaDraw, simulateRemainingCopaLiga, isCopaLigaComplete } = require('../src/engine/copa-liga');
const { getMarketStatus, simulateAiTransferMarket } = require('../src/engine/market');

async function main() {
  const db = await openDb();
  const career = await getCareer(db);
  if (!career) throw new Error('No hay carrera activa; corré scripts/smoke-test.js primero.');
  await ensureFirstSeason(db, 2026);
  await ensureSeasonCompetitions(db, 2026);
  const seasonYear = await getCurrentSeasonYear(db);
  console.log(`Temporada activa: ${seasonYear}, club: ${career.club_name}`);

  if (!(await isCopaComplete(db, seasonYear))) {
    await generateCopaDraw(db, seasonYear);
    const copaResult = await simulateRemainingCopa(db, seasonYear);
    console.log(`Copa Chile simulada: ${copaResult.length} partidos.`);
  }

  if (!(await isCopaLigaComplete(db, seasonYear))) {
    await ensureCopaLigaDraw(db, seasonYear);
    const ligaCopaResult = await simulateRemainingCopaLiga(db, seasonYear);
    console.log(`Copa de la Liga simulada: ${JSON.stringify(ligaCopaResult)}`);
  }

  if (!(await isLeagueComplete(db, seasonYear))) {
    const leagueResult = await simulateRemainingLeague(db, seasonYear);
    console.log(`Liga simulada: ${leagueResult.length} jornadas.`);
  }

  const marketStatus = await getMarketStatus(db);
  console.log('Estado de mercado:', marketStatus);
  await simulateAiTransferMarket(db, seasonYear, marketStatus.window || 'invierno');
  console.log('Mercado IA simulado sin errores.');

  const advanceResult = await advanceSeason(db);
  console.log('Temporada avanzada:', { nuevaTemporada: advanceResult.newSeasonYear || advanceResult });

  console.log('OK: partida completa simulada de punta a punta contra Turso real.');
  db.close();
}

main().catch((err) => {
  console.error('FALLO smoke-test-full:', err);
  process.exit(1);
});
