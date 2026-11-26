// Verifica el ID token de Firebase que manda el frontend en cada request
// (header "Authorization: Bearer <token>") y deja el uid del usuario en
// req.uid. No hay sesiones de servidor: el token lo valida Firebase Admin en
// cada pedido (stateless, apto para serverless/Vercel).
//
// firebase-admin@14 cambio a la API modular (initializeApp/cert desde
// 'firebase-admin/app', getAuth desde 'firebase-admin/auth'); ya no existe
// el namespace viejo admin.credential/admin.auth() del paquete raiz.
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

let app = null;

function getFirebaseApp() {
  if (app) return app;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Vercel guarda los \n del PEM como texto literal; hay que convertirlos de
  // vuelta a saltos de linea reales para que el SDK pueda parsear la clave.
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Faltan credenciales de Firebase Admin (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) en el entorno.'
    );
  }
  app = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
  return app;
}

// Middleware Express: exige un Authorization: Bearer <idToken> valido y deja
// req.uid con el uid del usuario autenticado. Responde 401 si falta o es
// invalido/expirado.
function requireAuth() {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const match = header.match(/^Bearer (.+)$/);
      if (!match) return res.status(401).json({ error: 'Falta el token de autenticación.' });

      const decoded = await getAuth(getFirebaseApp()).verifyIdToken(match[1]);
      req.uid = decoded.uid;
      next();
    } catch (err) {
      // Se loguea el motivo real server-side (puede ser un token vencido,
      // pero tambien un error de configuracion del SDK) sin exponerlo al
      // cliente, que siempre recibe el mismo 401 generico.
      console.error('requireAuth:', err.message);
      res.status(401).json({ error: 'Token de autenticación inválido o expirado.' });
    }
  };
}

module.exports = { requireAuth, getFirebaseApp };
