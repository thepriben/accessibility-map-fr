/// <reference lib="webworker" />
// Worker de clustering : detient LA copie des donnees et fait tout le travail
// lourd hors du thread principal. Il ne renvoie que les grappes/points VISIBLES
// (quelques centaines d'objets), jamais le jeu complet.
//
// Les donnees arrivent en deux temps, parce qu'elles n'ont pas la meme urgence :
//
//   le socle    coordonnees, criteres d'accessibilite, commune, code postal.
//               Decoupe en tranches d'environ 50 Ko, il permet de dessiner les
//               premieres grappes en une seconde et de chercher par ville ou
//               code postal ; la carte se complete tranche par tranche.
//   les textes  noms et activites. Ils pesent les deux tiers du total et ne
//               servent qu'a l'affichage d'une fiche ou a la recherche par nom :
//               une tranche n'est telechargee que lorsqu'on en a besoin.
//
// Un site deploye avant ce decoupage (ou un jeu de donnees pas encore
// reconstruit) reste servi par l'ancien fichier unique : voir initLegacy.
import Supercluster from 'supercluster';

/** Coordonnees entieres au 1e-5 degre dans le socle (environ un metre). */
const SCALE = 1e5;
/** Marque de format des tranches de socle (voir build-points.mjs). */
const MAGIC = 0x314d4141;
/** Repertoires publies a cote du fichier de points. */
const SOCLE_DIR = 'acceslibre-carte';
const TEXT_DIR = 'acceslibre-textes';

interface Meta {
  v: number;
  n: number;
  /** Nombre de points par tranche. */
  shard: number;
  shards: number;
  criteria: string[];
}

/** Ancien format : un seul fichier, toutes les colonnes ensemble. */
interface Columnar {
  n: number;
  criteria: string[];
  lon: number[];
  lat: number[];
  k: number[];
  v: number[];
  nom: string[];
  act: string[];
  com: string[];
  cp: string[];
}

let meta: Meta | null = null;
let criteria: string[] = [];
let baseDir = '';

let lon = new Float64Array(0);
let lat = new Float64Array(0);
let kMask = new Uint16Array(0);
let vMask = new Uint16Array(0);
let com: string[] = [];
let cp: string[] = [];
let nom: string[] = [];
let act: string[] = [];

/** Tranches de socle et de textes deja en memoire. */
let socleIn: Uint8Array = new Uint8Array(0);
let textIn: Uint8Array = new Uint8Array(0);
let textJobs = new Map<number, Promise<void>>();
/** Nombre de points de socle lus : borne les parcours et sert la progression. */
let loadedPoints = 0;

let index: Supercluster | null = null;
let activeBits: number[] = [];
let filteredTotal = 0;
/** Index texte normalise, rempli tranche par tranche avec les noms. */
let haystack: string[] = [];

const post = (msg: unknown): void => (self as unknown as Worker).postMessage(msg);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Code postal : restaure le 0 initial perdu par le CSV (1700 -> 01700). */
function fixCp(c: string): string {
  return c && /^\d{4}$/.test(c) ? `0${c}` : c || '';
}

function shardOf(i: number): number {
  return Math.floor(i / (meta?.shard || 10000));
}

/** Vrai si le point `i` a ete lu (sa tranche de socle est arrivee). */
function known(i: number): boolean {
  return socleIn[shardOf(i)] === 1;
}

function allocate(n: number, shards: number): void {
  lon = new Float64Array(n);
  lat = new Float64Array(n);
  kMask = new Uint16Array(n);
  vMask = new Uint16Array(n);
  com = new Array(n).fill('');
  cp = new Array(n).fill('');
  nom = new Array(n).fill('');
  act = new Array(n).fill('');
  haystack = new Array(n).fill('');
  socleIn = new Uint8Array(shards);
  textIn = new Uint8Array(shards);
  textJobs = new Map();
  loadedPoints = 0;
}

