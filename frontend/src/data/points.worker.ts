/// <reference lib="webworker" />
// Worker de clustering : detient LA copie des donnees (format colonnaire) et
// fait tout le travail lourd hors du thread principal (plus de gel/crash).
// Il ne renvoie que les grappes/points VISIBLES (quelques centaines d'objets).
import Supercluster from 'supercluster';

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

let data: Columnar | null = null;
let index: Supercluster | null = null;
let activeBits: number[] = [];
let filteredTotal = 0;
// Agrégats par département (recalculés à chaque (re)build) : servent de premier
// niveau de regroupement à l'échelle France, avant les grappes fines.
let deptFeatures: GeoJSON.Feature[] = [];
// Au-delà de ce zoom, on passe des départements aux grappes Supercluster.
const DEPT_MAX_ZOOM = 6;
// Index texte normalise (nom + commune + code postal + activite), construit a la
// premiere recherche pour ne pas ralentir l'init.
let haystack: string[] | null = null;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function ensureHaystack(): void {
  if (haystack) return;
  const d = data!;
  haystack = new Array(d.n);
  for (let i = 0; i < d.n; i += 1) {
    haystack[i] = normalize(`${d.nom[i]} ${d.com[i] || ''} ${d.cp[i] || ''} ${d.act[i] || ''}`);
  }
}

function passes(i: number): boolean {
  const d = data!;
  for (const b of activeBits) if (!((d.v[i] >> b) & 1)) return false;
  return true;
}

/** Code département depuis un code postal (DROM sur 3 chiffres, Corse = 20). */
function deptCode(cp: string): string | null {
  const c = (cp || '').trim();
  if (/^9[78]\d/.test(c)) return c.slice(0, 3);
  if (/^20\d/.test(c)) return '20';
  const two = c.slice(0, 2);
  return /^\d{2}$/.test(two) ? two : null;
}

function abbrev(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function rebuild(): void {
  const d = data!;
  const feats: Supercluster.PointFeature<{ i: number }>[] = [];
  const dept = new Map<string, { c: number; slon: number; slat: number }>();
  filteredTotal = 0;
  for (let i = 0; i < d.n; i += 1) {
    if (activeBits.length && !passes(i)) continue;
    filteredTotal += 1;
    const lon = d.lon[i];
    const lat = d.lat[i];
    feats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { i },
    });
    const code = deptCode(d.cp[i]);
    if (code) {
      const a = dept.get(code) ?? { c: 0, slon: 0, slat: 0 };
      a.c += 1;
      a.slon += lon;
      a.slat += lat;
      dept.set(code, a);
    }
  }
  deptFeatures = [...dept.entries()].map(([code, a]) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [a.slon / a.c, a.slat / a.c] },
    properties: {
      point_count: a.c,
      point_count_abbreviated: abbrev(a.c),
      dept: code,
    },
  }));
  // radius plus petit + maxZoom plus bas => les grappes se separent plus tot,
  // donc moins de clics pour atteindre les etablissements individuels.
  index = new Supercluster({ radius: 45, maxZoom: 15, minZoom: 0 });
  index.load(feats);
}

function decode(i: number): Record<string, unknown> {
  const d = data!;
  const kk = d.k[i];
  const vv = d.v[i];
  const props: Record<string, unknown> = {
    uuid: String(i),
    slug: '',
    nom: d.nom[i] || '',
    activite: d.act[i] || null,
    commune: d.com[i] || null,
    code_postal: d.cp[i] || null,
    adresse: [d.cp[i], d.com[i]].filter(Boolean).join(' ') || null,
  };
  for (let b = 0; b < d.criteria.length; b += 1) {
    props[d.criteria[b]] = (kk >> b) & 1 ? (((vv >> b) & 1) === 1 ? true : false) : null;
  }
  return props;
}

function place(i: number): { properties: Record<string, unknown>; lng: number; lat: number } {
  return { properties: decode(i), lng: data!.lon[i], lat: data!.lat[i] };
}

const post = (msg: unknown): void => (self as unknown as Worker).postMessage(msg);

self.onmessage = async (e: MessageEvent): Promise<void> => {
  const m = e.data as Record<string, unknown>;
  const id = m.id as number;
  try {
    switch (m.type) {
      case 'init': {
        const res = await fetch(m.url as string);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = (await res.json()) as Columnar;
        activeBits = [];
        rebuild();
        post({ type: 'ready', id, count: data.n, criteria: data.criteria });
        break;
      }
      case 'filter': {
        const keys = m.keys as string[];
        activeBits = keys.map((kk) => data!.criteria.indexOf(kk)).filter((b) => b >= 0);
        rebuild();
        post({ type: 'result', id, total: filteredTotal });
        break;
      }
      case 'query': {
        const bbox = m.bbox as [number, number, number, number];
        const zoom = m.zoom as number;
        // A l'echelle France : un regroupement par departement plutot que des
        // grappes fines (vue d'ensemble plus lisible).
        if (zoom <= DEPT_MAX_ZOOM) {
          post({ type: 'features', id, features: deptFeatures });
          break;
        }
        const clusters = index!.getClusters(bbox, zoom);
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
          const [lon, lat] = (c.geometry as GeoJSON.Point).coordinates as [number, number];
          return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: decode(props.i as number) };
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
        const d = data!;
        const limit = m.limit as number;
        let total = 0;
        const places: unknown[] = [];
        for (let i = 0; i < d.n; i += 1) {
          if (activeBits.length && !passes(i)) continue;
          total += 1;
          if (places.length < limit) places.push(place(i));
        }
        post({ type: 'list', id, total, places });
        break;
      }
      case 'listBbox': {
        // Liste des lieux dans l'emprise visible (synchronisee au zoom/pan).
        const [w, s, e, n] = m.bbox as [number, number, number, number];
        const limit = m.limit as number;
        const d = data!;
        let total = 0;
        const places: unknown[] = [];
        for (let i = 0; i < d.n; i += 1) {
          if (activeBits.length && !passes(i)) continue;
          const lon = d.lon[i];
          const lat = d.lat[i];
          if (lon < w || lon > e || lat < s || lat > n) continue;
          total += 1;
          if (places.length < limit) places.push(place(i));
        }
        post({ type: 'listBbox', id, total, places });
        break;
      }
      case 'search': {
        ensureHaystack();
        const tokens = normalize(String(m.q)).split(/\s+/).filter(Boolean);
        const limit = m.limit as number;
        const d = data!;
        let total = 0;
        const places: unknown[] = [];
        if (tokens.length) {
          for (let i = 0; i < d.n; i += 1) {
            const h = haystack![i];
            let ok = true;
            for (const t of tokens) {
              if (!h.includes(t)) {
                ok = false;
                break;
              }
            }
            if (!ok) continue;
            total += 1;
            if (places.length < limit) places.push(place(i));
          }
        }
        post({ type: 'search', id, total, places });
        break;
      }
      case 'place': {
        const i = m.i as number;
        post({ type: 'place', id, place: i >= 0 && i < data!.n ? place(i) : null });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
