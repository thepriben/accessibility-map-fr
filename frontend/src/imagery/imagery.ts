import { MAPILLARY_TOKEN, PANORAMAX_API } from '../config';
import type { StreetPhoto } from '../types';

/** Petit bbox (metres -> degres) centre sur un point. */
function bboxAround(lng: number, lat: number, radiusM: number): [number, number, number, number] {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/** Photos Panoramax proches (STAC search, aucune cle requise). */
export async function fetchPanoramax(
  lng: number,
  lat: number,
  radiusM = 120,
  limit = 40
): Promise<StreetPhoto[]> {
  const [minx, miny, maxx, maxy] = bboxAround(lng, lat, radiusM);
  const url = `${PANORAMAX_API}/search?bbox=${minx},${miny},${maxx},${maxy}&limit=${limit}`;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.features || []).map((f: any): StreetPhoto => {
      const c = f.geometry?.coordinates || [lng, lat];
      const az = f.properties?.['view:azimuth'];
      return {
        id: f.id,
        provider: 'panoramax',
        lng: c[0],
        lat: c[1],
        azimuth: typeof az === 'number' ? az : null,
        thumbUrl: f.assets?.thumb?.href || null,
        sourceUrl: f.assets?.sd?.href || f.assets?.hd?.href || f.assets?.thumb?.href || url,
      };
    });
  } catch {
    return [];
  }
}

/** Photos Mapillary proches (Graph API, token requis sinon liste vide). */
export async function fetchMapillary(
  lng: number,
  lat: number,
  radiusM = 120,
  limit = 40
): Promise<StreetPhoto[]> {
  if (!MAPILLARY_TOKEN) return [];
  const bbox = bboxAround(lng, lat, radiusM).join(',');
  const fields = 'id,geometry,compass_angle,thumb_256_url';
  const url =
    `https://graph.mapillary.com/images?fields=${fields}&bbox=${bbox}&limit=${limit}` +
    `&access_token=${encodeURIComponent(MAPILLARY_TOKEN)}`;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map((d: any): StreetPhoto => {
      const c = d.geometry?.coordinates || [lng, lat];
      return {
        id: d.id,
        provider: 'mapillary',
        lng: c[0],
        lat: c[1],
        azimuth: typeof d.compass_angle === 'number' ? d.compass_angle : null,
        thumbUrl: d.thumb_256_url || null,
        sourceUrl: `https://www.mapillary.com/app/?pKey=${encodeURIComponent(d.id)}&focus=photo`,
      };
    });
  } catch {
    return [];
  }
}

/** Combine les deux fournisseurs (Panoramax + Mapillary si token). */
export async function fetchNearbyPhotos(
  lng: number,
  lat: number,
  radiusM = 120
): Promise<StreetPhoto[]> {
  const [pano, mapi] = await Promise.all([
    fetchPanoramax(lng, lat, radiusM),
    fetchMapillary(lng, lat, radiusM),
  ]);
  return [...pano, ...mapi];
}
