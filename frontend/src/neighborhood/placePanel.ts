import { knownCriteria } from '../a11y';
import { fetchNeighborhood, type NeighborhoodData } from '../data/overpass';
import { fetchNearbyPhotos } from '../imagery/imagery';
import { flyToPlace } from '../map/mapView';
import { state } from '../state';
import { buildScenePayload, enterScene3D } from '../transition/transition';
import type { Place, StreetPhoto } from '../types';

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

  // Chargement parallele voisinage + imagerie (a la demande).
  const [neighborhood, photos] = await Promise.all([
    fetchNeighborhood(place.lng, place.lat, 90).catch(() => null),
    fetchNearbyPhotos(place.lng, place.lat, 120).catch(() => [] as StreetPhoto[]),
  ]);

  renderImagery(panel, photos);
  renderNeighborhoodSummary(panel, neighborhood);
  wire3DButton(panel, place, neighborhood, photos);
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

    <h3 class="panel-sub">Imagerie de rue à proximité</h3>
    <div id="panel-imagery" class="panel-imagery"><p class="muted">Recherche Panoramax / Mapillary...</p></div>

    <h3 class="panel-sub">Voisinage (30 derniers mètres)</h3>
    <div id="panel-neighborhood" class="panel-neighborhood"><p class="muted">Chargement OSM...</p></div>

    <div id="panel-3d" class="panel-3d"></div>`;
}

function renderImagery(panel: HTMLElement, photos: StreetPhoto[]): void {
  const el = panel.querySelector('#panel-imagery');
  if (!el) return;
  if (!photos.length) {
    el.innerHTML = '<p class="muted">Aucune photo de rue trouvée à proximité.</p>';
    return;
  }
  const items = photos
    .slice(0, 12)
    .map((ph) => {
      const az = ph.azimuth != null ? ` (${Math.round(ph.azimuth)}&deg;)` : '';
      const label = `${ph.provider}${az}`;
      const inner = ph.thumbUrl
        ? `<img src="${esc(ph.thumbUrl)}" alt="Photo ${esc(ph.provider)}" loading="lazy">`
        : `<span class="thumb-ph">${esc(ph.provider)}</span>`;
      return `<a class="imagery-thumb imagery-${ph.provider}" href="${esc(
        ph.sourceUrl
      )}" target="_blank" rel="noopener" title="${esc(label)}">${inner}</a>`;
    })
    .join('');
  el.innerHTML = `<div class="imagery-grid">${items}</div>
    <p class="muted">${photos.length} photo(s) &middot; Panoramax et Mapillary</p>`;
}

function renderNeighborhoodSummary(panel: HTMLElement, nb: NeighborhoodData | null): void {
  const el = panel.querySelector('#panel-neighborhood');
  if (!el) return;
  if (!nb) {
    el.innerHTML = '<p class="muted">Voisinage OSM indisponible.</p>';
    return;
  }
  const byKind = nb.furniture.reduce<Record<string, number>>((acc, f) => {
    acc[f.kind] = (acc[f.kind] || 0) + 1;
    return acc;
  }, {});
  const labels: Record<string, string> = {
    bench: 'bancs',
    bus_stop: 'arrêts de bus',
    fountain: 'fontaines',
    tree: 'arbres',
    crossing: 'passages piétons',
  };
  const chips = [
    `${nb.buildings.length} bâtiments`,
    ...Object.entries(byKind).map(([k, n]) => `${n} ${labels[k] || k}`),
    `${nb.paths.length} cheminements/parcs`,
  ]
    .map((t) => `<span class="chip">${esc(t)}</span>`)
    .join('');
  el.innerHTML = `<div class="chip-row">${chips}</div>`;
}

function wire3DButton(
  panel: HTMLElement,
  place: Place,
  nb: NeighborhoodData | null,
  photos: StreetPhoto[]
): void {
  const el = panel.querySelector('#panel-3d');
  if (!el || !nb) return;
  el.innerHTML =
    '<button id="btn-3d" type="button" class="btn-3d">Explorer le voisinage en 3D</button>' +
    '<p class="muted">Vue 3D sobre (Bevy/WASM). La liste accessible reste l\'alternative textuelle.</p>';
  el.querySelector('#btn-3d')?.addEventListener('click', async () => {
    const btn = el.querySelector('#btn-3d') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Chargement de la 3D...';
    const ok = await enterScene3D(buildScenePayload(place, nb, photos));
    btn.disabled = false;
    btn.textContent = ok ? 'Explorer le voisinage en 3D' : '3D indisponible (build WASM requis)';
  });
}

/**
 * Entree 3D directe (sans passer par le bouton) : recupere voisinage + imagerie
 * puis bascule. Utilisee par la bascule automatique de proximite.
 */
export async function autoEnter3D(place: Place): Promise<boolean> {
  const [neighborhood, photos] = await Promise.all([
    fetchNeighborhood(place.lng, place.lat, 90).catch(() => null),
    fetchNearbyPhotos(place.lng, place.lat, 120).catch(() => [] as StreetPhoto[]),
  ]);
  if (!neighborhood) return false;
  return enterScene3D(buildScenePayload(place, neighborhood, photos));
}
