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

/** Trajet préparé pour être parcouru : abscisses curvilignes précalculées. */
export interface WalkPath {
  points: P2[];
  /** Distance cumulée à chaque sommet ; `cum[0] = 0`. */
  cum: number[];
  total: number;
}

/** Position et cap le long d'un trajet, à une distance donnée du départ. */
export interface WalkPose {
  x: number;
  z: number;
  /** Vecteur unitaire de la direction du regard. */
  hx: number;
  hz: number;
}

/** Prépare un trajet pour l'échantillonnage : sommets confondus écartés. */
export function measureWalk(points: P2[]): WalkPath {
  const pts: P2[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-3) pts.push(p);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { points: pts, cum, total: cum[cum.length - 1] ?? 0 };
}

/** Point du trajet à l'abscisse `d`, bornée aux extrémités. */
function pointAt(w: WalkPath, d: number): P2 {
  const { points, cum, total } = w;
  if (points.length === 0) return [0, 0];
  if (points.length === 1 || total === 0) return points[0];
  const t = Math.min(Math.max(d, 0), total);
  let i = 1;
  while (i < cum.length - 1 && cum[i] < t) i += 1;
  const seg = cum[i] - cum[i - 1] || 1;
  const k = (t - cum[i - 1]) / seg;
  return [
    points[i - 1][0] + (points[i][0] - points[i - 1][0]) * k,
    points[i - 1][1] + (points[i][1] - points[i - 1][1]) * k,
  ];
}

/**
 * Position et cap à l'abscisse `d`.
 *
 * Le cap ne suit pas le segment courant mais vise un point situé `lookAhead`
 * mètres plus loin : sur un trottoir découpé en petits tronçons, suivre chaque
 * segment ferait tressauter la vue à chaque sommet.
 */
export function sampleWalk(w: WalkPath, d: number, lookAhead = 4): WalkPose {
  const here = pointAt(w, d);
  // En fin de parcours, on garde le cap des derniers mètres plutôt que de
  // pivoter au hasard sur un vecteur nul.
  const ahead =
    d + lookAhead <= w.total ? pointAt(w, d + lookAhead) : pointAt(w, w.total);
  let hx = ahead[0] - here[0];
  let hz = ahead[1] - here[1];
  let len = Math.hypot(hx, hz);
  if (len < 1e-6) {
    const back = pointAt(w, Math.max(w.total - lookAhead, 0));
    hx = w.points.length > 1 ? here[0] - back[0] : 1;
    hz = w.points.length > 1 ? here[1] - back[1] : 0;
    len = Math.hypot(hx, hz) || 1;
  }
  return { x: here[0], z: here[1], hx: hx / len, hz: hz / len };
}

/**
 * Point de l'empreinte d'un bâtiment le plus proche du réseau piéton, décalé de
 * `out` mètres vers l'extérieur.
 *
 * Sert de destination quand OpenStreetMap ne cartographie aucune entrée : viser
 * le point Access'libre ferait aboutir le trajet au milieu du bâtiment, alors
 * que la façade donnant sur le cheminement est presque toujours celle où se
 * trouve la porte.
 */
export function frontDoorGuess(ring: P2[], lines: RouteLine[], out = 1.2): P2 | null {
  if (ring.length < 3) return null;
  // On mesure la distance aux segments, pas à leurs extrémités : le long d'une
  // rue droite, les seuls sommets peuvent se trouver à cent mètres de là.
  const segs: [P2, P2][] = [];
  for (const l of lines)
    for (let i = 0; i < l.points.length - 1; i += 1) segs.push([l.points[i], l.points[i + 1]]);
  if (!segs.length) return null;

  let cx = 0;
  let cy = 0;
  for (const [x, y] of ring) {
    cx += x;
    cy += y;
  }
  cx /= ring.length;
  cy /= ring.length;

  // On choisit une façade entière, pas un point : viser le sommet le plus
  // proche ferait aboutir le trajet dans un angle du bâtiment.
  let best: P2 | null = null;
  let bestD = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let d = Infinity;
    for (const [p, q] of segs) d = Math.min(d, distToSegment(mid, p, q));
    if (d < bestD) {
      bestD = d;
      // Décalage perpendiculaire à la façade, du côté opposé au centre.
      const nx = -(b[1] - a[1]);
      const ny = b[0] - a[0];
      const len = Math.hypot(nx, ny) || 1;
      const s = (mid[0] - cx) * nx + (mid[1] - cy) * ny >= 0 ? 1 : -1;
      best = [mid[0] + (s * nx * out) / len, mid[1] + (s * ny * out) / len];
    }
  }
  return best;
}

/** Distance d'un point au segment [a, b]. */
function distToSegment(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
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
