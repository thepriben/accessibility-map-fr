import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import type {
  NeighborhoodData,
  OsmBuilding,
  OsmBusRoute,
  OsmEntrance,
  OsmFurniture,
  OsmPath,
} from '../data/overpass';
import { attachHover, tagInfo, type HoverHandle, type SceneInfo } from './hover';
import { findRoute, type RouteLine } from './route';
import {
  alignX,
  benchAngle,
  clipToRadius,
  closeRing,
  localSideZ,
  nearestLineDir,
  parkingStall,
  pathLength,
  pointAlong,
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
  hover: HoverHandle | null;
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

// --- Trajet en pointillés animés ------------------------------------------

/** Couleur du trajet : un cyan vif, absent du reste de la scène. */
const COLOR_ROUTE = 0x1fc3e0;
/** Longueur d'un motif tiret + espace (m). */
const ROUTE_PERIOD = 2.6;
/** Vitesse de défilement des tirets (m/s) : lisible sans être agité. */
const ROUTE_SPEED = 3.4;

/**
 * Motif d'un tiret, dessiné une fois puis répété le long du trajet. Le dégradé
 * de bout en bout adoucit la césure entre deux tirets.
 */
function dashTexture(colour: number): THREE.CanvasTexture {
  const w = 128;
  const h = 32;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d');
  if (g) {
    const css = `#${colour.toString(16).padStart(6, '0')}`;
    g.clearRect(0, 0, w, h);
    const grad = g.createLinearGradient(0, 0, w * 0.62, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.18, css);
    grad.addColorStop(0.82, css);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w * 0.62, h);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * Ruban dont la coordonnée U vaut la distance parcourue (m) : le motif de
 * tirets garde le même pas quels que soient les virages, et le faire défiler
 * revient à décaler la texture.
 */
function dashRibbon(points: [number, number][], width: number): THREE.BufferGeometry | null {
  if (points.length < 2) return null;
  const hw = width / 2;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let run = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x, z] = points[i];
    if (i > 0) run += Math.hypot(x - points[i - 1][0], z - points[i - 1][1]);
    const prev = points[Math.max(i - 1, 0)];
    const next = points[Math.min(i + 1, points.length - 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    pos.push(x - dz * hw, 0, z + dx * hw);
    pos.push(x + dz * hw, 0, z - dx * hw);
    uv.push(run, 1, run, 0);
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geom.setIndex(idx);
  return geom;
}

/** Petit anneau posé au sol, pour marquer une extrémité du trajet. */
function routeEnd(x: number, z: number, colour: number): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.85, 28),
    new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.21, z);
  ring.renderOrder = 3;
  return ring;
}

/**
 * Trajet matérialisé au sol : tirets qui défilent du départ vers l'arrivée,
 * plus un anneau à chaque extrémité. Renvoie le groupe et la fonction
 * d'animation à appeler à chaque trame.
 */
function makeRoute(
  points: [number, number][],
  colour: number
): { group: THREE.Group; tick: (dt: number) => void } | null {
  const geom = dashRibbon(points, 0.85);
  if (!geom) return null;

  const tex = dashTexture(colour);
  tex.repeat.set(1 / ROUTE_PERIOD, 1);
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      // Sans cela, les tirets masqueraient ce qui passe derrière eux ; ils
      // restent en revanche cachés par les bâtiments, ce qui est souhaitable.
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
  );
  mesh.position.y = 0.2;
  mesh.renderOrder = 3;

  const group = new THREE.Group();
  group.add(mesh);
  group.add(routeEnd(points[0][0], points[0][1], colour));
  group.add(routeEnd(points[points.length - 1][0], points[points.length - 1][1], colour));

  return {
    group,
    tick: (dt) => {
      tex.offset.x = (tex.offset.x - (dt * ROUTE_SPEED) / ROUTE_PERIOD) % 1;
    },
  };
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

/**
 * Couleur d'une entrée selon l'accessibilité fauteuil déclarée dans OSM. On
 * reprend le bleu PMR déjà utilisé par les places de stationnement plutôt qu'un
 * vert, pour garder une seule convention « accessible » dans la scène.
 */
function entranceColour(wheelchair: string | null): number {
  if (wheelchair === 'yes') return 0x2f6fb0;
  if (wheelchair === 'limited') return 0xd99a2b;
  if (wheelchair === 'no') return 0xc0483f;
  return 0x8891a0; // non renseigné
}

/**
 * Plaque ♿ apposée sur la porte, comme la signalétique réelle d'un accès PMR :
 * plus lisible et moins encombrant qu'une étiquette flottante.
 */
function makeAccessPlaque(colour: number): THREE.Mesh {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 128;
  const g = cv.getContext('2d')!;
  g.fillStyle = cssColour(colour);
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 96px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  g.fillText('\u267F', 64, 70);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(0.36, 0.36),
    new THREE.MeshBasicMaterial({ map: tex })
  );
}

/**
 * Marches du seuil, construites devant la porte : l'obstacle se voit au lieu de
 * s'écrire. `outward` indique de quel côté (±Z local) se trouve l'extérieur.
 */
function makeThresholdSteps(count: number, width: number, outward: number): THREE.Group {
  const g = new THREE.Group();
  const n = Math.min(count, 6);
  const rise = 0.16;
  const depth = 0.32;
  const mat = new THREE.MeshStandardMaterial({ color: 0xb9b0a4, roughness: 0.95 });
  for (let i = 0; i < n; i += 1) {
    // La marche la plus haute touche la porte, les suivantes descendent vers la rue.
    const h = rise * (n - i);
    const step = new THREE.Mesh(new THREE.BoxGeometry(width, h, depth), mat);
    step.position.set(0, h / 2, outward * (0.14 + depth * (i + 0.5)));
    step.castShadow = true;
    step.receiveShadow = true;
    g.add(step);
  }
  return g;
}

/**
 * Priorité d'une entrée pour représenter l'accès principal : une entrée de
 * service ou de secours ne doit pas l'emporter sur une entrée praticable.
 */
