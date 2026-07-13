/**
 * Construit les tuiles vectorielles PMTiles a partir du GeoJSON Acceslibre.
 *
 * Necessite `tippecanoe` (>=2.x, qui ecrit directement du .pmtiles) installe
 * sur la machine / le runner CI. On agrege les points en grappes aux zooms bas
 * (--cluster-distance) puisque MapLibre ne clusterise pas nativement les
 * sources vectorielles ; `point_count` est accumule pour styliser les grappes.
 *
 * Usage : node src/build-pmtiles.mjs [in.geojson] [out.pmtiles]
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const input = resolve(process.argv[2] || resolve(__dirname, '../out/acceslibre.geojson'));
const output = resolve(process.argv[3] || resolve(__dirname, '../../frontend/public/data/acceslibre.pmtiles'));

if (!existsSync(input)) {
  console.error(`Introuvable : ${input}. Lance d'abord fetch:acceslibre.`);
  process.exit(1);
}

const check = spawnSync('tippecanoe', ['--version'], { encoding: 'utf8' });
if (check.error) {
  console.error(
    "tippecanoe introuvable. Installe-le (brew install tippecanoe / apt) — il tourne surtout en CI."
  );
  process.exit(1);
}

const args = [
  '-o',
  output,
  '--force',
  '-l',
  'acceslibre',
  '-n',
  'Acceslibre',
  '--attribution',
  'Acceslibre (Etalab 2.0)',
  // Grappes agregees aux zooms bas, declustering complet au zoom rue (-z 16).
  '-Z',
  '3',
  '-z',
  '16',
  '--cluster-distance=45',
  '--accumulate-attribute=point_count:sum',
  '--drop-densest-as-needed',
  '--extend-zooms-if-still-dropping',
  input,
];

process.stderr.write(`tippecanoe ${args.join(' ')}\n`);
const run = spawnSync('tippecanoe', args, { stdio: 'inherit' });
process.exit(run.status ?? 0);
