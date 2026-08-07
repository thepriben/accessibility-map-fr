import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import type {
  NeighborhoodData,
  OsmBuilding,
  OsmBusRoute,
  OsmFurniture,
} from '../data/overpass';
import {
  alignX,
  benchAngle,
  clipToRadius,
  localSideZ,
  nearestLineDir,
  parkingStall,
  pathLength,
} from './orient';

// Couleurs OSM nommees usuelles (tag colour) -> hex, pour les bancs.
const NAMED_COLOURS: Record<string, number> = {
  brown: 0x8b5a2b,
  wood: 0x9c6b3f,
  wooden: 0x9c6b3f,
  red: 0xb23a3a,
  green: 0x3a7d44,
  blue: 0x3a5b9b,
  black: 0x2b2b2b,
  white: 0xe6e6e6,
  grey: 0x8a8a8a,
  gray: 0x8a8a8a,
  silver: 0xb8bcc0,
  yellow: 0xcaa63a,
  orange: 0xd07a2c,
  beige: 0xd8c9a3,
};

const BENCH_DEFAULT = 0x9c6b3f; // bois par defaut

/** Valeur OSM `colour` -> couleur Three, ou null si non exploitable. */
function parseColourOrNull(c: string | null): number | null {
  if (!c) return null;
  const v = c.trim().toLowerCase();
  if (/^#([0-9a-f]{6})$/.test(v)) return parseInt(v.slice(1), 16);
  if (/^#([0-9a-f]{3})$/.test(v)) {
    const r = v[1];
    const g = v[2];
    const b = v[3];
    return parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  return NAMED_COLOURS[v] ?? null;
}

/** Convertit une valeur OSM `colour` en couleur Three (hex, nom, sinon defaut). */
function parseColour(c: string | null): number {
  return parseColourOrNull(c) ?? BENCH_DEFAULT;
}

/** Couleur Three -> chaine CSS (pour les etiquettes dessinees sur canvas). */
function cssColour(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

/**
 * Pseudo-aleatoire stable derive d'un identifiant : donne de la variete aux
 * objets repetes (arbres) sans scintiller d'un rendu a l'autre.
 */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Etiquette texte flottante (sprite) : petit panneau lisible face camera. Sert
 * a annoter les places PMR et les arrets de bus (nom + ligne).
 */
function makeLabel(lines: string[], opts: { bg: string; fg: string; worldH?: number }): THREE.Sprite {
  const pad = 14;
  const lineH = 30;
  const font = '600 24px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const textW = Math.max(...lines.map((l) => measure.measureText(l).width));
  const w = Math.ceil(textW + pad * 2);
  const h = Math.ceil(lines.length * lineH + pad * 2);

  const canvas = document.createElement('canvas');
  const dpr = 2;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);
  g.font = font;
  g.textBaseline = 'middle';

  const r = 10;
  g.fillStyle = opts.bg;
  g.beginPath();
  g.moveTo(r, 0);
  g.arcTo(w, 0, w, h, r);
  g.arcTo(w, h, 0, h, r);
  g.arcTo(0, h, 0, 0, r);
  g.arcTo(0, 0, w, 0, r);
  g.closePath();
  g.fill();

  g.fillStyle = opts.fg;
  g.textAlign = 'center';
  lines.forEach((l, i) => g.fillText(l, w / 2, pad + lineH / 2 + i * lineH));

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
  const sprite = new THREE.Sprite(mat);
  const worldH = opts.worldH ?? 1.7;
  sprite.scale.set((worldH * w) / h, worldH, 1);
  return sprite;
}

export interface Scene3DPayload {
  place: { nom: string; lng: number; lat: number };
  neighborhood: NeighborhoodData;
  theme?: string;
}

interface Ctx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: MapControls;
  canvas: HTMLCanvasElement;
  raf: number;
  ro: ResizeObserver | null;
}

let ctx: Ctx | null = null;

const M_PER_DEG_LAT = 111320;

/** Projection locale equirectangulaire autour de l'origine (metres). */
function projector(originLng: number, originLat: number): (lng: number, lat: number) => [number, number] {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  return (lng, lat) => [(lng - originLng) * mPerDegLng, -(lat - originLat) * M_PER_DEG_LAT];
}

/** Hauteur d'un batiment : hauteur explicite, sinon etages x 3 m, sinon defaut. */
function buildingHeight(b: OsmBuilding): number {
  const h = b.height ?? (b.levels != null ? b.levels * 3 : null) ?? 9;
  return Math.min(Math.max(h, 3), 200);
}

/**
 * Rétrécit légèrement un anneau (vers son centroïde) : évite que les bâtiments
 * ne recouvrent la voirie/les trottoirs quand les empreintes OSM les touchent.
 */
function insetRing(ring: [number, number][], margin: number): [number, number][] {
  const n = ring.length;
  let cx = 0;
  let cz = 0;
  for (const [x, z] of ring) {
    cx += x;
    cz += z;
  }
  cx /= n;
  cz /= n;
  return ring.map(([x, z]) => {
    const dx = cx - x;
    const dz = cz - z;
    const len = Math.hypot(dx, dz) || 1;
    return [x + (dx / len) * margin, z + (dz / len) * margin] as [number, number];
  });
}

/** Point-dans-polygone (ray casting) sur un anneau (x, z). */
function ringContains(ring: [number, number][], px: number, pz: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Normalise un nom pour comparaison (minuscules, sans accents ni ponctuation). */
function normName(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Mots-outils ignorés dans le rapprochement de noms (articles, prépositions,
// génériques trop courants) pour ne comparer que les mots porteurs de sens.
const NAME_STOPWORDS = new Set([
  'de', 'du', 'des', 'la', 'le', 'les', 'un', 'une', 'et', 'au', 'aux', 'a',
  'the', 'of', 'chez',
]);

/** Mots significatifs d'un nom (>= 3 lettres, hors mots-outils). */
function nameTokens(s: string | null | undefined): string[] {
  return normName(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t));
}

/** Distance (m) du centroïde de l'empreinte locale à l'origine (le lieu visé). */
function ringCentroidDist(ring: [number, number][]): number {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  const n = ring.length || 1;
  return Math.hypot(sx / n, sy / n);
}

/**
 * Choisit le bâtiment cible avec un rapprochement de noms « intelligent » :
 *  1. nom OSM (name=) identique au nom Access'libre ;
 *  2. bâtiment contenant le point du lieu ET partageant au moins un mot
 *     significatif (très fiable : bon endroit + bon nom, ex. « Marché couvert »
 *     ↔ « Grand Marché de Vichy ») ;
 *  3. meilleur recoupement de mots significatifs (>= 2 mots communs, ou un nom
 *     entièrement inclus dans l'autre), le plus proche du centre en cas d'ex æquo ;
 *  4. repli géométrique : bâtiment dont l'empreinte contient le point.
 * Retourne l'index dans le tableau, ou -1.
 */
function pickTargetBuilding(
  buildings: OsmBuilding[],
  placeNom: string,
  toLocal: (lng: number, lat: number) => [number, number]
): number {
  const target = normName(placeNom);
  const placeToks = nameTokens(placeNom);

  const localRing = (b: OsmBuilding): [number, number][] | null =>
    b.ring && b.ring.length >= 3 ? b.ring.map((p) => toLocal(p[0], p[1])) : null;

  // 1. Nom exact.
  if (target.length >= 3) {
    for (let i = 0; i < buildings.length; i += 1) {
      if (normName(buildings[i].name) === target) return i;
    }
  }

  // 2. Contenance géométrique + au moins un mot commun.
  if (placeToks.length) {
    for (let i = 0; i < buildings.length; i += 1) {
      const bToks = nameTokens(buildings[i].name);
      if (!bToks.some((t) => placeToks.includes(t))) continue;
      const ring = localRing(buildings[i]);
      if (ring && ringContains(ring, 0, 0)) return i;
    }
  }

  // 3. Meilleur recoupement de mots significatifs.
  if (placeToks.length) {
    let best = -1;
    let bestShared = 0;
    let bestDist = Infinity;
    for (let i = 0; i < buildings.length; i += 1) {
      const bToks = nameTokens(buildings[i].name);
      if (!bToks.length) continue;
      const shared = bToks.filter((t) => placeToks.includes(t)).length;
      if (shared === 0) continue;
      // Exiger 2 mots communs, ou qu'un nom soit entièrement inclus dans l'autre
      // (évite d'accrocher un bâtiment sur un seul mot trop courant).
      const subset = shared === Math.min(placeToks.length, bToks.length);
      if (shared < 2 && !subset) continue;
      const ring = localRing(buildings[i]);
      const dist = ring ? ringCentroidDist(ring) : Infinity;
      if (shared > bestShared || (shared === bestShared && dist < bestDist)) {
        best = i;
        bestShared = shared;
        bestDist = dist;
      }
    }
    if (best >= 0) return best;
  }

  // 4. Repli géométrique.
  for (let i = 0; i < buildings.length; i += 1) {
    const ring = localRing(buildings[i]);
    if (ring && ringContains(ring, 0, 0)) return i;
  }
  return -1;
}

const COLOR_TARGET = 0xef8b4e; // lieu cible : orange chaud (conserve)

interface Theme {
  bg: number;
  ground: number;
  path: number; // trottoirs (sidewalk)
  foot: number; // cheminements pietons (footway / pedestrian)
  road: number; // chaussee carrossable
  wall: number; // batiments neutres (tous sauf la cible)
  sky: number;
  hemiGround: number;
  hemiI: number;
  dirI: number;
  edge: number;
  edgeOpacity: number;
}

function themeColors(dark: boolean): Theme {
  return dark
    ? {
        bg: 0x0e1219,
        ground: 0x1a1f29,
        path: 0x8b97b1,
        foot: 0x6f7890,
        road: 0x2c313b,
        wall: 0x3a4150,
        sky: 0x2a3446,
        hemiGround: 0x0c0f14,
        hemiI: 0.9,
        dirI: 2.0,
        edge: 0x000000,
        edgeOpacity: 0.35,
      }
    : {
        bg: 0xe8edf3,
        ground: 0xb9b3a6,
        path: 0xeef1f5,
        foot: 0xd7cdba,
        road: 0x8b9098,
        wall: 0xc6c8cc,
        sky: 0xeaf1fb,
        hemiGround: 0x9a948a,
        hemiI: 1.15,
        dirI: 2.4,
        edge: 0x2b2f36,
        edgeOpacity: 0.18,
      };
}

/** Construit un ruban plat (cheminement) le long d'une polyligne locale. */
function ribbon(points: [number, number][], width: number): THREE.BufferGeometry | null {
  if (points.length < 2) return null;
  const pos: number[] = [];
  const idx: number[] = [];
  const hw = width / 2;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < points.length; i += 1) {
    const [x, z] = points[i];
    const prev = points[Math.max(i - 1, 0)];
    const next = points[Math.min(i + 1, points.length - 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    // Normale horizontale (perpendiculaire a la direction).
    const nx = -dz;
    const nz = dx;
    left.push([x + nx * hw, z + nz * hw]);
    right.push([x - nx * hw, z - nz * hw]);
  }
  for (let i = 0; i < points.length; i += 1) {
    pos.push(left[i][0], 0, left[i][1]);
    pos.push(right[i][0], 0, right[i][1]);
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  return geom;
}

/** Calcule les bords gauche/droite d'un ruban (offset perpendiculaire). */
function ribbonEdges(
  points: [number, number][],
  width: number
): { left: [number, number][]; right: [number, number][] } {
  const hw = width / 2;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < points.length; i += 1) {
    const [x, z] = points[i];
    const prev = points[Math.max(i - 1, 0)];
    const next = points[Math.min(i + 1, points.length - 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const nx = -dz;
    const nz = dx;
    left.push([x + nx * hw, z + nz * hw]);
    right.push([x - nx * hw, z - nz * hw]);
  }
  return { left, right };
}

/**
 * Ruban avec une petite épaisseur (trottoir surélevé) : face supérieure à `h`,
 * murs latéraux et embouts. Même convention de coordonnées que `ribbon`.
 */
function ribbonSlab(
  points: [number, number][],
  width: number,
  thickness: number
): THREE.BufferGeometry | null {
  if (points.length < 2) return null;
  const { left, right } = ribbonEdges(points, width);
  const n = points.length;
  const pos: number[] = [];
  const idx: number[] = [];
  const add = (x: number, y: number, z: number): number => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  const lt: number[] = [];
  const rt: number[] = [];
  const lb: number[] = [];
  const rb: number[] = [];
  for (let i = 0; i < n; i += 1) {
    lt.push(add(left[i][0], thickness, left[i][1]));
    rt.push(add(right[i][0], thickness, right[i][1]));
    lb.push(add(left[i][0], 0, left[i][1]));
    rb.push(add(right[i][0], 0, right[i][1]));
  }
  for (let i = 0; i < n - 1; i += 1) {
    idx.push(lt[i], rt[i], lt[i + 1], rt[i], rt[i + 1], lt[i + 1]); // dessus
    idx.push(lt[i], lt[i + 1], lb[i], lt[i + 1], lb[i + 1], lb[i]); // mur gauche
    idx.push(rt[i], rb[i], rt[i + 1], rt[i + 1], rb[i], rb[i + 1]); // mur droit
  }
  idx.push(lt[0], lb[0], rt[0], rt[0], lb[0], rb[0]); // embout depart
  const e = n - 1;
  idx.push(lt[e], rt[e], lb[e], rt[e], rb[e], lb[e]); // embout fin
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  return geom;
}

/**
 * Passage piéton "rayé" : bandes blanches régulières le long de la traversée,
 * chaque bande perpendiculaire au sens de la marche (façon zébra).
 */
function makeCrossing(points: [number, number][], mat: THREE.Material): THREE.Group | null {
  if (points.length < 2) return null;
  const g = new THREE.Group();
  const stripeW = 0.5; // épaisseur d'une bande, le long de la traversée
  const spacing = 1.0; // pas entre deux bandes
  const across = 3.2; // longueur d'une bande, en travers
  const barGeom = new THREE.BoxGeometry(stripeW, 0.05, across);
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[i + 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.2) continue;
    const ux = dx / len;
    const uz = dz / len;
    const angle = alignX(ux, uz);
    const count = Math.max(1, Math.floor(len / spacing));
    for (let k = 0; k < count; k += 1) {
      const t = (k + 0.5) * spacing;
      if (t > len) break;
      const bar = new THREE.Mesh(barGeom, mat);
      bar.position.set(x0 + ux * t, 0.06, z0 + uz * t);
      bar.rotation.y = angle;
      bar.receiveShadow = true;
      g.add(bar);
    }
  }
  return g;
}

/**
 * Polygone plat (surface au sol) à partir d'un anneau local [x,z]. Même
 * convention de coordonnées que `ribbon` (pas de miroir) : on pré-inverse z
 * pour compenser le rotateX(-PI/2).
 */
function flatPolygon(ring: [number, number][]): THREE.BufferGeometry | null {
  if (ring.length < 3) return null;
  const pts = ring.map(([x, z]) => new THREE.Vector2(x, -z));
  const shape = new THREE.Shape(pts);
  const geom = new THREE.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  return geom;
}

// Couleurs de repli pour les lignes de bus dont le réseau ne publie pas de
// `colour` : teintes franches et bien distinctes entre elles.
const BUS_PALETTE = [0x2b6cb0, 0x8b5cf6, 0xd6336c, 0xd97706, 0x0f9b8e, 0xb45309, 0x4f46e5];

/** Couleur d'une ligne : celle du réseau si connue, sinon stable par ligne. */
function busColour(route: OsmBusRoute, index: number): number {
  const own = parseColourOrNull(route.colour);
  if (own != null) return own;
  const key = route.ref ?? route.name ?? route.id;
  return BUS_PALETTE[(Math.floor(hash01(key) * BUS_PALETTE.length) + index) % BUS_PALETTE.length];
}

/** Décale une polyligne perpendiculairement (lignes de bus parallèles lisibles). */
function offsetPolyline(points: [number, number][], off: number): [number, number][] {
  if (!off || points.length < 2) return points;
  return ribbonEdges(points, off * 2).left;
}

/** Ajoute un marqueur d'entree (pin) a l'origine = point Access'libre visé. */
function addEntranceMarker(scene: THREE.Scene, hasTargetBuilding: boolean): void {
  const group = new THREE.Group();
  // Un pin plus discret quand un batiment cible est deja mis en valeur.
  const headY = hasTargetBuilding ? 5.2 : 3.4;

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, headY, 12),
    new THREE.MeshStandardMaterial({ color: 0x5b6472, roughness: 0.6, metalness: 0.1 })
  );
  pole.position.y = headY / 2;
  pole.castShadow = true;
  group.add(pole);

  const head = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.85),
    new THREE.MeshStandardMaterial({
      color: COLOR_TARGET,
      emissive: COLOR_TARGET,
      emissiveIntensity: 0.6,
      roughness: 0.4,
      metalness: 0.1,
    })
  );
  head.position.y = headY + 0.6;
  head.castShadow = true;
  group.add(head);

  // Petit disque au sol pour situer l'acces meme si le pin est masque.
  const disc = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1.4, 32),
    new THREE.MeshBasicMaterial({
      color: COLOR_TARGET,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.08;
  group.add(disc);

  scene.add(group);
}

/**
 * Banc : assise (+ dossier optionnel), couleur issue d'OSM si connue. L'axe long
 * est +X et l'assise regarde vers +Z (le dossier est côté -Z), ce qui permet de
 * l'orienter par une simple rotation Y du groupe.
 */
function makeBench(x: number, z: number, colour: string | null, withBackrest: boolean): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: parseColour(colour), roughness: 0.75 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.45), mat);
  seat.position.y = 0.46;
  seat.castShadow = true;
  g.add(seat);
  for (const lx of [-0.7, 0.7]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.46, 0.4), mat);
    leg.position.set(lx, 0.23, 0);
    leg.castShadow = true;
    g.add(leg);
  }
  if (withBackrest) {
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.42, 0.06), mat);
    back.position.set(0, 0.74, -0.19);
    back.castShadow = true;
    g.add(back);
  }
  g.position.set(x, 0, z);
  return g;
}

