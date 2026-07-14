import { OVERPASS_API } from '../config';

// Miroirs Overpass : le principal est souvent sature/limite. On bascule sur un
// miroir en cas d'echec ou de timeout pour fiabiliser l'entree en 3D.
const OVERPASS_ENDPOINTS = [
  OVERPASS_API,
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

/**
 * POST Overpass en interrogeant TOUS les miroirs en parallele : on garde la
 * premiere reponse valide (le miroir le plus rapide gagne). Reduit fortement
 * la latence percue avant l'entree en 3D.
 */
async function overpassFetch(query: string, timeoutMs = 15000): Promise<any> {
  const body = 'data=' + encodeURIComponent(query);
  const attempts = OVERPASS_ENDPOINTS.map((url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctrl.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
        return res.json();
      })
      .finally(() => clearTimeout(timer));
  });
  try {
    return await Promise.any(attempts);
  } catch {
    throw new Error('Overpass indisponible');
  }
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
  kind: 'sidewalk' | 'footway' | 'park' | 'road' | 'crossing';
  coords: [number, number][];
  /** Largeur indicative (m) pour le rendu, surtout utile pour les routes. */
  width?: number;
}

/** Place de stationnement PMR (handicapé). */
export interface OsmParking {
  id: string;
  lng: number;
  lat: number;
  pmr: boolean;
}

/** Parking surfacique (amenity=parking) : empreinte au sol à matérialiser. */
export interface OsmParkingArea {
  id: string;
  ring: [number, number][];
  pmr: boolean;
}

/** Arrêt de bus : nom de l'arrêt + ligne(s) desservie(s) si connus. */
export interface OsmBusStop {
  id: string;
  lng: number;
  lat: number;
  name: string | null;
  line: string | null;
}

/** Banc : on récupère au mieux la couleur et la présence de dossier (OSM). */
export interface OsmBench {
  id: string;
  lng: number;
  lat: number;
  backrest: boolean | null;
  colour: string | null;
  material: string | null;
}

export interface NeighborhoodData {
  center: { lng: number; lat: number };
  buildings: OsmBuilding[];
  furniture: OsmFurniture[];
  pois: OsmPoi[];
  paths: OsmPath[];
  parking: OsmParking[];
  parkingAreas: OsmParkingArea[];
  busStops: OsmBusStop[];
  benches: OsmBench[];
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

function parseBool(v: unknown): boolean | null {
  if (v === 'yes' || v === 'true') return true;
  if (v === 'no' || v === 'false') return false;
  return null;
}

/** Centroïde simple d'une liste de points {lon,lat} (moyenne). */
function centroid(geom: { lon: number; lat: number }[]): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const g of geom) {
    sx += g.lon;
    sy += g.lat;
  }
  return [sx / geom.length, sy / geom.length];
}

/** Largeur de chaussée indicative (m) selon la classe de route OSM. */
function roadWidth(highway: string | undefined): number | null {
  switch (highway) {
    case 'motorway':
    case 'trunk':
      return 10;
    case 'primary':
      return 8;
    case 'secondary':
      return 7;
    case 'tertiary':
      return 6;
    case 'unclassified':
    case 'residential':
      return 5;
    case 'living_street':
    case 'road':
      return 4.5;
    case 'service':
      return 3.2;
    default:
      return null;
  }
}

/** Vrai si la place de stationnement est réservée PMR (handicapé). */
function isDisabledParking(tags: Record<string, string>): boolean {
  return (
    tags.parking_space === 'disabled' ||
    tags.wheelchair === 'yes' ||
    tags.wheelchair === 'designated' ||
    tags.disabled === 'yes' ||
    tags.capacity_disabled != null
  );
}

// Cache mémoire : évite de re-télécharger le voisinage (entrée 3D instantanée
// après survol/sélection). Clé = coordonnées arrondies + rayon.
const cache = new Map<string, Promise<NeighborhoodData>>();
function cacheKey(lng: number, lat: number, r: number): string {
  return `${lng.toFixed(5)},${lat.toFixed(5)},${r}`;
}

