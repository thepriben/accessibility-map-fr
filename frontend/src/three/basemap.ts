/**
 * Fond de carte plaqué au sol de la scène 3D.
 *
 * Au-delà du voisinage modélisé, la scène n'offrait qu'un plan uni : on perdait
 * la rue, le quartier, la direction du centre-ville. Les tuiles raster déjà
 * utilisées par la carte 2D sont assemblées en une seule image posée sur le sol,
 * évidée au centre pour laisser la 3D s'exprimer là où elle existe, et estompée
 * sur les bords pour qu'aucune arête de carré ne trahisse le procédé.
 *
 * Repère local : x = est, z = sud, en mètres depuis le lieu visé (voir
 * `projector` dans scene3d).
 */
import * as THREE from 'three';
import { BASEMAP_TILES_LIGHT } from '../config';

const TILE = 256;
const M_PER_DEG_LAT = 111320;
/** Au-delà, l'assemblage coûte plus de requêtes qu'il n'apporte de contexte. */
const MAX_TILES = 42;

const nTiles = (z: number): number => 2 ** z;

const lngToTile = (lng: number, z: number): number => ((lng + 180) / 360) * nTiles(z);

function latToTile(lat: number, z: number): number {
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * nTiles(z);
}

const tileToLng = (x: number, z: number): number => (x / nTiles(z)) * 360 - 180;

function tileToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / nTiles(z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function tileUrl(x: number, y: number, z: number): string {
  const tpl = BASEMAP_TILES_LIGHT[(x + y) % BASEMAP_TILES_LIGHT.length];
  return tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** Charge une tuile ; une tuile manquante laisse un trou, elle n'échoue pas. */
function loadTile(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export interface BasemapOptions {
  /** Demi-côté de la zone couverte, en mètres. */
  halfSize: number;
}

/**
 * Assemble le fond de carte autour du lieu et renvoie le plan à ajouter à la
 * scène, ou `null` si aucune tuile n'a pu être chargée.
 */
export async function basemapGround(
  originLng: number,
  originLat: number,
  { halfSize }: BasemapOptions
): Promise<THREE.Mesh | null> {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  const dLng = halfSize / mPerDegLng;
  const dLat = halfSize / M_PER_DEG_LAT;

  // Le niveau de zoom descend jusqu'à tenir dans le budget de tuiles. La zone
  // nette est de toute façon évidée : la périphérie tolère une image grossière.
  let z = 18;
  let x0 = 0;
  let x1 = 0;
  let y0 = 0;
  let y1 = 0;
  for (; z >= 12; z -= 1) {
    x0 = Math.floor(lngToTile(originLng - dLng, z));
    x1 = Math.floor(lngToTile(originLng + dLng, z));
    y0 = Math.floor(latToTile(originLat + dLat, z));
    y1 = Math.floor(latToTile(originLat - dLat, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) break;
  }

  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = cols * TILE;
  canvas.height = rows * TILE;
  const g = canvas.getContext('2d');
  if (!g) return null;

  const jobs: Promise<void>[] = [];
  let drawn = 0;
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      jobs.push(
        loadTile(tileUrl(x, y, z)).then((img) => {
          if (!img) return;
          g.drawImage(img, (x - x0) * TILE, (y - y0) * TILE, TILE, TILE);
          drawn += 1;
        })
      );
    }
  }
  await Promise.all(jobs);
  if (!drawn) return null;

  // Emprise exacte de l'assemblage, ramenée au repère local.
  const west = (tileToLng(x0, z) - originLng) * mPerDegLng;
  const east = (tileToLng(x1 + 1, z) - originLng) * mPerDegLng;
  const north = -(tileToLat(y0, z) - originLat) * M_PER_DEG_LAT;
  const south = -(tileToLat(y1 + 1, z) - originLat) * M_PER_DEG_LAT;
  const width = east - west;
  const depth = south - north;

  // Estompe des bords : sans elle, l'assemblage se termine par une arête de
  // carré posée sur le sol uni, qui saute aux yeux dès qu'on prend du recul.
  const px = ((0 - west) / width) * canvas.width;
  const py = ((0 - north) / depth) * canvas.height;
  const far = Math.max(
    Math.hypot(px, py),
    Math.hypot(canvas.width - px, py),
    Math.hypot(px, canvas.height - py),
    Math.hypot(canvas.width - px, canvas.height - py)
  );
  const grad = g.createRadialGradient(px, py, 0, px, py, far);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = grad;
  g.fillRect(0, 0, canvas.width, canvas.height);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      // La carte reste un arrière-plan : elle meuble les vides entre les objets
      // 3D sans prétendre au même niveau de lecture qu'eux.
      opacity: 0.88,
      // Le sol uni reste dessous : la carte s'y fond au lieu de le remplacer.
      depthWrite: false,
      // Une carte n'est pas une matière : la laisser hors du rendu tonal
      // preserve ses gris, calés sur ceux de la carte 2D.
      toneMapped: false,
    })
  );
  // Rotation à plat : le +Y du plan part vers le nord, comme le haut de l'image.
  mesh.rotation.x = -Math.PI / 2;
  // Entre le sol uni (−0,05) et la chaussée (0,03).
  mesh.position.set((west + east) / 2, -0.01, (north + south) / 2);
  return mesh;
}
