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
function raceMirrors(body: string, timeoutMs: number): Promise<any> {
  const attempts = OVERPASS_ENDPOINTS.map((url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
        const json = await res.json();
        // Certains miroirs renvoient 200 + un `remark` d'erreur/timeout, ou une
        // reponse a 0 element (rate-limit). On rejette pour laisser un autre
        // miroir repondre : sinon un miroir "rapide mais casse" gagnerait le
        // Promise.any et la scene 3D serait vide.
        const remark = json?.remark ? String(json.remark) : '';
        if (/error|timed out|timeout|rate_?limit|too many|quota/i.test(remark)) {
          throw new Error(`Overpass remark: ${remark}`);
        }
        if (!Array.isArray(json.elements) || json.elements.length === 0) {
          throw new Error('Overpass 0 element');
        }
        return json;
      })
      .finally(() => clearTimeout(timer));
  });
  return Promise.any(attempts);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Interroge Overpass sur tous les miroirs en parallele (le plus rapide et VALIDE
 * gagne). Une seconde salve est tentee si la premiere echoue entierement, ce qui
 * fiabilise l'entree en 3D quand un lot de miroirs est momentanement sature.
 */
async function overpassFetch(query: string, timeoutMs = 15000, retries = 1): Promise<any> {
  const body = 'data=' + encodeURIComponent(query);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await raceMirrors(body, timeoutMs);
    } catch {
      if (attempt < retries) await sleep(500);
    }
  }
  throw new Error('Overpass indisponible');
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
  | 'waste'
  | 'fire_hydrant'
  | 'street_cabinet'
  | 'toilets'
  | 'elevator'
  | 'barrier';

export interface OsmFurniture {
  id: string;
  kind: FurnitureKind;
  lng: number;
  lat: number;
  /** Hauteur (m) si renseignée : surtout utile pour les arbres. */
  height?: number | null;
  /** Diamètre de couronne (m) si renseigné : arbres. */
  crown?: number | null;
  /** Sous-type OSM (ex. `fire_hydrant:type`, `barrier`, `fountain`). */
  variant?: string | null;
  /** Accessibilité fauteuil déclarée : surtout utile pour toilettes/ascenseurs. */
  wheelchair?: string | null;
  /** Nom OSM quand il existe (ascenseur, toilettes publiques…). */
  name?: string | null;
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
  kind: 'sidewalk' | 'footway' | 'park' | 'road' | 'crossing' | 'steps';
  coords: [number, number][];
  /** Largeur indicative (m) pour le rendu, surtout utile pour les routes. */
  width?: number;
  /** Revêtement OSM (asphalt, pavé, gravier…) : confort de roulage. */
  surface?: string | null;
  /** Pente OSM (`incline`) : `up`, `down` ou pourcentage. */
  incline?: string | null;
  /** Qualité de roulement OSM (`smoothness`). */
  smoothness?: string | null;
  /** Bande d'éveil de vigilance (`tactile_paving`). */
  tactile?: boolean | null;
  /** Accessibilité fauteuil déclarée (`wheelchair`). */
  wheelchair?: string | null;
  /** Nombre de marches (`step_count`) pour un escalier. */
  stepCount?: number | null;
  /** Rampe le long des marches (`ramp`) : souvent une goulotte à vélo/poussette. */
  ramp?: boolean | null;
  /** Rampe praticable en fauteuil (`ramp:wheelchair`) : tout autre chose. */
  rampWheelchair?: boolean | null;
  /** Main courante (`handrail`). */
  handrail?: boolean | null;
}

/**
 * Entrée cartographiée sur le contour d'un bâtiment. C'est l'information la
 * plus utile avant de se déplacer : par où entrer, et si ce passage est
 * praticable en fauteuil.
 */
export interface OsmEntrance {
  id: string;
  lng: number;
  lat: number;
  /** Valeur du tag `entrance` : main, yes, service, exit, staircase… */
  kind: string;
  /** `wheelchair` : yes / limited / no, ou null si non renseigné. */
  wheelchair: string | null;
  /** Porte automatique (`automatic_door`). */
  automatic: boolean | null;
  /** Type de porte (`door`) : hinged, sliding, revolving, no… */
  door: string | null;
  /** Largeur de passage (m) si renseignée. */
  width: number | null;
  /** Marches à franchir au seuil (`step_count`). */
  stepCount: number | null;
  /** Ressaut au seuil (`kerb:height`, m) si renseigné. */
  kerbHeight: number | null;
}

