// Sistema de acontecimientos y relaciones: muestra en cola los acontecimientos
// pendientes (reuniones, exigencias, polemicas, clasicos) devueltos por el
// backend, dejando que el usuario responda cada uno con sus opciones.
// Expuesto como window.checkCareerEvents(), para llamarlo desde app.js /
// match.js cada vez que pudo haber terminado un partido dirigido por el usuario.

const CE_ICONS = { reunion: '🗂️', exigencia: '📈', polemica: '🔥', clasico: '⚔️', hinchada: '📣' };

let ceQueue = [];
let ceShowing = false;

async function ceApi(path, opts) {
  const res = await window.apiFetch('/api' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de red');
  return data;
}

window.checkCareerEvents = async function checkCareerEvents() {
  try {
    const pending = await ceApi('/career-events/pending');
    if (!pending.length) return;
    ceQueue = ceQueue.concat(pending.filter((e) => !ceQueue.some((q) => q.id === e.id)));
    ceShowNext();
  } catch (err) {
    // No debe interrumpir el flujo del juego si esto falla.
    console.error('checkCareerEvents error:', err);
  }
};

function ceShowNext() {
  if (ceShowing) return;
  const event = ceQueue.shift();
  if (!event) return;
  ceShowing = true;

  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'summary-modal-backdrop ce-backdrop';
  backdrop.innerHTML = `
    <div class="summary-modal ce-modal ce-kind-${event.kind}">
      <div class="ce-tag">${CE_ICONS[event.kind] || '📋'} ${ceKindLabel(event.kind)}</div>
      <h2>${escapeHtml(event.title)}</h2>
      <p class="ce-description">${escapeHtml(event.description)}</p>
      <div class="ce-options">
        ${event.options
          .map((o, idx) => `<button class="ce-option-btn" data-option-id="${escapeHtml(o.id)}" data-idx="${idx}">${escapeHtml(o.label)}</button>`)
          .join('')}
      </div>
      <div class="ce-result" style="display:none"></div>
    </div>`;
  modalRoot.appendChild(backdrop);

  backdrop.querySelectorAll('.ce-option-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      backdrop.querySelectorAll('.ce-option-btn').forEach((b) => (b.disabled = true));
      try {
        const result = await ceApi(`/career-events/${event.id}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ optionId: btn.dataset.optionId }),
        });
        const resultEl = backdrop.querySelector('.ce-result');
        resultEl.style.display = '';
        resultEl.innerHTML = `<p>${escapeHtml(result.event.result_text)}</p><button class="close-btn ce-continue-btn">Continuar</button>`;
        backdrop.querySelector('.ce-options').style.display = 'none';
        backdrop.querySelector('.ce-continue-btn').addEventListener('click', () => {
          window.closeModal(backdrop, () => {
            ceShowing = false;
            ceShowNext();
          });
        });
        if (typeof state === 'object' && state.career) {
          state.career.board_confidence = result.career.board_confidence;
          state.career.locker_room_morale = result.career.locker_room_morale;
          state.career.fan_support = result.career.fan_support;
          state.career.manager_reputation = result.career.manager_reputation;
          if (window.renderCareerBox) window.renderCareerBox();
        }
      } catch (err) {
        alert('Error al resolver el acontecimiento: ' + err.message);
        backdrop.querySelectorAll('.ce-option-btn').forEach((b) => (b.disabled = false));
      }
    });
  });
}

document.addEventListener('click', async (e) => {
  if (!e.target.closest('.ce-history-btn')) return;
  try {
    const history = await ceApi('/career-events/history?limit=40');
    ceShowHistory(history);
  } catch (err) {
    alert('Error al cargar el historial: ' + err.message);
  }
});

// Agrupa los "kind" de acontecimientos bajo los tres indicadores permanentes,
// para que el historial se pueda filtrar al pulsar cada barra (dirigencia,
// hinchada o camarín) en vez de mostrar siempre todo mezclado.
const RELATION_KIND_GROUPS = {
  dirigencia: ['reunion', 'exigencia'],
  hinchada: ['hinchada'],
  camarin: ['polemica'],
};

window.ceShowHistoryFiltered = async function ceShowHistoryFiltered(groupKey, groupLabel) {
  try {
    const history = await ceApi('/career-events/history?limit=80');
    const kinds = RELATION_KIND_GROUPS[groupKey];
    const filtered = kinds ? history.filter((e) => kinds.includes(e.kind)) : history;
    ceShowHistory(filtered, groupLabel);
  } catch (err) {
    alert('Error al cargar el historial: ' + err.message);
  }
};

function ceShowHistory(history, titleSuffix) {
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'summary-modal-backdrop ce-backdrop';
  const itemsHtml = history.length
    ? history
        .map(
          (e) => `<li>
            <span class="ev-season">${CE_ICONS[e.kind] || ''} ${e.season_year}</span>
            <strong>${escapeHtml(e.title)}</strong>
            ${e.status === 'resuelto' ? `<div style="color:var(--text-dim);font-size:12px;margin-top:2px">${escapeHtml(e.result_text || '')}</div>` : '<div style="color:var(--text-dim);font-size:12px;margin-top:2px">Pendiente de respuesta</div>'}
          </li>`
        )
        .join('')
    : '<div class="empty-state">Todavía no hay acontecimientos registrados en esta carrera.</div>';

  backdrop.innerHTML = `
    <div class="summary-modal">
      <h2>Historial de acontecimientos${titleSuffix ? ' · ' + escapeHtml(titleSuffix) : ''}</h2>
      <ul class="event-list">${itemsHtml}</ul>
      <button class="close-btn" id="close-ce-history">Cerrar</button>
    </div>`;
  modalRoot.appendChild(backdrop);
  document.getElementById('close-ce-history').addEventListener('click', () => window.closeModal(backdrop));
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) window.closeModal(backdrop);
  });
}

function ceKindLabel(kind) {
  return (
    {
      reunion: 'Reunión con la dirigencia',
      exigencia: 'Exigencia de la dirigencia',
      polemica: 'Polémica interna',
      clasico: 'Clásico',
      hinchada: 'Acontecimiento de la hinchada',
    }[kind] || kind
  );
}
