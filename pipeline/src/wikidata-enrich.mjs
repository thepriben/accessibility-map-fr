/**
 * Enrichissement Wikidata (build-time) : recupere, pour une zone (centre+rayon),
 * les batiments notables avec coordonnees, hauteur (P2048), nombre d'etages
 * (P1101), image (P18) et date de mise en service (P571). Sert de cache de
 * jointure avec les footprints OSM (tag `wikidata=Qxxx`).
 *
 * Usage : node src/wikidata-enrich.mjs <lat> <lon> [rayon_km] [out.json]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WDQS = 'https://query.wikidata.org/sparql';

async function main() {
  const lat = Number(process.argv[2]);
  const lon = Number(process.argv[3]);
  const radiusKm = Number(process.argv[4] || 0.5);
  const out = resolve(process.argv[5] || resolve(__dirname, '../out/wikidata-buildings.json'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.error('Usage: node src/wikidata-enrich.mjs <lat> <lon> [rayon_km] [out.json]');
    process.exit(1);
  }

  const query = `
    SELECT ?item ?itemLabel ?coord ?height ?levels ?image ?inception WHERE {
      SERVICE wikibase:around {
        ?item wdt:P625 ?coord .
        bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral .
        bd:serviceParam wikibase:radius "${radiusKm}" .
      }
      ?item wdt:P31/wdt:P279* wd:Q41176 .
      OPTIONAL { ?item wdt:P2048 ?height. }
      OPTIONAL { ?item wdt:P1101 ?levels. }
      OPTIONAL { ?item wdt:P18 ?image. }
      OPTIONAL { ?item wdt:P571 ?inception. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
    } LIMIT 400`;

  const res = await fetch(`${WDQS}?format=json&query=${encodeURIComponent(query)}`, {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': 'access-map/0.1 (github.com/Medialoco/accessibility-map-fr)',
    },
  });
  if (!res.ok) throw new Error(`WDQS HTTP ${res.status}`);
  const data = await res.json();

  const buildings = data.results.bindings.map((b) => {
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord?.value || '');
    return {
      qid: b.item.value.split('/').pop(),
      label: b.itemLabel?.value || null,
      lon: m ? Number(m[1]) : null,
      lat: m ? Number(m[2]) : null,
      height: b.height ? Number(b.height.value) : null,
      levels: b.levels ? Number(b.levels.value) : null,
      image: b.image?.value?.split('/').pop() || null,
      inception: b.inception?.value || null,
    };
  });

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ center: { lat, lon }, radiusKm, buildings }, null, 2));
  process.stderr.write(`${buildings.length} batiments Wikidata -> ${out}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
