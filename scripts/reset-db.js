// Borra todas las tablas de la base Turso configurada en .env, para empezar
// de cero en desarrollo (no hay modo archivo local: siempre es remoto).
require('dotenv/config');
const { createDbClient } = require('../src/db/client');

async function resetDb(client) {
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'libsql_wasm_func_table'"
  );
  if (!tables.rows.length) return 0;
  const dropSql = tables.rows.map((r) => `DROP TABLE IF EXISTS "${r[0]}";`).join('\n');
  await client.executeMultiple(dropSql);
  return tables.rows.length;
}

async function main() {
  const client = createDbClient({ url: process.env.TURSO_DB_URL, authToken: process.env.TURSO_DB_TOKEN });
  const count = await resetDb(client);
  console.log(`Tablas eliminadas: ${count}`);
  client.close();
}

module.exports = { resetDb };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
