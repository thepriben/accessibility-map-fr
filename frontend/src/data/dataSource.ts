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

/**
 * En mode geojson, charge le FeatureCollection en memoire (sert la carte ET la
 * liste accessible). Renvoie l'objet GeoJSON pour la source MapLibre.
 */
export async function loadGeoJson(cfg: DataConfig): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(asset(cfg.source), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Donnees introuvables (HTTP ${res.status})`);
  const fc = (await res.json()) as GeoJSON.FeatureCollection;

  state.allPlaces = fc.features
    .map((f) => featureToPlace(f))
    .filter((p): p is Place => p !== null);
  return fc;
}

export function featureToPlace(f: GeoJSON.Feature): Place | null {
  if (!f.geometry || f.geometry.type !== 'Point') return null;
  const [lng, lat] = f.geometry.coordinates as [number, number];
  return { properties: f.properties as unknown as PlaceProperties, lng, lat };
}
