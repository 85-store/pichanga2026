// Cliente chico para la Platform API de Turso (distinta del cliente libSQL de
// cada base): permite crear/listar/borrar bases y generar tokens de acceso
// para una base por nombre, usando el token de organizacion
// (TURSO_PLATFORM_TOKEN). Se usa para provisionar una base nueva por
// usuario/slot (Fase 2) en vez de tener que crearlas a mano en el dashboard.
const API_BASE = 'https://api.turso.tech';

function authHeaders() {
  const token = process.env.TURSO_PLATFORM_TOKEN;
  if (!token) throw new Error('Falta TURSO_PLATFORM_TOKEN en el entorno.');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function orgSlug() {
  const slug = process.env.TURSO_ORG_SLUG;
  if (!slug) throw new Error('Falta TURSO_ORG_SLUG en el entorno.');
  return slug;
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Turso platform API ${path} fallo (${res.status}): ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function listGroups() {
  const data = await request(`/v1/organizations/${orgSlug()}/groups`);
  return data.groups || [];
}

// La organizacion siempre tiene al menos un grupo (se crea uno "default" al
// crear la cuenta); se usa el que se llame "default" o, si no existe, el
// primero que haya.
async function defaultGroupName() {
  const groups = await listGroups();
  if (!groups.length) throw new Error('La organizacion de Turso no tiene ningun grupo creado.');
  const def = groups.find((g) => g.name === 'default');
  return (def || groups[0]).name;
}

async function getDatabase(name) {
  try {
    const data = await request(`/v1/organizations/${orgSlug()}/databases/${name}`);
    return data.database;
  } catch (err) {
    if (/\(404\)/.test(err.message)) return null;
    throw err;
  }
}

async function createDatabase(name, { group } = {}) {
  const groupName = group || (await defaultGroupName());
  const data = await request(`/v1/organizations/${orgSlug()}/databases`, {
    method: 'POST',
    body: JSON.stringify({ name, group: groupName }),
  });
  return data.database;
}

// Idempotente: si la base ya existe (por nombre), la devuelve en vez de
// fallar - asi provisionar una base que ya se habia creado antes no explota.
async function ensureDatabase(name, opts) {
  const existing = await getDatabase(name);
  if (existing) return existing;
  return createDatabase(name, opts);
}

async function createDatabaseToken(name, { expiration = 'never', authorization = 'full-access' } = {}) {
  const data = await request(
    `/v1/organizations/${orgSlug()}/databases/${name}/auth/tokens?expiration=${expiration}&authorization=${authorization}`,
    { method: 'POST' }
  );
  return data.jwt;
}

async function deleteDatabase(name) {
  await request(`/v1/organizations/${orgSlug()}/databases/${name}`, { method: 'DELETE' });
}

module.exports = { getDatabase, createDatabase, ensureDatabase, createDatabaseToken, deleteDatabase };
