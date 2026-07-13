// Recherche legere sur Wikidata pour enrichir la fiche d'un lieu avec le
// batiment associe : libelle, description et photo (via Wikimedia Commons).
// On respecte la licence en liant toujours vers la page d'origine du fichier.

export interface WikidataInfo {
  qid: string;
  label: string | null;
  description: string | null;
  /** URL d'affichage (miniature Commons). */
  imageUrl: string | null;
  /** Page d'origine du fichier sur Commons (licence/attribution). */
  imageSourceUrl: string | null;
  /** Page Wikidata de l'entite. */
  wikidataUrl: string;
}

const REST_API = 'https://www.wikidata.org/w/api.php';
const SPARQL_API = 'https://query.wikidata.org/sparql';

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

/** Recupere libelle / description / image d'une entite Wikidata par son QID. */
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

/**
 * Repli : cherche autour des coordonnees une entite Wikidata (avec photo de
 * preference) dans un petit rayon. Rapide et tolerant (timeout court).
 */
export async function findWikidataNear(
  lng: number,
  lat: number,
  radiusKm = 0.06
): Promise<WikidataInfo | null> {
  const sparql = `SELECT ?item ?img WHERE {
    SERVICE wikibase:around {
      ?item wdt:P625 ?loc .
      bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral .
      bd:serviceParam wikibase:radius "${radiusKm}" .
      bd:serviceParam wikibase:distance ?dist .
    }
    OPTIONAL { ?item wdt:P18 ?img . }
  } ORDER BY DESC(BOUND(?img)) ASC(?dist) LIMIT 1`;
  const url = `${SPARQL_API}?query=${encodeURIComponent(sparql)}&format=json`;
  const data = await fetchJson(url, 9000).catch(() => null);
  const row = data?.results?.bindings?.[0];
  if (!row?.item?.value) return null;
  const qid = row.item.value.split('/').pop() as string;
  return getWikidataEntity(qid);
}
