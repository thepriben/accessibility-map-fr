import type { StyleSpecification } from 'maplibre-gl';
import { BASEMAP_TILES, MAP_ATTRIBUTION } from '../config';

/** Style MapLibre minimal : fond raster CARTO Voyager (sobre). */
export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    // Serveur de glyphes fiable (le demo maplibre n'a pas "Open Sans Regular").
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
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
