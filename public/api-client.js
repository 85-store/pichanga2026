// Capa compartida de autenticacion (Firebase Auth) + fetch autenticado. Todas
// las llamadas al backend pasan por window.apiFetch en vez de fetch() directo,
// asi el token y el slot activo se agregan en un solo lugar (antes, con el
// motor de un solo usuario, no hacia falta nada de esto).
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// Slot de la partida activa (lo fija title.js al cargar/crear/continuar una
// partida). Los pedidos a /api y /api/match lo necesitan como header
// X-Save-Slot; /api/saves no, porque el slot va en la URL de esas rutas.
window.currentSlot = null;

let currentUser;
let authHasFired = false;
// Firebase puede avisar el estado de sesion mas de una vez (al cargar la
// pagina, y de nuevo cada vez que se loguea/desloguea), asi que esto es una
// suscripcion (auth.js y title.js se anotan los dos), no una promesa de una
// sola vez - si no, quien se hubiera "perdido" el aviso inicial (por ejemplo
// title.js, que lo necesita recien despues del login) nunca se enteraria.
const authListeners = [];
window.onAuthStateChange = function onAuthStateChange(cb) {
  authListeners.push(cb);
  if (authHasFired) cb(currentUser);
};

auth.onAuthStateChanged((user) => {
  currentUser = user;
  authHasFired = true;
  authListeners.forEach((cb) => cb(user));
});

window.getCurrentUser = () => currentUser;
window.signIn = (email, password) => auth.signInWithEmailAndPassword(email, password);
window.signUp = (email, password) => auth.createUserWithEmailAndPassword(email, password);
window.signOutUser = () => auth.signOut();

window.apiFetch = async function apiFetch(url, opts = {}) {
  if (!currentUser) throw new Error('No hay sesión iniciada.');
  const token = await currentUser.getIdToken();
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  if (window.currentSlot) headers['X-Save-Slot'] = String(window.currentSlot);
  return fetch(url, { ...opts, headers });
};