/** Distance approximative (mètres) entre deux points. */
function distM(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * 111320;
  const dLng = (lng2 - lng1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

/**
 * Réutilise un voisinage déjà en cache si son centre est assez proche : le point
 * demandé reste alors bien à l'intérieur de l'emprise déjà téléchargée. Utile
 * quand on sort d'un lieu 3D pour en explorer un autre juste à côté.
 */
function reuseNearbyCached(
  lng: number,
  lat: number,
  r: number
): Promise<NeighborhoodData> | null {
  for (const [key, val] of cache) {
    const parts = key.split(',');
    const clng = parseFloat(parts[0]);
    const clat = parseFloat(parts[1]);
    const cr = parseFloat(parts[2]);
    if (cr !== r) continue;
    if (distM(lng, lat, clng, clat) <= r * 0.4) return val;
  }
  return null;
}

/** Lance (sans attendre) la récupération du voisinage pour le mettre en cache. */
export function prefetchNeighborhood(lng: number, lat: number, radiusM = 100): void {
  const key = cacheKey(lng, lat, radiusM);
  if (!cache.has(key) && !reuseNearbyCached(lng, lat, radiusM)) {
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
  radiusM = 100
): Promise<NeighborhoodData> {
  const key = cacheKey(lng, lat, radiusM);
  const hit = cache.get(key);
  if (hit) return hit;
  const near = reuseNearbyCached(lng, lat, radiusM);
  if (near) return near;
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
  // Batiments + cheminements pietons + mobilier utile (places PMR, arrets de
  // bus, bancs). Les autres POI seront reintroduits plus tard si besoin.
  const query = `[out:json][timeout:25];
    (
      way["building"](${b});
      way["highway"="footway"](${b});
      way["footway"="sidewalk"](${b});
      way["footway"="crossing"](${b});
      way["highway"="pedestrian"](${b});
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|road)$"](${b});
      node["amenity"="bench"](${b});
      node["highway"="bus_stop"](${b});
      node["public_transport"="platform"](${b});
      node["amenity"="parking_space"](${b});
      way["amenity"="parking_space"](${b});
      way["amenity"="parking"](${b});
    );
    out geom tags;`;

  const data = await overpassFetch(query);

  const out: NeighborhoodData = {
    center: { lng, lat },
    buildings: [],
    furniture: [],
    pois: [],
    paths: [],
    parking: [],
    parkingAreas: [],
    busStops: [],
    benches: [],
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

    // Parking surfacique (amenity=parking) : empreinte au sol (way ferme).
    if (
      el.type === 'way' &&
      tags.amenity === 'parking' &&
      Array.isArray(el.geometry) &&
      el.geometry.length >= 3
    ) {
      out.parkingAreas.push({
        id: `w${el.id}`,
        ring: el.geometry.map((g: any) => [g.lon, g.lat] as [number, number]),
        pmr: isDisabledParking(tags),
      });
    }

    // Coordonnees ponctuelles (node -> lon/lat ; way -> center ou centroide).
    const pos: [number, number] | null =
      el.type === 'node'
        ? [el.lon, el.lat]
        : el.center
        ? [el.center.lon, el.center.lat]
        : Array.isArray(el.geometry) && el.geometry.length
        ? centroid(el.geometry)
        : null;

    const eid = `${el.type[0]}${el.id}`;

    // POI d'accueil (node ou way : restaurant, hotel, culte peuvent etre des ways).
    const poi = poiKind(tags);
    if (poi && pos) {
      out.pois.push({ id: eid, kind: poi, lng: pos[0], lat: pos[1], name: tags.name || null });
    }

    // Place de stationnement PMR (handicapé) : node ou way (surface).
    if (tags.amenity === 'parking_space' && pos && isDisabledParking(tags)) {
      out.parking.push({ id: eid, lng: pos[0], lat: pos[1], pmr: true });
    }

    if (el.type === 'node') {
      // Arret de bus : nom de l'arret + ligne(s) si disponibles.
      if (tags.highway === 'bus_stop' || (tags.public_transport === 'platform' && tags.bus === 'yes')) {
        out.busStops.push({
          id: eid,
          lng: el.lon,
          lat: el.lat,
          name: tags.name || null,
          line: tags.route_ref || tags.ref || null,
        });
      }

      // Banc : couleur / dossier / materiau au mieux (tags OSM).
      if (tags.amenity === 'bench') {
        out.benches.push({
          id: eid,
          lng: el.lon,
          lat: el.lat,
          backrest: parseBool(tags.backrest),
          colour: tags.colour || tags.color || null,
          material: tags.material || null,
        });
      }

      // Mobilier / obstacles / points d'eau (nodes).
      const kind = furnitureKind(tags);
      if (kind) out.furniture.push({ id: `n${el.id}`, kind, lng: el.lon, lat: el.lat });
    }

    // Cheminements pietons (footway / trottoir / parc) et routes carrossables.
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      let kind: OsmPath['kind'] | null = null;
      let width: number | undefined;
      const rw = roadWidth(tags.highway);
      if (tags.footway === 'crossing') kind = 'crossing';
      else if (tags.footway === 'sidewalk') kind = 'sidewalk';
      else if (tags.highway === 'footway' || tags.highway === 'pedestrian') kind = 'footway';
      else if (rw != null) {
        kind = 'road';
        width = tags.width ? toNum(tags.width) ?? rw : rw;
      } else if (tags.leisure === 'park') kind = 'park';
      if (kind) {
        out.paths.push({
          id: `w${el.id}`,
          kind,
          width,
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