/**
 * Bordure de trottoir : élément déterminant pour un fauteuil (abaissée =
 * franchissable, haute = obstacle).
 */
export interface OsmKerb {
  id: string;
  lng: number;
  lat: number;
  /** `lowered`, `flush`, `raised`, `rolled`… ou null si non précisé. */
  kind: string | null;
  /** Hauteur (m) si renseignée. */
  height: number | null;
  tactile: boolean | null;
}

/** Place de stationnement (amenity=parking_space), PMR ou non. */
export interface OsmParking {
  id: string;
  lng: number;
  lat: number;
  pmr: boolean;
  /**
   * Empreinte exacte quand la place est cartographiée en surface : permet de
   * l'orienter (et la dimensionner) fidèlement plutôt que de la deviner.
   */
  ring: [number, number][] | null;
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
  /** Abri voyageurs (`shelter`). */
  shelter: boolean | null;
  /** Banc à l'arrêt (`bench`). */
  bench: boolean | null;
  /** Bande d'éveil de vigilance sur le quai. */
  tactile: boolean | null;
}

/**
 * Ligne de bus passant dans le voisinage. Le tracé est celui des voies de la
 * relation présentes dans l'emprise (le reste du parcours n'est pas téléchargé).
 */
export interface OsmBusRoute {
  id: string;
  /** Numéro de ligne (`ref`). */
  ref: string | null;
  name: string | null;
  /** Couleur officielle (`colour`) si le réseau la publie. */
  colour: string | null;
  segments: [number, number][][];
}

/** Banc : on récupère au mieux la couleur et la présence de dossier (OSM). */
export interface OsmBench {
  id: string;
  lng: number;
  lat: number;
  backrest: boolean | null;
  colour: string | null;
  material: string | null;
  /**
   * Azimut (degrés, 0 = nord) vers lequel regarde la personne assise, d'après le
   * tag OSM `direction`. Null si absent : l'orientation sera alors déduite du
   * cheminement le plus proche.
   */
  direction: number | null;
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
  kerbs: OsmKerb[];
  busRoutes: OsmBusRoute[];
  entrances: OsmEntrance[];
}

