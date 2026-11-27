require('dotenv/config');
const fs = require('fs');
const path = require('path');
const { createDbClient } = require('./client');
const { CompatDb } = require('./compat');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
// Subir este numero cada vez que se agregue un paso nuevo a migrate() (una
// columna, una migracion de tabla, o se cambie BUDGET_TOPUP_VERSION) - es lo
// que hace que ese guardado vuelva a pasar por toda la cadena de migracion
// una vez mas. Si no se sube, un guardado que ya esta al dia se la salta.
const SCHEMA_VERSION = 3;

async function columnExists(db, table, column) {
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((c) => c.name === column);
}

// Multiplicador de prestigio/tamano historico de cada club (hinchada, ingresos
// por TV y sponsors, patrimonio), independiente de la division en la que esten
// jugando ahora mismo: un "grande" recien descendido sigue teniendo bastante
// mas presupuesto que un chico de la misma division, como en la realidad.
const CLUB_PRESTIGE = {
  'Colo-Colo': 10,
  'Universidad de Chile': 10,
  'Universidad Católica': 7,
  Cobresal: 3.2,
  Huachipato: 3,
  "O'Higgins": 2.8,
  Palestino: 2.6,
  'Unión Española': 2.6,
  'Audax Italiano': 2.4,
  Cobreloa: 2.4,
  'Everton de Viña del Mar': 2.2,
  Ñublense: 2,
  'Coquimbo Unido': 2,
  'Universidad de Concepción': 1.4,
  'Santiago Wanderers': 1.3,
  'Deportes La Serena': 1.3,
  'Deportes Antofagasta': 1.3,
  'Curicó Unido': 1.2,
  'Unión San Felipe': 1.2,
  'Deportes Concepción': 1.2,
  'Unión La Calera': 1.1,
  'San Marcos de Arica': 1.1,
  'Deportes Limache': 1.1,
  'Deportes Iquique': 1.1,
  Magallanes: 1,
  'Deportes Copiapó': 1,
  'Deportes Temuco': 1,
  'Rangers de Talca': 1,
  'San Luis de Quillota': 0.9,
  'Deportes Recoleta': 0.9,
  'Deportes Puerto Montt': 0.9,
  'Deportes Santa Cruz': 0.8,
};
const DEFAULT_PRESTIGE = 1;
const BUDGET_UNIT_K = 400; // unidad base de presupuesto, en miles de USD
const BUDGET_TOPUP_VERSION = 'v2-prestige';

// Asigna presupuesto de fichajes a los clubes que todavia no tienen uno
// calculado con la version vigente del modelo (base de datos nueva, migrada
// desde una version sin mercado de pases, o con el modelo viejo de
// presupuesto parejo). Usa last_budget_topup como marca de version, para que
// sea seguro volver a correr esto en cada apertura sin pisar presupuestos que
// el jugador ya gasto/gano bajo el modelo vigente.
async function backfillClubBudgets(db) {
  const clubs = await db
    .prepare(`SELECT id, name, division FROM clubs WHERE last_budget_topup IS NULL OR last_budget_topup != ?`)
    .all(BUDGET_TOPUP_VERSION);
  for (const club of clubs) {
    const row = await db
      .prepare(
        `SELECT AVG(rating) as avg FROM players WHERE club_id = ? AND status IN ('activo','lesionado') AND is_real_player = 1`
      )
      .get(club.id);
    const avgRating = row && row.avg != null ? row.avg : 60;
    const prestige = CLUB_PRESTIGE[club.name] ?? DEFAULT_PRESTIGE;
    const divisionFactor = club.division === 'Primera A' ? 1 : 0.45;
    const base = BUDGET_UNIT_K * prestige * divisionFactor;
    const ratingBonus = Math.max(0, avgRating - 55) * 6 * divisionFactor;
    const variance = 0.85 + Math.random() * 0.3;
    const budget = Math.max(60, Math.round((base + ratingBonus) * variance));
    await db
      .prepare('UPDATE clubs SET budget = ?, last_budget_topup = ? WHERE id = ?')
      .run(budget, BUDGET_TOPUP_VERSION, club.id);
  }
}

