/**
 * Géométrie d'orientation de la scène 3D, sans dépendance à Three.js : de quel
 * côté et dans quel sens poser un objet (place de stationnement, banc, armoire)
 * à partir de la voirie, d'une empreinte OSM ou d'un tag `direction`.
 *
 * Convention du repère local (voir `projector` dans scene3d) : x = est,
 * z = sud, et les objets « regardent » vers +Z. Une rotation Y de θ envoie
 * l'axe local +X sur (cos θ, −sin θ) et l'axe local +Z sur (sin θ, cos θ).
 */

/** Point du plan local, en mètres depuis le lieu visé. */
export type P2 = [number, number];

/** Longueur cumulée (m) d'une polyligne locale. */
export function pathLength(points: P2[]): number {
  let d = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    d += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  }
  return d;
}

/**
 * Tronçons d'une polyligne restant dans le rayon affiché. Évite qu'une ligne de
 * bus ne file jusqu'à l'autre bout de la ville, hors du voisinage.
 */
export function clipToRadius(points: P2[], radius: number): P2[][] {
  const runs: P2[][] = [];
  let cur: P2[] = [];
  for (const p of points) {
    if (Math.hypot(p[0], p[1]) <= radius) cur.push(p);
    else {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/** Position et direction locale à une distance donnée le long d'une polyligne. */
export interface AlongPoint {
  x: number;
  z: number;
  /** Direction unitaire du segment courant. */
  ux: number;
  uz: number;
}

/**
 * Point situé à `dist` mètres du début d'une polyligne. Sert à répartir
 * régulièrement les marches d'un escalier ou les poteaux d'une main courante.
 * Au-delà de la longueur totale, renvoie l'extrémité.
 */
export function pointAlong(points: P2[], dist: number): AlongPoint | null {
  if (points.length < 2) return null;
  let acc = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-9) continue;
    if (acc + len >= dist) {
      const t = (dist - acc) / len;
      return {
        x: x0 + (x1 - x0) * t,
        z: z0 + (z1 - z0) * t,
        ux: (x1 - x0) / len,
        uz: (z1 - z0) / len,
      };
    }
    acc += len;
  }
  const [xa, za] = points[points.length - 2];
  const [xb, zb] = points[points.length - 1];
  const len = Math.hypot(xb - xa, zb - za) || 1;
  return { x: xb, z: zb, ux: (xb - xa) / len, uz: (zb - za) / len };
}

/**
 * Ferme un anneau (dernier point = premier) pour le traiter comme une
 * polyligne, et pouvoir chercher le point de façade le plus proche.
 */
export function closeRing(ring: P2[]): P2[] {
  if (ring.length < 2) return ring;
  const [fx, fz] = ring[0];
  const [lx, lz] = ring[ring.length - 1];
  return fx === lx && fz === lz ? ring : [...ring, [fx, fz]];
}

/** Rotation Y alignant l'axe local +X sur la direction (dx, dz). */
export function alignX(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

/**
 * Rotation Y faisant regarder un objet vers l'azimut donné (0 = nord,
 * 90 = est), c'est-à-dire orientant son axe +Z dans cette direction.
 */
export function faceBearing(bearingDeg: number): number {
  return Math.PI - (bearingDeg * Math.PI) / 180;
}

/**
 * De quel côté transversal (+1 = +Z local) se trouve un vecteur monde une fois
 * l'objet tourné de `angle`. Permet de poser le poteau côté rue et l'abri côté
 * trottoir, ou de tourner un banc vers le cheminement.
 */
export function localSideZ(dx: number, dz: number, angle: number): number {
  return dx * Math.sin(angle) + dz * Math.cos(angle) >= 0 ? 1 : -1;
}

export interface OrientedBox {
  cx: number;
  cz: number;
  /** Rotation Y alignant +X local sur le grand côté mesuré par `width`. */
  angle: number;
  width: number;
  depth: number;
}

/**
 * Boîte orientée (d'aire minimale) englobant un anneau : donne l'orientation
 * réelle d'une place de stationnement cartographiée en surface. On teste les
 * directions portées par chaque côté et on garde la plus compacte.
 */
export function orientedBox(ring: P2[]): OrientedBox | null {
  if (ring.length < 3) return null;
  let best: (OrientedBox & { area: number }) | null = null;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, z] of ring) {
      const u = x * ux + z * uz;
      const v = -x * uz + z * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const width = maxU - minU;
    const depth = maxV - minV;
    const area = width * depth;
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        area,
        angle: alignX(ux, uz),
        width,
        depth,
        cx: cu * ux - cv * uz,
        cz: cu * uz + cv * ux,
      };
    }
  }
  return best;
}

export interface NearestLine {
  /** Rotation Y alignant +X local sur la direction du segment. */
  angle: number;
  dist: number;
  /** Projeté du point sur le segment le plus proche. */
  px: number;
  pz: number;
}

/**
 * Segment le plus proche parmi des polylignes. Sert à orienter les places de
 * stationnement, les bancs et le mobilier sur la voie voisine.
 */
export function nearestLineDir(x: number, z: number, lines: P2[][]): NearestLine | null {
  let best: NearestLine | null = null;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const [x0, z0] = line[i];
      const [x1, z1] = line[i + 1];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / len2));
      const px = x0 + dx * t;
      const pz = z0 + dz * t;
      const dist = Math.hypot(x - px, z - pz);
      if (!best || dist < best.dist) best = { angle: alignX(dx, dz), dist, px, pz };
    }
  }
  return best;
}

/**
 * Orientation et gabarit d'une place de stationnement, par ordre de fiabilité :
 * son empreinte OSM, sinon le parking qui la contient (véhicules rangés en
 * bataille, donc perpendiculairement au grand axe de l'emprise), sinon la rue
 * voisine (stationnement longitudinal).
 */
export function parkingStall(opts: {
  x: number;
  z: number;
  pmr: boolean;
  /** Empreinte propre de la place, en coordonnées locales. */
  ring: P2[] | null;
  /** Empreinte du parking englobant, si la place est dans un parking. */
  host: P2[] | null;
  /** Voirie environnante. */
  roads: P2[][];
}): { angle: number; long: number; short: number } {
  const own = opts.ring ? orientedBox(opts.ring) : null;
  if (own && own.width > 1.2 && own.depth > 1.2) {
    return {
      angle: own.width >= own.depth ? own.angle : own.angle + Math.PI / 2,
      long: Math.max(own.width, own.depth),
      short: Math.min(own.width, own.depth),
    };
  }
  // Place PMR : plus large qu'une place ordinaire (bande de transfert).
  const long = 5;
  const short = opts.pmr ? 3.3 : 2.5;
  const box = opts.host ? orientedBox(opts.host) : null;
  if (box) {
    const alley = box.width >= box.depth ? box.angle : box.angle + Math.PI / 2;
    return { angle: alley + Math.PI / 2, long, short };
  }
  return { angle: nearestLineDir(opts.x, opts.z, opts.roads)?.angle ?? 0, long, short };
}

/**
 * Orientation d'un banc : le tag OSM `direction` s'il existe, sinon axe long
 * parallèle au cheminement le plus proche, assise tournée vers lui (on s'assoit
 * face au passage, dos au mur ou à la végétation).
 */
export function benchAngle(
  x: number,
  z: number,
  directionDeg: number | null,
  guides: P2[][]
): number {
  if (directionDeg != null) return faceBearing(directionDeg);
  const near = nearestLineDir(x, z, guides);
  if (!near) return 0;
  return near.angle + (localSideZ(near.px - x, near.pz - z, near.angle) > 0 ? 0 : Math.PI);
}
