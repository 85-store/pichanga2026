// Panel de MEDIOS: presentacion al estilo de los programas de analisis del
// futbol chileno, con dos panelistas de opinion fija que comentan los
// partidos y fichajes del club que dirige el usuario. Todo el texto viene
// del backend (src/engine/media.js), ya generado por plantillas de la
// simulacion y siempre acompañado de su aviso de "opinión ficticia" - este
// archivo solo se encarga de mostrarlo con el formato de debate en pantalla.

const MEDIOS_KIND_LABEL = { partido: '⚽ Partido', fichaje: '🖊️ Fichaje' };

function mediosPersonaCardHtml(persona, text) {
  return `
    <div class="medios-take medios-take--${escapeHtml(persona.key)}">
      <img class="medios-photo" src="medios/${escapeHtml(persona.photo.split('/').pop())}" alt="${escapeHtml(persona.name)}"
           onerror="this.src='';this.classList.add('medios-photo--missing')">
      <div class="medios-take-body">
        <div class="medios-take-name">${escapeHtml(persona.name)}</div>
        <div class="medios-take-role">${escapeHtml(persona.role)}</div>
        <p class="medios-take-text">“${escapeHtml(text)}”</p>
      </div>
    </div>`;
}

function mediosCommentCardHtml(comment, personasByKey) {
  const borghi = personasByKey.borghi;
  const tezanos = personasByKey.tezanos;
  return `
    <div class="medios-card">
      <div class="medios-card-header">
        <span class="medios-kind-badge">${MEDIOS_KIND_LABEL[comment.kind] || comment.kind}</span>
        <span class="medios-headline">${escapeHtml(comment.headline)}</span>
      </div>
      <div class="medios-debate">
        ${mediosPersonaCardHtml(borghi, comment.borghi_text)}
        <div class="medios-vs">VS</div>
        ${mediosPersonaCardHtml(tezanos, comment.tezanos_text)}
      </div>
      <div class="medios-disclaimer">⚠️ ${escapeHtml(comment.disclaimer)}</div>
    </div>`;
}

async function renderMediosView() {
  mainView.innerHTML = '<div class="empty-state">Cargando…</div>';
  try {
    const data = await api('/media');
    const personasByKey = Object.fromEntries(data.personas.map((p) => [p.key, p]));

    const header = `
      <div class="view-header">
        <div>
          <h1>📺 Medios</h1>
          <div class="sub">Panel de análisis con Claudio Borghi y Manuel de Tezanos</div>
        </div>
        <img class="medios-tnt-logo" src="medios/tnt-logo.png" alt="TNT" onerror="this.style.display='none'">
      </div>
      <div class="medios-disclaimer medios-disclaimer--top">
        Este panel es un segmento ficticio de la simulación Pichanga 2026. Las opiniones que se muestran aquí
        son generadas por el juego a partir de los resultados, fichajes y decisiones de tu carrera; no son
        declaraciones reales de Claudio Borghi ni de Manuel de Tezanos.
      </div>`;

    if (!data.comments.length) {
      mainView.innerHTML = `${header}<div class="empty-state">Todavía no hay comentarios. Juega algunos partidos o
        cierra algún fichaje para que el panel tenga algo de qué hablar.</div>`;
      return;
    }

    mainView.innerHTML = `${header}
      <div class="medios-feed">
        ${data.comments.map((c) => mediosCommentCardHtml(c, personasByKey)).join('')}
      </div>`;
  } catch (e) {
    mainView.innerHTML = `<div class="empty-state">Error al cargar Medios: ${escapeHtml(e.message)}</div>`;
  }
}
