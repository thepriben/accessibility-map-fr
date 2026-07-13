import { knownCriteria } from '../a11y';
import { fetchNeighborhood, type NeighborhoodData } from '../data/overpass';
import { findWikidataNear, getWikidataEntity, type WikidataInfo } from '../data/wikidata';
import { flyToPlace } from '../map/mapView';
import { state } from '../state';
import { buildScenePayload, enterScene3D } from '../transition/transition';
import { hideLoader, setLoaderMessage, showLoader } from '../ui/loader';
import type { Place } from '../types';

/** Rayon du voisinage exploré autour du lieu. */
const NEIGHBORHOOD_RADIUS_M = 75;

/** Voisinage vide (repli) : la 3D s'ouvre quand meme, centree sur le lieu. */
function emptyNeighborhood(place: Place): NeighborhoodData {
  return {
    center: { lng: place.lng, lat: place.lat },
    buildings: [],
    furniture: [],
    pois: [],
    paths: [],
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
  void renderWikidata(panel, place, neighborhood);
}

/** Point-dans-polygone (ray casting) sur un anneau [lng,lat]. */
function ringContains(ring: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Cherche le bâtiment cible (contenant le point) et son éventuel QID Wikidata. */
function targetBuildingQid(nb: NeighborhoodData | null, lng: number, lat: number): string | null {
  if (!nb) return null;
  for (const b of nb.buildings) {
    if (b.wikidata && b.ring.length >= 3 && ringContains(b.ring, lng, lat)) return b.wikidata;
  }
  // À défaut, tout bâtiment du voisinage portant un QID.
  for (const b of nb.buildings) {
    if (b.wikidata) return b.wikidata;
  }
  return null;
}

/** Enrichit la fiche avec les infos Wikidata du bâtiment (si disponibles). */
async function renderWikidata(
  panel: HTMLElement,
  place: Place,
  nb: NeighborhoodData | null
): Promise<void> {
  const el = panel.querySelector('#panel-wikidata');
  if (!el) return;

  const qid = targetBuildingQid(nb, place.lng, place.lat);
  let info: WikidataInfo | null = null;
  try {
    info = qid
      ? await getWikidataEntity(qid)
      : await findWikidataNear(place.lng, place.lat);
  } catch {
    info = null;
  }

  // La fiche a pu être fermée/rouverte entre-temps : on ignore alors le résultat.
  if (!info || panel.hidden) return;

  const img = info.imageUrl
    ? `<a class="wd-photo" href="${esc(info.imageSourceUrl)}" target="_blank" rel="noopener"
         title="Voir l'original et la licence sur Wikimedia Commons">
         <img src="${esc(info.imageUrl)}" alt="Photo de ${esc(info.label ?? 'ce bâtiment')}" loading="lazy">
       </a>`
    : '';

  el.innerHTML = `
    <h3 class="panel-sub">Le bâtiment</h3>
    ${img}
    ${info.label ? `<p class="wd-name">${esc(info.label)}</p>` : ''}
    ${info.description ? `<p class="wd-desc">${esc(info.description)}</p>` : ''}
    <p class="wd-links">
      <a href="${esc(info.wikidataUrl)}" target="_blank" rel="noopener">Fiche Wikidata &nearr;</a>${
        info.imageSourceUrl
          ? ` &middot; <a href="${esc(info.imageSourceUrl)}" target="_blank" rel="noopener">Photo &amp; licence &nearr;</a>`
          : ''
      }
    </p>`;
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

    <div id="panel-wikidata" class="panel-wikidata"></div>

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
    btn.textContent = 'Chargement de la 3D...';
    showLoader('Préparation de la vue 3D…');
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
  showLoader('Chargement des bâtiments (OpenStreetMap)…');
  try {
    // Etape actuelle : batiments seuls (rapide), pas d'imagerie de rue.
    const neighborhood = await fetchNeighborhood(
      place.lng,
      place.lat,
      NEIGHBORHOOD_RADIUS_M
    ).catch(() => null);
    // Si Overpass n'a rien renvoye, on bascule quand meme en 3D (voisinage vide).
    const nb = neighborhood ?? emptyNeighborhood(place);
    setLoaderMessage('Préparation de la vue 3D…');
    return await enterScene3D(buildScenePayload(place, nb, []));
  } finally {
    hideLoader();
  }
}
