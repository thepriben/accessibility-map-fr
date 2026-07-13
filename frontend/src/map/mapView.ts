import maplibregl, { Map as MlMap, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { INITIAL_VIEW, asset, basemapTiles } from '../config';
import { getTheme } from '../theme';
import { state } from '../state';
import type { DataConfig, Place, PlaceProperties } from '../types';
import { baseStyle } from './style';
import { showPlacePopup, type PopupHandlers } from './popup';
import { ClusterClient } from '../data/clusterClient';
import {
  CLUSTER_LAYER,
  POINT_LAYER,
  SRC_ID,
  addGeoJsonClusters,
  addManagedClusterSource,
  addPmtilesClusters,
} from './layers';

const PM_SOURCE_LAYER = 'acceslibre';

let map: MlMap | null = null;
let geojsonData: GeoJSON.FeatureCollection | null = null;
let cluster: ClusterClient | null = null;
let totalCount = 0;
let queryToken = 0;

export function getMap(): MlMap | null {
  return map;
}

/** Client de clustering (mode points) : utilise par la liste et le deep-link. */
export function getClusterClient(): ClusterClient | null {
  return cluster;
}

/** Nombre total de lieux charges (pour l'affichage du statut). */
export function dataCount(): number {
  return totalCount || state.allPlaces.length;
}

/** Initialise la carte et branche les donnees selon le mode (geojson/pmtiles). */
export async function initMap(
  cfg: DataConfig,
  fc: GeoJSON.FeatureCollection | null,
  handlers: PopupHandlers
): Promise<MlMap> {
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  map = new maplibregl.Map({
    container: 'map',
    style: baseStyle(getTheme()),
    center: INITIAL_VIEW.center,
    zoom: INITIAL_VIEW.zoom,
    attributionControl: false,
    maxZoom: 20,
  });

  map.addControl(
    new maplibregl.AttributionControl({ compact: true, customAttribution: cfg.attribution }),
    'bottom-right'
  );
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(
    new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }),
    'top-right'
  );

  await new Promise<void>((resolve) => map!.on('load', () => resolve()));

  // Voile hors-France (DOM-TOM inclus) : ajoute avant les grappes pour rester dessous.
  await addFranceMask(map);

  if (cfg.mode === 'points') {
    // Clustering cote client dans un worker : donnees hors du thread principal,
    // seules les grappes visibles reviennent (pas de crash memoire).
    addManagedClusterSource(map, { type: 'FeatureCollection', features: [] });
    cluster = new ClusterClient();
    totalCount = await cluster.init(asset(cfg.source));
    wireInteractions(cfg, handlers);
    await refreshClusters();
    map.on('moveend', () => void refreshClusters());
  } else if (cfg.mode === 'geojson' && fc) {
    geojsonData = fc;
    addGeoJsonClusters(map, fc);
    wireInteractions(cfg, handlers);
  } else {
    addPmtilesClusters(map, asset(cfg.source), PM_SOURCE_LAYER);
    wireInteractions(cfg, handlers);
  }

  // Garde le spinner tant que les premieres grappes ne sont pas rendues.
  await firstTilesLoaded(map);
  return map;
}

/**
 * Interroge le worker pour les grappes/points de la vue courante et les pousse
 * dans la source geree. Les requetes obsoletes (deplacements rapides) sont
 * ignorees via un jeton.
 */
async function refreshClusters(): Promise<void> {
  if (!map || !cluster) return;
  const b = map.getBounds();
  const bbox: [number, number, number, number] = [
    b.getWest(),
    b.getSouth(),
    b.getEast(),
    b.getNorth(),
  ];
  const zoom = Math.floor(map.getZoom());
  const token = (queryToken += 1);
  const features = await cluster.query(bbox, zoom);
  if (token !== queryToken || !map) return;
  const src = map.getSource(SRC_ID) as GeoJSONSource | undefined;
  src?.setData({ type: 'FeatureCollection', features });
}

