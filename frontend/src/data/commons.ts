// Recherche d'une photo Wikimedia Commons à proximité (geosearch). Plus fiable
// et pertinent qu'une entité Wikidata voisine (qui pouvait renvoyer une route).
// On lie toujours vers la page d'origine du fichier (licence / attribution).

export interface CommonsPhoto {
  thumbUrl: string;
  sourceUrl: string;
  title: string;
  license: string | null;
}

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

const SKIP = /\.(svg|pdf|ogg|oga|ogv|webm|wav|mp3|tif|tiff)$/i;

/** Retourne une photo Commons proche des coordonnées, ou null si aucune. */
export async function findNearbyCommonsPhoto(
  lng: number,
  lat: number,
  radiusM = 300
): Promise<CommonsPhoto | null> {
  const url =
    'https://commons.wikimedia.org/w/api.php?origin=*&format=json&action=query' +
    `&generator=geosearch&ggscoord=${lat}|${lng}&ggsradius=${radiusM}&ggslimit=15&ggsnamespace=6` +
    '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=520';
  const data = await fetchJson(url).catch(() => null);
  const pages = data?.query?.pages;
  if (!pages) return null;

  for (const p of Object.values(pages) as any[]) {
    const ii = p?.imageinfo?.[0];
    if (!ii?.thumburl) continue;
    const title = String(p.title || '');
    if (SKIP.test(title)) continue;
    const meta = ii.extmetadata || {};
    return {
      thumbUrl: ii.thumburl,
      sourceUrl: ii.descriptionurl || ii.url,
      title: title.replace(/^File:/, ''),
      license: meta.LicenseShortName?.value ?? null,
    };
  }
  return null;
}
