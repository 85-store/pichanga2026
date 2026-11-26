// Prueba de humo de la Fase 2: crea (o inicia sesion con) 2 usuarios reales
// de Firebase Auth via la REST API, y confirma contra el servidor local que
// cada uno solo ve y puede tocar su propia partida (cada uno con su propia
// base Turso, provisionada por src/db/registry.js).
require('dotenv/config');
const fs = require('fs');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:4099';
const FIREBASE_API_KEY = (() => {
  const src = fs.readFileSync('public/firebase-config.js', 'utf8');
  const m = src.match(/apiKey:\s*'([^']+)'/);
  if (!m) throw new Error('No se pudo leer apiKey de public/firebase-config.js');
  return m[1];
})();

async function firebaseSignUpOrSignIn(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
  let res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  let data = await res.json();
  if (data.error) {
    const signUpUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
    res = await fetch(signUpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    data = await res.json();
    if (data.error) throw new Error(`Firebase auth fallo para ${email}: ${JSON.stringify(data.error)}`);
  }
  return { idToken: data.idToken, uid: data.localId };
}

async function api(token, method, path, { slot, body } = {}) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (slot) headers['X-Save-Slot'] = String(slot);
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function assert(cond, msg) {
  if (!cond) throw new Error(`FALLO: ${msg}`);
  console.log(`  OK: ${msg}`);
}

async function main() {
  const stamp = Date.now();
  const userA = await firebaseSignUpOrSignIn(`pichanga-test-a-${stamp}@example.com`, 'Test1234!');
  const userB = await firebaseSignUpOrSignIn(`pichanga-test-b-${stamp}@example.com`, 'Test1234!');
  console.log(`Usuario A uid=${userA.uid}`);
  console.log(`Usuario B uid=${userB.uid}`);

  const clubs = await api(userA.idToken, 'GET', '/api/saves/template-clubs');
  assert(clubs.status === 200 && Array.isArray(clubs.data) && clubs.data.length > 0, 'catalogo de clubes disponible');
  const clubIdA = clubs.data[0].id;
  const clubIdB = clubs.data[1].id;

  console.log('Provisionando partida nueva para A (esto crea una base Turso real, puede tardar)...');
  const newA = await api(userA.idToken, 'POST', '/api/saves/1/new', { slot: 1, body: { clubId: clubIdA, managerName: 'DT A' } });
  assert(newA.status === 200, `A crea partida en slot 1 (status ${newA.status}, ${JSON.stringify(newA.data)})`);

  console.log('Provisionando partida nueva para B...');
  const newB = await api(userB.idToken, 'POST', '/api/saves/1/new', { slot: 1, body: { clubId: clubIdB, managerName: 'DT B' } });
  assert(newB.status === 200, `B crea partida en slot 1 (status ${newB.status}, ${JSON.stringify(newB.data)})`);

  const listA = await api(userA.idToken, 'GET', '/api/saves');
  const listB = await api(userB.idToken, 'GET', '/api/saves');
  assert(listA.data.slots[0].exists && listA.data.slots[0].club === clubs.data[0].name, 'A ve su propio club en su slot 1');
  assert(listB.data.slots[0].exists && listB.data.slots[0].club === clubs.data[1].name, 'B ve su propio club en su slot 1');
  assert(listA.data.slots[0].club !== listB.data.slots[0].club, 'A y B tienen clubes distintos (bases distintas)');

  // A pide su propia temporada con su slot: debe andar.
  const seasonA = await api(userA.idToken, 'GET', '/api/season', { slot: 1 });
  assert(seasonA.status === 200 && seasonA.data.year === 2026, 'A puede leer su propia temporada via X-Save-Slot');

  // B, con el token de B pero pidiendo contenido de su propio slot 1: anda (es su base, no la de A).
  const seasonB = await api(userB.idToken, 'GET', '/api/season', { slot: 1 });
  assert(seasonB.status === 200 && seasonB.data.year === 2026, 'B puede leer su propia temporada via X-Save-Slot');

  // Pedido sin token: rechazado.
  const noAuth = await api('', 'GET', '/api/season', { slot: 1 });
  assert(noAuth.status === 401, 'sin token, el servidor rechaza con 401');

  // Token invalido: rechazado.
  const badAuth = await api('token-invalido', 'GET', '/api/season', { slot: 1 });
  assert(badAuth.status === 401, 'con token invalido, el servidor rechaza con 401');

  // Limpieza: borra ambas partidas de prueba (y sus bases Turso).
  await api(userA.idToken, 'DELETE', '/api/saves/1');
  await api(userB.idToken, 'DELETE', '/api/saves/1');
  console.log('Limpieza: ambas partidas de prueba borradas.');

  console.log('\nOK: aislamiento confirmado entre 2 cuentas reales de Firebase.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