// Asigna una identidad tactica estable (y variada) a los clubes que todavia no
// tienen una, para que el motor de simulacion rapido (el que resuelve la gran
// mayoria de los partidos de la temporada) no use la misma tactica neutra para
// todos los equipos IA. La semilla es el id del club, asi que es determinista
// y reproducible entre aperturas del mismo guardado.
async function backfillClubTactics(db) {
  const { FORMATION_NAMES, MENTALITIES, STYLES, PRESSINGS } = require('../engine/formations');
  const clubs = await db.prepare('SELECT id FROM clubs WHERE pref_formation IS NULL').all();
  for (const club of clubs) {
    const seed = club.id;
    const formation = FORMATION_NAMES[seed % FORMATION_NAMES.length];
    const mentality = MENTALITIES[(seed + 1) % MENTALITIES.length];
    const style = STYLES[(seed + 2) % STYLES.length];
    const pressing = PRESSINGS[(seed + 3) % PRESSINGS.length];
    await db
      .prepare('UPDATE clubs SET pref_formation = ?, pref_mentality = ?, pref_style = ?, pref_pressing = ? WHERE id = ?')
      .run(formation, mentality, style, pressing, club.id);
  }
}

async function migrate(db) {
  if (!(await columnExists(db, 'clubs', 'budget'))) {
    await db.exec('ALTER TABLE clubs ADD COLUMN budget INTEGER NOT NULL DEFAULT 0');
  }
  if (!(await columnExists(db, 'clubs', 'last_budget_topup'))) {
    await db.exec('ALTER TABLE clubs ADD COLUMN last_budget_topup TEXT');
  }
  if (!(await columnExists(db, 'clubs', 'pref_formation'))) {
    await db.exec(`
      ALTER TABLE clubs ADD COLUMN pref_formation TEXT;
      ALTER TABLE clubs ADD COLUMN pref_mentality TEXT;
      ALTER TABLE clubs ADD COLUMN pref_style TEXT;
      ALTER TABLE clubs ADD COLUMN pref_pressing TEXT;
    `);
  }
  if (!(await columnExists(db, 'players', 'loaned_from_club_id'))) {
    await db.exec(`
      ALTER TABLE players ADD COLUMN loaned_from_club_id INTEGER REFERENCES clubs(id);
      ALTER TABLE players ADD COLUMN loan_return_season INTEGER;
    `);
  }
  if (!(await columnExists(db, 'career', 'lineup_formation'))) {
    await db.exec(`
      ALTER TABLE career ADD COLUMN lineup_formation TEXT;
      ALTER TABLE career ADD COLUMN lineup_players TEXT;
    `);
  }
  if (!(await columnExists(db, 'career', 'board_confidence'))) {
    await db.exec(`
      ALTER TABLE career ADD COLUMN board_confidence INTEGER NOT NULL DEFAULT 60;
      ALTER TABLE career ADD COLUMN locker_room_morale INTEGER NOT NULL DEFAULT 60;
      ALTER TABLE career ADD COLUMN manager_reputation INTEGER NOT NULL DEFAULT 60;
      ALTER TABLE career ADD COLUMN matches_managed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE career ADD COLUMN last_reunion_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE career ADD COLUMN last_exigencia_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE career ADD COLUMN last_polemica_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE career ADD COLUMN last_clasico_at INTEGER NOT NULL DEFAULT 0;
    `);
  }
  if (!(await columnExists(db, 'career', 'team_identity'))) {
    await db.exec('ALTER TABLE career ADD COLUMN team_identity TEXT');
  }
  if (!(await columnExists(db, 'career', 'fan_support'))) {
    await db.exec(`
      ALTER TABLE career ADD COLUMN fan_support INTEGER NOT NULL DEFAULT 60;
      ALTER TABLE career ADD COLUMN last_hinchada_at INTEGER NOT NULL DEFAULT 0;
    `);
  }
  if (!(await columnExists(db, 'career', 'media_pressure'))) {
    await db.exec(`
      ALTER TABLE career ADD COLUMN media_pressure INTEGER NOT NULL DEFAULT 40;
      ALTER TABLE career ADD COLUMN last_prensa_at INTEGER NOT NULL DEFAULT 0;
    `);
  }
  // El orden importa: migrateCareerEventsKind reconstruye la tabla con el
  // esquema viejo (sin written_response) si venia de antes de 'hinchada', asi
  // que el ALTER ADD COLUMN de written_response va despues de esa y antes de
  // migrateCareerEventsKindPrensa (que si necesita seleccionarla al reconstruir).
  await migrateCareerEventsKind(db);
  if (!(await columnExists(db, 'career_events', 'written_response'))) {
    await db.exec('ALTER TABLE career_events ADD COLUMN written_response TEXT');
  }
  await migrateCareerEventsKindPrensa(db);
  await migrateSentOffersCounterOffers(db);
  await migrateSuperCopaStages(db);
  await backfillClubBudgets(db);
  await backfillClubTactics(db);
}

