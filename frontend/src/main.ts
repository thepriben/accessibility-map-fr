import { loadDataConfig, loadGeoJson } from './data/dataSource';
import { MAX_RENDER, renderAccessibleList, type ListResult } from './accessible/accessibleView';
import { renderFilters } from './map/filters';
import {
  applyFilters,
  currentZoom,
  dataCount,
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
import type { Place } from './types';

// Bascule 3D automatique : au-dela de ce zoom, si un lieu est proche du centre,
// on passe en 3D. On re-arme la bascule seulement apres un dezoom en dessous du
// seuil de re-armement (evite de re-basculer juste apres etre revenu a la carte).
const AUTO_3D_ZOOM = 18;
const REARM_ZOOM = 16.5;
let auto3dArmed = true;

const statusEl = document.getElementById('status')!;
function status(msg: string): void {
  statusEl.textContent = msg;
}

function selectPlace(place: Place): void {
  history.replaceState(null, '', `#place=${encodeURIComponent(place.properties.uuid)}`);
  void openPlacePanel(place);
}

/** Depuis le popup : bascule directe en 3D dans le voisinage du lieu. */
async function enter3DForPlace(place: Place): Promise<void> {
  history.replaceState(null, '', `#place=${encodeURIComponent(place.properties.uuid)}`);
  state.setSelected(place.properties.uuid);
  status(`Passage en 3D : ${place.properties.nom}`);
  const ok = await autoEnter3D(place);
  if (!ok) status('3D indisponible (build WASM requis) - vue carte conservée.');
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

/** Liste filtree : via le worker (mode points) ou l'etat memoire (echantillon). */
async function listResult(): Promise<ListResult> {
  const client = getClusterClient();
  if (client) return client.list(MAX_RENDER);
  const all = state.filteredPlaces();
  return { total: all.length, places: all.slice(0, MAX_RENDER) };
}

async function refreshViews(): Promise<void> {
  const cfg = state.dataConfig;
  if (cfg) await applyFilters(cfg);
  const listContainer = document.getElementById('list-container')!;
  const result = await listResult();
  renderAccessibleList(listContainer, result, (place) => selectPlace(place));
}

/** Bascule automatique en 3D quand on s'approche d'un lieu. */
async function maybeAutoEnter3D(): Promise<void> {
  const z = currentZoom();
  if (z < REARM_ZOOM) auto3dArmed = true;
  if (z < AUTO_3D_ZOOM || !auto3dArmed || isScene3DActive()) return;

  const place = nearestPlaceToCenter(70);
  if (!place) return;

  auto3dArmed = false;
  history.replaceState(null, '', `#place=${encodeURIComponent(place.properties.uuid)}`);
  state.setSelected(place.properties.uuid);
  status(`Passage en 3D : ${place.properties.nom}`);
  const ok = await autoEnter3D(place);
  if (!ok) status('3D indisponible (build WASM requis) - vue carte conservée.');
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

    renderFilters(document.getElementById('filters')!, () => void refreshViews());
    await refreshViews();

    // Bascule 3D de proximite au fil des deplacements/zoom.
    map.on('moveend', () => {
      void maybeAutoEnter3D();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        exitScene3D();
        closePlacePanel();
      }
    });

    setupTabs();
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
