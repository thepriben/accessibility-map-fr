/** Types partages entre la carte, la vue accessible, le voisinage et la 3D. */

export type TriState = boolean | null;

/** Criteres d'accessibilite normalises (produits par le pipeline). */
export interface A11yFlags {
  stepFreeEntrance?: TriState;
  wheelchairEntrance?: TriState;
  accessibleParking?: TriState;
  adaptedToilets?: TriState;
  extStepFreePath?: TriState;
  audioBeacon?: TriState;
  guidePath?: TriState;
  hearingEquipment?: TriState;
  staffTrained?: string | null;
  callDevice?: TriState;
  publicTransport?: TriState;
  humanHelp?: TriState;
}

/** Proprietes d'un lieu Acceslibre telles que portees par les features. */
export interface PlaceProperties extends A11yFlags {
  uuid: string;
  slug: string;
  nom: string;
  activite?: string | null;
  activite_slug?: string | null;
  adresse?: string | null;
  commune?: string | null;
  code_insee?: string | null;
  code_postal?: string | null;
  web_url?: string | null;
  site_internet?: string | null;
}

export interface Place {
  properties: PlaceProperties;
  lng: number;
  lat: number;
}

/** Cle de filtre <-> propriete booleenne. */
export type FilterKey =
  | 'wheelchairEntrance'
  | 'stepFreeEntrance'
  | 'accessibleParking'
  | 'adaptedToilets'
  | 'audioBeacon'
  | 'guidePath'
  | 'hearingEquipment'
  | 'publicTransport';

/** Photo de rue (Mapillary ou Panoramax) pres d'un lieu. */
export interface StreetPhoto {
  id: string;
  provider: 'mapillary' | 'panoramax';
  lng: number;
  lat: number;
  azimuth: number | null;
  thumbUrl: string | null;
  sourceUrl: string;
}

/** Configuration de la source de donnees (mode geojson ou pmtiles). */
export interface DataConfig {
  mode: 'geojson' | 'pmtiles' | 'points';
  source: string;
  label?: string;
  count?: number;
  attribution: string;
}
