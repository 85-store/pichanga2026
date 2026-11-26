// Utilidades de azar reutilizables por el motor de simulacion.
function chance(probability) {
  return Math.random() < probability;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function weightedPick(options) {
  // options: [{ value, weight }]
  const total = options.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  for (const o of options) {
    if (r < o.weight) return o.value;
    r -= o.weight;
  }
  return options[options.length - 1].value;
}

module.exports = { chance, pick, randInt, weightedPick };
