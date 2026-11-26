// Genera el calendario de una liga: todos contra todos, ida y vuelta (circle method).
function generateRoundRobin(teamIds) {
  const teams = [...teamIds];
  if (teams.length % 2 !== 0) teams.push(null); // bye si el numero de equipos es impar

  const n = teams.length;
  const roundsCount = n - 1;
  const half = n / 2;
  const rounds = [];

  let arr = [...teams];
  for (let r = 0; r < roundsCount; r++) {
    const round = [];
    for (let i = 0; i < half; i++) {
      const home = arr[i];
      const away = arr[n - 1 - i];
      if (home != null && away != null) {
        // alterna localia para repartir partidos de local/visita de forma pareja
        if (r % 2 === 0) round.push([home, away]);
        else round.push([away, home]);
      }
    }
    rounds.push(round);
    // rotacion: se fija el primer equipo, el resto rota
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr = [fixed, ...rest];
  }

  // segunda vuelta: mismos cruces con localia invertida
  const secondLeg = rounds.map((round) => round.map(([home, away]) => [away, home]));

  return [...rounds, ...secondLeg];
}

module.exports = { generateRoundRobin };
