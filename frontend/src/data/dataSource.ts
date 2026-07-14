import { asset } from '../config';
import { state } from '../state';
import type { DataConfig, Place, PlaceProperties } from '../types';

/** Charge la config de donnees (mode geojson vs pmtiles) depuis public/data. */
export async function loadDataConfig(): Promise<DataConfig> {
  const res = await fetch(asset('data/config.json'), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`config.json introuvable (HTTP ${res.status})`);
  const cfg = (await res.json()) as DataConfig;
  state.dataConfig = cfg;
  return cfg;
}

/** Format colonnaire compact produit par le pipeline (build-points.mjs). */
interface ColumnarPoints {
  n: number;
  criteria: string[];
  lon: number[];
  lat: number[];
  k: number[]; // bitmask "critere renseigne"
  v: number[]; // bitmask "critere vrai"
  nom: string[];
  act: string[];
  com: string[];
  cp: string[];
}

function isColumnar(x: unknown): x is ColumnarPoints {
  const o = x as ColumnarPoints;
  return !!o && Array.isArray(o.lon) && Array.isArray(o.k) && Array.isArray(o.criteria);
}

/**
 * En mode geojson, charge le jeu complet en memoire (sert la carte ET la liste
 * accessible). Accepte soit un FeatureCollection brut (echantillon de dev),
 * soit le format colonnaire compact (France entiere) qu'on expanse ici. Le
 * clustering cote client permet aux filtres de recomposer les grappes en direct.
 */
export async function loadGeoJson(cfg: DataConfig): Promise<GeoJSON.FeatureCollection> {
  // Cache HTTP navigateur autorise : gros fichier, mis a jour ~hebdo (ETag).
  const res = await fetch(asset(cfg.source));
  if (!res.ok) throw new Error(`Donnees introuvables (HTTP ${res.status})`);
  const json = (await res.json()) as unknown;

  if (isColumnar(json)) return expandColumnar(json);

  const fc = json as GeoJSON.FeatureCollection;
  state.allPlaces = fc.features
    .map((f) => featureToPlace(f))
    .filter((p): p is Place => p !== null);
  return fc;
}

/** Expanse le format colonnaire en FeatureCollection + state.allPlaces. */
function expandColumnar(d: ColumnarPoints): GeoJSON.FeatureCollection {
  const crit = d.criteria;
  const features: GeoJSON.Feature[] = new Array(d.n);
  const places: Place[] = new Array(d.n);

  for (let i = 0; i < d.n; i += 1) {
    const k = d.k[i];
    const val = d.v[i];
    // Code postal : restaure le 0 initial perdu (ex. 1700 -> 01700, dept. 01-09).
    const cp = d.cp[i] && /^\d{4}$/.test(d.cp[i]) ? `0${d.cp[i]}` : d.cp[i] || null;
    // L'objet properties est partage entre la Place et la Feature (memoire).
    const props: Record<string, unknown> = {
      uuid: String(i),
      slug: '',
      nom: d.nom[i] || '',
      activite: d.act[i] || null,
      commune: d.com[i] || null,
      code_postal: cp,
      adresse: [cp, d.com[i]].filter(Boolean).join(' ') || null,
    };
    for (let b = 0; b < crit.length; b += 1) {
      props[crit[b]] = (k >> b) & 1 ? (((val >> b) & 1) === 1 ? true : false) : null;
    }
    const lng = d.lon[i];
    const lat = d.lat[i];
    features[i] = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: props,
    };
    places[i] = { properties: props as unknown as PlaceProperties, lng, lat };
  }

  state.allPlaces = places;
  return { type: 'FeatureCollection', features };
}

export function featureToPlace(f: GeoJSON.Feature): Place | null {
  if (!f.geometry || f.geometry.type !== 'Point') return null;
  const [lng, lat] = f.geometry.coordinates as [number, number];
  return { properties: f.properties as unknown as PlaceProperties, lng, lat };
}
