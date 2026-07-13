import type { StyleSpecification } from 'maplibre-gl';
import { BASEMAP_TILES, MAP_ATTRIBUTION } from '../config';

/** Style MapLibre minimal : fond raster CARTO Voyager (sobre). */
export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      basemap: {
        type: 'raster',
        tiles: BASEMAP_TILES,
        tileSize: 256,
        attribution: MAP_ATTRIBUTION,
        maxzoom: 19,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#eef1f4' } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
    ],
  };
}
