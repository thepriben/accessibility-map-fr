/**
 * Survol des objets de la scène 3D : une infobulle décrit ce que la souris
 * désigne (ligne de bus, banc, escalier, entrée…).
 *
 * Les objets porteurs d'information déclarent un `SceneInfo` via
 * `tagInfo(objet, info)` ; le survol remonte la hiérarchie jusqu'au premier
 * ancêtre étiqueté, ce qui permet d'étiqueter un groupe entier d'un seul coup.
 */
import * as THREE from 'three';

export interface SceneInfo {
  /** Titre court, en gras dans l'infobulle. */
  title: string;
  /** Précisions, une par ligne. Les valeurs vides sont ignorées. */
  details?: (string | null | undefined | false)[];
  /** Pastille de couleur devant le titre (couleur Three, ex. 0x2f6fb0). */
  colour?: number;
}

interface Tagged extends THREE.Object3D {
  userData: { sceneInfo?: SceneInfo };
}

/** Associe une information de survol à un objet (ou à tout un groupe). */
export function tagInfo<T extends THREE.Object3D>(obj: T, info: SceneInfo): T {
  (obj as Tagged).userData.sceneInfo = info;
  return obj;
}

/** Première information trouvée en remontant la hiérarchie. */
function findInfo(obj: THREE.Object3D | null): SceneInfo | null {
  for (let o = obj; o; o = o.parent) {
    const info = (o as Tagged).userData?.sceneInfo;
    if (info) return info;
  }
  return null;
}

export interface HoverHandle {
  /** Objets interrogés au survol. À réalimenter si la scène change. */
  setTargets(objects: THREE.Object3D[]): void;
  dispose(): void;
}

/**
 * Branche le survol sur un canvas. Le picking n'est calculé qu'une fois par
 * trame et seulement si la souris a bougé : un raycast à chaque `pointermove`
 * saturerait le thread principal sur une scène chargée.
 */
export function attachHover(
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  targets: THREE.Object3D[]
): HoverHandle {
  const host = canvas.parentElement ?? document.body;
  const tip = document.createElement('div');
  tip.className = 'scene3d-tip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  host.appendChild(tip);

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let list = targets;
  let px = 0;
  let py = 0;
  let dirty = false;
  let raf = 0;
  let shown: SceneInfo | null = null;

  const hide = (): void => {
    if (!shown) return;
    shown = null;
    tip.hidden = true;
    canvas.style.cursor = '';
  };

  const show = (info: SceneInfo): void => {
    if (info !== shown) {
      shown = info;
      const dot =
        info.colour != null
          ? `<span class="tip-dot" style="background:#${info.colour
              .toString(16)
              .padStart(6, '0')}"></span>`
          : '';
      const details = (info.details ?? [])
        .filter((d): d is string => typeof d === 'string' && d.length > 0)
        .map((d) => `<span>${d}</span>`)
        .join('');
      tip.innerHTML = `<strong>${dot}${info.title}</strong>${details}`;
      tip.hidden = false;
      canvas.style.cursor = 'help';
    }
    // Décalage sous le curseur, rabattu si l'infobulle sort du canvas.
    const r = canvas.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const x = Math.min(Math.max(px - r.left + 14, 6), Math.max(r.width - w - 6, 6));
    const y = py - r.top + 18 + h > r.height ? py - r.top - h - 12 : py - r.top + 18;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(y, 6))}px)`;
  };

  const pick = (): void => {
    raf = 0;
    if (!dirty) return;
    dirty = false;
    const r = canvas.getBoundingClientRect();
    ndc.x = ((px - r.left) / r.width) * 2 - 1;
    ndc.y = -((py - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(list, true);
    for (const hit of hits) {
      const info = findInfo(hit.object);
      if (info) {
        show(info);
        return;
      }
    }
    hide();
  };

  const onMove = (ev: PointerEvent): void => {
    px = ev.clientX;
    py = ev.clientY;
    dirty = true;
    if (!raf) raf = requestAnimationFrame(pick);
  };
  const onLeave = (): void => hide();
  // Pendant un déplacement de caméra, l'infobulle n'aurait plus de sens.
  const onDown = (): void => hide();

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);

  return {
    setTargets(objects) {
      list = objects;
    },
    dispose() {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      if (raf) cancelAnimationFrame(raf);
      canvas.style.cursor = '';
      tip.remove();
    },
  };
}
