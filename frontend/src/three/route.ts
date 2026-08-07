/**
 * Itinéraire piéton dans le voisinage, sans dépendance à Three.js.
 *
 * Le réseau OSM du quartier (trottoirs, cheminements, passages piétons,
 * escaliers) est transformé en graphe, puis parcouru au plus court entre deux
 * points de la scène. C'est ce qui permet de montrer, par exemple, le trajet
 * entre la place PMR la plus proche et l'arrêt de bus le plus proche.
 *
 * Deux partis pris :
 *  - les sommets sont recalés sur une grille de 50 cm, sinon deux tronçons OSM
 *    qui se rejoignent à quelques centimètres près resteraient déconnectés ;
 *  - les escaliers ne sont pas interdits mais fortement pénalisés : le trajet
 *    les contourne dès qu'un détour raisonnable existe, sans pour autant
 *    échouer là où ils sont l'unique passage.
 */
import { pathLength, type P2 } from './orient';

/** Tronçon utilisable par le calcul, avec son coût relatif. */
export interface RouteLine {
  points: P2[];
  /** 1 = cheminement ordinaire ; au-delà, le trajet préfère l'éviter. */
  cost?: number;
}

export interface RouteResult {
  /** Polyligne du trajet, du départ à l'arrivée. */
  points: P2[];
  /** Longueur réellement parcourue (m). */
  length: number;
  /**
   * Vrai quand aucun cheminement ne relie les deux points : on retombe alors
   * sur une liaison directe, qu'il faut présenter comme telle.
   */
  direct: boolean;
}

/** Taille de la grille de recalage des sommets (m). */
const SNAP = 0.5;

const key = (x: number, y: number): string =>
  `${Math.round(x / SNAP)}|${Math.round(y / SNAP)}`;

interface Graph {
  coords: P2[];
  adj: { to: number; w: number }[][];
}

function buildGraph(lines: RouteLine[]): Graph {
  const index = new Map<string, number>();
  const coords: P2[] = [];
  const adj: { to: number; w: number }[][] = [];

  const node = (p: P2): number => {
    const k = key(p[0], p[1]);
    const found = index.get(k);
    if (found !== undefined) return found;
    const id = coords.length;
    index.set(k, id);
    coords.push(p);
    adj.push([]);
    return id;
  };

  for (const line of lines) {
    const cost = line.cost ?? 1;
    for (let i = 0; i < line.points.length - 1; i += 1) {
      const a = node(line.points[i]);
      const b = node(line.points[i + 1]);
      if (a === b) continue;
      const w =
        Math.hypot(coords[b][0] - coords[a][0], coords[b][1] - coords[a][1]) * cost;
      adj[a].push({ to: b, w });
      adj[b].push({ to: a, w });
    }
  }
  return { coords, adj };
}

/** Sommet le plus proche d'un point, et sa distance. */
function nearestNode(g: Graph, p: P2): { id: number; dist: number } | null {
  let id = -1;
  let best = Infinity;
  for (let i = 0; i < g.coords.length; i += 1) {
    const d = Math.hypot(g.coords[i][0] - p[0], g.coords[i][1] - p[1]);
    if (d < best) {
      best = d;
      id = i;
    }
  }
  return id < 0 ? null : { id, dist: best };
}

/**
 * Dijkstra. Le voisinage tient en quelques milliers de sommets : un balayage
 * linéaire du plus proche non visité suffit, et évite d'embarquer un tas.
 */
function dijkstra(g: Graph, start: number, goal: number): number[] | null {
  const n = g.coords.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[start] = 0;

  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i += 1) {
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0) return null;
    if (u === goal) break;
    done[u] = 1;
    for (const e of g.adj[u]) {
      const alt = dist[u] + e.w;
      if (alt < dist[e.to]) {
        dist[e.to] = alt;
        prev[e.to] = u;
      }
    }
  }

  const path: number[] = [];
  for (let v = goal; v >= 0; v = prev[v]) path.push(v);
  return path.reverse();
}

/**
 * Trajet au plus court entre deux points de la scène, en suivant le réseau
 * piéton. `snap` borne la distance acceptable entre un point et le réseau :
 * au-delà, rattacher le trajet au cheminement le plus proche raconterait
 * n'importe quoi, et on renvoie une liaison directe.
 */
export function findRoute(
  lines: RouteLine[],
  from: P2,
  to: P2,
  snap = 35
): RouteResult {
  const direct = (): RouteResult => ({
    points: [from, to],
    length: Math.hypot(to[0] - from[0], to[1] - from[1]),
    direct: true,
  });

  const usable = lines.filter((l) => l.points.length >= 2);
  if (!usable.length) return direct();

  const g = buildGraph(usable);
  const a = nearestNode(g, from);
  const b = nearestNode(g, to);
  if (!a || !b || a.dist > snap || b.dist > snap || a.id === b.id) return direct();

  const ids = dijkstra(g, a.id, b.id);
  if (!ids || ids.length < 2) return direct();

  // Les amorces relient le point réel au réseau : sans elles, le trajet
  // démarrerait à côté de la place de stationnement.
  const points: P2[] = [from, ...ids.map((i) => g.coords[i]), to];
  return { points, length: pathLength(points), direct: false };
}