function bbox(lng: number, lat: number, radiusM: number): string {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  // Overpass attend (south,west,north,east)
  return `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;
}

// Points cardinaux OSM -> azimut en degrés.
const COMPASS: Record<string, number> = {
  n: 0,
  nne: 22.5,
  ne: 45,
  ene: 67.5,
  e: 90,
  ese: 112.5,
  se: 135,
  sse: 157.5,
  s: 180,
  ssw: 202.5,
  sw: 225,
  wsw: 247.5,
  w: 270,
  wnw: 292.5,
  nw: 315,
  nnw: 337.5,
};

/**
 * Tag OSM `direction` -> azimut en degrés (0 = nord). Accepte un nombre
 * (`180`) ou un point cardinal (`SW`). Null si inexploitable.
 */
function parseDirection(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  const cardinal = COMPASS[s];
  if (cardinal != null) return cardinal;
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : null;
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
  // Bloc principal : bâtiments, réseau piéton (avec les attributs qui décident
  // de la franchissabilité en fauteuil), voirie, stationnement et mobilier.
  // Puis, en second temps, les lignes de bus : `foreach` sort les relations une
  // par une avec leurs seules voies présentes dans l'emprise, ce qui permet de
  // savoir à quelle ligne appartient chaque tronçon sans télécharger le
  // parcours entier (souvent toute la ville).
  const query = `[out:json][timeout:25];
    (
      way["building"](${b});
      way["highway"="footway"](${b});
      way["footway"="sidewalk"](${b});
      way["footway"="crossing"](${b});
      way["highway"="pedestrian"](${b});
      way["highway"="steps"](${b});
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|road)$"](${b});
      node["amenity"="bench"](${b});
      node["highway"="bus_stop"](${b});
      node["public_transport"="platform"](${b});
      node["amenity"="parking_space"](${b});
      way["amenity"="parking_space"](${b});
      way["amenity"="parking"](${b});
      node["natural"="tree"](${b});
      way["natural"="tree_row"](${b});
      node["emergency"="fire_hydrant"](${b});
      node["man_made"="street_cabinet"](${b});
      node["amenity"="drinking_water"](${b});
      node["amenity"="fountain"](${b});
      way["amenity"="fountain"](${b});
      node["barrier"="kerb"](${b});
      node["kerb"](${b});
      node["entrance"](${b});
      node["barrier"="bollard"](${b});
      node["highway"="street_lamp"](${b});
      node["amenity"="waste_basket"](${b});
      node["amenity"="toilets"](${b});
      way["amenity"="toilets"](${b});
      node["highway"="elevator"](${b});
      node["barrier"~"^(gate|lift_gate|swing_gate|kissing_gate|cycle_barrier|stile|block|chicane)$"](${b});
    );
    out geom tags;
    rel["route"~"^(bus|trolleybus)$"](${b})->.br;
    foreach.br->.r (
      .r out tags;
      way(r.r)(${b});
      out skel geom;
    );`;

  const data = await overpassFetch(query);

  // Réponse sans aucun élément = quasi certainement un échec/rate-limit (une
  // zone habitée a toujours au moins un bâtiment ou une voie). On lève une
  // erreur pour NE PAS mettre ce vide en cache (sinon les points voisins le
  // réutiliseraient et la zone entière paraîtrait vide).
  if (!Array.isArray(data.elements) || data.elements.length === 0) {
    throw new Error('Voisinage vide (Overpass)');
  }

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
    kerbs: [],
    busRoutes: [],
    entrances: [],
  };

  // Le `foreach` des lignes de bus émet ses éléments après le bloc principal :
  // tout ce qui suit la première relation `route=` relève de cette section.
  const elements: any[] = data.elements;
  const busStart = elements.findIndex((e) => e.type === 'relation' && e.tags?.route);
  const mainEls = busStart >= 0 ? elements.slice(0, busStart) : elements;

  for (const el of mainEls) {
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

    // Place de stationnement, PMR ou non. Pour un way, on conserve l'empreinte :
    // elle donne l'orientation réelle de la place (sinon on la déduira du
    // parking qui la contient ou de la voirie voisine).
    if (tags.amenity === 'parking_space' && pos) {
      out.parking.push({
        id: eid,
        lng: pos[0],
        lat: pos[1],
        pmr: isDisabledParking(tags),
        ring:
          el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 3
            ? el.geometry.map((g: any) => [g.lon, g.lat] as [number, number])
            : null,
      });
    }

    // Alignement d'arbres : on matérialise des sujets régulièrement espacés.
    if (el.type === 'way' && tags.natural === 'tree_row' && Array.isArray(el.geometry)) {
      sampleAlong(el.geometry, 9).forEach(([tlng, tlat], i) => {
        out.furniture.push({
          id: `w${el.id}-${i}`,
          kind: 'tree',
          lng: tlng,
          lat: tlat,
          height: toNum(tags.height),
          crown: toNum(tags.diameter_crown),
          variant: tags.leaf_type || null,
        });
      });
    }

    if (el.type === 'node') {
      // Arret de bus : nom, ligne(s) et confort du quai (abri, banc).
      if (tags.highway === 'bus_stop' || (tags.public_transport === 'platform' && tags.bus === 'yes')) {
        out.busStops.push({
          id: eid,
          lng: el.lon,
          lat: el.lat,
          name: tags.name || null,
          line: tags.route_ref || tags.ref || null,
          shelter: parseBool(tags.shelter),
          bench: parseBool(tags.bench),
          tactile: parseBool(tags.tactile_paving),
        });
      }

      // Entrée : par où entrer, et à quelles conditions.
      if (tags.entrance) {
        out.entrances.push({
          id: eid,
          lng: el.lon,
          lat: el.lat,
          kind: tags.entrance,
          wheelchair: tags.wheelchair || null,
          automatic: parseBool(tags.automatic_door),
          door: tags.door || null,
          width: toNum(tags.width),
          stepCount: toNum(tags.step_count),
          kerbHeight: toNum(tags['kerb:height']),
        });
      }

      // Bordure de trottoir : franchissable ou non pour un fauteuil.
      if (tags.kerb || tags.barrier === 'kerb') {
        out.kerbs.push({
          id: eid,
          lng: el.lon,
          lat: el.lat,
          kind: tags.kerb || null,
          height: toNum(tags['kerb:height'] ?? tags.height),
          tactile: parseBool(tags.tactile_paving),
        });
      }

      // Banc : couleur / dossier / materiau / orientation au mieux (tags OSM).
      if (tags.amenity === 'bench') {
        out.benches.push({
          id: eid,
          lng: el.lon,
          lat: el.lat,
          backrest: parseBool(tags.backrest),
          colour: tags.colour || tags.color || null,
          material: tags.material || null,
          direction: parseDirection(tags.direction),
        });
      }

      // Mobilier / obstacles / services (nodes).
      const kind = furnitureKind(tags);
      if (kind) {
        out.furniture.push({
          id: `n${el.id}`,
          kind,
          lng: el.lon,
          lat: el.lat,
          height: toNum(tags.height),
          crown: toNum(tags.diameter_crown),
          variant:
            tags['fire_hydrant:type'] || tags.barrier || tags.fountain || tags.leaf_type || null,
          wheelchair: tags.wheelchair || null,
          name: tags.name || null,
        });
      }
    }

    // Équipements cartographiés en surface : on les ramène à leur centre.
    if (el.type === 'way' && pos) {
      if (tags.amenity === 'fountain') {
        out.furniture.push({ id: eid, kind: 'fountain', lng: pos[0], lat: pos[1] });
      } else if (tags.amenity === 'toilets') {
        out.furniture.push({
          id: eid,
          kind: 'toilets',
          lng: pos[0],
          lat: pos[1],
          wheelchair: tags.wheelchair || null,
          name: tags.name || null,
        });
      }
    }

    // Cheminements pietons (footway / trottoir / marches / parc) et routes.
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      let kind: OsmPath['kind'] | null = null;
      let width: number | undefined;
      const rw = roadWidth(tags.highway);
      if (tags.highway === 'steps') {
        kind = 'steps';
        width = toNum(tags.width) ?? undefined;
      } else if (tags.footway === 'crossing') kind = 'crossing';
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
          surface: tags.surface || null,
          incline: tags.incline || null,
          smoothness: tags.smoothness || null,
          tactile: parseBool(tags.tactile_paving),
          wheelchair: tags.wheelchair || null,
          stepCount: toNum(tags.step_count),
          ramp: parseBool(tags.ramp),
          rampWheelchair: parseBool(tags['ramp:wheelchair']),
          handrail:
            parseBool(tags.handrail) ??
            parseBool(tags['handrail:left']) ??
            parseBool(tags['handrail:right']),
        });
      }
    }
  }

  // Lignes de bus : une relation puis ses voies (voir le `foreach` de la requête).
  if (busStart >= 0) {
    let current: OsmBusRoute | null = null;
    for (const el of elements.slice(busStart)) {
      if (el.type === 'relation') {
        const t = el.tags || {};
        current = {
          id: `r${el.id}`,
          ref: t.ref || null,
          name: t.name || null,
          colour: t.colour || t.color || null,
          segments: [],
        };
        out.busRoutes.push(current);
      } else if (el.type === 'way' && current && Array.isArray(el.geometry)) {
        const seg = el.geometry
          .filter((g: any) => g && Number.isFinite(g.lon) && Number.isFinite(g.lat))
          .map((g: any) => [g.lon, g.lat] as [number, number]);
        if (seg.length >= 2) current.segments.push(seg);
      }
    }
    // Une ligne sans tracé dans l'emprise n'a rien à montrer.
    out.busRoutes = out.busRoutes.filter((r) => r.segments.length > 0);
  }

  return out;
}

/**
 * Points régulièrement espacés (tous `stepM` mètres) le long d'une géométrie
 * OSM. Sert à matérialiser un alignement d'arbres.
 */
function sampleAlong(
  geom: { lon: number; lat: number }[],
  stepM: number,
  max = 40
): [number, number][] {
  const pts: [number, number][] = [];
  let acc = 0;
  let next = 0;
  for (let i = 0; i < geom.length - 1 && pts.length < max; i += 1) {
    const a = geom[i];
    const c = geom[i + 1];
    const seg = distM(a.lon, a.lat, c.lon, c.lat);
    if (seg <= 0) continue;
    while (next <= acc + seg && pts.length < max) {
      const t = (next - acc) / seg;
      pts.push([a.lon + (c.lon - a.lon) * t, a.lat + (c.lat - a.lat) * t]);
      next += stepM;
    }
    acc += seg;
  }
  return pts;
}

// Obstacles de passage : chicanes et portillons reduisent la largeur utile et
// bloquent souvent un fauteuil, au contraire d'une borne isolee.
const BARRIER_KINDS = new Set([
  'gate',
  'lift_gate',
  'swing_gate',
  'kissing_gate',
  'cycle_barrier',
  'stile',
  'block',
  'chicane',
]);

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
  if (tags.emergency === 'fire_hydrant') return 'fire_hydrant';
  if (tags.man_made === 'street_cabinet') return 'street_cabinet';
  if (tags.amenity === 'toilets') return 'toilets';
  if (tags.highway === 'elevator') return 'elevator';
  if (tags.barrier && BARRIER_KINDS.has(tags.barrier)) return 'barrier';
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