/** Panneau "BUS" (+ numéros de ligne) dessiné sur canvas, lisible des deux côtés. */
function busSignTexture(refs: string | null): THREE.Texture {
  const w = 264;
  const h = 176;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#1d4e89';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 66px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  g.fillText('BUS', w / 2, refs ? 54 : h / 2);
  if (refs) {
    g.font = '700 44px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    g.fillText(refs.slice(0, 12), w / 2, 124);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

/**
 * Arrêt de bus : quai, poteau et panneau côté rue, abri voyageurs et banc
 * lorsqu'OSM les signale. `angle` aligne l'arrêt sur la voie (+X local), `side`
 * indique de quel côté (Z local) se trouve la chaussée.
 */
function makeBusStop(opts: {
  x: number;
  z: number;
  angle: number;
  side: number;
  shelter: boolean;
  bench: boolean;
  tactile: boolean;
  signTex: THREE.Texture;
}): THREE.Group {
  const { side } = opts;
  const g = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({
    color: 0x50596b,
    roughness: 0.45,
    metalness: 0.55,
  });
  const quayMat = new THREE.MeshStandardMaterial({ color: 0xd3cdc2, roughness: 0.95 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xbcd3e0,
    roughness: 0.12,
    metalness: 0.05,
    transparent: true,
    opacity: 0.38,
    side: THREE.DoubleSide,
  });

  // Quai légèrement surélevé (montée à niveau).
  const quay = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.14, 1.9), quayMat);
  quay.position.set(0, 0.07, 0);
  quay.receiveShadow = true;
  g.add(quay);

  // Bande d'éveil de vigilance en bord de quai.
  if (opts.tactile) {
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(4.4, 0.03, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xe8d64f, roughness: 0.8 })
    );
    band.position.set(0, 0.155, side * 0.75);
    g.add(band);
  }

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 2.9, 10), poleMat);
  pole.position.set(1.5, 1.45, side * 0.6);
  pole.castShadow = true;
  g.add(pole);

  // Panneau : deux faces texturées pour être lisible dans les deux sens.
  const signMat = new THREE.MeshBasicMaterial({ map: opts.signTex, side: THREE.FrontSide });
  const backing = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.48, 0.72),
    new THREE.MeshStandardMaterial({ color: 0x203a5c, roughness: 0.6 })
  );
  backing.position.set(1.5, 2.6, side * 0.6);
  backing.castShadow = true;
  g.add(backing);
  for (const s of [1, -1]) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.46), signMat);
    face.rotation.y = (s * Math.PI) / 2;
    face.position.set(1.5 + s * 0.035, 2.6, side * 0.6);
    g.add(face);
  }

  if (opts.shelter) {
    const roof = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.09, 1.5), poleMat);
    roof.position.set(-0.3, 2.45, -side * 0.25);
    roof.castShadow = true;
    g.add(roof);
    // Paroi arrière (côté trottoir) + deux joues vitrées.
    const back = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.0), glassMat);
    back.position.set(-0.3, 1.4, -side * 0.98);
    g.add(back);
    for (const s of [-1, 1]) {
      const cheek = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.0), glassMat);
      cheek.rotation.y = Math.PI / 2;
      cheek.position.set(-0.3 + s * 1.7, 1.4, -side * 0.25);
      g.add(cheek);
    }
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.4, 0.08), poleMat);
      post.position.set(-0.3 + s * 1.66, 1.2, -side * 0.96);
      post.castShadow = true;
      g.add(post);
    }
  }

  if (opts.bench) {
    const seat = makeBench(0, 0, null, false);
    seat.position.set(-0.3, 0.14, -side * 0.7);
    // On attend le bus en regardant la chaussée.
    seat.rotation.y = side > 0 ? 0 : Math.PI;
    g.add(seat);
  }

  g.position.set(opts.x, 0, opts.z);
  g.rotation.y = opts.angle;
  return g;
}