/**
 * Lit une tranche de socle : ecarts successifs pour les coordonnees, indices de
 * dictionnaire local pour commune et code postal, plans d'octets pour les deux
 * masques de criteres.
 */
function readSocle(s: number, buf: ArrayBuffer): void {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error(`tranche ${s} illisible`);
  const count = dv.getUint32(4, true);
  const dictLen = dv.getUint32(8, true);
  const dict = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, dictLen))) as {
    com: string[];
    cp: string[];
  };
  const cpDict = dict.cp.map(fixCp);
  const bytes = new Uint8Array(buf, 12 + dictLen);

  let p = 0;
  const uint = (): number => {
    let out = 0;
    let scale = 1;
    let b = 0;
    do {
      b = bytes[p];
      p += 1;
      out += (b & 0x7f) * scale;
      scale *= 128;
    } while (b & 0x80);
    return out;
  };
  // Le signe voyage dans le bit de poids faible ; les valeurs depassent la
  // portee des operateurs binaires, d'ou l'arithmetique.
  const int = (): number => {
    const u = uint();
    return u % 2 ? -(u + 1) / 2 : u / 2;
  };

  const from = s * meta!.shard;
  let prev = 0;
  for (let j = 0; j < count; j += 1) {
    prev += int();
    lon[from + j] = prev / SCALE;
  }
  prev = 0;
  for (let j = 0; j < count; j += 1) {
    prev += int();
    lat[from + j] = prev / SCALE;
  }
  for (let j = 0; j < count; j += 1) com[from + j] = dict.com[uint()] ?? '';
  for (let j = 0; j < count; j += 1) cp[from + j] = cpDict[uint()] ?? '';

  const kLo = p;
  const kHi = p + count;
  const vLo = p + count * 2;
  const vHi = p + count * 3;
  for (let j = 0; j < count; j += 1) {
    kMask[from + j] = bytes[kLo + j] | (bytes[kHi + j] << 8);
    vMask[from + j] = bytes[vLo + j] | (bytes[vHi + j] << 8);
  }

  for (let j = 0; j < count; j += 1) {
    haystack[from + j] = normalize(`${com[from + j]} ${cp[from + j]}`);
  }

  socleIn[s] = 1;
  loadedPoints += count;
}

/** Lit une tranche de textes (noms + activites en dictionnaire local). */
function readText(s: number, payload: { nom: string[]; actDict: string[]; act: number[] }): void {
  const from = s * meta!.shard;
  for (let j = 0; j < payload.nom.length; j += 1) {
    const i = from + j;
    nom[i] = payload.nom[j] || '';
    act[i] = payload.actDict[payload.act[j]] || '';
    haystack[i] = normalize(`${nom[i]} ${com[i]} ${cp[i]} ${act[i]}`);
  }
  textIn[s] = 1;
}

function passes(i: number): boolean {
  for (const b of activeBits) if (!((vMask[i] >> b) & 1)) return false;
  return true;
}

/** Reconstruit l'index de grappes sur les points connus a cet instant. */
function rebuild(): void {
  const feats: Supercluster.PointFeature<{ i: number }>[] = [];
  filteredTotal = 0;
  const shards = socleIn.length;
  const per = meta?.shard ?? 0;
  for (let s = 0; s < shards; s += 1) {
    if (!socleIn[s]) continue;
    const from = s * per;
    const to = Math.min(from + per, meta!.n);
    for (let i = from; i < to; i += 1) {
      if (activeBits.length && !passes(i)) continue;
      filteredTotal += 1;
      feats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon[i], lat[i]] },
        properties: { i },
      });
    }
  }
  // radius plus petit + maxZoom plus bas => les grappes se separent plus tot,
  // donc moins de clics pour atteindre les etablissements individuels.
  index = new Supercluster({ radius: 45, maxZoom: 15, minZoom: 0 });
  index.load(feats);
}

