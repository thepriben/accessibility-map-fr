import maplibregl, { type Map as MlMap, type Popup } from 'maplibre-gl';
import { knownCriteria } from '../a11y';
import { prefetchNeighborhood } from '../data/overpass';
import type { Place } from '../types';

let popup: Popup | null = null;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

export interface PopupHandlers {
  onEnter3D: (place: Place) => void;
  onDetails: (place: Place) => void;
}

/** Affiche un popup carto avec les infos Acceslibre du lieu + actions (3D / fiche). */
export function showPlacePopup(
  map: MlMap,
  place: Place,
  handlers: PopupHandlers,
  note?: string
): void {
  const p = place.properties;
  // Precharge le voisinage : l'entree en 3D depuis ce popup sera quasi instantanee.
  prefetchNeighborhood(place.lng, place.lat);
  const crit = knownCriteria(p).slice(0, 6);
  const badges = crit.length
    ? crit
        .map(
          (c) =>
            `<span class="ppop-badge ${c.value ? 'badge-ok' : 'badge-no'}">${
              c.value ? '✓' : '✗'
            } ${esc(c.label)}</span>`
        )
        .join('')
    : '<span class="muted">Peu d\'informations d\'accessibilité renseignées.</span>';

  const loc = [p.commune, p.code_postal].filter(Boolean).join(' ');
  const sub = [p.activite, loc].filter(Boolean).join(' · ');

  const el = document.createElement('div');
  el.className = 'ppop';
  el.innerHTML = `
    ${note ? `<p class="ppop-note">${esc(note)}</p>` : ''}
    <h3 class="ppop-title">${esc(p.nom)}</h3>
    ${sub ? `<p class="ppop-sub">${esc(sub)}</p>` : ''}
    <div class="ppop-badges">${badges}</div>
    <div class="ppop-actions">
      <button type="button" class="ppop-btn ppop-3d">Voisinage en 3D</button>
      <button type="button" class="ppop-btn ppop-details">Fiche détaillée</button>
    </div>`;

  el.querySelector('.ppop-3d')?.addEventListener('click', () => handlers.onEnter3D(place));
  el.querySelector('.ppop-details')?.addEventListener('click', () => handlers.onDetails(place));

  popup?.remove();
  popup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px', offset: 14 })
    .setLngLat([place.lng, place.lat])
    .setDOMContent(el)
    .addTo(map);
}

export function closePlacePopup(): void {
  popup?.remove();
  popup = null;
}
