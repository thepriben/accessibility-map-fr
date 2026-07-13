import { asset } from '../config';
import type { NeighborhoodData } from '../data/overpass';
import { getTheme } from '../theme';
import type { Place, StreetPhoto } from '../types';

export interface ScenePayload {
  place: { nom: string; lng: number; lat: number };
  neighborhood: NeighborhoodData;
  photos: StreetPhoto[];
  /** Thème de rendu ('light' | 'dark'), consommé par la scène Bevy. */
  theme?: string;
}

interface WasmModule {
  default: (input?: unknown) => Promise<unknown>;
  start_neighborhood: (canvasId: string, payloadJson: string) => void;
  stop_neighborhood?: () => void;
}

let wasm: WasmModule | null = null;
let loading: Promise<WasmModule | null> | null = null;

/** Charge (une fois) le module WASM Bevy genere par wasm-bindgen/wasm-pack. */
async function loadWasm(): Promise<WasmModule | null> {
  if (wasm) return wasm;
  if (loading) return loading;
  loading = (async () => {
    try {
      const url = asset('wasm/neighborhood3d.js');
      const mod = (await import(/* @vite-ignore */ url)) as unknown as WasmModule;
      await mod.default(asset('wasm/neighborhood3d_bg.wasm'));
      wasm = mod;
      return mod;
    } catch (err) {
      console.warn('Module 3D indisponible (build WASM absent ?)', err);
      return null;
    }
  })();
  return loading;
}

const CANVAS_ID = 'scene3d';

/**
 * Bascule sur la vue 3D : fondu du canvas Bevy par-dessus la carte, puis
 * lancement de la scene ECS avec les donnees du voisinage. Retourne false si
 * le module WASM n'est pas disponible (fallback : on reste en 2D).
 */
let lastPayload: ScenePayload | null = null;

export async function enterScene3D(payload: ScenePayload): Promise<boolean> {
  const mod = await loadWasm();
  const canvas = document.getElementById(CANVAS_ID) as HTMLCanvasElement | null;
  const ui = document.getElementById('scene3d-ui');
  if (!mod || !canvas) return false;

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
    mod.start_neighborhood(CANVAS_ID, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.error('Echec du lancement de la scene 3D', err);
    exitScene3D();
    return false;
  }
}

/** Resynchronise le thème de la scène 3D si elle est affichée (relance légère). */
export function refreshScene3DTheme(): void {
  if (!wasm || !isScene3DActive() || !lastPayload) return;
  try {
    lastPayload.theme = getTheme();
    wasm.stop_neighborhood?.();
    wasm.start_neighborhood(CANVAS_ID, JSON.stringify(lastPayload));
  } catch (err) {
    console.warn('Resynchronisation du thème 3D impossible', err);
  }
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
  wasm?.stop_neighborhood?.();
}

function sceneUiHtml(payload: ScenePayload): string {
  const nb = payload.neighborhood;
  return `
    <div class="scene3d-bar">
      <div>
        <strong>${escapeHtml(payload.place.nom)}</strong>
        <span class="scene3d-sub">Vue 3D des 30 derniers mètres &middot;
          ${nb.buildings.length} bâtiments, ${nb.furniture.length} mobiliers,
          ${nb.pois.length} lieux d'accueil, ${payload.photos.length} photos &middot;
          souris : glisser = pivoter, clic droit = se déplacer, molette = zoom</span>
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
    place: { nom: place.properties.nom, lng: place.lng, lat: place.lat },
    neighborhood,
    photos,
  };
}
