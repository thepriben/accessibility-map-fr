import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { NeighborhoodData, OsmBuilding } from '../data/overpass';

export interface Scene3DPayload {
  place: { nom: string; lng: number; lat: number };
  neighborhood: NeighborhoodData;
  theme?: string;
}

interface Ctx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
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

function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const WALL_PALETTE = [0x9e5c4d, 0x8c784d, 0x66738c, 0x7a6685, 0x598580, 0x998c73];
const COLOR_TARGET = 0xf28c33;
const COLOR_WIKIDATA = 0xd9b340;

interface Theme {
  bg: number;
  ground: number;
  ambient: number;
  ambientI: number;
  dir: number;
  dirI: number;
}

function themeColors(dark: boolean): Theme {
  return dark
    ? { bg: 0x0c0f14, ground: 0x171a20, ambient: 0x8899bb, ambientI: 1.1, dir: 0xffffff, dirI: 1.6 }
    : { bg: 0xdfe6ee, ground: 0x9e988c, ambient: 0xffffff, ambientI: 1.5, dir: 0xffffff, dirI: 1.9 };
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
    new THREE.PlaneGeometry(1000, 1000),
    new THREE.MeshLambertMaterial({ color: th.ground })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);

  // --- Batiments extrudes ---
  let maxR = 20;
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

    let color: number;
    if (ringContains(ring, 0, 0)) color = COLOR_TARGET;
    else if (b.wikidata) color = COLOR_WIKIDATA;
    else color = WALL_PALETTE[hashId(b.id) % WALL_PALETTE.length];

    const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color }));
    scene.add(mesh);
  }

  // --- Lumieres (sobres) ---
  scene.add(new THREE.AmbientLight(th.ambient, th.ambientI));
  const dir = new THREE.DirectionalLight(th.dir, th.dirI);
  dir.position.set(60, 120, 40);
  scene.add(dir);

  // --- Camera + rendu ---
  const radius = Math.min(Math.max(maxR * 1.9, 30), 320);
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || canvas.parentElement?.clientHeight || window.innerHeight;
  const camera = new THREE.PerspectiveCamera(55, w / h, 0.5, 4000);
  camera.position.set(radius * 0.6, radius * 0.7, radius * 0.6);

  scene.fog = new THREE.Fog(th.bg, radius * 1.1, radius * 3);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minDistance = 8;
  controls.maxDistance = radius * 3;
  controls.target.set(0, Math.min(radius * 0.15, 8), 0);
  controls.listenToKeyEvents(window);
  controls.keyPanSpeed = 14;
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
