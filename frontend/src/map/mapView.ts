import maplibregl, { Map as MlMap, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { INITIAL_VIEW, asset } from '../config';
import { state } from '../state';
import type { DataConfig, Place, PlaceProperties } from '../types';
import { baseStyle } from './style';
import {
  CLUSTER_LAYER,
  POINT_LAYER,
  SRC_ID,
  addGeoJsonClusters,
  addPmtilesClusters,
} from './layers';

const PM_SOURCE_LAYER = 'acceslibre';

let map: MlMap | null = null;
let geojsonData: GeoJSON.FeatureCollection | null = null;

export function getMap(): MlMap | null {
  return map;
}

/** Initialise la carte et branche les donnees selon le mode (geojson/pmtiles). */
export async function initMap(
  cfg: DataConfig,
  fc: GeoJSON.FeatureCollection | null,
  onSelect: (place: Place) => void
): Promise<MlMap> {
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  map = new maplibregl.Map({
    container: 'map',
    style: baseStyle(),
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

  if (cfg.mode === 'geojson' && fc) {
    geojsonData = fc;
    addGeoJsonClusters(map, fc);
  } else {
    addPmtilesClusters(map, asset(cfg.source), PM_SOURCE_LAYER);
  }

  wireInteractions(cfg, onSelect);
  return map;
}

function wireInteractions(cfg: DataConfig, onSelect: (place: Place) => void): void {
  if (!map) return;

  // Clic sur une grappe -> zoom (geojson : expansion native ; sinon zoom simple)
  map.on('click', CLUSTER_LAYER, async (e) => {
    const feat = e.features?.[0];
    if (!feat) return;
    const coords = (feat.geometry as GeoJSON.Point).coordinates as [number, number];
    if (cfg.mode === 'geojson') {
      const src = map!.getSource(SRC_ID) as GeoJSONSource;
      const clusterId = feat.properties?.cluster_id;
      const zoom = await src.getClusterExpansionZoom(clusterId);
      map!.easeTo({ center: coords, zoom });
    } else {
      map!.easeTo({ center: coords, zoom: Math.min((map!.getZoom() || 5) + 2.5, 18) });
    }
  });

  map.on('click', POINT_LAYER, (e) => {
    const feat = e.features?.[0];
    if (!feat) return;
    const [lng, lat] = (feat.geometry as GeoJSON.Point).coordinates as [number, number];
    onSelect({ properties: feat.properties as unknown as PlaceProperties, lng, lat });
  });

  for (const layer of [CLUSTER_LAYER, POINT_LAYER]) {
    map.on('mouseenter', layer, () => (map!.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map!.getCanvas().style.cursor = ''));
  }
}

/** Recalcule l'affichage apres changement de filtres. */
export function applyFilters(cfg: DataConfig): void {
  if (!map) return;
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
