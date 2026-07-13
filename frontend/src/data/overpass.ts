import { OVERPASS_API } from '../config';

// Miroirs Overpass : le principal est souvent sature/limite. On bascule sur un
// miroir en cas d'echec ou de timeout pour fiabiliser l'entree en 3D.
const OVERPASS_ENDPOINTS = [
  OVERPASS_API,
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** POST Overpass avec timeout, en essayant chaque miroir a tour de role. */
async function overpassFetch(query: string, timeoutMs = 20000): Promise<any> {
  let lastErr: unknown = null;
  for (const url of OVERPASS_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Overpass indisponible');
}

export interface OsmBuilding {
  id: string;
  ring: [number, number][]; // anneau exterieur [lng,lat]
  levels: number | null;
  height: number | null;
  wikidata: string | null;
  name: string | null;
}

export type FurnitureKind =
  | 'bench'
  | 'bus_stop'
  | 'fountain'
  | 'tree'
  | 'crossing'
  | 'bollard'
  | 'lamp'
  | 'drinking_water'
  | 'waste';

export interface OsmFurniture {
  id: string;
  kind: FurnitureKind;
  lng: number;
  lat: number;
}

/** Lieux d'accueil (POI) : hotels, restaurants, cafes, communautaires, cultuels. */
export type PoiKind = 'hotel' | 'restaurant' | 'cafe' | 'community' | 'worship';

export interface OsmPoi {
  id: string;
  kind: PoiKind;
  lng: number;
  lat: number;
  name: string | null;
}

export interface OsmPath {
  id: string;
  kind: 'sidewalk' | 'footway' | 'park';
  coords: [number, number][];
}

export interface NeighborhoodData {
  center: { lng: number; lat: number };
  buildings: OsmBuilding[];
  furniture: OsmFurniture[];
  pois: OsmPoi[];
  paths: OsmPath[];
}

function bbox(lng: number, lat: number, radiusM: number): string {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  // Overpass attend (south,west,north,east)
  return `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Cache mémoire : évite de re-télécharger le voisinage (entrée 3D instantanée
// après survol/sélection). Clé = coordonnées arrondies + rayon.
const cache = new Map<string, Promise<NeighborhoodData>>();
function cacheKey(lng: number, lat: number, r: number): string {
  return `${lng.toFixed(5)},${lat.toFixed(5)},${r}`;
}

/** Lance (sans attendre) la récupération du voisinage pour le mettre en cache. */
export function prefetchNeighborhood(lng: number, lat: number, radiusM = 25): void {
  const key = cacheKey(lng, lat, radiusM);
  if (!cache.has(key)) {
    cache.set(
      key,
      fetchNeighborhoodRaw(lng, lat, radiusM).catch((e) => {
        cache.delete(key); // permet une nouvelle tentative
        throw e;
      })
    );
  }
}

/**
 * Recupere le voisinage OSM (rayon ~ des "30 derniers metres") : batiments,
 * mobilier, obstacles, points d'eau, trottoirs, parcs et lieux d'accueil.
 * Résultat mémoïsé.
 */
export function fetchNeighborhood(
  lng: number,
  lat: number,
  radiusM = 25
): Promise<NeighborhoodData> {
  const key = cacheKey(lng, lat, radiusM);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = fetchNeighborhoodRaw(lng, lat, radiusM).catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, p);
  return p;
}

async function fetchNeighborhoodRaw(
  lng: number,
  lat: number,
  radiusM: number
): Promise<NeighborhoodData> {
  const b = bbox(lng, lat, radiusM);
  const query = `[out:json][timeout:25];
    (
      way["building"](${b});
      node["amenity"="bench"](${b});
      node["highway"="bus_stop"](${b});
      node["public_transport"="platform"]["bus"="yes"](${b});
      node["amenity"="fountain"](${b});
      node["natural"="tree"](${b});
      node["highway"="crossing"](${b});
      node["barrier"="bollard"](${b});
      node["highway"="street_lamp"](${b});
      node["amenity"="drinking_water"](${b});
      node["amenity"="waste_basket"](${b});
      node["tourism"="hotel"](${b});
      node["amenity"="restaurant"](${b});
      way["amenity"="restaurant"](${b});
      node["amenity"~"^(cafe|bar|pub)$"](${b});
      node["amenity"~"^(community_centre|social_centre)$"](${b});
      way["amenity"~"^(community_centre|social_centre)$"](${b});
      node["amenity"="place_of_worship"](${b});
      way["amenity"="place_of_worship"](${b});
      way["footway"="sidewalk"](${b});
      way["highway"="footway"](${b});
      way["leisure"="park"](${b});
    );
    out geom tags center;`;

  const data = await overpassFetch(query);

  const out: NeighborhoodData = {
    center: { lng, lat },
    buildings: [],
    furniture: [],
    pois: [],
    paths: [],
  };

  for (const el of data.elements || []) {
    const tags = el.tags || {};

    // Batiments (way avec footprint).
    if (el.type === 'way' && tags.building && Array.isArray(el.geometry)) {
      out.buildings.push({
        id: `w${el.id}`,
        ring: el.geometry.map((g: any) => [g.lon, g.lat] as [number, number]),
        levels: toNum(tags['building:levels']),
        height: toNum(tags.height),
        wikidata: tags.wikidata || null,
        name: tags.name || null,
      });
    }

    // Coordonnees ponctuelles (node -> lon/lat ; way -> center).
    const pos: [number, number] | null =
      el.type === 'node'
        ? [el.lon, el.lat]
        : el.center
        ? [el.center.lon, el.center.lat]
        : null;

    // POI d'accueil (node ou way : restaurant, hotel, culte peuvent etre des ways).
    const poi = poiKind(tags);
    if (poi && pos) {
      out.pois.push({ id: `${el.type[0]}${el.id}`, kind: poi, lng: pos[0], lat: pos[1], name: tags.name || null });
    }

    // Mobilier / obstacles / points d'eau (nodes).
    if (el.type === 'node') {
      const kind = furnitureKind(tags);
      if (kind) out.furniture.push({ id: `n${el.id}`, kind, lng: el.lon, lat: el.lat });
    }

    // Cheminements (footway / trottoir / parc).
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      let kind: OsmPath['kind'] | null = null;
      if (tags.footway === 'sidewalk') kind = 'sidewalk';
      else if (tags.highway === 'footway') kind = 'footway';
      else if (tags.leisure === 'park') kind = 'park';
      if (kind) {
        out.paths.push({
          id: `w${el.id}`,
          kind,
          coords: el.geometry.map((g: any) => [g.lon, g.lat] as [number, number]),
        });
      }
    }
  }
  return out;
}

function furnitureKind(tags: Record<string, string>): FurnitureKind | null {
  if (tags.amenity === 'bench') return 'bench';
  if (tags.highway === 'bus_stop' || tags.public_transport === 'platform') return 'bus_stop';
  if (tags.amenity === 'fountain') return 'fountain';
  if (tags.natural === 'tree') return 'tree';
  if (tags.highway === 'crossing') return 'crossing';
  if (tags.barrier === 'bollard') return 'bollard';
  if (tags.highway === 'street_lamp') return 'lamp';
  if (tags.amenity === 'drinking_water') return 'drinking_water';
  if (tags.amenity === 'waste_basket') return 'waste';
  return null;
}

function poiKind(tags: Record<string, string>): PoiKind | null {
  if (tags.tourism === 'hotel') return 'hotel';
  if (tags.amenity === 'restaurant') return 'restaurant';
  if (tags.amenity === 'cafe' || tags.amenity === 'bar' || tags.amenity === 'pub') return 'cafe';
  if (tags.amenity === 'community_centre' || tags.amenity === 'social_centre') return 'community';
  if (tags.amenity === 'place_of_worship') return 'worship';
  return null;
}