/** Arbre : tronc + houppier, dimensions OSM si connues, silhouette variée. */
function makeTree(
  f: OsmFurniture,
  x: number,
  z: number,
  mats: { trunk: THREE.Material; leaf: THREE.Material[] }
): THREE.Group {
  const r = hash01(f.id);
  const h = Math.min(Math.max(f.height ?? 5 + r * 5, 3), 18);
  const crown = Math.min(Math.max(f.crown ?? h * 0.55, 1.5), 9);
  const trunkH = h * 0.36;
  const g = new THREE.Group();

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(h * 0.032, h * 0.05, trunkH, 7),
    mats.trunk
  );
  trunk.position.y = trunkH / 2;
  trunk.castShadow = true;
  g.add(trunk);

  const leaf = mats.leaf[Math.floor(r * mats.leaf.length) % mats.leaf.length];
  // Conifère si OSM le précise : cône plutôt que boule.
  if (f.variant === 'needleleaved') {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(crown / 2, h - trunkH, 9), leaf);
    cone.position.y = trunkH + (h - trunkH) / 2;
    cone.castShadow = true;
    g.add(cone);
  } else {
    const main = new THREE.Mesh(new THREE.IcosahedronGeometry(crown / 2, 1), leaf);
    main.position.y = trunkH + crown * 0.34;
    main.scale.set(1, 1.12, 1);
    main.rotation.y = r * Math.PI;
    main.castShadow = true;
    g.add(main);
    // Second volume décalé : silhouette moins artificielle qu'une seule boule.
    const top = new THREE.Mesh(new THREE.IcosahedronGeometry(crown * 0.29, 1), leaf);
    top.position.set(crown * 0.14, trunkH + crown * 0.72, -crown * 0.12);
    top.castShadow = true;
    g.add(top);
  }

  g.position.set(x, 0, z);
  g.rotation.y = r * Math.PI * 2;
  return g;
}