// Reconstruire l'index coute quelques centaines de millisecondes sur la France
// entiere : on ne le refait donc pas a chaque tranche, mais par paliers.
let lastBuild = 0;
function rebuildThrottled(force: boolean): void {
  const now = Date.now();
  if (!force && now - lastBuild < 1500) return;
  lastBuild = now;
  rebuild();
  post({ type: 'grown', loaded: loadedPoints, total: meta?.n ?? loadedPoints });
}

function decode(i: number): Record<string, unknown> {
  const kk = kMask[i];
  const vv = vMask[i];
  const props: Record<string, unknown> = {
    uuid: String(i),
    // Position dans le jeu de donnees : c'est par elle que l'on retrouve
    // l'identifiant Acceslibre, publie a part (voir data/acceslibre.ts).
    srcIndex: i,
    slug: '',
    nom: nom[i] || '',
    activite: act[i] || null,
    commune: com[i] || null,
    code_postal: cp[i] || null,
    adresse: [cp[i], com[i]].filter(Boolean).join(' ') || null,
  };
  for (let b = 0; b < criteria.length; b += 1) {
    props[criteria[b]] = (kk >> b) & 1 ? (((vv >> b) & 1) === 1 ? true : false) : null;
  }
  return props;
}

function place(i: number): { properties: Record<string, unknown>; lng: number; lat: number } {
  return { properties: decode(i), lng: lon[i], lat: lat[i] };
}

