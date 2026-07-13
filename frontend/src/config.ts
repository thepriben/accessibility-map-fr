import type { FilterKey } from './types';

/** Chemin de base (aligne sur vite `base`) pour resoudre les assets publics. */
export const BASE_URL = import.meta.env.BASE_URL || '/';

export function asset(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${BASE_URL}${path.replace(/^\//, '')}`;
}

/** Token Mapillary (client). Vide -> couche Mapillary desactivee proprement. */
export const MAPILLARY_TOKEN: string = import.meta.env.VITE_MAPILLARY_TOKEN ?? '';

/** API STAC Panoramax (aucune cle requise). */
export const PANORAMAX_API = 'https://api.panoramax.xyz/api';

/** Endpoint Overpass pour le voisinage (petit bbox, a la demande). */
export const OVERPASS_API = 'https://overpass-api.de/api/interpreter';

/**
 * Attribution custom : PAS de drapeau Ukraine (contrairement au prefixe Leaflet
 * par defaut). On cite le fond de carte et les donnees, comme l'exige la licence.
 */
export const MAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &middot; ' +
  'fond <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> &middot; ' +
  'données <a href="https://acceslibre.beta.gouv.fr/" target="_blank" rel="noopener">Acceslibre</a>';

/** Tuiles raster du fond de carte (CARTO Positron, sobre, sans cle). */
export const BASEMAP_TILES = [
  'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
  'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
  'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
];

/** Vue initiale (France metropolitaine). */
export const INITIAL_VIEW = { center: [2.6, 46.7] as [number, number], zoom: 5.2 };

/** Definition des filtres exposes dans l'UI, par famille de handicap. */
export const FILTERS: { key: FilterKey; label: string; group: string }[] = [
  { key: 'wheelchairEntrance', label: 'Entrée accessible fauteuil', group: 'Mobilité' },
  { key: 'stepFreeEntrance', label: 'Entrée de plain-pied', group: 'Mobilité' },
  { key: 'accessibleParking', label: 'Stationnement PMR', group: 'Mobilité' },
  { key: 'adaptedToilets', label: 'Sanitaires adaptés', group: 'Mobilité' },
  { key: 'audioBeacon', label: 'Balise sonore', group: 'Vue' },
  { key: 'guidePath', label: 'Bande de guidage', group: 'Vue' },
  { key: 'hearingEquipment', label: 'Équipement malentendants', group: 'Audition' },
  { key: 'publicTransport', label: 'Transport à proximité', group: 'Divers' },
];
