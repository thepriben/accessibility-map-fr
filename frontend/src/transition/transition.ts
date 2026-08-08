import type { NeighborhoodData } from '../data/overpass';
import { getTheme } from '../theme';
import type { Place, StreetPhoto } from '../types';
import { hideFlatFallback, isNeighborhoodEmpty, showFlatFallback } from './flatFallback';
import type { LegendKind } from '../three/scene3d';
import { MAP_ATTRIBUTION } from '../config';

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

  // Voisinage sans bati ni cheminement : une scene 3D vide passerait pour une
  // panne. On montre la carte 2D du lieu a la place.
  if (isNeighborhoodEmpty(payload.neighborhood)) {
    showFlatFallback(payload.place, canvas.parentElement ?? document.body);
    dispatchSceneToggle(true);
    return true;
  }

  try {
    const mod = await loadScene();
    if (!mod) {
      exitScene3D();
      return false;
    }
    mod.startScene3D(canvas, payload);
    paintLegendIcons(mod);
    setupWalkUI(mod);
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
  hideFlatFallback();
  sceneMod?.stopScene3D();
  dispatchSceneToggle(false);
}

function sceneUiHtml(payload: ScenePayload): string {
  // Bandeau minimal : nom du lieu + retour. Les statistiques et l'aide de
  // navigation ont été retirées pour une vue plus épurée. Quand la 3D cède la
  // place à la carte, la raison est dite ici plutôt qu'en surimpression.
  const flat = isNeighborhoodEmpty(payload.neighborhood);
  return `
    <div class="scene3d-bar">
      <div class="scene3d-info">
        <strong>${escapeHtml(payload.place.nom)}</strong>
        ${
          flat
            ? '<span class="scene3d-sub">OpenStreetMap ne décrit pas encore ce voisinage (ni bâtiment, ni cheminement) : voici la carte.</span>'
            : ''
        }
        <span class="scene3d-credits">${MAP_ATTRIBUTION}</span>
      </div>
      <button id="scene3d-close" type="button" class="scene3d-close">Revenir à la carte (Échap)</button>
    </div>
    ${flat ? '' : legendHtml(payload)}
    ${flat ? '' : walkHtml()}`;
}

/**
 * Simulation de parcours. Le bandeau d'avertissement n'est pas décoratif : la
 * scène est une reconstitution d'après OpenStreetMap, forcément incomplète, et
 * quelqu'un ne doit pas préparer un déplacement en la prenant pour un relevé.
 * Le bloc est vide tant que la scène n'a pas annoncé de trajet parcourable.
 */
function walkHtml(): string {
  return `
    <div id="scene3d-sim" class="scene3d-sim" hidden>
      <div class="sim-controls">
        <label class="sim-pick">
          <span class="sr-only">Trajet à parcourir</span>
          <select id="sim-route"></select>
        </label>
        <button id="sim-play" type="button" class="sim-btn">Parcourir le trajet</button>
        <button id="sim-stop" type="button" class="sim-btn sim-quiet" hidden>Quitter la simulation</button>
      </div>
      <div id="sim-transport" class="sim-transport" hidden>
        <button id="sim-start" type="button" class="sim-step" title="Revenir au départ" aria-label="Revenir au départ">⏮</button>
        <button id="sim-back" type="button" class="sim-step" title="Reculer de 10 mètres" aria-label="Reculer de 10 mètres">⏪</button>
        <button id="sim-fwd" type="button" class="sim-step" title="Avancer de 10 mètres" aria-label="Avancer de 10 mètres">⏩</button>
        <button id="sim-end" type="button" class="sim-step" title="Aller à l’arrivée" aria-label="Aller à l’arrivée">⏭</button>
        <label class="sim-seek">
          <span class="sr-only">Position sur le trajet, en mètres</span>
          <input id="sim-seek" type="range" min="0" max="100" step="1" value="0" />
        </label>
        <span id="sim-state" class="sim-state" role="status" aria-live="polite"></span>
        <label class="sim-speed">
          <span class="sr-only">Allure de la simulation</span>
          <select id="sim-speed">
            <option value="0.5">×0,5 — au ralenti</option>
            <option value="1" selected>×1 — allure réelle</option>
            <option value="2">×2</option>
            <option value="4">×4</option>
          </select>
        </label>
      </div>
    </div>
    <div id="scene3d-sim-banner" class="scene3d-sim-banner" hidden>
      <strong>Simulation</strong> — vue à hauteur d'yeux en fauteuil (1,20 m).
      Reconstitution d'après OpenStreetMap, elle ne remplace pas un relevé sur place.
    </div>
    <figure id="scene3d-mini" class="scene3d-mini" hidden>
      <canvas id="sim-mini" width="240" height="180"></canvas>
      <figcaption>Position sur le trajet</figcaption>
    </figure>`;
}

