import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import type { NeighborhoodData, OsmBuilding } from '../data/overpass';

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

/** Convertit une valeur OSM `colour` en couleur Three (hex, nom, sinon defaut). */
function parseColour(c: string | null): number {
  if (!c) return BENCH_DEFAULT;
  const v = c.trim().toLowerCase();
  if (/^#([0-9a-f]{6})$/.test(v)) return parseInt(v.slice(1), 16);
  if (/^#([0-9a-f]{3})$/.test(v)) {
    const r = v[1];
    const g = v[2];
    const b = v[3];
    return parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  return NAMED_COLOURS[v] ?? BENCH_DEFAULT;
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
    const angle = Math.atan2(-uz, ux);
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

/** Petit banc : assise (+ dossier optionnel), couleur issue d'OSM si connue. */
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

/** Poteau + panneau d'arrêt de bus (le nom/ligne sont portés par une étiquette). */
function makeBusStop(
  x: number,
  z: number,
  poleMat: THREE.Material,
  signMat: THREE.Material
): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.8, 10), poleMat);
  pole.position.y = 1.4;
  pole.castShadow = true;
  g.add(pole);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.36, 0.05), signMat);
  sign.position.set(0, 2.55, 0);
  sign.castShadow = true;
  g.add(sign);
  g.position.set(x, 0, z);
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
  for (const path of payload.neighborhood.paths) {
    if (path.kind === 'park') continue;
    const pts: [number, number][] = path.coords.map((p) => toLocal(p[0], p[1]));
    for (const [x, z] of pts) maxR = Math.max(maxR, Math.hypot(x, z));

    // Passage piéton : bandes blanches rayées posées sur la chaussée.
    if (path.kind === 'crossing') {
      const zebra = makeCrossing(pts, zebraMat);
      if (zebra) scene.add(zebra);
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
  for (const area of nb.parkingAreas ?? []) {
    const ring: [number, number][] = area.ring.map((p) => toLocal(p[0], p[1]));
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

  for (const bench of nb.benches ?? []) {
    const [x, z] = toLocal(bench.lng, bench.lat);
    maxR = Math.max(maxR, Math.hypot(x, z));
    scene.add(makeBench(x, z, bench.colour, bench.backrest !== false));
  }

  const busSignMat = new THREE.MeshStandardMaterial({ color: 0x2b6cb0, roughness: 0.5 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x394251, roughness: 0.6, metalness: 0.2 });
  for (const stop of nb.busStops ?? []) {
    const [x, z] = toLocal(stop.lng, stop.lat);
    maxR = Math.max(maxR, Math.hypot(x, z));
    scene.add(makeBusStop(x, z, poleMat, busSignMat));
    const lines: string[] = [];
    if (stop.name) lines.push(stop.name);
    lines.push(stop.line ? `Ligne ${stop.line}` : 'Arrêt de bus');
    const label = makeLabel(lines, { bg: 'rgba(23,58,102,0.92)', fg: '#eaf1fb', worldH: 1.5 });
    label.position.set(x, 3.9, z);
    scene.add(label);
  }

  for (const p of nb.parking ?? []) {
    const [x, z] = toLocal(p.lng, p.lat);
    maxR = Math.max(maxR, Math.hypot(x, z));
    // Emplacement bleu marque au sol.
    const stall = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 5),
      new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.85 })
    );
    stall.rotation.x = -Math.PI / 2;
    stall.position.set(x, 0.07, z);
    stall.receiveShadow = true;
    scene.add(stall);
    const label = makeLabel(['\u267F PMR'], { bg: 'rgba(47,111,176,0.95)', fg: '#ffffff', worldH: 1.5 });
    label.position.set(x, 2.2, z);
    scene.add(label);
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
