import { OVERPASS_API } from '../config';

export interface OsmBuilding {
  id: string;
  ring: [number, number][]; // anneau exterieur [lng,lat]
  levels: number | null;
  height: number | null;
  wikidata: string | null;
  name: string | null;
}

export type FurnitureKind = 'bench' | 'bus_stop' | 'fountain' | 'tree' | 'crossing';

export interface OsmFurniture {
  id: string;
  kind: FurnitureKind;
  lng: number;
  lat: number;
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

/**
 * Recupere le voisinage OSM (rayon ~ des "30 derniers metres") : batiments,
 * bancs, arrets de bus, fontaines, arbres, passages pietons, trottoirs, parcs.
 */
export async function fetchNeighborhood(
  lng: number,
  lat: number,
  radiusM = 80
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
      way["footway"="sidewalk"](${b});
      way["highway"="footway"](${b});
      way["leisure"="park"](${b});
    );
    out geom tags;`;

  const res = await fetch(OVERPASS_API, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();

  const out: NeighborhoodData = {
    center: { lng, lat },
    buildings: [],
    furniture: [],
    paths: [],
  };

  for (const el of data.elements || []) {
    const tags = el.tags || {};
    if (el.type === 'way' && tags.building && Array.isArray(el.geometry)) {
      out.buildings.push({
        id: `w${el.id}`,
        ring: el.geometry.map((g: any) => [g.lon, g.lat] as [number, number]),
        levels: toNum(tags['building:levels']),
        height: toNum(tags.height),
        wikidata: tags.wikidata || null,
        name: tags.name || null,
      });
    } else if (el.type === 'node') {
      let kind: FurnitureKind | null = null;
      if (tags.amenity === 'bench') kind = 'bench';
      else if (tags.highway === 'bus_stop' || tags.public_transport === 'platform') kind = 'bus_stop';
      else if (tags.amenity === 'fountain') kind = 'fountain';
      else if (tags.natural === 'tree') kind = 'tree';
      else if (tags.highway === 'crossing') kind = 'crossing';
      if (kind) out.furniture.push({ id: `n${el.id}`, kind, lng: el.lon, lat: el.lat });
    } else if (el.type === 'way' && Array.isArray(el.geometry)) {
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