/** Borne (ou bouche) d'incendie : obstacle bas fréquent sur les trottoirs. */
function makeHydrant(x: number, z: number, variant: string | null): THREE.Group {
  const g = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xb5322f, roughness: 0.5, metalness: 0.3 });
  if (variant === 'underground' || variant === 'pipe') {
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.07, 16), red);
    plate.position.y = 0.035;
    g.add(plate);
  } else {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.7, 12), red);
    body.position.y = 0.35;
    body.castShadow = true;
    g.add(body);
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      red
    );
    cap.position.y = 0.7;
    g.add(cap);
    for (const s of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 8), red);
      arm.rotation.z = Math.PI / 2;
      arm.position.set(s * 0.17, 0.5, 0);
      g.add(arm);
    }
  }
  g.position.set(x, 0, z);
  return g;
}

/** Armoire de rue (réseaux) : volume opaque qui réduit la largeur de passage. */
function makeStreetCabinet(x: number, z: number, angle: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x76806f, roughness: 0.7, metalness: 0.25 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.35, 0.48), mat);
  box.position.y = 0.675;
  box.castShadow = true;
  g.add(box);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.03, 0.07, 0.56), mat);
  roof.position.y = 1.38;
  roof.castShadow = true;
  g.add(roof);
  g.position.set(x, 0, z);
  g.rotation.y = angle;
  return g;
}