/** Telecharge la tranche de textes d'un point, une seule fois. */
function ensureText(s: number): Promise<void> {
  if (!meta || textIn[s]) return Promise.resolve();
  const running = textJobs.get(s);
  if (running) return running;
  const job = fetch(`${baseDir}/${TEXT_DIR}/${String(s).padStart(4, '0')}.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((payload) => {
      if (payload) readText(s, payload as { nom: string[]; actDict: string[]; act: number[] });
    })
    .catch(() => {
      // Sans nom, la fiche reste utilisable (commune, code postal, criteres) :
      // on n'interrompt pas le parcours pour autant.
    });
  textJobs.set(s, job);
  return job;
}

/**
 * Textes des points cites, pour que la liste et les fiches soient completes.
 * Le nombre de tranches est borne : une liste etalee sur toute la France ne doit
 * pas declencher dix telechargements avant de s'afficher.
 */
async function ensureTextFor(indices: number[], maxShards = 4): Promise<void> {
  const wanted = [...new Set(indices.map(shardOf))].filter((s) => !textIn[s]);
  await Promise.all(wanted.slice(0, maxShards).map((s) => ensureText(s)));
  for (const s of wanted.slice(maxShards)) void ensureText(s);
}

/** Charge tous les textes, sans presser : pour la recherche par nom. */
let fullText: Promise<void> | null = null;
function ensureAllText(): Promise<void> {
  if (!meta) return Promise.resolve();
  if (!fullText) {
    fullText = (async () => {
      for (let s = 0; s < meta!.shards; s += 1) {
        if (!textIn[s]) await ensureText(s);
      }
      // La recherche par nom porte enfin sur tout le pays : le thread principal
      // rejoue la recherche affichee pour la completer.
      post({ type: 'progress', loaded: loadedPoints, total: meta!.n, done: true, names: true });
    })();
  }
  return fullText;
}

/** Vrai quand la recherche porte deja sur tous les noms. */
function textComplete(): boolean {
  if (!meta) return true;
  for (let s = 0; s < meta.shards; s += 1) if (!textIn[s]) return false;
  return true;
}

/**
 * Socle par tranches : la premiere suffit pour afficher la carte, les suivantes
 * arrivent en fond et la completent. Renvoie faux si ce decoupage n'est pas
 * publie (le site retombe alors sur l'ancien fichier unique).
 */
async function initSharded(dir: string): Promise<boolean> {
  let head: Meta;
  try {
    const res = await fetch(`${dir}/${SOCLE_DIR}/meta.json`, { cache: 'no-cache' });
    if (!res.ok) return false;
    head = (await res.json()) as Meta;
    if (!head?.n || !head?.shards || !head?.shard) return false;
  } catch {
    return false;
  }

  meta = head;
  criteria = head.criteria;
  baseDir = dir;
  allocate(head.n, head.shards);

  const shard = async (s: number): Promise<void> => {
    const res = await fetch(`${dir}/${SOCLE_DIR}/${String(s).padStart(4, '0')}.bin`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    readSocle(s, await res.arrayBuffer());
  };

  // La premiere tranche d'abord : des qu'elle est la, la carte peut s'afficher.
  await shard(0);
  rebuild();
  return true;
}

/**
 * Suite du socle. Elle n'est lancee qu'une fois la carte affichee : sur une
 * connexion lente, ces trois megaoctets prendraient sinon toute la bande
 * passante et retarderaient de vingt secondes un ecran deja utilisable.
 */
let socleResumed = false;
async function continueSocle(): Promise<void> {
  if (!meta || socleResumed) return;
  socleResumed = true;
  const total = meta.shards;
  let next = 1;
  const worker = async (): Promise<void> => {
    for (;;) {
      const s = next;
      next += 1;
      if (s >= total) return;
      try {
        const res = await fetch(`${baseDir}/${SOCLE_DIR}/${String(s).padStart(4, '0')}.bin`);
        if (res.ok) readSocle(s, await res.arrayBuffer());
      } catch {
        // Tranche manquante : la carte reste incomplete sur cette region plutot
        // que de tout perdre. Le rafraichissement suivant la rattrapera.
      }
      post({ type: 'progress', loaded: loadedPoints, total: meta!.n });
      rebuildThrottled(false);
    }
  };
  // Quatre telechargements en parallele : masque la latence sans saturer.
  await Promise.all([worker(), worker(), worker(), worker()]);
  rebuildThrottled(true);
  post({ type: 'progress', loaded: loadedPoints, total: meta.n, done: true });
  // Les noms peuvent maintenant descendre tranquillement, pour la recherche.
  void ensureAllText();
}

/** Ancien format : un seul fichier contenant toutes les colonnes. */
async function initLegacy(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Donnees introuvables (HTTP ${res.status})`);
  const d = (await res.json()) as Columnar;
  meta = { v: 0, n: d.n, shard: d.n, shards: 1, criteria: d.criteria };
  criteria = d.criteria;
  allocate(d.n, 1);
  for (let i = 0; i < d.n; i += 1) {
    lon[i] = d.lon[i];
    lat[i] = d.lat[i];
    kMask[i] = d.k[i];
    vMask[i] = d.v[i];
    nom[i] = d.nom[i] || '';
    act[i] = d.act[i] || '';
    com[i] = d.com[i] || '';
    cp[i] = fixCp(d.cp[i] || '');
    haystack[i] = normalize(`${nom[i]} ${com[i]} ${cp[i]} ${act[i]}`);
  }
  socleIn[0] = 1;
  textIn[0] = 1;
  loadedPoints = d.n;
  fullText = Promise.resolve();
  rebuild();
}

