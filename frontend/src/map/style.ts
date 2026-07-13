import type { StyleSpecification } from 'maplibre-gl';
import { BASEMAP_TILES, MAP_ATTRIBUTION, asset } from '../config';

/** Style MapLibre minimal : fond raster Plan IGN (sobre, francais). */
export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    // Glyphes AUTO-HEBERGES (meme origine) : fiables et sans dependance externe.
    // (fonts.openmaptiles.org renvoyait du HTML -> tuiles illisibles "type 4".)
    glyphs: asset('fonts/{fontstack}/{range}.pbf'),
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