// sent_offers nacio sin soporte de contraofertas (sin player_id/resolved y con
// un CHECK de status que no admitia 'contraoferta'). SQLite no soporta
// ALTER TABLE ... DROP CONSTRAINT, asi que para guardados viejos hay que
// reconstruir la tabla igual que con career_events.kind.
async function migrateSentOffersCounterOffers(db) {
  const row = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sent_offers'").get();
  if (!row || !row.sql || row.sql.includes("'contraoferta'")) return;
  await db.exec(`
    ALTER TABLE sent_offers RENAME TO sent_offers_old;
    CREATE TABLE sent_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_year INTEGER NOT NULL,
      window TEXT NOT NULL,
      player_id INTEGER REFERENCES players(id),
      player_name TEXT NOT NULL,
      target_club_name TEXT,
      amount INTEGER,
      kind TEXT NOT NULL CHECK (kind IN ('agente_libre', 'fichaje', 'prestamo')),
      status TEXT NOT NULL CHECK (status IN ('aceptada', 'rechazada', 'contraoferta')),
      resolved INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO sent_offers (id, season_year, window, player_name, target_club_name, amount, kind, status, created_at)
      SELECT id, season_year, window, player_name, target_club_name, amount, kind, status, created_at FROM sent_offers_old;
    DROP TABLE sent_offers_old;
  `);
}

// super_copa_matches nacio como un partido unico por temporada (UNIQUE
// season_year), pero la nueva Supercopa tiene 2 semifinales + final por
// temporada. SQLite no soporta ALTER TABLE ... DROP CONSTRAINT, asi que hay
// que reconstruir la tabla con una columna stage y UNIQUE(season_year, stage).
// Los partidos viejos (formato de partido unico) se preservan como stage
// 'final' para no perder el historial de supercopas ya jugadas.
async function migrateSuperCopaStages(db) {
  if (await columnExists(db, 'super_copa_matches', 'stage')) return;
  await db.exec(`
    ALTER TABLE super_copa_matches RENAME TO super_copa_matches_old;
    CREATE TABLE super_copa_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_year INTEGER NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('semifinal1', 'semifinal2', 'final')),
      home_club_id INTEGER REFERENCES clubs(id),
      away_club_id INTEGER REFERENCES clubs(id),
      home_goals INTEGER,
      away_goals INTEGER,
      played INTEGER NOT NULL DEFAULT 0,
      decided_by_penalties INTEGER NOT NULL DEFAULT 0,
      winner_club_id INTEGER REFERENCES clubs(id),
      skipped_reason TEXT,
      UNIQUE(season_year, stage)
    );
    INSERT INTO super_copa_matches (id, season_year, stage, home_club_id, away_club_id, home_goals, away_goals, played, decided_by_penalties, winner_club_id, skipped_reason)
      SELECT id, season_year, 'final', home_club_id, away_club_id, home_goals, away_goals, played, decided_by_penalties, winner_club_id, skipped_reason FROM super_copa_matches_old;
    DROP TABLE super_copa_matches_old;
  `);
}