/**
 * Branche les commandes de simulation sur la scène. Rien ne s'affiche si aucun
 * trajet n'a pu être calculé : ni place PMR, ni arrêt de bus dans le voisinage.
 */
function setupWalkUI(mod: SceneMod): void {
  const box = document.getElementById('scene3d-sim');
  const pick = document.getElementById('sim-route') as HTMLSelectElement | null;
  const play = document.getElementById('sim-play') as HTMLButtonElement | null;
  const stop = document.getElementById('sim-stop') as HTMLButtonElement | null;
  const transport = document.getElementById('sim-transport');
  const seek = document.getElementById('sim-seek') as HTMLInputElement | null;
  const speed = document.getElementById('sim-speed') as HTMLSelectElement | null;
  const state = document.getElementById('sim-state');
  const banner = document.getElementById('scene3d-sim-banner');
  const mini = document.getElementById('scene3d-mini');
  const miniCv = document.getElementById('sim-mini') as HTMLCanvasElement | null;
  const legend = document.querySelector('.scene3d-legend') as HTMLElement | null;
  if (!box || !pick || !play || !stop || !state || !banner || !mini || !miniCv) return;
  if (!transport || !seek || !speed) return;

  const options = mod.walkOptions();
  if (!options.length) return;
  pick.innerHTML = options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)} — ${o.length} m${
          o.direct ? ' (à vol d’oiseau)' : ''
        }</option>`
    )
    .join('');
  box.hidden = false;

  /** Pas des commandes de recul et d'avance, en mètres. */
  const STEP_M = 10;
  let running = false;
  let finished = false;
  /** Vrai pendant qu'on tire le curseur : la trame ne doit pas le reprendre. */
  let scrubbing = false;

  const leave = (): void => {
    running = false;
    finished = false;
    mod.stopWalk();
    banner.hidden = true;
    mini.hidden = true;
    stop.hidden = true;
    transport.hidden = true;
    pick.disabled = false;
    if (legend) legend.hidden = false;
    play.textContent = 'Parcourir le trajet';
    state.textContent = '';
  };

  const begin = (): void => {
    const chosen = options.find((o) => o.id === pick.value) ?? options[0];
    // Le compteur est en zone `aria-live` : le rafraîchir à chaque image le
    // ferait annoncer soixante fois par seconde. On ne le touche que tous les
    // dix mètres, ce qui suffit à suivre la progression.
    let said = -1;
    const ok = mod.startWalk(chosen.id, miniCv, (f) => {
      if (!scrubbing) {
        seek.max = String(Math.max(1, Math.round(f.total)));
        seek.value = String(Math.round(f.distance));
      }
      const step = f.done ? -2 : Math.round(f.remaining / 10);
      if (step !== said) {
        said = step;
        state.textContent = f.done ? 'Arrivée à l’entrée.' : `Encore ${step * 10} m`;
      }
      // Le libellé se lit sur la trame plutôt que d'être posé par chaque
      // commande : arrivée, pause et reprise se ramènent au même calcul, et
      // revenir en arrière rouvre naturellement un trajet déjà terminé.
      finished = f.done;
      const label = f.done ? 'Recommencer' : f.playing ? 'Suspendre' : 'Reprendre';
      if (play.textContent !== label) play.textContent = label;
    });
    if (!ok) return;
    running = true;
    finished = false;
    play.textContent = 'Suspendre';
    stop.hidden = false;
    transport.hidden = false;
    pick.disabled = true;
    banner.hidden = false;
    mini.hidden = false;
    // La légende laisse la place : au ras du sol, c'est la vue elle-même qui
    // porte l'information, et l'écran est déjà chargé.
    if (legend) legend.hidden = true;
  };

  play.addEventListener('click', () => {
    if (!running) {
      begin();
      return;
    }
    // Une fois arrivé, le bouton repart du départ plutôt que de rester inerte.
    if (finished) mod.seekWalk(0);
    // Deuxième appui en cours de route : on suspend sans quitter la hauteur de
    // fauteuil, pour regarder autour de soi à un endroit précis.
    mod.setWalkPlaying(finished || play.textContent === 'Reprendre');
  });

  // Commandes de déplacement. Le parcours reste en pause après un saut : on se
  // déplace pour observer un point précis, pas pour repartir aussitôt.
  const jump = (fn: () => void): void => {
    if (!running) return;
    fn();
    mod.setWalkPlaying(false);
  };
  document.getElementById('sim-start')?.addEventListener('click', () => jump(() => mod.seekWalk(0)));
  document
    .getElementById('sim-back')
    ?.addEventListener('click', () => jump(() => mod.seekWalk(-STEP_M, true)));
  document
    .getElementById('sim-fwd')
    ?.addEventListener('click', () => jump(() => mod.seekWalk(STEP_M, true)));
  // L'arrivée se demande sans borne : le curseur est arrondi au mètre, il
  // s'arrêterait juste avant la fin et le trajet ne se saurait pas terminé.
  document
    .getElementById('sim-end')
    ?.addEventListener('click', () => jump(() => mod.seekWalk(Number.POSITIVE_INFINITY)));

  // Curseur de position : au clavier, les flèches le parcourent mètre par
  // mètre, ce qui donne un recul et une avance fine sans commande dédiée.
  const grab = (): void => {
    scrubbing = true;
  };
  const release = (): void => {
    scrubbing = false;
  };
  seek.addEventListener('pointerdown', grab);
  seek.addEventListener('pointerup', release);
  seek.addEventListener('pointercancel', release);
  seek.addEventListener('input', () => {
    if (!running) return;
    mod.seekWalk(Number(seek.value));
    mod.setWalkPlaying(false);
  });

  speed.addEventListener('change', () => mod.setWalkSpeed(Number(speed.value)));

  stop.addEventListener('click', leave);
}

/**
 * Légende 3D. Elle est volontairement courte : trois blocs qui répondent aux
 * seules questions utiles avant de se déplacer (où est le lieu, par où on
 * entre, ce qui gêne en chemin), et rien qui ne soit présent dans la scène.
 * Chaque entrée est illustrée par une vignette rendue depuis l'objet 3D réel.
 */
function legendHtml(payload: ScenePayload): string {
  const nb = payload.neighborhood;
  const ent = nb.entrances ?? [];
  const path = (k: string): boolean => nb.paths.some((p) => p.kind === k);
  const furn = (k: string): boolean => (nb.furniture ?? []).some((f) => f.kind === k);

  const groups: { title: string; entries: [LegendKind, string][] }[] = [
    {
      title: 'Se repérer',
      entries: [
        ['target', 'Lieu visé'],
        ['building', 'Autres bâtiments'],
      ],
    },
    {
      title: 'Entrer',
      entries: [
        ent.some((e) => e.wheelchair === 'yes') && (['entrance-yes', 'Entrée accessible'] as const),
        ent.some((e) => e.wheelchair === 'no' || e.wheelchair === 'limited') &&
          (['entrance-no', 'Entrée difficile ou impossible'] as const),
        ent.some((e) => !e.wheelchair) && (['entrance-other', 'Entrée, accès non renseigné'] as const),
      ].filter(Boolean) as [LegendKind, string][],
    },
    {
      title: 'Cheminer',
      entries: [
        path('sidewalk') && (['sidewalk', 'Trottoir'] as const),
        path('footway') && (['footway', 'Cheminement piéton'] as const),
        path('crossing') && (['crossing', 'Passage piéton'] as const),
        path('road') && (['road', 'Chaussée'] as const),
        nb.paths.some((p) => p.kind === 'steps' && !p.rampWheelchair) &&
          (['steps', 'Escalier'] as const),
        nb.paths.some((p) => p.kind === 'steps' && p.rampWheelchair) &&
          (['steps-ramp', 'Escalier avec rampe'] as const),
        nb.kerbs?.some(
          (k) => k.kind === 'lowered' || k.kind === 'flush' || (k.height ?? 1) <= 0.03
        ) &&
          (['kerb-low', 'Bordure abaissée'] as const),
        furn('barrier') && (['barrier', 'Barrière, chicane'] as const),
      ].filter(Boolean) as [LegendKind, string][],
    },
    {
      title: 'Sur place',
      entries: [
        (nb.busStops?.length || nb.parking?.some((p) => p.pmr)) &&
          (['route', 'Trajet à pied vers l’entrée'] as const),
        nb.busStops?.length && (['bus_stop', 'Arrêt de bus'] as const),
        nb.busRoutes?.length && (['bus_route', 'Ligne de bus'] as const),
        nb.parking?.some((p) => p.pmr) && (['parking-pmr', 'Place PMR'] as const),
        nb.parking?.some((p) => !p.pmr) && (['parking', 'Stationnement'] as const),
        nb.benches?.length && (['bench', 'Banc'] as const),
        furn('toilets') && (['toilets', 'Toilettes'] as const),
        furn('elevator') && (['elevator', 'Ascenseur'] as const),
        (furn('drinking_water') || furn('fountain')) && (['water', 'Point d’eau'] as const),
        furn('tree') && (['tree', 'Arbre'] as const),
        furn('bollard') && (['bollard', 'Borne'] as const),
        furn('lamp') && (['lamp', 'Lampadaire'] as const),
        furn('waste') && (['waste', 'Corbeille'] as const),
        furn('fire_hydrant') && (['fire_hydrant', 'Borne incendie'] as const),
        furn('street_cabinet') && (['street_cabinet', 'Armoire de rue'] as const),
      ].filter(Boolean) as [LegendKind, string][],
    },
  ];

  // Vignette vide au depart : elle est remplie une fois la scene construite,
  // avec le rendu des vrais objets 3D.
  const blank =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const body = groups
    .filter((g) => g.entries.length)
    .map(
      (g) => `
        <h4>${g.title}</h4>
        <ul>${g.entries
          .map(
            ([kind, label]) =>
              `<li><img class="lg-icon" data-lg="${kind}" src="${blank}" alt="" width="30" height="30">${escapeHtml(
                label
              )}</li>`
          )
          .join('')}</ul>`
    )
    .join('');

  return `
    <details class="scene3d-legend" open>
      <summary>Légende</summary>
      <div class="scene3d-legend-body">${body}</div>
    </details>`;
}

/**
 * Remplace les vignettes vides de la légende par le rendu des objets 3D.
 * En l'absence de WebGL, l'entrée reste lisible : seul le texte subsiste.
 */
function paintLegendIcons(mod: SceneMod): void {
  const imgs = Array.from(
    document.querySelectorAll<HTMLImageElement>('#scene3d-ui img.lg-icon[data-lg]')
  );
  if (!imgs.length) return;
  const kinds = [...new Set(imgs.map((i) => i.dataset.lg as LegendKind))];
  let icons: Record<string, string> = {};
  try {
    icons = mod.renderLegendIcons(kinds);
  } catch (err) {
    console.warn('Vignettes de légende indisponibles', err);
  }
  for (const img of imgs) {
    const src = icons[img.dataset.lg ?? ''];
    if (src) img.src = src;
    else img.remove();
  }
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
