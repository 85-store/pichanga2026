// Envuelve un Client de @libsql/client para que se vea y se use como el
// DatabaseSync de node:sqlite que usaba el motor (mismo patron
// db.prepare(sql).run()/.get()/.all(), mismo db.exec(sql) para DDL/scripts
// multi-statement) pero devolviendo Promises. Asi la conversion de cada sitio
// de llamada en el motor se reduce, en la mayoria de los casos, a agregar
// "await" en vez de reescribir cada query al formato nativo del cliente.

function rowToObject(columns, row) {
  const obj = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = row[i];
  }
  return obj;
}

function normalizeId(id) {
  if (id === undefined || id === null) return id;
  return typeof id === 'bigint' ? Number(id) : id;
}

class Statement {
  constructor(client, sql) {
    this.client = client;
    this.sql = sql;
  }

  async run(...args) {
    const result = await this.client.execute({ sql: this.sql, args });
    return { changes: result.rowsAffected, lastInsertRowid: normalizeId(result.lastInsertRowid) };
  }

  async get(...args) {
    const result = await this.client.execute({ sql: this.sql, args });
    if (!result.rows.length) return undefined;
    return rowToObject(result.columns, result.rows[0]);
  }

  async all(...args) {
    const result = await this.client.execute({ sql: this.sql, args });
    return result.rows.map((row) => rowToObject(result.columns, row));
  }
}

// Wrapper de una transaccion interactiva con la MISMA forma que CompatDb
// (prepare().run()/.get()/.all(), exec()) para que el codigo dentro de una
// transaccion se escriba igual que el resto del motor. Statement funciona sin
// cambios porque el objeto Transaction de @libsql/client tambien expone
// execute({sql, args}), igual que el Client normal.
class CompatTx {
  constructor(tx) {
    this.tx = tx;
  }

  prepare(sql) {
    return new Statement(this.tx, sql);
  }

  async exec(sql) {
    await this.tx.executeMultiple(sql);
  }

  async commit() {
    await this.tx.commit();
  }

  async rollback() {
    await this.tx.rollback();
  }

  // Igual que CompatDb.batch pero dentro de una transaccion interactiva ya
  // abierta: varios statements en una sola llamada HTTP en vez de un
  // round-trip por cada uno.
  async batch(stmts) {
    const results = await this.tx.batch(stmts.map((s) => ({ sql: s.sql, args: s.args || [] })));
    return results.map((result) => ({
      changes: result.rowsAffected,
      lastInsertRowid: normalizeId(result.lastInsertRowid),
      rows: result.rows ? result.rows.map((row) => rowToObject(result.columns, row)) : [],
    }));
  }

  close() {
    this.tx.close();
  }
}

class CompatDb {
  constructor(client) {
    this.client = client;
  }

  prepare(sql) {
    return new Statement(this.client, sql);
  }

  // DDL y scripts con varios statements separados por ';' (schema.sql, las
  // migraciones que reconstruyen tablas). No se envuelve en transaccion -
  // igual que el db.exec() de node:sqlite, que tampoco lo hacia.
  async exec(sql) {
    await this.client.executeMultiple(sql);
  }

  // Transaccion interactiva: reemplaza el BEGIN/COMMIT/ROLLBACK manual con
  // db.exec() que usaba node:sqlite. Uso:
  //   const tx = await db.transaction('write');
  //   try { ... tx.prepare(sql).run(...) ...; await tx.commit(); }
  //   catch (err) { await tx.rollback(); throw err; }
  async transaction(mode = 'write') {
    const tx = await this.client.transaction(mode);
    return new CompatTx(tx);
  }

  // Ejecuta varios statements en una sola llamada HTTP en vez de un
  // round-trip de red por cada uno (contra una base remota de Turso, un bucle
  // de cientos de .run() secuenciales -como sembrar el plantel completo de la
  // liga- puede tardar minutos; en un solo batch tarda segundos). stmts es un
  // array de {sql, args}.
  async batch(stmts, mode = 'write') {
    const results = await this.client.batch(
      stmts.map((s) => ({ sql: s.sql, args: s.args || [] })),
      mode
    );
    return results.map((result) => ({
      changes: result.rowsAffected,
      lastInsertRowid: normalizeId(result.lastInsertRowid),
      rows: result.rows ? result.rows.map((row) => rowToObject(result.columns, row)) : [],
    }));
  }

  close() {
    this.client.close();
  }
}

module.exports = { CompatDb };
