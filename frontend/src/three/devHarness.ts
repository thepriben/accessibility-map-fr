// Banc d'essai local (non deploye) : charge un voisinage reel via Overpass et
// monte la scene 3D dans un canvas plein ecran, pour inspecter le rendu sans
// passer par la carte. Coordonnees surchargeables : ?lat=..&lng=..&nom=..
import { fetchNeighborhood } from '../data/overpass';
import { startScene3D } from './scene3d';

const q = new URLSearchParams(location.search);
const lat = parseFloat(q.get('lat') ?? '46.12640');
const lng = parseFloat(q.get('lng') ?? '3.42560');
const nom = q.get('nom') ?? 'Grand Marché de Vichy';

const canvas = document.getElementById('c') as HTMLCanvasElement;

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
