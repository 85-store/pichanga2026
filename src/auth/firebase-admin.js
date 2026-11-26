// Verifica el ID token de Firebase que manda el frontend en cada request
// (header "Authorization: Bearer <token>") y deja el uid del usuario en
// req.uid. No hay sesiones de servidor: el token lo valida Firebase Admin en
// cada pedido (stateless, apto para serverless/Vercel).
const admin = require('firebase-admin');

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
  app = admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
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

      const decoded = await admin.auth(getFirebaseApp()).verifyIdToken(match[1]);
      req.uid = decoded.uid;
      next();
    } catch (err) {
      res.status(401).json({ error: 'Token de autenticación inválido o expirado.' });
    }
  };
}

module.exports = { requireAuth, getFirebaseApp };
