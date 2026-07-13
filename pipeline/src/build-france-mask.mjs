// Construit un "voile hors-France" : un polygone couvrant le monde, troue a
// l'emplacement de la France (metropole + DROM). MapLibre remplit alors tout
// SAUF la France. Source des contours : france-geojson (regions simplifiees),
// qui inclut Guadeloupe, Martinique, Guyane, La Reunion et Mayotte.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC =
  'https://raw.githubusercontent.com/gregoiredavid/france-geojson/master/regions-version-simplifiee.geojson';
const OUT = resolve(__dirname, '../../frontend/public/data/france-mask.geojson');

// Anneau exterieur couvrant le monde (sens horaire).
const WORLD = [
  [-180, -85],
  [180, -85],
  [180, 85],
  [-180, 85],
  [-180, -85],
];

function collectOuterRings(geometry, holes) {
  if (!geometry) return;
  if (geometry.type === 'Polygon') {
    if (geometry.coordinates[0]) holes.push(geometry.coordinates[0]);
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) {
      if (poly[0]) holes.push(poly[0]);
    }
  }
}

async function main() {
  process.stderr.write(`Telechargement contours : ${SRC}\n`);
  const res = await fetch(SRC);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const fc = await res.json();

  const holes = [];
  for (const f of fc.features) collectOuterRings(f.geometry, holes);
  process.stderr.write(`France : ${holes.length} anneaux (metropole + DROM + iles)\n`);

  const mask = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { role: 'hors-france' },
        geometry: { type: 'Polygon', coordinates: [WORLD, ...holes] },
      },
    ],
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(mask));
  process.stderr.write(`Ecrit -> ${OUT}\n`);
}

main().catch((e) => {
  process.stderr.write(String(e) + '\n');
  process.exit(1);
});