// career_events.kind nacio con un CHECK que no admitia el nuevo tipo 'hinchada'.
// SQLite no soporta ALTER TABLE ... DROP CONSTRAINT, asi que para guardados
// viejos hay que reconstruir la tabla (renombrar, crear la nueva con el CHECK
// ampliado, copiar los datos y borrar la vieja) en vez de solo agregar columnas.
async function migrateCareerEventsKind(db) {
  const row = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'career_events'").get();
  if (!row || !row.sql || row.sql.includes("'hinchada'")) return;
  await db.exec(`
    ALTER TABLE career_events RENAME TO career_events_old;
    CREATE TABLE career_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_year INTEGER NOT NULL,
      match_count INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('reunion', 'exigencia', 'polemica', 'clasico', 'hinchada')),
      subtype TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      options TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'resuelto')),
      chosen_option TEXT,
      result_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    INSERT INTO career_events (id, season_year, match_count, kind, subtype, title, description, options, status, chosen_option, result_text, created_at, resolved_at)
      SELECT id, season_year, match_count, kind, subtype, title, description, options, status, chosen_option, result_text, created_at, resolved_at FROM career_events_old;
    DROP TABLE career_events_old;
    CREATE INDEX IF NOT EXISTS idx_career_events_status ON career_events(status, id DESC);
  `);
}

// Misma historia que migrateCareerEventsKind, pero para el tipo 'prensa'
// (declaraciones de periodistas/comentaristas) agregado despues: el CHECK
// viejo no lo admite, asi que hay que reconstruir la tabla otra vez.
async function migrateCareerEventsKindPrensa(db) {
  const row = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'career_events'").get();
  if (!row || !row.sql || row.sql.includes("'prensa'")) return;
  await db.exec(`
    ALTER TABLE career_events RENAME TO career_events_old;
    CREATE TABLE career_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_year INTEGER NOT NULL,
      match_count INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('reunion', 'exigencia', 'polemica', 'clasico', 'hinchada', 'prensa')),
      subtype TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      options TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'resuelto')),
      chosen_option TEXT,
      written_response TEXT,
      result_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    INSERT INTO career_events (id, season_year, match_count, kind, subtype, title, description, options, status, chosen_option, written_response, result_text, created_at, resolved_at)
      SELECT id, season_year, match_count, kind, subtype, title, description, options, status, chosen_option, written_response, result_text, created_at, resolved_at FROM career_events_old;
    DROP TABLE career_events_old;
    CREATE INDEX IF NOT EXISTS idx_career_events_status ON career_events(status, id DESC);
  `);
}

// openDb acepta { url, authToken } apuntando a una base Turso. Sin
// argumentos, usa la base configurada por variables de entorno (TURSO_DB_URL
// / TURSO_DB_TOKEN) - la base compartida de la Fase 1, antes de que exista
// una base por usuario (Fase 2).
async function openDb(target) {
  const config = target || { url: process.env.TURSO_DB_URL, authToken: process.env.TURSO_DB_TOKEN };
  const client = createDbClient(config);
  const db = new CompatDb(client);
  await db.exec('PRAGMA foreign_keys = ON;');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await db.exec(schema);

  // Turso (remoto) no permite escribir PRAGMA user_version, asi que la
  // version de esquema se guarda en una tabla chica en vez del pragma.
  await db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)');
  const versionRow = await db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
  const currentVersion = versionRow ? Number(versionRow.value) : 0;

  if (currentVersion < SCHEMA_VERSION) {
    await migrate(db);
    await db
      .prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
  }

  return db;
}

module.exports = { openDb };