/** Resout quand la carte a fini de charger/rendre ses tuiles (ou apres delai). */
function firstTilesLoaded(m: MlMap): Promise<void> {
  if (m.areTilesLoaded()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      m.off('idle', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 8000); // filet de securite si un tile echoue
    m.on('idle', done);
  });
}

/**
 * Attenue tout ce qui n'est pas la France (metropole + DROM) via un voile
 * semi-transparent : un polygone couvrant le monde, troue a l'emplacement de
 * la France. La geometrie est pre-calculee dans france-mask.geojson.
 */
function maskPaint(theme: string): { color: string; opacity: number } {
  return theme === 'dark'
    ? { color: '#05070a', opacity: 0.6 }
    : { color: '#f2efe8', opacity: 0.68 };
}

async function addFranceMask(m: MlMap): Promise<void> {
  try {
    const res = await fetch(asset('data/france-mask.geojson'));
    if (!res.ok) return;
    const mask = (await res.json()) as GeoJSON.GeoJSON;
    const { color, opacity } = maskPaint(getTheme());
    m.addSource('france-mask', { type: 'geojson', data: mask });
    m.addLayer({
      id: 'france-mask',
      type: 'fill',
      source: 'france-mask',
      paint: { 'fill-color': color, 'fill-opacity': opacity },
    });
  } catch {
    /* masque optionnel : on ignore si indisponible */
  }
}

/** Bascule le fond de carte + voile selon le theme (sans recreer la carte). */
export function updateMapTheme(theme: string): void {
  if (!map) return;
  const src = map.getSource('basemap') as maplibregl.RasterTileSource | undefined;
  src?.setTiles?.(basemapTiles(theme));
  if (map.getLayer('bg')) {
    map.setPaintProperty('bg', 'background-color', theme === 'dark' ? '#0c0f14' : '#eae7df');
  }
  if (map.getLayer('france-mask')) {
    const { color, opacity } = maskPaint(theme);
    map.setPaintProperty('france-mask', 'fill-color', color);
    map.setPaintProperty('france-mask', 'fill-opacity', opacity);
  }
}

function wireInteractions(cfg: DataConfig, handlers: PopupHandlers): void {
  if (!map) return;

  // Clic sur une grappe -> zoom (geojson : expansion native ; sinon zoom simple)
  map.on('click', CLUSTER_LAYER, async (e) => {
    const feat = e.features?.[0];
    if (!feat) return;
    const coords = (feat.geometry as GeoJSON.Point).coordinates as [number, number];
    if (cfg.mode === 'points') {
      // Grappe Supercluster (worker) : on demande le zoom d'expansion.
      const cid = feat.properties?.cluster_id;
      if (cid != null && cluster) {
        const zoom = await cluster.expansion(Number(cid));
        map!.easeTo({ center: coords, zoom: Math.min(zoom, 20) });
      } else {
        map!.easeTo({ center: coords, zoom: Math.min((map!.getZoom() || 5) + 2, 20) });
      }
    } else if (cfg.mode === 'geojson') {
      const src = map!.getSource(SRC_ID) as GeoJSONSource;
      const clusterId = feat.properties?.cluster_id;
      const zoom = await src.getClusterExpansionZoom(clusterId);
      map!.easeTo({ center: coords, zoom });
    } else {
      // Mode pmtiles : les grappes sont pre-agregees (zoom max des tuiles = 16).
      // Au zoom rue, une petite grappe ne se separe plus par un simple zoom.
      // tippecanoe conserve les attributs d'un lieu representatif sur la grappe :
      // on ouvre alors un popup exploitable (lieu + "N lieux ici" + 3D) plutot
      // que de rester bloque sur un rond "2".
      const count = Number(feat.properties?.point_count ?? 0);
      const z = map!.getZoom() || 5;
      const props = feat.properties as unknown as PlaceProperties;
      if (z >= 15 && count > 0 && count <= 12 && props?.nom) {
        const place: Place = { properties: props, lng: coords[0], lat: coords[1] };
        const note = `${count} lieux à cet endroit · exemple ci-dessous`;
        showPlacePopup(map!, place, handlers, note);
      } else {
        map!.easeTo({ center: coords, zoom: Math.min(z + 2.5, 18) });
      }
    }
  });

  map.on('click', POINT_LAYER, (e) => {
    const feat = e.features?.[0];
    if (!feat) return;
    const [lng, lat] = (feat.geometry as GeoJSON.Point).coordinates as [number, number];
    const place: Place = { properties: feat.properties as unknown as PlaceProperties, lng, lat };
    showPlacePopup(map!, place, handlers);
  });

  for (const layer of [CLUSTER_LAYER, POINT_LAYER]) {
    map.on('mouseenter', layer, () => (map!.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map!.getCanvas().style.cursor = ''));
  }
}

