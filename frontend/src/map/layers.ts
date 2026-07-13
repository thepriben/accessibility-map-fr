import type { ExpressionSpecification, Map as MlMap } from 'maplibre-gl';

export const SRC_ID = 'places';
export const CLUSTER_LAYER = 'clusters';
export const CLUSTER_COUNT_LAYER = 'cluster-count';
export const POINT_LAYER = 'unclustered';

/**
 * Icone d'epingle d'un node isole selon l'accessibilite fauteuil.
 * Palette sans vert (bleu / orange / ardoise) pour ne pas confondre avec les
 * grappes et rester lisible.
 */
const pinImage: ExpressionSpecification = [
  'case',
  ['==', ['get', 'wheelchairEntrance'], true],
  'pin-ok',
  ['==', ['get', 'wheelchairEntrance'], false],
  'pin-no',
  'pin-unknown',
];

// Grappes : degrade indigo (pas de vert), taille selon le nombre de points.
const clusterColor: ExpressionSpecification = [
  'step',
  ['get', 'point_count'],
  '#a5b4fc',
  25,
  '#6366f1',
  100,
  '#4338ca',
];

const PINS: { id: string; color: string }[] = [
  { id: 'pin-ok', color: '#2563eb' },
  { id: 'pin-no', color: '#ea580c' },
  { id: 'pin-unknown', color: '#64748b' },
];

/**
 * Dessine une epingle (goutte + pastille blanche) sur un canvas et l'enregistre
 * comme image de la carte. Repere non ambigu pour un lieu unitaire.
 */
function pinImageData(color: string): { width: number; height: number; data: Uint8ClampedArray } {
  const s = 2; // rendu 2x pour la nettete (pixelRatio: 2)
  const w = 26 * s;
  const h = 34 * s;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  const cx = w / 2;
  const cy = 13 * s;
  const r = 11 * s;

  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0, false);
  ctx.lineTo(cx, h - s);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2 * s;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, 4.2 * s, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data };
}

function ensurePinIcons(map: MlMap): void {
  for (const { id, color } of PINS) {
    if (!map.hasImage(id)) {
      map.addImage(id, pinImageData(color), { pixelRatio: 2 });
    }
  }
}

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
  ensurePinIcons(map);

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
    type: 'symbol',
    source: SRC_ID,
    ...src,
    filter: ['!', hasCount],
    layout: {
      'icon-image': pinImage,
      'icon-size': 1,
      'icon-anchor': 'bottom',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
}