function entranceScore(e: OsmEntrance): number {
  let s = 0;
  if (e.kind === 'main') s += 4;
  else if (e.kind === 'yes') s += 2;
  else if (e.kind === 'service' || e.kind === 'emergency' || e.kind === 'exit') s -= 3;
  if (e.wheelchair === 'yes') s += 3;
  else if (e.wheelchair === 'limited') s += 1;
  else if (e.wheelchair === 'no') s -= 1;
  return s;
}

/**
 * Porte matérialisée sur la façade. L'encadrement est fait de deux montants et
 * d'un linteau, et le vantail est en retrait dans le mur : un panneau plein,
 * lui, se lisait comme une stèle posée contre le bâtiment. `outward` donne le
 * côté extérieur (±Z local), pour poser signalétique et marches du bon côté.
 */
function makeDoorMarker(
  e: OsmEntrance,
  colour: number,
  prominent: boolean,
  outward: number
): THREE.Group {
  const g = new THREE.Group();

  // Entrée d'un autre bâtiment : un simple seuil au sol suffit à se repérer.
  // Dresser une porte devant chaque façade du voisinage surchargeait la scène.
  if (!prominent) {
    const sill = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.07, 0.55),
      new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85 })
    );
    sill.position.set(0, 0.035, outward * 0.3);
    sill.receiveShadow = true;
    g.add(sill);
    return g;
  }

  const w = 1.35;
  const h = 2.3;
  const jamb = 0.16;
  const frameMat = new THREE.MeshStandardMaterial({
    color: colour,
    roughness: 0.55,
    metalness: 0.1,
    emissive: colour,
    emissiveIntensity: 0.35,
  });

  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(jamb, h, 0.22), frameMat);
    post.position.set((s * (w - jamb)) / 2, h / 2, 0);
    post.castShadow = true;
    g.add(post);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(w, 0.18, 0.22), frameMat);
  lintel.position.y = h - 0.09;
  lintel.castShadow = true;
  g.add(lintel);

  // Vantail enfonce dans l'epaisseur du mur : creuse l'ouverture.
  const leaf = new THREE.Mesh(
    new THREE.BoxGeometry(w - 2 * jamb, h - 0.18, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.5, metalness: 0.15 })
  );
  leaf.position.set(0, (h - 0.18) / 2, -outward * 0.07);
  g.add(leaf);

  // Halo au sol : on repère la porte même quand la façade est de biais.
  const disc = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1.2, 28),
    new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.1;
  g.add(disc);

  if (e.wheelchair === 'yes') {
    const plaque = makeAccessPlaque(colour);
    plaque.rotation.y = outward > 0 ? 0 : Math.PI;
    plaque.position.set(w / 2 - 0.3, 1.62, outward * 0.13);
    g.add(plaque);
  }
  if (e.stepCount) g.add(makeThresholdSteps(e.stepCount, w, outward));
  return g;
}

/** Ajoute le marqueur (pin) de l'acces vise, a l'origine ou sur l'entree OSM. */
function addEntranceMarker(
  scene: THREE.Scene,
  hasTargetBuilding: boolean,
  at?: [number, number]
): void {
  const group = new THREE.Group();
  if (at) group.position.set(at[0], 0, at[1]);
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

/** Borne (bollard) : obstacle bas, souvent en série le long d'un trottoir. */
function makeBollard(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x4b5159,
    roughness: 0.5,
    metalness: 0.4,
  });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.85, 10), mat);
  post.position.y = 0.425;
  post.castShadow = true;
  g.add(post);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 6), mat);
  cap.position.y = 0.85;
  g.add(cap);
  g.position.set(x, 0, z);
  return g;
}

/** Lampadaire : mât et crosse, gabarit indicatif. */
function makeStreetLamp(x: number, z: number, angle: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x596170,
    roughness: 0.45,
    metalness: 0.55,
  });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 4.2, 10), mat);
  mast.position.y = 2.1;
  mast.castShadow = true;
  g.add(mast);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 8), mat);
  arm.rotation.z = Math.PI / 2;
  arm.position.set(0.5, 4.15, 0);
  g.add(arm);
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.14, 0.26),
    new THREE.MeshStandardMaterial({
      color: 0xf2ead4,
      roughness: 0.4,
      emissive: 0x2a2a20,
    })
  );
  head.position.set(0.95, 4.05, 0);
  g.add(head);
  g.position.set(x, 0, z);
  g.rotation.y = angle;
  return g;
}

/** Corbeille de rue : petit encombrement, mais sur le cheminement. */
function makeWasteBin(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x4f5a52,
    roughness: 0.75,
    metalness: 0.2,
  });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.22, 0.8, 12), mat);
  body.position.y = 0.5;
  body.castShadow = true;
  g.add(body);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.035, 6, 14), mat);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.9;
  g.add(rim);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), mat);
  post.position.y = 0.25;
  g.add(post);
  g.position.set(x, 0, z);
  return g;
}

/**
 * Toilettes publiques : cabine, avec le pictogramme ♿ quand elles sont
 * declarees accessibles — une information de premier plan pour preparer une
 * sortie.
 */
function makeToilets(x: number, z: number, angle: number, accessible: boolean): THREE.Group {
  const g = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({
    color: 0x9aa6ab,
    roughness: 0.7,
    metalness: 0.2,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.4, 1.6), shell);
  body.position.y = 1.2;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.12, 1.75), shell);
  roof.position.y = 2.45;
  roof.castShadow = true;
  g.add(roof);
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 1.95, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.55 })
  );
  door.position.set(0, 0.98, 0.82);
  g.add(door);
  if (accessible) {
    const plaque = makeAccessPlaque(0x2f6fb0);
    plaque.position.set(0, 1.75, 0.87);
    g.add(plaque);
  }
  g.position.set(x, 0, z);
  g.rotation.y = angle;
  return g;
}

