import { loadDataConfig, loadGeoJson } from './data/dataSource';
import { MAX_RENDER, renderAccessibleList, type ListResult } from './accessible/accessibleView';
import {
  currentBbox,
  currentZoom,
  dataCount,
  flyToPlace,
  getClusterClient,
  getMap,
  initMap,
  nearestPlaceToCenter,
  updateMapTheme,
} from './map/mapView';
import { autoEnter3D, closePlacePanel, openPlacePanel } from './neighborhood/placePanel';
import { exitScene3D, isScene3DActive, refreshScene3DTheme } from './transition/transition';
import { initTheme, onThemeChange } from './theme';
import { hideLoader, showLoader } from './ui/loader';
import { state } from './state';
import { INITIAL_VIEW } from './config';
import type { Place } from './types';

// Bascule 3D automatique : au-dela de ce zoom, si un lieu est proche du centre,
// on passe en 3D. On memorise le dernier lieu entre en 3D (par uuid) : on ne
// re-bascule pas sur le meme lieu (evite de re-entrer juste apres la sortie),
// mais un lieu voisin different declenche bien la 3D. Un dezoom sous le seuil de
// re-armement oublie ce lieu (on pourra y revenir).
const AUTO_3D_ZOOM = 18;
const REARM_ZOOM = 16.5;
let lastAuto3dUuid: string | null = null;

const statusEl = document.getElementById('status')!;
function status(msg: string): void {
  statusEl.textContent = msg;
}

// Dernier lieu selectionne : sert de cible au bouton swap 3D/2D de l'en-tete.
let lastSelectedPlace: Place | null = null;

function selectPlace(place: Place): void {
  lastSelectedPlace = place;
  history.replaceState(null, '', `#place=${encodeURIComponent(place.properties.uuid)}`);
  void openPlacePanel(place);
}

/** Depuis le popup : bascule directe en 3D dans le voisinage du lieu. */
async function enter3DForPlace(place: Place): Promise<void> {
  lastSelectedPlace = place;
  lastAuto3dUuid = place.properties.uuid;
  history.replaceState(null, '', `#place=${encodeURIComponent(place.properties.uuid)}`);
  state.setSelected(place.properties.uuid);
  status(`Passage en 3D : ${place.properties.nom}`);
  const ok = await autoEnter3D(place);
  if (!ok) status('3D indisponible - vue carte conservée.');
}

function setupTabs(): void {
  const tabMap = document.getElementById('tab-map')!;
  const tabList = document.getElementById('tab-list')!;
  const viewMap = document.getElementById('view-map')!;
  const viewList = document.getElementById('view-list')!;

  function activate(which: 'map' | 'list'): void {
    const isMap = which === 'map';
    tabMap.setAttribute('aria-selected', String(isMap));
    tabList.setAttribute('aria-selected', String(!isMap));
    tabMap.classList.toggle('is-active', isMap);
    tabList.classList.toggle('is-active', !isMap);
    viewMap.hidden = !isMap;
    viewList.hidden = isMap;
    if (isMap) getMap()?.resize();
  }

  tabMap.addEventListener('click', () => activate('map'));
  tabList.addEventListener('click', () => activate('list'));
}

const SEARCH_LIMIT = 20;

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Recherche texte (nom / ville / code postal / activité) via worker ou memoire. */
async function searchPlaces(q: string): Promise<Place[]> {
  const client = getClusterClient();
  if (client) return (await client.search(q, SEARCH_LIMIT)).places;
  const tokens = normalizeText(q).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const out: Place[] = [];
  for (const p of state.allPlaces) {
    const hay = normalizeText(
      `${p.properties.nom} ${p.properties.commune ?? ''} ${p.properties.code_postal ?? ''} ${p.properties.activite ?? ''}`
    );
    if (tokens.every((t) => hay.includes(t))) {
      out.push(p);
      if (out.length >= SEARCH_LIMIT) break;
    }
  }
  return out;
}

