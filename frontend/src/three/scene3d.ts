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

const COLOR_TARGET = 0xef8b4e; // lieu cible : orange chaud (conserve)

interface Theme {
  bg: number;
  ground: number;
  path: number; // cheminements pietons (trottoirs / footways)
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
  let hasTargetBuilding = false;
  for (const b of payload.neighborhood.buildings) {
    if (!b.ring || b.ring.length < 3) continue;
    const ring: [number, number][] = b.ring.map((p) => toLocal(p[0], p[1]));
    const shape = new THREE.Shape();
    ring.forEach(([x, z], i) => {
      if (i === 0) shape.moveTo(x, z);
      else shape.lineTo(x, z);
      maxR = Math.max(maxR, Math.hypot(x, z));
    });
    const height = buildingHeight(b);
    const geom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    geom.rotateX(-Math.PI / 2);

    const isTarget = !hasTargetBuilding && ringContains(ring, 0, 0);
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

  // --- Chaussees (routes) et cheminements pietons : rubans plats au sol ---
  // Les routes sont plus larges et d'une couleur asphalte distincte ; les
  // trottoirs/footways restent clairs et passent legerement au-dessus.
  const pathMat = new THREE.MeshStandardMaterial({
    color: th.path,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const roadMat = new THREE.MeshStandardMaterial({
    color: th.road,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  for (const path of payload.neighborhood.paths) {
    if (path.kind === 'park') continue;
    const pts: [number, number][] = path.coords.map((p) => toLocal(p[0], p[1]));
    for (const [x, z] of pts) maxR = Math.max(maxR, Math.hypot(x, z));
    const isRoad = path.kind === 'road';
    const width = isRoad ? path.width ?? 5 : path.kind === 'sidewalk' ? 1.5 : 1.2;
    const geom = ribbon(pts, width);
    if (!geom) continue;
    const mesh = new THREE.Mesh(geom, isRoad ? roadMat : pathMat);
    mesh.position.y = isRoad ? 0.03 : 0.06; // trottoirs au-dessus de la chaussee
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // --- Mobilier : bancs, arrets de bus, places PMR ---
  const nb = payload.neighborhood;

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
