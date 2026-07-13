import { a11ySummary } from '../a11y';
import { asset } from '../config';
import type { NeighborhoodData } from '../data/overpass';
import { getTheme } from '../theme';
import type { Place, StreetPhoto } from '../types';

export interface ScenePayload {
  place: { nom: string; lng: number; lat: number; activite?: string; a11y?: string };
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

const LEGEND: { c: string; label: string }[] = [
  { c: '#fcd64c', label: 'Lieu ciblé (balise)' },
  { c: '#f28c33', label: 'Bâtiment du lieu' },
  { c: '#e04d4d', label: 'Restaurant' },
  { c: '#cc8c40', label: 'Café / bar' },
  { c: '#8c5abf', label: 'Hôtel' },
  { c: '#33a69e', label: 'Lieu communautaire' },
  { c: '#7380d9', label: 'Lieu cultuel' },
  { c: '#3b73d9', label: 'Arrêt de bus' },
  { c: '#3cb4d9', label: "Point d'eau" },
  { c: '#d94d40', label: 'Obstacle (borne)' },
  { c: '#9e6626', label: 'Banc' },
  { c: '#3c8c47', label: 'Arbre' },
];

function sceneUiHtml(payload: ScenePayload): string {
  const nb = payload.neighborhood;
  const a11y = payload.place.a11y ? `<span class="scene3d-a11y">${escapeHtml(payload.place.a11y)}</span>` : '';
  const legend = LEGEND.map(
    (l) => `<li><span class="lg-sw" style="background:${l.c}"></span>${escapeHtml(l.label)}</li>`
  ).join('');
  return `
    <div class="scene3d-bar">
      <div class="scene3d-info">
        <strong>${escapeHtml(payload.place.nom)}</strong>
        ${a11y}
        <span class="scene3d-sub">Voisinage : ${nb.buildings.length} bâtiments &middot;
          ${nb.furniture.length} mobiliers/obstacles &middot; ${nb.pois.length} lieux d'accueil &middot;
          ${payload.photos.length} photos</span>
        <span class="scene3d-sub">Souris : glisser = pivoter, clic droit = se déplacer, molette = zoom &middot;
          Clavier : flèches/ZQSD = se déplacer, A/E = pivoter, +/- = zoom</span>
      </div>
      <button id="scene3d-close" type="button" class="scene3d-close">Revenir à la carte (Échap)</button>
    </div>
    <details class="scene3d-legend" open>
      <summary>Légende</summary>
      <ul>${legend}</ul>
    </details>`;
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
      a11y: a11ySummary(place.properties),
    },
    neighborhood,
    photos,
  };
}