/** Ascenseur : cabine vitree, acces vertical decisif quand il existe. */
function makeElevator(x: number, z: number, accessible: boolean): THREE.Group {
  const g = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x5c6673,
    roughness: 0.4,
    metalness: 0.6,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: 0xbcd3e0,
    roughness: 0.1,
    metalness: 0.05,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
  });
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.6, 1.6), glass);
  cabin.position.y = 1.3;
  g.add(cabin);
  for (const [sx, sz] of [
    [-0.8, -0.8],
    [0.8, -0.8],
    [-0.8, 0.8],
    [0.8, 0.8],
  ]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.7, 0.1), frameMat);
    post.position.set(sx, 1.35, sz);
    post.castShadow = true;
    g.add(post);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.12, 1.8), frameMat);
  roof.position.y = 2.72;
  roof.castShadow = true;
  g.add(roof);
  if (accessible) {
    const plaque = makeAccessPlaque(0x2f6fb0);
    plaque.position.set(0, 1.6, 0.83);
    g.add(plaque);
  }
  g.position.set(x, 0, z);
  return g;
}

/**
 * Barriere de passage (portillon, chicane, bloc). Contrairement a une borne
 * isolee, elle reduit la largeur utile et bloque souvent un fauteuil : on la
 * marque donc en teinte d'alerte.
 */
function makeBarrier(x: number, z: number, angle: number, variant: string | null): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb8783a,
    roughness: 0.6,
    metalness: 0.3,
  });
  if (variant === 'cycle_barrier' || variant === 'chicane') {
    // Chicane : deux barres decalees imposant un zigzag, impraticable en fauteuil.
    for (const s of [-1, 1]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.0, 1.2), mat);
      bar.position.set(s * 0.45, 0.5, s * 0.35);
      bar.castShadow = true;
      g.add(bar);
    }
  } else if (variant === 'block') {
    const block = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.6, 0.6), mat);
    block.position.y = 0.3;
    block.castShadow = true;
    g.add(block);
  } else {
    // Portillon : deux montants et une lisse.
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.2, 8), mat);
      post.position.set(s * 0.8, 0.6, 0);
      post.castShadow = true;
      g.add(post);
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 0.08), mat);
    rail.position.y = 0.95;
    g.add(rail);
  }
  g.position.set(x, 0, z);
  g.rotation.y = angle;
  return g;
}

/**
 * Bordure de trottoir. Abaissee, elle se franchit et se marque discretement au
 * sol ; haute, c'est un ressaut qu'on materialise en relief.
 */
function makeKerb(x: number, z: number, angle: number, lowered: boolean): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: lowered ? 0x2f6fb0 : 0xa8563f,
    roughness: 0.85,
  });
  const h = lowered ? 0.05 : 0.16;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(1.4, h, 0.34), mat);
  slab.position.y = h / 2;
  slab.receiveShadow = true;
  g.add(slab);
  g.position.set(x, 0, z);
  g.rotation.y = angle;
  return g;
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

/** Hauteur de montée d'un escalier telle qu'elle est representee dans la scene. */
const STEPS_MAX_RISE = 1.1;

/**
 * Escalier : volée de marches, main courante et rampe d'accès quand OSM les
 * signale.
 *
 * Le voisinage est rendu sur un sol plat, sans modèle de terrain : une volée à
 * sa hauteur réelle finirait suspendue en l'air, déconnectée du cheminement
 * qu'elle rejoint. On comprime donc la montée, l'information utile ici étant
 * « il y a N marches, avec ou sans rampe », pas leur altitude exacte.
 */
