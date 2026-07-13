import type { DataConfig, FilterKey, Place } from './types';

type Listener = () => void;

/** Etat applicatif minimal + abonnement (pattern observateur leger). */
class AppState {
  dataConfig: DataConfig | null = null;
  /** Features chargees en memoire (mode geojson). Vide en mode pmtiles. */
  allPlaces: Place[] = [];
  activeFilters = new Set<FilterKey>();
  selectedUuid: string | null = null;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  toggleFilter(key: FilterKey): void {
    if (this.activeFilters.has(key)) this.activeFilters.delete(key);
    else this.activeFilters.add(key);
    this.emit();
  }

  setSelected(uuid: string | null): void {
    this.selectedUuid = uuid;
    this.emit();
  }

  /** Lieux respectant les filtres actifs (tous vrais requis). */
  filteredPlaces(): Place[] {
    if (this.activeFilters.size === 0) return this.allPlaces;
    const keys = [...this.activeFilters];
    return this.allPlaces.filter((p) =>
      keys.every((k) => p.properties[k] === true)
    );
  }
}

export const state = new AppState();
