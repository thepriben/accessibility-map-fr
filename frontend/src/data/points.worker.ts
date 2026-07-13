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

function passes(i: number): boolean {
  const d = data!;
  for (const b of activeBits) if (!((d.v[i] >> b) & 1)) return false;
  return true;
}

function rebuild(): void {
  const d = data!;
  const feats: Supercluster.PointFeature<{ i: number }>[] = [];
  filteredTotal = 0;
  for (let i = 0; i < d.n; i += 1) {
    if (activeBits.length && !passes(i)) continue;
    filteredTotal += 1;
    feats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [d.lon[i], d.lat[i]] },
      properties: { i },
    });
  }
  index = new Supercluster({ radius: 55, maxZoom: 17, minZoom: 0 });
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
