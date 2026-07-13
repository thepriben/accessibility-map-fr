import type { StyleSpecification } from 'maplibre-gl';
import { MAP_ATTRIBUTION, asset, basemapTiles } from '../config';

/** Style MapLibre minimal : fond raster CARTO Positron/Dark selon le theme. */
export function baseStyle(theme: string): StyleSpecification {
  return {
    version: 8,
    // Glyphes AUTO-HEBERGES (meme origine) : fiables et sans dependance externe.
    // (fonts.openmaptiles.org renvoyait du HTML -> tuiles illisibles "type 4".)
    glyphs: asset('fonts/{fontstack}/{range}.pbf'),
    sources: {
      basemap: {
        type: 'raster',
        tiles: basemapTiles(theme),
        tileSize: 256,
        attribution: MAP_ATTRIBUTION,
        maxzoom: 20,
      },
    },
    layers: [
      {
        id: 'bg',
        type: 'background',
        paint: { 'background-color': theme === 'dark' ? '#0c0f14' : '#eae7df' },
      },
      { id: 'basemap', type: 'raster', source: 'basemap' },
    ],
  };
}
