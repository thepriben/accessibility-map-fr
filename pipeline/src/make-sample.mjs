/**
 * Genere un echantillon GeoJSON (par defaut Paris) directement consommable par
 * le frontend en mode dev, sans PMTiles ni tippecanoe.
 *
 * Sortie : frontend/public/data/sample.geojson (+ data/config.json en mode geojson)
 *
 * Usage : ACCESLIBRE_API_KEY=xxx node src/make-sample.mjs [--commune Paris] [--max-pages 16]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iterErps, erpToFeature } from './lib/acceslibre.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../../frontend/public/data');

async function main() {
  const argv = process.argv;
  let commune = 'Paris';
  let maxPages = 16;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--commune') commune = argv[++i];
    else if (argv[i] === '--max-pages') maxPages = Number(argv[++i]);
  }

  await mkdir(DATA_DIR, { recursive: true });
  const features = [];
  for await (const { results } of iterErps({ params: { commune }, maxPages, pageSize: 50 })) {
    for (const erp of results) {
      const f = erpToFeature(erp, { includeRaw: false });
      if (f) features.push(f);
    }
    process.stderr.write(`\r${features.length} features...`);
  }
  process.stderr.write('\n');

  const fc = { type: 'FeatureCollection', features };
  await writeFile(resolve(DATA_DIR, 'sample.geojson'), JSON.stringify(fc));

  const config = {
    mode: 'geojson',
    source: 'data/sample.geojson',
    generatedAt: new Date().toISOString(),
    label: `Échantillon Acceslibre (${commune})`,
    count: features.length,
    attribution:
      '&copy; <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN</a> / <a href="https://geoservices.ign.fr/" target="_blank" rel="noopener">Géoplateforme</a> &middot; données <a href="https://acceslibre.beta.gouv.fr/" target="_blank" rel="noopener">Acceslibre</a>',
  };
  await writeFile(resolve(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2));
  process.stderr.write(`Echantillon ecrit : ${features.length} features -> ${DATA_DIR}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