self.onmessage = async (e: MessageEvent): Promise<void> => {
  const m = e.data as Record<string, unknown>;
  const id = m.id as number;
  try {
    switch (m.type) {
      case 'init': {
        const url = m.url as string;
        const dir = url.slice(0, Math.max(0, url.lastIndexOf('/')));
        const sharded = dir ? await initSharded(dir) : false;
        if (!sharded) await initLegacy(url);
        post({
          type: 'ready',
          id,
          count: meta!.n,
          criteria,
          loaded: loadedPoints,
          partial: loadedPoints < meta!.n,
        });
        // Le reste du socle attend le feu vert du thread principal (message
        // 'resume', envoye des que la carte est a l'ecran). Filet de securite si
        // ce message n'arrive jamais : on s'y met quand meme.
        if (sharded) setTimeout(() => void continueSocle(), 20000);
        break;
      }
      case 'resume': {
        void continueSocle();
        break;
      }
      case 'filter': {
        const keys = m.keys as string[];
        activeBits = keys.map((kk) => criteria.indexOf(kk)).filter((b) => b >= 0);
        rebuild();
        post({ type: 'result', id, total: filteredTotal });
        break;
      }
      case 'query': {
        const bbox = m.bbox as [number, number, number, number];
        const zoom = m.zoom as number;
        const clusters = index!.getClusters(bbox, zoom);
        // Les noms des points visibles sont utiles au clic, pas au dessin : on
        // les demande sans attendre, pour ne pas retarder l'affichage.
        const singles = clusters
          .filter((c) => !(c.properties as Record<string, unknown>).cluster)
          .map((c) => (c.properties as Record<string, unknown>).i as number);
        if (singles.length) void ensureTextFor(singles);
        const features = clusters.map((c) => {
          const props = c.properties as Record<string, unknown>;
          if (props.cluster) {
            return {
              type: 'Feature',
              geometry: c.geometry,
              properties: {
                point_count: props.point_count,
                point_count_abbreviated: props.point_count_abbreviated,
                cluster_id: props.cluster_id,
              },
            };
          }
          return {
            type: 'Feature',
            geometry: c.geometry,
            properties: decode(props.i as number),
          };
        });
        post({ type: 'features', id, features });
        break;
      }
      case 'expansion': {
        let zoom = 20;
        try {
          zoom = index!.getClusterExpansionZoom(m.clusterId as number);
        } catch {
          /* cluster introuvable : on garde un zoom par defaut */
        }
        post({ type: 'expansion', id, zoom });
        break;
      }
      case 'list': {
        const limit = m.limit as number;
        let total = 0;
        const picked: number[] = [];
        for (let i = 0; i < meta!.n; i += 1) {
          if (!known(i)) continue;
          if (activeBits.length && !passes(i)) continue;
          total += 1;
          if (picked.length < limit) picked.push(i);
        }
        await ensureTextFor(picked);
        post({ type: 'list', id, total, places: picked.map(place) });
        break;
      }
      case 'listBbox': {
        // Liste des lieux dans l'emprise visible (synchronisee au zoom/pan).
        const [w, s, e2, n2] = m.bbox as [number, number, number, number];
        const limit = m.limit as number;
        let total = 0;
        const picked: number[] = [];
        for (let i = 0; i < meta!.n; i += 1) {
          if (!known(i)) continue;
          if (activeBits.length && !passes(i)) continue;
          if (lon[i] < w || lon[i] > e2 || lat[i] < s || lat[i] > n2) continue;
          total += 1;
          if (picked.length < limit) picked.push(i);
        }
        await ensureTextFor(picked);
        post({ type: 'listBbox', id, total, places: picked.map(place) });
        break;
      }
      case 'search': {
        const tokens = normalize(String(m.q)).split(/\s+/).filter(Boolean);
        const limit = m.limit as number;
        let total = 0;
        const picked: number[] = [];
        if (tokens.length) {
          for (let i = 0; i < meta!.n; i += 1) {
            if (!known(i)) continue;
            const h = haystack[i];
            let ok = true;
            for (const t of tokens) {
              if (!h.includes(t)) {
                ok = false;
                break;
              }
            }
            if (!ok) continue;
            total += 1;
            if (picked.length < limit) picked.push(i);
          }
        }
        await ensureTextFor(picked);
        // On distingue les deux attentes : tant que le socle descend, des regions
        // entieres manquent ; tant que les noms descendent, seule la recherche par
        // nom est incomplete (ville et code postal, eux, sont deja tous la).
        const placesPartial = loadedPoints < meta!.n;
        const namesPartial = !textComplete();
        if (namesPartial) void ensureAllText();
        post({
          type: 'search',
          id,
          total,
          places: picked.map(place),
          partial: placesPartial,
          namesPartial,
        });
        break;
      }
      case 'place': {
        const i = m.i as number;
        if (i >= 0 && i < meta!.n && known(i)) await ensureText(shardOf(i));
        post({ type: 'place', id, place: i >= 0 && i < meta!.n && known(i) ? place(i) : null });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
