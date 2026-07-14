import { knownCriteria } from '../a11y';
import { fetchNeighborhood, type NeighborhoodData } from '../data/overpass';
import { flyToPlace } from '../map/mapView';
import { state } from '../state';
import { buildScenePayload, enterScene3D, prefetchScene3D } from '../transition/transition';
import { hideLoader, showLoader } from '../ui/loader';
import type { Place } from '../types';

/** Rayon du voisinage exploré autour du lieu. */
const NEIGHBORHOOD_RADIUS_M = 100;

/** Voisinage vide (repli) : la 3D s'ouvre quand meme, centree sur le lieu. */
function emptyNeighborhood(place: Place): NeighborhoodData {
  return {
    center: { lng: place.lng, lat: place.lat },
    buildings: [],
    furniture: [],
    pois: [],
    paths: [],
    parking: [],
    parkingAreas: [],
    busStops: [],
    benches: [],
  };
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

/** Ouvre la fiche d'un lieu : criteres, voisinage OSM, imagerie de rue, bouton 3D. */
export async function openPlacePanel(place: Place): Promise<void> {
  const panel = document.getElementById('place-panel');
  if (!panel) return;
  state.setSelected(place.properties.uuid);
  flyToPlace(place.lng, place.lat, 17);

  panel.hidden = false;
  panel.innerHTML = skeleton(place);
  panel.querySelector('#panel-close')?.addEventListener('click', closePlacePanel);

  const criteria = knownCriteria(place.properties);
  const critEl = panel.querySelector('#panel-criteria');
  if (critEl) {
    critEl.innerHTML = criteria.length
      ? criteria
          .map(
            (c) =>
              `<li class="${c.value ? 'crit-ok' : 'crit-no'}">${esc(c.label)} : ${
                c.value ? 'oui' : 'non'
              }</li>`
          )
          .join('')
      : '<li>Peu d\'informations d\'accessibilité renseignées.</li>';
  }

  const neighborhood = await fetchNeighborhood(place.lng, place.lat, NEIGHBORHOOD_RADIUS_M).catch(
    () => null
  );
  wire3DButton(panel, place, neighborhood);
}

export function closePlacePanel(): void {
  const panel = document.getElementById('place-panel');
  if (panel) {
    panel.hidden = true;
    panel.innerHTML = '';
  }
  state.setSelected(null);
}

function skeleton(place: Place): string {
  const p = place.properties;
  return `
    <div class="panel-head">
      <h2 class="panel-title">${esc(p.nom)}</h2>
      <button id="panel-close" type="button" class="panel-close" aria-label="Fermer la fiche">&times;</button>
    </div>
    <p class="panel-meta">${esc([p.activite, p.adresse].filter(Boolean).join(' - '))}</p>
    ${p.web_url ? `<p><a href="${esc(p.web_url)}" target="_blank" rel="noopener">Voir sur Acceslibre &nearr;</a></p>` : ''}

    <h3 class="panel-sub">Accessibilité</h3>
    <ul id="panel-criteria" class="panel-criteria"><li>Chargement...</li></ul>

    <div id="panel-3d" class="panel-3d"></div>`;
}

function wire3DButton(
  panel: HTMLElement,
  place: Place,
  nb: NeighborhoodData | null
): void {
  const el = panel.querySelector('#panel-3d');
  if (!el || !nb) return;
  el.innerHTML =
    '<button id="btn-3d" type="button" class="btn-3d">Explorer le voisinage en 3D</button>';
  el.querySelector('#btn-3d')?.addEventListener('click', async () => {
    const btn = el.querySelector('#btn-3d') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Chargement 3D…';
    prefetchScene3D(); // charge le module 3D en parallele
    showLoader('Chargement 3D');
    const ok = await enterScene3D(buildScenePayload(place, nb, []));
    hideLoader();
    btn.disabled = false;
    btn.textContent = ok ? 'Explorer le voisinage en 3D' : '3D indisponible';
  });
}

/**
 * Entree 3D directe (sans passer par le bouton) : recupere voisinage + imagerie
 * puis bascule. Utilisee par la bascule automatique de proximite.
 */
export async function autoEnter3D(place: Place): Promise<boolean> {
  showLoader('Chargement 3D');
  prefetchScene3D(); // module 3D chargé en parallèle du voisinage (Overpass)
  try {
    const neighborhood = await fetchNeighborhood(
      place.lng,
      place.lat,
      NEIGHBORHOOD_RADIUS_M
    ).catch(() => null);
    // Si Overpass n'a rien renvoye, on bascule quand meme en 3D (voisinage vide).
    const nb = neighborhood ?? emptyNeighborhood(place);
    return await enterScene3D(buildScenePayload(place, nb, []));
  } finally {
    hideLoader();
  }
}
