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
  'Fond <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, HERE, Garmin &middot; ' +
  '<a href="https://geoservices.ign.fr/" target="_blank" rel="noopener">IGN</a>/Géoplateforme &middot; ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &middot; ' +
  'données <a href="https://acceslibre.beta.gouv.fr/" target="_blank" rel="noopener">Acceslibre</a>';

/**
 * Fond de carte sobre et sans clef : Esri Gray Canvas, clair ou sombre.
 * CARTO Positron, utilise jusqu'ici, tamponne desormais « API KEY REQUIRED »
 * en travers des tuiles anonymes. Le rendu Esri est aussi neutre et laisse
 * ressortir les points, avec une toponymie locale (francaise en France).
 *
 * Chez Esri le decor et les libelles sont deux services distincts : on les
 * empile, ce qui garde les noms de rues sous les grappes et sous le voile.
 */
const ESRI_CANVAS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';

/**
 * Dernier niveau reellement en cache chez Esri : au-dela, le service renvoie
 * une tuile « Map data not yet available ». On borne la source pour que
 * MapLibre agrandisse la tuile du niveau 16 plutot que de la demander.
 */
export const BASEMAP_MAX_ZOOM = 16;

const canvasTiles = (kind: 'Base' | 'Reference', theme: string): string[] => [
  `${ESRI_CANVAS}/World_${theme === 'dark' ? 'Dark' : 'Light'}_Gray_${kind}/MapServer/tile/{z}/{y}/{x}`,
];

export function basemapTiles(theme: string): string[] {
  return canvasTiles('Base', theme);
}

/** Libelles seuls, sur fond transparent : a poser au-dessus du decor. */
export function basemapLabelTiles(theme: string): string[] {
  return canvasTiles('Reference', theme);
}

/**
 * Relais de detail au-dela du cache Esri : le Plan IGN de la Geoplateforme,
 * lui aussi sans clef, va jusqu'au niveau 19. Il ne couvre que la France, ce
 * qui suffit ici (les etablissements Acceslibre y sont tous) : ailleurs, le
 * fond Esri agrandi reste visible dessous.
 *
 * Sans ce relais, la recherche amenait la carte au niveau 17/18 sur une tuile
 * Esri agrandie quatre fois : plus un batiment, plus un nom de rue lisibles.
 * Le style est ramene au gris dans la couche (voir `map/style.ts`).
 */
export const BASEMAP_DETAIL_TILES = [
  'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile' +
    '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM' +
    '&FORMAT=image/png&TILEMATRIX={z}&TILECOL={x}&TILEROW={y}',
];

export const BASEMAP_DETAIL_MAX_ZOOM = 19;

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
