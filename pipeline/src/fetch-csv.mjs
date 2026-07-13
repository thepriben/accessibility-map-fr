/**
 * Import France entiere depuis l'export CSV public d'Acceslibre (data.gouv.fr).
 * Aucune cle requise : la donnee est ouverte (Licence Ouverte / Etalab 2.0).
 *
 * Streame le CSV (~200 Mo), normalise chaque ligne et ecrit un GeoJSON
 * newline-delimited (une Feature par ligne) lu directement par tippecanoe.
 *
 * Usage : node src/fetch-csv.mjs [out.geojson] [--limit N]
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASET_API = 'https://www.data.gouv.fr/api/1/datasets/acceslibre/';

/** Resout l'URL du CSV `acceslibre.csv` (datee) via l'API data.gouv. */
async function resolveCsvUrl() {
  const res = await fetch(DATASET_API);
  if (!res.ok) throw new Error(`data.gouv HTTP ${res.status}`);
  const data = await res.json();
  const r =
    (data.resources || []).find((x) => x.title === 'acceslibre.csv') ||
    (data.resources || []).find((x) => x.format === 'csv');
  if (!r) throw new Error('Ressource CSV Acceslibre introuvable');
  return r.url;
}

function bool(v) {
  if (v === 'True') return true;
  if (v === 'False') return false;
  return null;
}

/** Ligne CSV plate -> proprietes normalisees (memes cles que la version API). */
function rowToFeature(row) {
  const lon = parseFloat(row.longitude);
  const lat = parseFloat(row.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const stepFreeEntrance = bool(row.entree_plain_pied);
  const entranceElevator = bool(row.entree_ascenseur);
  const entranceRamp = bool(row.entree_marches_rampe);
  const entreePmr = bool(row.entree_pmr);
  const wheelchairEntrance =
    entreePmr === true ||
    stepFreeEntrance === true ||
    entranceElevator === true ||
    entranceRamp === true
      ? true
      : stepFreeEntrance === null && entranceElevator === null && entreePmr === null
      ? null
      : false;

  const adresse = [row.numero, row.voie, row.postal_code, row.commune]
    .filter((s) => s && String(s).trim())
    .join(' ');

  const properties = {
    uuid: row.id,
    slug: null,
    nom: row.name,
    activite: row.activite || null,
    activite_slug: null,
    adresse: adresse || null,
    commune: row.commune || null,
    code_insee: row.code_insee || null,
    code_postal: row.postal_code || null,
    web_url: null,
    site_internet: row.site_internet || null,
    stepFreeEntrance,
    wheelchairEntrance,
    accessibleParking: bool(row.stationnement_pmr),
    adaptedToilets: bool(row.sanitaires_adaptes),
    extStepFreePath: bool(row.cheminement_ext_plain_pied),
    audioBeacon: bool(row.entree_balise_sonore),
    guidePath: bool(row.cheminement_ext_bande_guidage),
    hearingEquipment: bool(row.accueil_equipements_malentendants_presence),
    staffTrained: row.accueil_personnels || null,
    callDevice: bool(row.entree_dispositif_appel),
    publicTransport: bool(row.transport_station_presence),
    humanHelp: bool(row.entree_aide_humaine),
  };

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
  const out = resolve(args.find((a) => !a.startsWith('--') && a !== String(limit)) || resolve(__dirname, '../out/acceslibre.geojson'));

  await mkdir(dirname(out), { recursive: true });
  const url = await resolveCsvUrl();
  process.stderr.write(`Telechargement : ${url}\n`);

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`CSV HTTP ${res.status}`);

  const parser = parse({ columns: true, skip_empty_lines: true, relax_quotes: true });
  const sink = createWriteStream(out, { encoding: 'utf8' });

  let kept = 0;
  let total = 0;
  parser.on('readable', () => {
    let row;
    while ((row = parser.read()) !== null) {
      total += 1;
      const f = rowToFeature(row);
      if (f) {
        sink.write(JSON.stringify(f) + '\n');
        kept += 1;
      }
      if (kept % 20000 === 0) process.stderr.write(`\r${kept}/${total} features...`);
      if (kept >= limit) {
        parser.end();
        break;
      }
    }
  });

  await new Promise((res2, rej) => {
    parser.on('error', rej);
    parser.on('end', res2);
    Readable.fromWeb(res.body).pipe(parser);
  });
  await new Promise((r) => sink.end(r));
  process.stderr.write(`\nEcrit ${kept} features (sur ${total} lignes) -> ${out}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