/** Matériau d'eau (fontaines, points d'eau potable). */
function waterMat(): THREE.Material {
  return new THREE.MeshStandardMaterial({
    color: 0x5fa8c7,
    roughness: 0.15,
    metalness: 0.2,
    transparent: true,
    opacity: 0.85,
  });
}

/** Point d'eau potable : borne fontaine avec vasque. */
function makeDrinkingWater(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x3f6b78, roughness: 0.4, metalness: 0.5 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 1.0, 12), metal);
  post.position.y = 0.5;
  post.castShadow = true;
  g.add(post);
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.22, 0.15, 14), metal);
  basin.position.y = 1.03;
  basin.castShadow = true;
  g.add(basin);
  const surface = new THREE.Mesh(new THREE.CircleGeometry(0.23, 16), waterMat());
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = 1.1;
  g.add(surface);
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.24, 8), metal);
  spout.rotation.x = Math.PI / 2.4;
  spout.position.set(0, 1.24, -0.07);
  g.add(spout);
  g.position.set(x, 0, z);
  return g;
}

/** Fontaine ornementale : bassin de pierre et jet d'eau. */
function makeFountain(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0xb6ada0, roughness: 0.95 });
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.62, 0.44, 24), stone);
  basin.position.y = 0.22;
  basin.castShadow = true;
  basin.receiveShadow = true;
  g.add(basin);
  const surface = new THREE.Mesh(new THREE.CircleGeometry(1.34, 24), waterMat());
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = 0.42;
  g.add(surface);
  const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.95, 10), waterMat());
  jet.position.y = 0.9;
  g.add(jet);
  const crown = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), waterMat());
  crown.position.y = 1.42;
  g.add(crown);
  g.position.set(x, 0, z);
  return g;
}

/**
 * Escalier : marches successives le long du cheminement. L'altitude réelle est
 * inconnue, on suggère la montée — l'important est de voir l'obstacle.
 */
function makeSteps(
  points: [number, number][],
  count: number | null,
  mat: THREE.Material
): THREE.Group | null {
  const total = pathLength(points);
  if (points.length < 2 || total < 0.6) return null;
  const g = new THREE.Group();
  const n = Math.max(3, Math.min(count ?? Math.round(total / 0.3), 30));
  const step = total / n;
  const rise = Math.min(0.16, 2.4 / n);
  const unit = new THREE.BoxGeometry(step * 0.92, 1, 1.7);
  let done = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[i + 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const ux = dx / len;
    const uz = dz / len;
    const angle = alignX(ux, uz);
    for (let t = step / 2; t < len; t += step) {
      const y = rise * (done + 1);
      const tread = new THREE.Mesh(unit, mat);
      tread.scale.y = y;
      tread.position.set(x0 + ux * t, y / 2, z0 + uz * t);
      tread.rotation.y = angle;
      tread.castShadow = true;
      tread.receiveShadow = true;
      g.add(tread);
      done += 1;
    }
  }
  return g;
}

