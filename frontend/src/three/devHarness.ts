// Banc d'essai local (non deploye) : charge un voisinage reel via Overpass et
// monte la scene 3D dans un canvas plein ecran, pour inspecter le rendu sans
// passer par la carte. Coordonnees surchargeables : ?lat=..&lng=..&nom=..
import { fetchNeighborhood } from '../data/overpass';
import { renderLegendIcons, startScene3D, type LegendKind } from './scene3d';

const q = new URLSearchParams(location.search);
const lat = parseFloat(q.get('lat') ?? '46.12640');
const lng = parseFloat(q.get('lng') ?? '3.42560');
const nom = q.get('nom') ?? 'Grand Marché de Vichy';

const canvas = document.getElementById('c') as HTMLCanvasElement;

// ?icons=1 : planche de contact des vignettes de legende, pour verifier d'un
// coup d'oeil que chaque objet se rend et se cadre correctement.
if (q.get('icons') === '1') {
  const kinds: LegendKind[] = [
    'target', 'building', 'entrance-yes', 'entrance-no', 'entrance-other',
    'sidewalk', 'footway', 'crossing', 'road', 'steps', 'steps-ramp', 'kerb-low',
    'bench', 'bus_stop', 'bus_route', 'parking-pmr', 'parking', 'tree',
    'fire_hydrant', 'street_cabinet', 'water', 'bollard', 'lamp', 'waste',
    'toilets', 'elevator', 'barrier', 'route',
  ];
  const icons = renderLegendIcons(kinds);
  canvas.remove();
  const sheet = document.createElement('div');
  sheet.style.cssText =
    'display:grid;grid-template-columns:repeat(7,1fr);gap:8px;padding:16px;background:#12161c;color:#eaf0f7;font:12px system-ui';
  sheet.innerHTML = kinds
    .map(
      (k) =>
        `<figure style="margin:0;text-align:center"><img src="${icons[k] ?? ''}" width="72" height="72" alt=""><figcaption>${k}${
          icons[k] ? '' : ' ⚠️'
        }</figcaption></figure>`
    )
    .join('');
  document.body.appendChild(sheet);
  document.title = 'icons-prets';
  console.log(
    'vignettes manquantes',
    kinds.filter((k) => !icons[k])
  );

} else {
  fetchNeighborhood(lng, lat, 100)
    .then((neighborhood) => {
      startScene3D(canvas, { place: { nom, lng, lat }, neighborhood });
      // Repere pour la capture automatisee.
      document.title = 'scene-prete';
      console.log('scene prete', {
        batiments: neighborhood.buildings.length,
        chemins: neighborhood.paths.length,
        places: neighborhood.parking.length,
        arrets: neighborhood.busStops.length,
        lignes: neighborhood.busRoutes.length,
        mobilier: neighborhood.furniture.length,
        bordures: neighborhood.kerbs.length,
      });
    })
    .catch((e) => {
      document.title = 'scene-erreur';
      console.error(e);
    });
}
