import type { Place, PlaceProperties } from '../types';

export interface ListResult {
  total: number;
  places: Place[];
  /** Vrai si des regions entieres manquent encore (socle en cours). */
  partial?: boolean;
  /** Vrai si les noms ne sont pas tous la (recherche par nom incomplete). */
  namesPartial?: boolean;
}

/** Avancement du telechargement des donnees. */
export interface LoadProgress {
  loaded: number;
  total: number;
  done: boolean;
  /** Ce palier-ci annonce l'arrivee de tous les noms, pas des coordonnees. */
  names?: boolean;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

/**
 * Facade thread principal du worker de clustering (Supercluster). Le worker
 * detient les donnees ; on ne fait que lui poser des questions (grappes
 * visibles, liste filtree, expansion d'une grappe) et recevoir de petits
 * resultats. Cela garde le thread principal leger (pas de crash memoire).
 */
export class ClusterClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();

  /** Avancement du socle, pour l'afficher pendant que la carte se complete. */
  onProgress: ((p: LoadProgress) => void) | null = null;
  /** L'index de grappes vient d'integrer de nouveaux points : a redemander. */
  onGrown: (() => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('./points.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data as Record<string, unknown> & { id: number; type: string };
      // Messages spontanes : le worker signale l'arrivee des donnees, sans
      // qu'on la lui ait demandee.
      if (m.type === 'progress') {
        this.onProgress?.({
          loaded: m.loaded as number,
          total: m.total as number,
          done: m.done === true,
          names: m.names === true,
        });
        return;
      }
      if (m.type === 'grown') {
        this.onGrown?.();
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(String(m.message)));
      else p.resolve(m);
    };
  }

  private call(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = (this.seq += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  async init(url: string): Promise<number> {
    const r = await this.call({ type: 'init', url });
    return r.count as number;
  }

  /**
   * Autorise le worker a telecharger le reste des donnees. A appeler quand la
   * carte est affichee : avant, ces megaoctets retarderaient le premier ecran.
   */
  resume(): void {
    this.worker.postMessage({ type: 'resume', id: 0 });
  }

  async filter(keys: string[]): Promise<number> {
    const r = await this.call({ type: 'filter', keys });
    return r.total as number;
  }

  async query(
    bbox: [number, number, number, number],
    zoom: number
  ): Promise<GeoJSON.Feature[]> {
    const r = await this.call({ type: 'query', bbox, zoom });
    return r.features as GeoJSON.Feature[];
  }

  async expansion(clusterId: number): Promise<number> {
    const r = await this.call({ type: 'expansion', clusterId });
    return r.zoom as number;
  }

  async list(limit: number): Promise<ListResult> {
    const r = await this.call({ type: 'list', limit });
    return { total: r.total as number, places: r.places as Place[] };
  }

  /** Liste des lieux dans l'emprise visible (bbox = [ouest, sud, est, nord]). */
  async listBbox(bbox: [number, number, number, number], limit: number): Promise<ListResult> {
    const r = await this.call({ type: 'listBbox', bbox, limit });
    return { total: r.total as number, places: r.places as Place[] };
  }

  async place(i: number): Promise<Place | null> {
    const r = await this.call({ type: 'place', i });
    return (r.place as Place | null) ?? null;
  }

  async search(q: string, limit: number): Promise<ListResult> {
    const r = await this.call({ type: 'search', q, limit });
    return {
      total: r.total as number,
      places: r.places as Place[],
      partial: r.partial === true,
      namesPartial: r.namesPartial === true,
    };
  }
}

/** Type d'assistance : les properties renvoyees par le worker sont des PlaceProperties. */
export type WorkerPlace = { properties: PlaceProperties; lng: number; lat: number };
