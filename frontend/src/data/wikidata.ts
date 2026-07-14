// Lookup Wikidata FIABLE : uniquement via le QID porté par le bâtiment OSM
// (tag `wikidata`). Pas de recherche géographique approximative (qui renvoyait
// parfois une route). Sert à afficher une image du bâtiment (ex. mairies).

export interface WikidataInfo {
  qid: string;
  label: string | null;
  description: string | null;
  imageUrl: string | null;
  imageSourceUrl: string | null;
  wikidataUrl: string;
}

const REST_API = 'https://www.wikidata.org/w/api.php';

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** URL miniature Commons (via Special:FilePath) + page d'origine (licence). */
function commonsUrls(filename: string): { thumb: string; source: string } {
  const safe = filename.replace(/ /g, '_');
  return {
    thumb: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(safe)}?width=520`,
    source: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(safe)}`,
  };
}

const WDQS = 'https://query.wikidata.org/sparql';

/**
 * Recherche de repli : QID du bâtiment Wikidata le plus proche des coordonnées.
 * On filtre sur les entités « bâtiment » (instance/sous-classe de Q41176) pour
 * écarter les routes et autres objets : quand ça tombe assez près, il y a une
 * bonne chance que ce soit bien le bâtiment visé.
 */
export async function findNearbyBuildingQid(
  lng: number,
  lat: number,
  radiusKm = 0.06
): Promise<string | null> {
  const sparql =
    `SELECT ?item WHERE {` +
    `SERVICE wikibase:around {` +
    `?item wdt:P625 ?loc .` +
    `bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral .` +
    `bd:serviceParam wikibase:radius "${radiusKm}" .` +
    `bd:serviceParam wikibase:distance ?dist .` +
    `}` +
    `?item wdt:P31/wdt:P279* wd:Q41176 .` +
    `} ORDER BY ?dist LIMIT 1`;
  const url = `${WDQS}?format=json&query=${encodeURIComponent(sparql)}`;
  const data = await fetch(url, {
    headers: { Accept: 'application/sparql-results+json' },
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const uri: string | undefined = data?.results?.bindings?.[0]?.item?.value;
  const m = uri?.match(/Q\d+$/);
  return m ? m[0] : null;
}

/** Récupère libellé / description / image (P18) d'une entité Wikidata par QID. */
export async function getWikidataEntity(qid: string): Promise<WikidataInfo | null> {
  if (!/^Q\d+$/.test(qid)) return null;
  const url =
    `${REST_API}?action=wbgetentities&ids=${qid}` +
    `&props=labels|descriptions|claims&languages=fr|en&format=json&origin=*`;
  const data = await fetchJson(url).catch(() => null);
  const ent = data?.entities?.[qid];
  if (!ent) return null;

  const label = ent.labels?.fr?.value ?? ent.labels?.en?.value ?? null;
  const description = ent.descriptions?.fr?.value ?? ent.descriptions?.en?.value ?? null;
  const p18: string | undefined = ent.claims?.P18?.[0]?.mainsnak?.datavalue?.value;

  let imageUrl: string | null = null;
  let imageSourceUrl: string | null = null;
  if (p18) {
    const { thumb, source } = commonsUrls(p18);
    imageUrl = thumb;
    imageSourceUrl = source;
  }

  return {
    qid,
    label,
    description,
    imageUrl,
    imageSourceUrl,
    wikidataUrl: `https://www.wikidata.org/wiki/${qid}`,
  };
}
