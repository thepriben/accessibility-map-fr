/**
 * Repli cartographique de la vue 3D.
 *
 * OpenStreetMap ne décrit pas partout le voisinage immédiat : sans bâtiment ni
 * cheminement, la scène 3D serait un sol vide, ce qui laisse croire à une
 * panne. On affiche alors une carte 2D zoomée sur le lieu, qui reste utile pour
 * se repérer, et on dit franchement pourquoi la 3D n'est pas disponible.
 */
import maplibregl, { type Map as MlMap } from 'maplibre-gl';
import { MAP_ATTRIBUTION } from '../config';
import { baseStyle } from '../map/style';
import type { NeighborhoodData } from '../data/overpass';

const HOST_ID = 'scene3d-flat';

let map: MlMap | null = null;

/**
 * Vrai quand il n'y a rien à construire en 3D : ni bâtiment, ni cheminement.
 * Le reste du mobilier seul (un banc isolé) ne fait pas une scène lisible.
 */
export function isNeighborhoodEmpty(nb: NeighborhoodData): boolean {
  return (nb.buildings?.length ?? 0) === 0 && (nb.paths?.length ?? 0) === 0;
}

/**
 * Affiche la carte 2D de repli à la place de la vue 3D. `parent` est le
 * conteneur du canvas 3D : on reste ainsi dans le même contexte d'empilement,
 * sous la barre d'action qui porte le bouton de retour.
 */
export function showFlatFallback(
  place: { nom: string; lng: number; lat: number },
  parent: HTMLElement
): void {
  hideFlatFallback();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.className = 'scene3d-flat';
  // L'explication est portée par la barre de la vue (voir `sceneUiHtml`) : posée
  // sur la carte, elle passait sous les attributions ou sous la barre.
  host.innerHTML = `<div class="scene3d-flat-map" id="${HOST_ID}-map"></div>`;
  parent.appendChild(host);

  map = new maplibregl.Map({
    container: `${HOST_ID}-map`,
    style: baseStyle('light'),
    center: [place.lng, place.lat],
    zoom: 18,
    attributionControl: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: MAP_ATTRIBUTION }));
  // En bas à gauche : le haut est pris par la barre de la vue, et la droite
  // par la fiche du lieu quand elle est ouverte.
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');

  // Repere du lieu vise, dans l'orange deja utilise par la 3D.
  new maplibregl.Marker({ color: '#ef8b4e' })
    .setLngLat([place.lng, place.lat])
    .setPopup(new maplibregl.Popup({ closeButton: false }).setText(place.nom))
    .addTo(map);
}

/** Retire la carte de repli et libère ses ressources. */
export function hideFlatFallback(): void {
  map?.remove();
  map = null;
  document.getElementById(HOST_ID)?.remove();
}