/** Construit (ou reconstruit) la scene Three.js dans le canvas fourni. */
export function startScene3D(canvas: HTMLCanvasElement, payload: Scene3DPayload): void {
  stopScene3D();

  const dark = payload.theme === 'dark';
  const th = themeColors(dark);
  const toLocal = projector(payload.place.lng, payload.place.lat);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(th.bg);

  // --- Sol ---
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshStandardMaterial({ color: th.ground, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  const edgeMat = new THREE.LineBasicMaterial({
    color: th.edge,
    transparent: true,
    opacity: th.edgeOpacity,
  });

  // --- Batiments extrudes ---
  // Tous les batiments partagent un materiau gris neutre ; seul le batiment
  // cible (celui qui contient le point Access'libre) garde l'orange.
  const wallMat = new THREE.MeshStandardMaterial({
    color: th.wall,
    roughness: 0.9,
    metalness: 0.02,
  });
  const targetMat = new THREE.MeshStandardMaterial({
    color: COLOR_TARGET,
    roughness: 0.8,
    metalness: 0.02,
    emissive: COLOR_TARGET,
    emissiveIntensity: 0.12,
  });
  let maxR = 20;
  const targetIdx = pickTargetBuilding(
    payload.neighborhood.buildings,
    payload.place.nom,
    toLocal
  );
  let hasTargetBuilding = false;
  for (let bi = 0; bi < payload.neighborhood.buildings.length; bi += 1) {
    const b = payload.neighborhood.buildings[bi];
    if (!b.ring || b.ring.length < 3) continue;
    const ring: [number, number][] = b.ring.map((p) => toLocal(p[0], p[1]));
    for (const [x, z] of ring) maxR = Math.max(maxR, Math.hypot(x, z));
    // Empreinte legerement retrecie -> les routes/trottoirs restent visibles.
    const inner = insetRing(ring, 0.6);
    // Le rotateX(-PI/2) applique ensuite inverse le signe de z ; on pre-inverse z
    // (et on inverse l'ordre pour conserver l'orientation des faces) afin que le
    // batiment tombe au meme endroit que les routes/trottoirs (pas de miroir).
    const src = inner.map(([x, z]) => [x, -z] as [number, number]).reverse();
    const shape = new THREE.Shape();
    src.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, z) : shape.lineTo(x, z)));
    const height = buildingHeight(b);
    const geom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    geom.rotateX(-Math.PI / 2);

    const isTarget = bi === targetIdx;
    if (isTarget) hasTargetBuilding = true;

    const mesh = new THREE.Mesh(geom, isTarget ? targetMat : wallMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Aretes discretes pour une definition "maquette".
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), edgeMat);
    scene.add(edges);
  }

  // --- Marqueur d'entree (point Access'libre) a l'origine ---
  // Represente l'acces du lieu vise : utile quand le point n'est pas dans une
  // empreinte de batiment, et pour s'orienter dans le voisinage.
  addEntranceMarker(scene, hasTargetBuilding);

  // --- Chaussees (routes) et cheminements pietons ---
  // Routes = ruban asphalte plat ; trottoirs = dalle claire surelevee ;
  // footways = dalle fine teinte "pave".
  const roadMat = new THREE.MeshStandardMaterial({
    color: th.road,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  // Trottoir surélevé (dalle) : couleur claire, faces des deux côtés.
  const curbMat = new THREE.MeshStandardMaterial({
    color: th.path,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  // Cheminement piéton (footway) : dalle fine, teinte "pavé" distincte des
  // trottoirs (clairs) et des routes (asphalte).
  const footMat = new THREE.MeshStandardMaterial({
    color: th.foot,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  // Bandes blanches des passages piétons.
  const zebraMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.85 });
  // Marches : teinte distincte, c'est l'obstacle majeur en fauteuil.
  const stepsMat = new THREE.MeshStandardMaterial({ color: 0xc08a5a, roughness: 0.9 });
  // Tracés conservés pour orienter le mobilier et les places de stationnement
  // sans empreinte propre : la voirie d'un côté, le réseau piéton de l'autre
  // (un banc s'aligne sur le trottoir, une place sur la rue).
  const roadLines: [number, number][][] = [];
  const footLines: [number, number][][] = [];
  for (const path of payload.neighborhood.paths) {
    if (path.kind === 'park') continue;
    const pts: [number, number][] = path.coords.map((p) => toLocal(p[0], p[1]));
    for (const [x, z] of pts) maxR = Math.max(maxR, Math.hypot(x, z));
    if (pts.length >= 2) {
      if (path.kind === 'road') roadLines.push(pts);
      else if (path.kind === 'sidewalk' || path.kind === 'footway') footLines.push(pts);
    }

    // Passage piéton : bandes blanches rayées posées sur la chaussée.
    if (path.kind === 'crossing') {
      const zebra = makeCrossing(pts, zebraMat);
      if (zebra) scene.add(zebra);
      continue;
    }

    // Escalier : marches matérialisées le long du cheminement.
    if (path.kind === 'steps') {
      const stairs = makeSteps(pts, path.stepCount ?? null, stepsMat);
      if (stairs) scene.add(stairs);
      continue;
    }

    // Trottoir : petite épaisseur (dalle surélevée) pour un rendu plus lisible.
    if (path.kind === 'sidewalk') {
      const geom = ribbonSlab(pts, 1.6, 0.12);
      if (!geom) continue;
      const mesh = new THREE.Mesh(geom, curbMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      continue;
    }

    // Footway / cheminement piéton : dalle fine surélevée (teinte pavé).
    if (path.kind === 'footway') {
      const geom = ribbonSlab(pts, 1.4, 0.07);
      if (!geom) continue;
      const mesh = new THREE.Mesh(geom, footMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      continue;
    }

    // Routes (larges, asphalte) : ruban plat au sol.
    const width = path.width ?? 5;
    const geom = ribbon(pts, width);
    if (!geom) continue;
    const mesh = new THREE.Mesh(geom, roadMat);
    mesh.position.y = 0.03;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // --- Mobilier : bancs, arrets de bus, places PMR ---
  const nb = payload.neighborhood;

  // --- Parkings surfaciques (amenity=parking) : empreinte au sol matérialisée ---
  const parkMat = new THREE.MeshStandardMaterial({
    color: 0x6b7382,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const parkPmrMat = new THREE.MeshStandardMaterial({
    color: 0x2f6fb0,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  // Empreintes des parkings : réutilisées pour orienter les places qu'ils
  // contiennent (une place suit toujours la géométrie de son parking).
  const parkingRings: [number, number][][] = [];
  for (const area of nb.parkingAreas ?? []) {
    const ring: [number, number][] = area.ring.map((p) => toLocal(p[0], p[1]));
    parkingRings.push(ring);
    let cx = 0;
    let cz = 0;
    for (const [x, z] of ring) {
      maxR = Math.max(maxR, Math.hypot(x, z));
      cx += x;
      cz += z;
    }
    cx /= ring.length;
    cz /= ring.length;
    const geom = flatPolygon(ring);
    if (!geom) continue;
    const mesh = new THREE.Mesh(geom, area.pmr ? parkPmrMat : parkMat);
    mesh.position.y = 0.02;
    mesh.receiveShadow = true;
    scene.add(mesh);
    // Repère "P" (ou "P PMR") au centre pour indiquer le stationnement.
    const label = makeLabel([area.pmr ? '\u267F P' : 'P'], {
      bg: area.pmr ? 'rgba(47,111,176,0.95)' : 'rgba(60,66,78,0.92)',
      fg: '#ffffff',
      worldH: 1.8,
    });
    label.position.set(cx, 2.2, cz);
    scene.add(label);
  }

  // --- Bancs : orientés par le tag OSM `direction` s'il existe, sinon alignés
  // sur le cheminement le plus proche et tournés vers lui. ---
  const benchGuides = footLines.length ? footLines : roadLines;
  for (const bench of nb.benches ?? []) {
    const [x, z] = toLocal(bench.lng, bench.lat);
    maxR = Math.max(maxR, Math.hypot(x, z));
    const seat = makeBench(x, z, bench.colour, bench.backrest !== false);
    seat.rotation.y = benchAngle(x, z, bench.direction, benchGuides);
    scene.add(seat);
  }

  // --- Arrêts de bus : quai orienté sur la voie, abri/banc si connus ---
  for (const stop of nb.busStops ?? []) {
    const [x, z] = toLocal(stop.lng, stop.lat);
    maxR = Math.max(maxR, Math.hypot(x, z));
    const near = nearestLineDir(x, z, roadLines);
    const angle = near?.angle ?? 0;
    // Côté chaussée : on oriente le quai et le poteau vers la rue.
    const side = near ? localSideZ(near.px - x, near.pz - z, angle) : 1;
    scene.add(
      makeBusStop({
        x,
        z,
        angle,
        side,
        shelter: stop.shelter === true,
        bench: stop.bench === true,
        tactile: stop.tactile === true,
        signTex: busSignTexture(stop.line),
      })
    );
    const lines: string[] = [];
    if (stop.name) lines.push(stop.name);
    lines.push(stop.line ? `Ligne ${stop.line}` : 'Arrêt de bus');
    const equip = [
      stop.shelter === true ? 'abri' : null,
      stop.bench === true ? 'banc' : null,
    ].filter(Boolean);
    if (equip.length) lines.push(equip.join(' · '));
    const label = makeLabel(lines, { bg: 'rgba(23,58,102,0.92)', fg: '#eaf1fb', worldH: 1.5 });
    label.position.set(x, 4.1, z);
    scene.add(label);
  }

  // --- Lignes de bus : ruban coloré suivant le tracé, décalé quand plusieurs
  // lignes empruntent la même voie, avec la pastille du numéro. ---
  const busRoutes = nb.busRoutes ?? [];
  busRoutes.forEach((route, ri) => {
    const col = busColour(route, ri);
    const mat = new THREE.MeshStandardMaterial({
      color: col,
      roughness: 0.5,
      emissive: col,
      emissiveIntensity: 0.2,
      side: THREE.DoubleSide,
    });
    const joint = new THREE.CircleGeometry(0.32, 12);
    const lateral = (ri - (busRoutes.length - 1) / 2) * 0.85;
    let longest: [number, number][] | null = null;
    for (const seg of route.segments) {
      const local = seg.map((p) => toLocal(p[0], p[1]));
      for (const run of clipToRadius(local, Math.max(maxR, 60))) {
        const line = offsetPolyline(run, lateral);
        const geom = ribbon(line, 0.62);
        if (geom) {
          const mesh = new THREE.Mesh(geom, mat);
          mesh.position.y = 0.14;
          scene.add(mesh);
        }
        // Pastilles aux sommets : le ruban reste continu dans les virages.
        for (const [jx, jz] of line) {
          const dot = new THREE.Mesh(joint, mat);
          dot.rotation.x = -Math.PI / 2;
          dot.position.set(jx, 0.14, jz);
          scene.add(dot);
        }
        if (!longest || pathLength(line) > pathLength(longest)) longest = line;
      }
    }
    if (longest) {
      const mid = longest[Math.floor(longest.length / 2)];
      const badge = makeLabel([route.ref ? `Bus ${route.ref}` : 'Bus'], {
        bg: cssColour(col),
        fg: '#ffffff',
        worldH: 1.3,
      });
      badge.position.set(mid[0], 2.6, mid[1]);
      scene.add(badge);
    }
  });

  // --- Places de stationnement : orientées par leur empreinte OSM si elle
  // existe, sinon par le parking qui les contient, sinon par la voirie. ---
  const stallMat = new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.85 });
  const stallPlainMat = new THREE.MeshStandardMaterial({ color: 0x9aa3af, roughness: 0.9 });
  const stallLineMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.8 });
  for (const p of nb.parking ?? []) {
    const [x, z] = toLocal(p.lng, p.lat);
    maxR = Math.max(maxR, Math.hypot(x, z));

    const { angle, long, short } = parkingStall({
      x,
      z,
      pmr: p.pmr,
      ring: p.ring ? p.ring.map((q) => toLocal(q[0], q[1])) : null,
      host: parkingRings.find((ring) => ringContains(ring, x, z)) ?? null,
      roads: roadLines,
    });

    // Le plan est basculé à plat (X = longueur, Z = largeur) ; l'orientation est
    // portée par le groupe parent, ce qui évite de composer trois rotations.
    const holder = new THREE.Group();
    holder.position.set(x, 0, z);
    holder.rotation.y = angle;
    scene.add(holder);

    const stall = new THREE.Mesh(
      new THREE.PlaneGeometry(long, short),
      p.pmr ? stallMat : stallPlainMat
    );
    stall.rotation.x = -Math.PI / 2;
    stall.position.y = 0.07;
    stall.receiveShadow = true;
    holder.add(stall);

    // Marquage au sol : deux traits blancs délimitant l'emplacement.
    for (const s of [-1, 1]) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(long, 0.12), stallLineMat);
      strip.rotation.x = -Math.PI / 2;
      strip.position.set(0, 0.085, (s * short) / 2);
      holder.add(strip);
    }

    if (p.pmr) {
      const label = makeLabel(['\u267F PMR'], {
        bg: 'rgba(47,111,176,0.95)',
        fg: '#ffffff',
        worldH: 1.5,
      });
      label.position.set(x, 2.2, z);
      scene.add(label);
    }
  }

  // --- Arbres, bornes incendie, armoires de rue, points d'eau ---
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b5340, roughness: 0.95 });
  const leafMats = [0x5f8f52, 0x6f9c5c, 0x4f8352, 0x7fa863].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true })
  );
  for (const f of nb.furniture ?? []) {
    const [x, z] = toLocal(f.lng, f.lat);
    if (f.kind === 'tree' || f.kind === 'fountain') maxR = Math.max(maxR, Math.hypot(x, z));
    switch (f.kind) {
      case 'tree':
        scene.add(makeTree(f, x, z, { trunk: trunkMat, leaf: leafMats }));
        break;
      case 'fire_hydrant':
        scene.add(makeHydrant(x, z, f.variant ?? null));
        break;
      case 'street_cabinet':
        scene.add(makeStreetCabinet(x, z, nearestLineDir(x, z, roadLines)?.angle ?? 0));
        break;
      case 'drinking_water':
        scene.add(makeDrinkingWater(x, z));
        break;
      case 'fountain':
        scene.add(makeFountain(x, z));
        break;
      default:
        // Bancs et arrêts de bus sont déjà rendus depuis leurs propres listes ;
        // le reste (bornes, lampadaires...) n'est pas encore représenté.
        break;
    }
  }

  const radius = Math.min(Math.max(maxR * 1.9, 40), 400);

  // --- Lumieres : ambiance hemispherique douce + soleil avec ombres portees ---
  scene.add(new THREE.HemisphereLight(th.sky, th.hemiGround, th.hemiI));
  const sun = new THREE.DirectionalLight(0xfff4e6, th.dirI);
  sun.position.set(radius * 0.7, radius * 1.3, radius * 0.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.5;
  const s = radius * 1.25;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = radius * 4;
  scene.add(sun);

  // --- Camera + rendu ---
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || canvas.parentElement?.clientHeight || window.innerHeight;
  const camera = new THREE.PerspectiveCamera(52, w / h, 0.5, 6000);
  camera.position.set(radius * 0.55, radius * 0.75, radius * 0.55);

  scene.fog = new THREE.Fog(th.bg, radius * 1.4, radius * 3.4);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  // MapControls : navigation "type carte" (glisser = deplacer, clic droit =
  // pivoter, molette = zoom), plus intuitive pour explorer un voisinage.
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minDistance = 6;
  controls.maxDistance = radius * 3;
  controls.zoomSpeed = 1.1;
  controls.target.set(0, 0, 0);
  controls.listenToKeyEvents(window);
  controls.keyPanSpeed = 16;
  controls.update();

  const c: Ctx = { renderer, scene, camera, controls, canvas, raf: 0, ro: null };

  const resize = (): void => {
    const nw = canvas.clientWidth || canvas.parentElement?.clientWidth || window.innerWidth;
    const nh = canvas.clientHeight || canvas.parentElement?.clientHeight || window.innerHeight;
    if (nw === 0 || nh === 0) return;
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, nh, false);
  };
  c.ro = new ResizeObserver(resize);
  c.ro.observe(canvas.parentElement ?? canvas);

  const loop = (): void => {
    c.raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  ctx = c;
}

/** Met a jour le theme (fond + sol) sans reconstruire la geometrie. */
export function updateTheme(dark: boolean): void {
  if (!ctx) return;
  const th = themeColors(dark);
  ctx.scene.background = new THREE.Color(th.bg);
  if (ctx.scene.fog) (ctx.scene.fog as THREE.Fog).color = new THREE.Color(th.bg);
}

/** Detruit la scene et libere les ressources GPU. */
export function stopScene3D(): void {
  if (!ctx) return;
  cancelAnimationFrame(ctx.raf);
  ctx.ro?.disconnect();
  ctx.controls.dispose();
  ctx.scene.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) (mat as THREE.Material).dispose();
  });
  ctx.renderer.dispose();
  ctx = null;
}
