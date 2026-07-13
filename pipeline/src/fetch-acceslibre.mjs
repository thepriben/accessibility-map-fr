/**
 * Recupere l'integralite (ou un sous-ensemble filtre) des ERP Acceslibre et
 * ecrit un GeoJSON compact dans pipeline/out/acceslibre.geojson (NDJSON possible).
 *
 * Usage :
 *   ACCESLIBRE_API_KEY=xxx node src/fetch-acceslibre.mjs [--commune Paris] [--max-pages N]
 *
 * La sortie ne contient jamais la cle API.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iterErps, erpToFeature } from './lib/acceslibre.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../out');

function parseArgs(argv) {
  const args = { params: {}, maxPages: Infinity };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--commune') args.params.commune = argv[++i];
    else if (a === '--code-postal') args.params.code_postal = argv[++i];
    else if (a === '--q') args.params.q = argv[++i];
    else if (a === '--max-pages') args.maxPages = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const { params, maxPages } = parseArgs(process.argv);
  await mkdir(OUT_DIR, { recursive: true });

  const features = [];
  let total = 0;
  for await (const { results, count } of iterErps({ params, maxPages, pageSize: 50 })) {
    total = count;
    for (const erp of results) {
      const f = erpToFeature(erp);
      if (f) features.push(f);
    }
    process.stderr.write(`\r${features.length} / ${total} ERP recuperes...`);
  }
  process.stderr.write('\n');

  const fc = { type: 'FeatureCollection', features };
  const outPath = resolve(OUT_DIR, 'acceslibre.geojson');
  await writeFile(outPath, JSON.stringify(fc));
  process.stderr.write(`Ecrit ${features.length} features -> ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
