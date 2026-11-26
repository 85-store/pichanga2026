// Usamos el transporte "web" (HTTP puro, sin binario nativo) en vez del
// default de @libsql/client: el default carga siempre el driver nativo
// "libsql" (para el modo archivo local) aunque la conexion sea remota, y ese
// binario no abre en este Windows (falta una dependencia del sistema). El
// transporte web es exactamente el que se usa en entornos serverless/edge
// (Vercel, Cloudflare, etc.), asi que tambien es el que mas se parece a
// produccion.
const { createClient } = require('@libsql/client/web');

// Crea un cliente libSQL contra una base remota de Turso.
function createDbClient({ url, authToken } = {}) {
  if (!url) throw new Error('createDbClient necesita una url libsql://... o https://...');
  return createClient(authToken ? { url, authToken } : { url });
}

module.exports = { createDbClient };
