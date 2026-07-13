import type { NeighborhoodData } from '../data/overpass';
import { getTheme } from '../theme';
import type { Place, StreetPhoto } from '../types';

export interface ScenePayload {
  place: { nom: string; lng: number; lat: number; activite?: string; a11y?: string };
  neighborhood: NeighborhoodData;
  photos: StreetPhoto[];
  /** Thème de rendu ('light' | 'dark'). */
  theme?: string;
}

const CANVAS_ID = 'scene3d';

/** Notifie l'UI (bouton swap, etc.) d'un changement d'état de la vue 3D. */
function dispatchSceneToggle(active: boolean): void {
  window.dispatchEvent(new CustomEvent('scene3d:toggle', { detail: { active } }));
}

// Chargement paresseux du module Three.js (chunk separe) : la page reste legere
// et la 3D n'est telechargee qu'a la premiere utilisation.
type SceneMod = typeof import('../three/scene3d');
let sceneMod: SceneMod | null = null;
let loading: Promise<SceneMod | null> | null = null;

async function loadScene(): Promise<SceneMod | null> {
  if (sceneMod) return sceneMod;
  if (loading) return loading;
  loading = import('../three/scene3d')
    .then((m) => {
      sceneMod = m;
      return m;
    })
    .catch((err) => {
      console.warn('Module 3D (Three.js) indisponible', err);
      return null;
    });
  return loading;
}

/** Précharge (sans attendre) le module 3D pour une bascule quasi instantanée. */
export function prefetchScene3D(): void {
  void loadScene();
}

let lastPayload: ScenePayload | null = null;

/**
 * Bascule sur la vue 3D (Three.js) : affiche le canvas par-dessus la carte et
 * construit la scene (batiments du voisinage). Retourne false si le module 3D
 * n'a pas pu se charger (fallback : on reste en 2D).
 */
export async function enterScene3D(payload: ScenePayload): Promise<boolean> {
  const canvas = document.getElementById(CANVAS_ID) as HTMLCanvasElement | null;
  const ui = document.getElementById('scene3d-ui');
  if (!canvas) return false;

  payload.theme = getTheme();
  lastPayload = payload;

  canvas.setAttribute('aria-hidden', 'false');
  canvas.classList.add('is-visible');
  if (ui) {
    ui.hidden = false;
    ui.innerHTML = sceneUiHtml(payload);
    ui.querySelector('#scene3d-close')?.addEventListener('click', () => exitScene3D());
  }

  try {
    const mod = await loadScene();
    if (!mod) {
      exitScene3D();
      return false;
    }
    mod.startScene3D(canvas, payload);
    dispatchSceneToggle(true);
    return true;
  } catch (err) {
    console.error('Echec du lancement de la scene 3D', err);
    exitScene3D();
    return false;
  }
}

/** Resynchronise le thème de la scène 3D si elle est affichée. */
export function refreshScene3DTheme(): void {
  if (!sceneMod || !isScene3DActive() || !lastPayload) return;
  lastPayload.theme = getTheme();
  sceneMod.updateTheme(getTheme() === 'dark');
}

/** Vrai si la scene 3D est actuellement affichee. */
export function isScene3DActive(): boolean {
  return document.getElementById(CANVAS_ID)?.classList.contains('is-visible') ?? false;
}

export function exitScene3D(): void {
  const canvas = document.getElementById(CANVAS_ID);
  const ui = document.getElementById('scene3d-ui');
  canvas?.classList.remove('is-visible');
  canvas?.setAttribute('aria-hidden', 'true');
  if (ui) {
    ui.hidden = true;
    ui.innerHTML = '';
  }
  lastPayload = null;
  sceneMod?.stopScene3D();
  dispatchSceneToggle(false);
}

function sceneUiHtml(payload: ScenePayload): string {
  const nb = payload.neighborhood;
  const paths = nb.paths.filter((p) => p.kind !== 'park').length;
  return `
    <div class="scene3d-bar">
      <div class="scene3d-info">
        <strong>${escapeHtml(payload.place.nom)}</strong>
        <span class="scene3d-sub">${nb.buildings.length} bâtiment(s) &middot; ${paths} cheminement(s) &middot; rayon 75 m</span>
        <span class="scene3d-sub">Glisser = se déplacer &middot; clic droit = pivoter &middot; molette = zoom &middot; flèches = se déplacer</span>
      </div>
      <button id="scene3d-close" type="button" class="scene3d-close">Revenir à la carte (Échap)</button>
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

/** Construit la charge utile pour la scene a partir du lieu + donnees voisines. */
export function buildScenePayload(
  place: Place,
  neighborhood: NeighborhoodData,
  photos: StreetPhoto[]
): ScenePayload {
  return {
    place: {
      nom: place.properties.nom,
      lng: place.lng,
      lat: place.lat,
      activite: place.properties.activite ?? undefined,
    },
    neighborhood,
    photos,
  };
}