/** Barre de recherche unique : suggestions cliquables + navigation clavier. */
function setupSearch(): void {
  const input = document.getElementById('search-input') as HTMLInputElement | null;
  const results = document.getElementById('search-results') as HTMLUListElement | null;
  if (!input || !results) return;

  let timer = 0;
  let items: Place[] = [];
  let active = -1;
  let token = 0;
  let lastQuery = '';

  const close = (): void => {
    results.hidden = true;
    results.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const choose = (p: Place): void => {
    // Code postal seul -> vue de quartier ; sinon on cadre sur le lieu précis.
    const isPostal = /^\d{4,5}$/.test(lastQuery);
    if (!isPostal) input.value = p.properties.nom;
    close();
    flyToPlace(p.lng, p.lat, isPostal ? 14 : 18);
    if (!isPostal) selectPlace(p);
  };

  const updateActive = (): void => {
    [...results.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `search-opt-${active}`);
      (results.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const render = (): void => {
    results.innerHTML = '';
    if (!items.length) {
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      return;
    }
    items.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'search-item';
      li.id = `search-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const loc = [p.properties.code_postal, p.properties.commune].filter(Boolean).join(' ');
      const name = document.createElement('span');
      name.className = 'si-name';
      name.textContent = p.properties.nom || '(sans nom)';
      li.appendChild(name);
      if (loc) {
        const locEl = document.createElement('span');
        locEl.className = 'si-loc';
        locEl.textContent = loc;
        li.appendChild(locEl);
      }
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(p);
      });
      results.appendChild(li);
    });
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    lastQuery = q;
    window.clearTimeout(timer);
    if (q.length < 2) {
      items = [];
      close();
      return;
    }
    timer = window.setTimeout(async () => {
      const my = (token += 1);
      const found = await searchPlaces(q);
      if (my !== token) return;
      items = found;
      active = -1;
      render();
    }, 220);
  });

  input.addEventListener('keydown', (e) => {
    if (results.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, items.length - 1);
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      updateActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) choose(items[active]);
      else if (items.length) choose(items[0]);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('#search')) close();
  });
}

/** Liste des lieux dans l'emprise visible (worker en mode points, sinon mémoire). */
async function listResult(): Promise<ListResult> {
  const bbox = currentBbox();
  const client = getClusterClient();
  if (client) return bbox ? client.listBbox(bbox, MAX_RENDER) : client.list(MAX_RENDER);
  const all = state.allPlaces;
  const inB = bbox
    ? all.filter((p) => p.lng >= bbox[0] && p.lng <= bbox[2] && p.lat >= bbox[1] && p.lat <= bbox[3])
    : all;
  return { total: inB.length, places: inB.slice(0, MAX_RENDER) };
}

/** Rafraîchit la liste accessible (synchronisée à l'emprise de la carte). */
async function refreshViews(): Promise<void> {
  const listContainer = document.getElementById('list-container')!;
  const result = await listResult();
  renderAccessibleList(listContainer, result, (place) => selectPlace(place));
}

/** Bascule automatique en 3D quand on s'approche d'un lieu. */
async function maybeAutoEnter3D(): Promise<void> {
  const z = currentZoom();
  if (z < REARM_ZOOM) lastAuto3dUuid = null; // dezoom : on pourra revenir sur ce lieu
  if (z < AUTO_3D_ZOOM || isScene3DActive()) return;

  const place = nearestPlaceToCenter(70);
  if (!place) return;
  // Ne pas re-basculer sur le meme lieu (ex. juste apres etre revenu a la carte).
  if (place.properties.uuid === lastAuto3dUuid) return;

  lastAuto3dUuid = place.properties.uuid;
  lastSelectedPlace = place;
  history.replaceState(null, '', `#place=${encodeURIComponent(place.properties.uuid)}`);
  state.setSelected(place.properties.uuid);
  status(`Passage en 3D : ${place.properties.nom}`);
  const ok = await autoEnter3D(place);
  if (!ok) status('3D indisponible - vue carte conservée.');
}

/** Réinitialise l'application à son état de départ (clic sur le titre). */
function resetToHome(): void {
  exitScene3D();
  closePlacePanel();
  state.setSelected(null);
  lastSelectedPlace = null;
  lastAuto3dUuid = null;

  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  if (searchInput) {
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input'));
  }

  void refreshViews();

  (document.getElementById('tab-map') as HTMLButtonElement | null)?.click();
  history.replaceState(null, '', location.pathname + location.search);
  getMap()?.flyTo({ center: INITIAL_VIEW.center, zoom: INITIAL_VIEW.zoom, duration: 800 });
  status('');
}

/** Bouton swap : bascule entre la vue 3D et la carte 2D. */
function setupViewSwap(): void {
  const btn = document.getElementById('toggle-3d') as HTMLButtonElement | null;
  if (!btn) return;

  const sync = (active: boolean): void => {
    btn.setAttribute('aria-pressed', String(active));
    btn.textContent = active ? 'Carte 2D' : 'Vue 3D';
    btn.title = active ? 'Revenir à la carte 2D' : 'Basculer en vue 3D du voisinage';
  };

  window.addEventListener('scene3d:toggle', (e) => sync((e as CustomEvent).detail.active === true));

  btn.addEventListener('click', () => {
    if (isScene3DActive()) {
      exitScene3D();
      return;
    }
    const place = lastSelectedPlace ?? nearestPlaceToCenter(400);
    if (!place) {
      status('Sélectionnez un lieu (clic sur un point) pour la vue 3D.');
      return;
    }
    void enter3DForPlace(place);
  });

  sync(isScene3DActive());
}

async function handleDeepLink(): Promise<void> {
  const m = /#place=([^&]+)/.exec(location.hash);
  if (!m) return;
  const uuid = decodeURIComponent(m[1]);
  const client = getClusterClient();
  const place = client
    ? await client.place(Number(uuid))
    : (state.allPlaces.find((p) => p.properties.uuid === uuid) ?? null);
  if (place) selectPlace(place);
}

async function boot(): Promise<void> {
  showLoader('Chargement des données…');
  try {
    status('Chargement des données...');
    const cfg = await loadDataConfig();
    const fc = cfg.mode === 'geojson' ? await loadGeoJson(cfg) : null;

    const map = await initMap(cfg, fc, {
      onDetails: selectPlace,
      onEnter3D: (place) => void enter3DForPlace(place),
    });

    setupSearch();
    await refreshViews();

    // Au fil des deplacements/zoom : liste synchronisee sur l'emprise + bascule 3D.
    map.on('moveend', () => {
      void refreshViews();
      void maybeAutoEnter3D();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        exitScene3D();
        closePlacePanel();
      }
    });

    setupTabs();
    setupViewSwap();
    document.getElementById('home-btn')?.addEventListener('click', resetToHome);
    void handleDeepLink();
    status(cfg.label ? `${cfg.label} - ${cfg.count ?? dataCount()} lieux` : '');
  } catch (err) {
    console.error(err);
    status(`Erreur : ${(err as Error).message}`);
  } finally {
    hideLoader();
  }
}

initTheme();
onThemeChange((t) => {
  updateMapTheme(t);
  refreshScene3DTheme();
});
setupTabs();
void boot();
