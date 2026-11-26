// Calculo de edad en base a la fecha de nacimiento y el anio de la temporada actual.
function ageInSeason(birthDate, seasonYear) {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  // Se asume que la temporada corre durante el anio calendario `seasonYear`;
  // la edad reportada es la que el jugador cumple (o ya tiene) ese anio.
  return seasonYear - birth.getFullYear();
}

module.exports = { ageInSeason };
