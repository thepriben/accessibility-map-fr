import type { StyleSpecification } from 'maplibre-gl';
import {
  BASEMAP_DETAIL_MAX_ZOOM,
  BASEMAP_DETAIL_TILES,
  BASEMAP_MAX_ZOOM,
  MAP_ATTRIBUTION,
  asset,
  basemapLabelTiles,
  basemapTiles,
} from '../config';

/** Style MapLibre minimal : fond raster Esri Gray Canvas selon le theme. */
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
        maxzoom: BASEMAP_MAX_ZOOM,
      },
      'basemap-labels': {
        type: 'raster',
        tiles: basemapLabelTiles(theme),
        tileSize: 256,
        maxzoom: BASEMAP_MAX_ZOOM,
      },
      'basemap-detail': {
        type: 'raster',
        tiles: BASEMAP_DETAIL_TILES,
        tileSize: 256,
        minzoom: BASEMAP_MAX_ZOOM,
        maxzoom: BASEMAP_DETAIL_MAX_ZOOM,
      },
    },
    layers: [
      {
        id: 'bg',
        type: 'background',
        paint: { 'background-color': theme === 'dark' ? '#0c0f14' : '#eae7df' },
      },
      { id: 'basemap', type: 'raster', source: 'basemap' },
      {
        id: 'basemap-labels',
        type: 'raster',
        source: 'basemap-labels',
        // Au-dela, ces libelles agrandis ne sont plus que des taches ; le Plan
        // IGN porte les siens, nets.
        maxzoom: BASEMAP_MAX_ZOOM + 1,
      },
      {
        id: 'basemap-detail',
        type: 'raster',
        source: 'basemap-detail',
        minzoom: BASEMAP_MAX_ZOOM,
        paint: {
          // Le Plan IGN est colore, la carte ne l'est pas : ramene au gris et
          // eclairci, il prolonge le rendu Esri au lieu de le trancher. (Les
          // reglages visent le theme clair, le seul rendu par `getTheme`.)
          'raster-saturation': -1,
          'raster-contrast': -0.28,
          'raster-brightness-min': 0.42,
          // Fondu sur un niveau : la bascule d'un fond a l'autre ne se voit pas.
          'raster-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            BASEMAP_MAX_ZOOM,
            0,
            BASEMAP_MAX_ZOOM + 1,
            1,
          ],
        },
      },
    ],
  };
}
