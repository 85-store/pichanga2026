// Entrypoint de Vercel (convencion: todo archivo bajo /api es una funcion
// serverless). Solo exporta la app de Express ya armada - server.js la usa
// con .listen() para correr local, pero en Vercel no hay que levantar un
// puerto: cada pedido se invoca por separado.
const { buildApp } = require('../src/server');

module.exports = buildApp();