function makeSteps(
  path: OsmPath,
  points: [number, number][],
  mat: THREE.Material
): THREE.Group | null {
  const total = pathLength(points);
  if (points.length < 2 || total < 0.6) return null;

  // `incline=down` décrit la pente dans le sens des nœuds OSM : on parcourt
  // alors la volée à l'envers pour que la montée aille dans le bon sens.
  const line = path.incline === 'down' ? [...points].reverse() : points;
  const n = Math.max(2, Math.min(path.stepCount ?? Math.round(total / 0.3), 24));
  const riseTotal = Math.min(n * 0.17, STEPS_MAX_RISE);
  const rise = riseTotal / n;
  const going = total / n;
  const width = Math.min(Math.max(path.width ?? 1.8, 1), 6);

  const g = new THREE.Group();
  const unit = new THREE.BoxGeometry(going * 0.98, 1, width);
  for (let k = 0; k < n; k += 1) {
    const at = pointAlong(line, (k + 0.5) * going);
    if (!at) continue;
    const y = rise * (k + 1);
    const tread = new THREE.Mesh(unit, mat);
    tread.scale.y = y;
    tread.position.set(at.x, y / 2, at.z);
    tread.rotation.y = alignX(at.ux, at.uz);
    tread.castShadow = true;
    tread.receiveShadow = true;
    g.add(tread);
  }

  // Palier haut : la volée se termine sur un replat plutôt que sur une arête
  // dans le vide.
  const top = pointAlong(line, total);
  if (top) {
    const landing = new THREE.Mesh(new THREE.BoxGeometry(0.7, riseTotal, width), mat);
    landing.position.set(top.x + top.ux * 0.34, riseTotal / 2, top.z + top.uz * 0.34);
    landing.rotation.y = alignX(top.ux, top.uz);
    landing.castShadow = true;
    landing.receiveShadow = true;
    g.add(landing);
  }

  // Main courante : elle change tout pour une personne à mobilité réduite qui
  // emprunte quand même l'escalier.
  if (path.handrail) {
    const railMat = new THREE.MeshStandardMaterial({
      color: 0x8a8f98,
      roughness: 0.35,
      metalness: 0.65,
    });
    for (const side of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= n; k += 1) {
        const at = pointAlong(line, Math.min(k * going, total));
        if (!at) continue;
        // Décalage perpendiculaire au sens de la montée.
        pts.push(
          new THREE.Vector3(
            at.x + -at.uz * side * (width / 2 - 0.08),
            rise * k + 0.95,
            at.z + at.ux * side * (width / 2 - 0.08)
          )
        );
      }
      if (pts.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(pts);
      const rail = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.max(n * 2, 8), 0.035, 6, false),
        railMat
      );
      rail.castShadow = true;
      g.add(rail);
    }
  }

  // Rampe praticable en fauteuil : c'est ce qui fait la difference entre un
  // escalier infranchissable et un passage possible. On la marque en bleu PMR.
  if (path.rampWheelchair) {
    const rampMat = new THREE.MeshStandardMaterial({
      color: 0x2f6fb0,
      roughness: 0.8,
      emissive: 0x2f6fb0,
      emissiveIntensity: 0.15,
    });
    const rampW = 1.1;
    const offset = width / 2 + rampW / 2 + 0.1;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(going * 1.02, 1, rampW), rampMat);
    for (let k = 0; k < n; k += 1) {
      const at = pointAlong(line, (k + 0.5) * going);
      if (!at) continue;
      // Plan incliné approché par tranches : évite une géométrie sur mesure.
      const y = rise * (k + 0.5);
      const seg = slab.clone();
      seg.scale.y = y;
      seg.position.set(at.x + -at.uz * offset, y / 2, at.z + at.ux * offset);
      seg.rotation.y = alignX(at.ux, at.uz);
      seg.castShadow = true;
      seg.receiveShadow = true;
      g.add(seg);
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

  // Objets interrogeables au survol : uniquement ceux qui portent une
  // information, jamais le decor (sol, trottoirs, chaussees).
  const hoverables: THREE.Object3D[] = [];
  const addInfo = <T extends THREE.Object3D>(obj: T, info: SceneInfo): T => {
    tagInfo(obj, info);
    hoverables.push(obj);
    scene.add(obj);
    return obj;
  };

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
  // Rayon de cadrage. Overpass renvoie les chemins entiers, pas seulement leur
  // portion dans le voisinage : une rue qui traverse le quartier peut filer sur
  // un kilomètre. Sans plafond, la caméra reculait jusqu'à ce que ces bouts de
  // voirie tiennent à l'écran, et les 100 derniers mètres devenaient illisibles.
  const FRAME_MAX = 130;
  let maxR = 20;
  const grow = (x: number, z: number): void => {
    const d = Math.hypot(x, z);
    if (d <= FRAME_MAX && d > maxR) maxR = d;
  };
  const targetIdx = pickTargetBuilding(payload.neighborhood.buildings, payload.place.nom, toLocal);
  let hasTargetBuilding = false;
  // Façades effectivement dessinees (empreintes retrecies), indexees comme les
  // batiments : servent a poser les portes au bon endroit sur le mur.
  const facades: ([number, number][] | null)[] = [];
  for (let bi = 0; bi < payload.neighborhood.buildings.length; bi += 1) {
    const b = payload.neighborhood.buildings[bi];
    if (!b.ring || b.ring.length < 3) {
      facades.push(null);
      continue;
    }
    const ring: [number, number][] = b.ring.map((p) => toLocal(p[0], p[1]));
    for (const [x, z] of ring) grow(x, z);
    // Empreinte legerement retrecie -> les routes/trottoirs restent visibles.
    const inner = insetRing(ring, 0.6);
    facades.push(inner);
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
    if (isTarget || b.name) {
      addInfo(mesh, {
        title: isTarget ? payload.place.nom : (b.name ?? 'Bâtiment'),
        colour: isTarget ? COLOR_TARGET : undefined,
        details: [
          isTarget ? 'Lieu visé' : null,
          isTarget && b.name && b.name !== payload.place.nom ? `OpenStreetMap : ${b.name}` : null,
          b.levels ? `${b.levels} niveau${b.levels > 1 ? 'x' : ''}` : null,
        ],
      });
    } else {
      scene.add(mesh);
    }

    // Aretes discretes pour une definition "maquette".
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), edgeMat);
    scene.add(edges);
  }

  // --- Entrees OSM ---
  // Hierarchie volontaire : toutes les entrees du batiment vise (c'est
  // l'information qu'on vient chercher), mais seulement les entrees principales
  // des autres batiments, en sourdine, pour se reperer sans surcharger.
  const doors: {
    e: OsmEntrance;
    x: number;
    z: number;
    angle: number;
    outward: number;
    target: boolean;
  }[] = [];
  for (const e of payload.neighborhood.entrances ?? []) {
    const [ex, ez] = toLocal(e.lng, e.lat);
    // On rattache l'entree a la façade la plus proche : le nœud OSM est sur le
    // contour d'origine, donc a ~0,6 m de la façade dessinee.
    let bestIdx = -1;
    let best: ReturnType<typeof nearestLineDir> = null;
    for (let bi = 0; bi < facades.length; bi += 1) {
      const inner = facades[bi];
      if (!inner) continue;
      const hit = nearestLineDir(ex, ez, [closeRing(inner)]);
      if (hit && (!best || hit.dist < best.dist)) {
        best = hit;
        bestIdx = bi;
      }
    }
    if (!best || best.dist > 2.5) continue;
    const isTarget = bestIdx === targetIdx;
    if (!isTarget && e.kind !== 'main') continue;
    // Extérieur = à l'opposé du centre du bâtiment, pour poser pictogramme et
    // marches du bon côté de la porte.
    const ring = facades[bestIdx]!;
    let cx = 0;
    let cz = 0;
    for (const [rx, rz] of ring) {
      cx += rx;
      cz += rz;
    }
    cx /= ring.length;
    cz /= ring.length;
    const outward = -localSideZ(cx - best.px, cz - best.pz, best.angle);
    doors.push({ e, x: best.px, z: best.pz, angle: best.angle, outward, target: isTarget });
  }

  for (const d of doors) {
    const colour = d.target ? entranceColour(d.e.wheelchair) : 0x8891a0;
    const door = makeDoorMarker(d.e, colour, d.target, d.outward);
    door.position.set(d.x, 0, d.z);
    door.rotation.y = d.angle; // encadrement dans le plan de la façade
    const access =
      d.e.wheelchair === 'yes'
        ? 'Accessible en fauteuil'
        : d.e.wheelchair === 'limited'
          ? 'Accès limité en fauteuil'
          : d.e.wheelchair === 'no'
            ? 'Non accessible en fauteuil'
            : 'Accessibilité non renseignée';
    addInfo(door, {
      title: d.target
        ? d.e.kind === 'main'
          ? 'Entrée principale du lieu'
          : 'Entrée du lieu'
        : 'Entrée d’un bâtiment voisin',
      colour,
      details: [
        access,
        d.e.automatic ? 'Porte automatique' : null,
        d.e.stepCount ? `${d.e.stepCount} marche${d.e.stepCount > 1 ? 's' : ''} au seuil` : null,
        d.e.kerbHeight != null && d.e.kerbHeight > 0 ? `Ressaut de ${d.e.kerbHeight} m` : null,
        d.e.width ? `Passage de ${d.e.width} m` : null,
      ],
    });
  }

  // --- Marqueur de l'acces vise ---
  // On le pose sur la meilleure entree cartographiee du batiment vise ; a
  // defaut, sur le point Access'libre (utile quand aucune entree n'est connue,
  // ou quand le point n'est dans aucune empreinte de batiment).
  const bestDoor = doors
    .filter((d) => d.target)
    .sort(
      (a, b) =>
        entranceScore(b.e) - entranceScore(a.e) ||
        Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)
    )[0];
  addEntranceMarker(scene, hasTargetBuilding, bestDoor ? [bestDoor.x, bestDoor.z] : undefined);

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
  // Réseau empruntable à pied, pour le calcul du trajet. Les escaliers y
  // figurent mais coûtent cher : le trajet les contourne s'il le peut.
  const walkNet: RouteLine[] = [];
  for (const path of payload.neighborhood.paths) {
    if (path.kind === 'park') continue;
    // Overpass rend les chemins entiers : une rue traversant le quartier
    // partait sinon jusqu'à l'horizon, en étoile autour de la scène. On ne
    // garde que les portions présentes dans le voisinage.
    const whole: [number, number][] = path.coords.map((p) => toLocal(p[0], p[1]));
    for (const pts of clipToRadius(whole, FRAME_MAX)) {
      for (const [x, z] of pts) grow(x, z);
      if (pts.length >= 2) {
        if (path.kind === 'road') roadLines.push(pts);
        else if (path.kind === 'sidewalk' || path.kind === 'footway') footLines.push(pts);
        if (path.kind !== 'road')
          walkNet.push({ points: pts, cost: path.kind === 'steps' ? 6 : 1 });
      }

    // Passage piéton : bandes blanches rayées posées sur la chaussée.
    if (path.kind === 'crossing') {
      const zebra = makeCrossing(pts, zebraMat);
      if (zebra) scene.add(zebra);
      continue;
    }

      // Escalier : volée de marches, main courante et rampe si OSM les signale.
      if (path.kind === 'steps') {
        const stairs = makeSteps(path, pts, stepsMat);
        if (stairs) {
          addInfo(stairs, {
            title: 'Escalier',
            colour: path.rampWheelchair ? 0x2f6fb0 : 0xc08a5a,
            details: [
              path.stepCount ? `${path.stepCount} marches` : 'Nombre de marches non renseigné',
              path.rampWheelchair
                ? 'Rampe praticable en fauteuil'
                : 'Pas de rampe fauteuil signalée',
              path.handrail ? 'Main courante' : null,
              path.surface ? `Revêtement : ${path.surface}` : null,
            ],
          });
        }
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
      grow(x, z);
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

  // Bancs et mobilier s'alignent d'abord sur le reseau pieton, a defaut sur la
  // voirie ; les bordures et barrieres, elles, peuvent border l'un ou l'autre.
  const benchGuides = footLines.length ? footLines : roadLines;
  const allGuides = [...footLines, ...roadLines];
  for (const bench of nb.benches ?? []) {
    const [x, z] = toLocal(bench.lng, bench.lat);
    grow(x, z);
    const seat = makeBench(x, z, bench.colour, bench.backrest !== false);
    seat.rotation.y = benchAngle(x, z, bench.direction, benchGuides);
    addInfo(seat, {
      title: 'Banc',
      details: [
        bench.backrest === true ? 'avec dossier' : bench.backrest === false ? 'sans dossier' : null,
        bench.material ? `Matériau : ${bench.material}` : null,
        'Point de repos sur le trajet',
      ],
    });
  }

  // --- Arrêts de bus : quai orienté sur la voie, abri/banc si connus ---
  // Retenus au passage pour le trajet : on garde le plus proche du lieu visé.
  let nearestStop: {
    x: number;
    z: number;
    name: string | null;
    d: number;
  } | null = null;
  for (const stop of nb.busStops ?? []) {
    const [x, z] = toLocal(stop.lng, stop.lat);
    grow(x, z);
    const dStop = Math.hypot(x, z);
    if (!nearestStop || dStop < nearestStop.d)
      nearestStop = { x, z, name: stop.name ?? null, d: dStop };
    const near = nearestLineDir(x, z, roadLines);
    const angle = near?.angle ?? 0;
    // Côté chaussée : on oriente le quai et le poteau vers la rue.
    const side = near ? localSideZ(near.px - x, near.pz - z, angle) : 1;
    addInfo(
      makeBusStop({
        x,
        z,
        angle,
        side,
        shelter: stop.shelter === true,
        bench: stop.bench === true,
        tactile: stop.tactile === true,
        signTex: busSignTexture(stop.line),
      }),
      {
        title: stop.name ? `Arrêt ${stop.name}` : 'Arrêt de bus',
        colour: 0x2b6cb0,
        details: [
          stop.line ? `Ligne(s) : ${stop.line.split(';').join(', ')}` : null,
          stop.shelter === true ? 'Abri voyageurs' : null,
          stop.bench === true ? 'Banc à l’arrêt' : null,
          stop.tactile === true ? 'Bande d’éveil de vigilance' : null,
        ],
      }
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
    // Un groupe par ligne : le survol renvoie la ligne entiere, quel que soit
    // le troncon designe.
    const group = new THREE.Group();
    let longest: [number, number][] | null = null;
    for (const seg of route.segments) {
      const local = seg.map((p) => toLocal(p[0], p[1]));
      for (const run of clipToRadius(local, Math.max(maxR, 60))) {
        const line = offsetPolyline(run, lateral);
        const geom = ribbon(line, 0.62);
        if (geom) {
          const mesh = new THREE.Mesh(geom, mat);
          mesh.position.y = 0.14;
          group.add(mesh);
        }
        // Pastilles aux sommets : le ruban reste continu dans les virages.
        for (const [jx, jz] of line) {
          const dot = new THREE.Mesh(joint, mat);
          dot.rotation.x = -Math.PI / 2;
          dot.position.set(jx, 0.14, jz);
          group.add(dot);
        }
        if (!longest || pathLength(line) > pathLength(longest)) longest = line;
      }
    }
    // Les arrets desservis par cette ligne, d'apres le `route_ref` des arrets.
    const served = (nb.busStops ?? [])
      .filter((s) => s.line && route.ref && s.line.split(';').includes(route.ref))
      .map((s) => s.name)
      .filter((n): n is string => !!n);
    addInfo(group, {
      title: route.ref ? `Ligne de bus ${route.ref}` : 'Ligne de bus',
      colour: col,
      details: [
        route.name,
        served.length ? `Dessert : ${served.slice(0, 3).join(', ')}` : null,
        'Tracé dans le voisinage · source OpenStreetMap',
      ],
    });
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
  const stallMat = new THREE.MeshStandardMaterial({
    color: 0x2f6fb0,
    roughness: 0.85,
  });
  const stallPlainMat = new THREE.MeshStandardMaterial({
    color: 0x9aa3af,
    roughness: 0.9,
  });
  const stallLineMat = new THREE.MeshStandardMaterial({
    color: 0xf4f4f2,
    roughness: 0.8,
  });
  // Place PMR la plus proche du lieu : point de départ du trajet.
  let nearestPmr: { x: number; z: number; d: number } | null = null;
  for (const p of nb.parking ?? []) {
    const [x, z] = toLocal(p.lng, p.lat);
    grow(x, z);
    const dPmr = Math.hypot(x, z);
    if (p.pmr && (!nearestPmr || dPmr < nearestPmr.d)) nearestPmr = { x, z, d: dPmr };

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
    addInfo(holder, {
      title: p.pmr ? 'Place de stationnement PMR' : 'Place de stationnement',
      colour: p.pmr ? 0x2f6fb0 : 0x9aa3af,
      details: [
        `${long.toFixed(1)} m × ${short.toFixed(1)} m`,
        p.ring ? 'Emprise cartographiée dans OpenStreetMap' : 'Orientation déduite du contexte',
      ],
    });

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
    if (f.kind === 'tree' || f.kind === 'fountain') grow(x, z);
    switch (f.kind) {
      case 'tree':
        addInfo(makeTree(f, x, z, { trunk: trunkMat, leaf: leafMats }), {
          title: 'Arbre',
          details: [
            f.height ? `Hauteur : ${f.height} m` : null,
            f.crown ? `Couronne : ${f.crown} m` : null,
            'Ombre sur le cheminement',
          ],
        });
        break;
      case 'fire_hydrant':
        addInfo(makeHydrant(x, z, f.variant ?? null), {
          title: 'Borne incendie',
          colour: 0xb5322f,
          details: [f.variant ? `Type : ${f.variant}` : null, 'Obstacle bas sur le trottoir'],
        });
        break;
      case 'street_cabinet':
        addInfo(makeStreetCabinet(x, z, nearestLineDir(x, z, roadLines)?.angle ?? 0), {
          title: 'Armoire de rue',
          details: ['Réduit la largeur de passage'],
        });
        break;
      case 'drinking_water':
        addInfo(makeDrinkingWater(x, z), {
          title: 'Eau potable',
          colour: 0x5fa8c7,
          details: ['Point d’eau accessible au public'],
        });
        break;
      case 'fountain':
        addInfo(makeFountain(x, z), { title: 'Fontaine', colour: 0x5fa8c7 });
        break;
      case 'bollard':
        addInfo(makeBollard(x, z), {
          title: 'Borne',
          details: ['Obstacle bas, souvent en série'],
        });
        break;
      case 'lamp':
        addInfo(makeStreetLamp(x, z, nearestLineDir(x, z, roadLines)?.angle ?? 0), {
          title: 'Lampadaire',
          details: ['Éclairage du cheminement'],
        });
        break;
      case 'waste':
        addInfo(makeWasteBin(x, z), { title: 'Corbeille de rue' });
        break;
      case 'toilets': {
        grow(x, z);
        const ok = f.wheelchair === 'yes';
        addInfo(makeToilets(x, z, nearestLineDir(x, z, allGuides)?.angle ?? 0, ok), {
          title: f.name ?? 'Toilettes publiques',
          colour: ok ? 0x2f6fb0 : 0x9aa6ab,
          details: [
            ok
              ? 'Accessibles en fauteuil'
              : f.wheelchair === 'no'
                ? 'Non accessibles en fauteuil'
                : 'Accessibilité non renseignée',
          ],
        });
        break;
      }
      case 'elevator':
        grow(x, z);
        addInfo(makeElevator(x, z, f.wheelchair !== 'no'), {
          title: f.name ?? 'Ascenseur',
          colour: 0x2f6fb0,
          details: [
            f.wheelchair === 'no' ? 'Non accessible en fauteuil' : 'Accès vertical sans marches',
          ],
        });
        break;
      case 'barrier':
        addInfo(makeBarrier(x, z, nearestLineDir(x, z, allGuides)?.angle ?? 0, f.variant ?? null), {
          title: f.variant === 'cycle_barrier' || f.variant === 'chicane' ? 'Chicane' : 'Barrière',
          colour: 0xb8783a,
          details: [
            f.variant ? `Type OSM : ${f.variant}` : null,
            f.variant === 'cycle_barrier' || f.variant === 'chicane'
              ? 'Passage étroit, souvent infranchissable en fauteuil'
              : 'Réduit la largeur de passage',
          ],
        });
        break;
      default:
        // Bancs, arrêts de bus et passages piétons sont déjà rendus depuis
        // leurs propres listes.
        break;
    }
  }

  // --- Bordures de trottoir : abaissees (franchissables) ou hautes (ressaut) ---
  for (const k of nb.kerbs ?? []) {
    const [x, z] = toLocal(k.lng, k.lat);
    const lowered = k.kind === 'lowered' || k.kind === 'flush' || (k.height ?? 1) <= 0.03;
    addInfo(makeKerb(x, z, nearestLineDir(x, z, allGuides)?.angle ?? 0, lowered), {
      title: lowered ? 'Bordure abaissée' : 'Bordure haute',
      colour: lowered ? 0x2f6fb0 : 0xa8563f,
      details: [
        lowered ? 'Franchissable en fauteuil' : 'Ressaut à franchir',
        k.height != null ? `Hauteur : ${k.height} m` : null,
        k.tactile ? 'Bande d’éveil de vigilance' : null,
      ],
    });
  }

  // --- Trajet : de la place PMR la plus proche à l'arrêt de bus le plus proche
  // Les deux arrivées les plus courantes pour qui prépare une visite. Le tracé
  // suit les cheminements cartographiés ; à défaut il relie les deux points en
  // ligne droite, ce que l'infobulle annonce sans détour.
  const tickers: ((dt: number) => void)[] = [];
  if (nearestPmr && nearestStop) {
    const route = findRoute(walkNet, [nearestPmr.x, nearestPmr.z], [nearestStop.x, nearestStop.z]);
    const drawn = makeRoute(route.points, COLOR_ROUTE);
    if (drawn) {
      addInfo(drawn.group, {
        title: 'Trajet à pied',
        colour: COLOR_ROUTE,
        details: [
          `Place PMR → ${nearestStop.name ? `arrêt ${nearestStop.name}` : 'arrêt de bus'}`,
          `Environ ${Math.round(route.length)} m`,
          route.direct
            ? 'Liaison directe : aucun cheminement cartographié entre les deux'
            : 'Suit les trottoirs et cheminements d’OpenStreetMap',
        ],
      });
      tickers.push(drawn.tick);
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

  const c: Ctx = {
    renderer,
    scene,
    camera,
    controls,
    canvas,
    raf: 0,
    ro: null,
    hover: null,
  };

  // Survol : l'information vient a la demande, sous le curseur, au lieu
  // d'etiquettes permanentes qui encombraient la scene.
  c.hover = attachHover(canvas, camera, hoverables);

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

  // Horloge partagée : les animations avancent au temps écoulé, pas au nombre
  // de trames, pour défiler à la même vitesse quel que soit l'affichage.
  const clock = new THREE.Clock();
  const loop = (): void => {
    c.raf = requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1);
    for (const tick of tickers) tick(dt);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  ctx = c;
}

/**
 * Objets que la légende sait illustrer. Chaque clé est rendue à partir du même
 * code que la scène : la vignette montre exactement ce qu'on verra.
 */
export type LegendKind =
  | 'target'
  | 'building'
  | 'entrance-yes'
  | 'entrance-no'
  | 'entrance-other'
  | 'sidewalk'
  | 'footway'
  | 'crossing'
  | 'road'
  | 'steps'
  | 'steps-ramp'
  | 'bench'
  | 'bus_stop'
  | 'bus_route'
  | 'parking-pmr'
  | 'parking'
  | 'tree'
  | 'fire_hydrant'
  | 'street_cabinet'
  | 'water'
  | 'bollard'
  | 'lamp'
  | 'waste'
  | 'toilets'
  | 'elevator'
  | 'barrier'
  | 'kerb-low'
  | 'route';

/** Petit tronçon droit, pour illustrer un revêtement de cheminement. */
function legendStrip(geom: THREE.BufferGeometry | null, colour: number, y = 0): THREE.Object3D {
  const g = new THREE.Group();
  if (!geom) return g;
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshStandardMaterial({
      color: colour,
      roughness: 0.95,
      side: THREE.DoubleSide,
    })
  );
  mesh.position.y = y;
  g.add(mesh);
  return g;
}

/** Construit l'objet représentatif d'une entrée de légende. */
function legendObject(kind: LegendKind): THREE.Object3D | null {
  const line: [number, number][] = [
    [-2.2, 0],
    [2.2, 0],
  ];
  const door = (wheelchair: string | null, prominent: boolean): OsmEntrance => ({
    id: 'legend',
    lng: 0,
    lat: 0,
    kind: prominent ? 'main' : 'yes',
    wheelchair,
    automatic: null,
    door: null,
    width: null,
    stepCount: null,
    kerbHeight: null,
  });
  const stairs = (ramp: boolean): OsmPath => ({
    id: 'legend',
    kind: 'steps',
    coords: [],
    stepCount: 6,
    handrail: true,
    rampWheelchair: ramp,
    width: 1.8,
  });

  switch (kind) {
    case 'target':
    case 'building': {
      const isTarget = kind === 'target';
      const col = isTarget ? COLOR_TARGET : 0xc6c8cc;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(6, 9, 6),
        new THREE.MeshStandardMaterial({
          color: col,
          roughness: 0.85,
          emissive: isTarget ? col : 0x000000,
          emissiveIntensity: isTarget ? 0.12 : 0,
        })
      );
      mesh.position.y = 4.5;
      return mesh;
    }
    case 'entrance-yes':
      return makeDoorMarker(door('yes', true), entranceColour('yes'), true, 1);
    case 'entrance-no':
      return makeDoorMarker(door('no', true), entranceColour('no'), true, 1);
    case 'entrance-other': {
      // Un pan de façade derrière le seuil : sans lui, la vignette se confond
      // avec une dalle de trottoir.
      const g = new THREE.Group();
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 1.7, 0.3),
        new THREE.MeshStandardMaterial({ color: 0xc6c8cc, roughness: 0.9 })
      );
      wall.position.set(0, 0.85, -0.25);
      g.add(wall);
      g.add(makeDoorMarker(door(null, false), 0x8891a0, false, 1));
      return g;
    }
    case 'sidewalk':
      return legendStrip(ribbonSlab(line, 1.6, 0.12), 0xeef1f5);
    case 'footway':
      return legendStrip(ribbonSlab(line, 1.4, 0.07), 0xd7cdba);
    case 'road':
      return legendStrip(ribbon(line, 3), 0x8b9098);
    case 'crossing': {
      const g = new THREE.Group();
      g.add(legendStrip(ribbon(line, 3.4), 0x8b9098));
      const zebra = makeCrossing(line, new THREE.MeshStandardMaterial({ color: 0xf2f2f2 }));
      if (zebra) g.add(zebra);
      return g;
    }
    case 'steps':
    case 'steps-ramp':
      return makeSteps(
        stairs(kind === 'steps-ramp'),
        line,
        new THREE.MeshStandardMaterial({ color: 0xc08a5a, roughness: 0.9 })
      );
    case 'bench':
      return makeBench(0, 0, null, true);
    case 'bus_stop':
      return makeBusStop({
        x: 0,
        z: 0,
        angle: 0,
        side: 1,
        shelter: true,
        bench: true,
        tactile: true,
        signTex: busSignTexture(null),
      });
    case 'bus_route':
      return legendStrip(ribbon(line, 0.62), 0x8b5cf6, 0.05);
    case 'parking-pmr':
    case 'parking': {
      const pmr = kind === 'parking-pmr';
      const g = new THREE.Group();
      const stall = new THREE.Mesh(
        new THREE.PlaneGeometry(5, pmr ? 3.3 : 2.5),
        new THREE.MeshStandardMaterial({
          color: pmr ? 0x2f6fb0 : 0x9aa3af,
          roughness: 0.85,
        })
      );
      stall.rotation.x = -Math.PI / 2;
      g.add(stall);
      return g;
    }
    case 'tree':
      return makeTree({ id: 'legend', kind: 'tree', lng: 0, lat: 0, height: 6, crown: 3.4 }, 0, 0, {
        trunk: new THREE.MeshStandardMaterial({
          color: 0x6b5340,
          roughness: 0.95,
        }),
        leaf: [
          new THREE.MeshStandardMaterial({
            color: 0x5f8f52,
            roughness: 0.9,
            flatShading: true,
          }),
        ],
      });
    case 'fire_hydrant':
      return makeHydrant(0, 0, null);
    case 'street_cabinet':
      return makeStreetCabinet(0, 0, 0);
    case 'water':
      return makeDrinkingWater(0, 0);
    case 'bollard':
      return makeBollard(0, 0);
    case 'lamp':
      return makeStreetLamp(0, 0, 0);
    case 'waste':
      return makeWasteBin(0, 0);
    case 'toilets':
      return makeToilets(0, 0, 0, true);
    case 'elevator':
      return makeElevator(0, 0, true);
    case 'barrier':
      return makeBarrier(0, 0, 0, 'cycle_barrier');
    case 'kerb-low':
      return makeKerb(0, 0, 0, true);
    case 'route': {
      // Vignette figée : la vignette est une image, le défilement se voit dans
      // la scène. On garde deux tirets pour que le motif se lise.
      const drawn = makeRoute(
        [
          [-2.6, 0],
          [2.6, 0],
        ],
        COLOR_ROUTE
      );
      return drawn ? drawn.group : null;
    }
    default:
      return null;
  }
}

/** Libere geometries et materiaux d'une sous-arborescence. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) (mat as THREE.Material).dispose();
  });
}

/**
 * Rend chaque entrée de légende en petite image, avec le même code que la
 * scène : la légende montre l'objet réel plutôt qu'une pastille de couleur.
 * Un seul contexte WebGL jetable est utilisé pour l'ensemble, puis libéré.
 */
export function renderLegendIcons(kinds: LegendKind[]): Record<string, string> {
  const out: Record<string, string> = {};
  const size = 72;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      // Indispensable pour relire le rendu via toDataURL.
      preserveDrawingBuffer: true,
    });
  } catch {
    return out; // pas de WebGL : la légende restera textuelle
  }
  renderer.setPixelRatio(2);
  renderer.setSize(size, size, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x8d949d, 2.2));
  const sun = new THREE.DirectionalLight(0xfff4e6, 1.6);
  sun.position.set(4, 8, 5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 400);

  for (const kind of kinds) {
    const obj = legendObject(kind);
    if (!obj) continue;
    scene.add(obj);
    // Cadrage automatique : on recule d'autant que l'objet est grand, en vue
    // trois quarts pour que le volume se lise.
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) {
      scene.remove(obj);
      disposeTree(obj);
      continue;
    }
    const span = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    // Cadrage sur la sphère englobante : toutes les vignettes remplissent la
    // même surface, qu'il s'agisse d'une dalle ou d'un lampadaire. On abaisse
    // le point de vue pour les objets élancés, qui sinon se lisent mal.
    const r = Math.max(span.length() / 2, 0.35);
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.04;
    const tall = span.y > Math.max(span.x, span.z) * 1.6;
    const elev = THREE.MathUtils.degToRad(tall ? 15 : 34);
    const azim = THREE.MathUtils.degToRad(38);
    camera.position.set(
      centre.x + dist * Math.cos(elev) * Math.sin(azim),
      centre.y + dist * Math.sin(elev),
      centre.z + dist * Math.cos(elev) * Math.cos(azim)
    );
    camera.lookAt(centre);
    renderer.render(scene, camera);
    out[kind] = canvas.toDataURL('image/png');
    scene.remove(obj);
    disposeTree(obj);
  }

  disposeTree(scene);
  renderer.dispose();
  return out;
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
  ctx.hover?.dispose();
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
