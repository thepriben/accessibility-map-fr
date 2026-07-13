import type { ExpressionSpecification, Map as MlMap } from 'maplibre-gl';

export const SRC_ID = 'places';
export const CLUSTER_LAYER = 'clusters';
export const CLUSTER_COUNT_LAYER = 'cluster-count';
export const POINT_LAYER = 'unclustered';

/** Couleur d'un point selon l'accessibilite fauteuil (vert / orange / gris). */
const pointColor: ExpressionSpecification = [
  'case',
  ['==', ['get', 'wheelchairEntrance'], true],
  '#1f9d55',
  ['==', ['get', 'wheelchairEntrance'], false],
  '#d97706',
  '#8a94a6',
];

const clusterColor: ExpressionSpecification = [
  'step',
  ['get', 'point_count'],
  '#7cc6a6',
  25,
  '#3f9e78',
  100,
  '#2e7d5b',
];

const clusterRadius: ExpressionSpecification = [
  'step',
  ['get', 'point_count'],
  16,
  25,
  22,
  100,
  30,
];

/** Ajoute une source GeoJSON clusterisee (mode dev / echantillon). */
export function addGeoJsonClusters(map: MlMap, data: GeoJSON.FeatureCollection): void {
  map.addSource(SRC_ID, {
    type: 'geojson',
    data,
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 50,
  });
  addClusterLayers(map);
}

/**
 * Ajoute une source vectorielle PMTiles. Les grappes sont pre-agregees par
 * tippecanoe (attribut `point_count`), donc on style les memes couches en
 * lisant cet attribut plutot que le clustering natif MapLibre.
 */
export function addPmtilesClusters(map: MlMap, pmtilesUrl: string, sourceLayer: string): void {
  map.addSource(SRC_ID, {
    type: 'vector',
    url: `pmtiles://${pmtilesUrl}`,
  });
  addClusterLayers(map, sourceLayer);
}

function addClusterLayers(map: MlMap, sourceLayer?: string): void {
  const src = sourceLayer ? { 'source-layer': sourceLayer } : {};
  const hasCount: ExpressionSpecification = ['has', 'point_count'];

  map.addLayer({
    id: CLUSTER_LAYER,
    type: 'circle',
    source: SRC_ID,
    ...src,
    filter: hasCount,
    paint: {
      'circle-color': clusterColor,
      'circle-radius': clusterRadius,
      'circle-opacity': 0.85,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  });

  map.addLayer({
    id: CLUSTER_COUNT_LAYER,
    type: 'symbol',
    source: SRC_ID,
    ...src,
    filter: hasCount,
    layout: {
      // tippecanoe fournit `point_count` (pas `point_count_abbreviated`).
      // On abrege les gros compteurs (>= 1000) en "Nk".
      'text-field': [
        'step',
        ['get', 'point_count'],
        ['to-string', ['get', 'point_count']],
        1000,
        ['concat', ['to-string', ['round', ['/', ['get', 'point_count'], 1000]]], 'k'],
      ],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
    },
    paint: { 'text-color': '#ffffff' },
  });

  map.addLayer({
    id: POINT_LAYER,
    type: 'circle',
    source: SRC_ID,
    ...src,
    filter: ['!', hasCount],
    paint: {
      'circle-color': pointColor,
      'circle-radius': 6,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff',
    },
  });
}