/** Recalcule l'affichage apres changement de filtres. */
export async function applyFilters(cfg: DataConfig): Promise<void> {
  if (!map) return;
  if (cfg.mode === 'points' && cluster) {
    // Le worker re-clusterise le sous-ensemble filtre : grappes recomposees
    // instantanement, a tous les zooms.
    await cluster.filter([...state.activeFilters]);
    await refreshClusters();
    return;
  }
  if (cfg.mode === 'geojson' && geojsonData) {
    const filtered = {
      type: 'FeatureCollection' as const,
      features: state.filteredPlaces().map((p) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
        properties: p.properties,
      })),
    };
    (map.getSource(SRC_ID) as GeoJSONSource).setData(filtered);
  } else {
    // Mode pmtiles : les grappes sont pre-agregees ; on filtre les points isoles.
    const keys = [...state.activeFilters];
    const filter =
      keys.length === 0
        ? (['!', ['has', 'point_count']] as unknown as maplibregl.FilterSpecification)
        : ([
            'all',
            ['!', ['has', 'point_count']],
            ...keys.map((k) => ['==', ['get', k], true]),
          ] as unknown as maplibregl.FilterSpecification);
    map.setFilter(POINT_LAYER, filter);
  }
}

/** Centre la carte sur un lieu (utilise par la liste accessible et le deep-link). */
export function flyToPlace(lng: number, lat: number, zoom = 17): void {
  map?.flyTo({ center: [lng, lat], zoom, speed: 1.2 });
}

function metersBetween(a: [number, number], b: [number, number]): number {
  const dLat = (b[1] - a[1]) * 111320;
  const dLng = (b[0] - a[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

/** Zoom courant de la carte (pour la bascule 3D de proximite). */
export function currentZoom(): number {
  return map?.getZoom() ?? 0;
}

/**
 * Lieu isole le plus proche du centre de la carte, dans un rayon donne.
 * Fonctionne en mode geojson (memoire) et pmtiles (features rendues).
 */
export function nearestPlaceToCenter(maxMeters = 70): Place | null {
  if (!map) return null;
  const c = map.getCenter();
  const center: [number, number] = [c.lng, c.lat];

  const candidates: { place: Place; d: number }[] = [];
  const consider = (props: PlaceProperties, lng: number, lat: number) => {
    const d = metersBetween(center, [lng, lat]);
    if (d <= maxMeters) candidates.push({ place: { properties: props, lng, lat }, d });
  };

  if (state.allPlaces.length > 0) {
    for (const p of state.filteredPlaces()) consider(p.properties, p.lng, p.lat);
  } else {
    const pt = map.project(c);
    const pad = 60;
    const feats = map.queryRenderedFeatures(
      [
        [pt.x - pad, pt.y - pad],
        [pt.x + pad, pt.y + pad],
      ],
      { layers: [POINT_LAYER] }
    );
    for (const f of feats) {
      const g = f.geometry as GeoJSON.Point;
      const [lng, lat] = g.coordinates as [number, number];
      consider(f.properties as unknown as PlaceProperties, lng, lat);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.d - b.d);
  return candidates[0].place;
}
