/**
 * Mise en forme des lignes de bus avant dessin.
 *
 * OpenStreetMap décrit une ligne par une relation et par sens de circulation,
 * souvent dédoublée en variantes de service (renfort, période scolaire). Sur
 * une rue à double sens, les deux relations citent la même voie : dessinées
 * telles quelles, elles empilaient jusqu'à quatre rubans identiques côte à côte
 * pour une seule ligne. On réunit donc les relations par numéro, on ne garde
 * qu'une fois chaque voie, et on ne décale un ruban que là où une autre ligne
 * emprunte réellement la même rue — ailleurs il reste au milieu de la chaussée.
 */
import { nearestLineDir, pathLength, pointAlong } from './orient';
import type { OsmBusRoute } from '../data/overpass';

type P2 = [number, number];

/** Ligne de bus telle qu'on la dessine : un numéro, une couleur, un tracé. */
export interface BusLine {
  key: string;
  ref: string | null;
  /** Nom du réseau débarrassé de la direction (« MobiVie D »). */
  name: string | null;
  colour: string | null;
  /** Tronçons uniques, en coordonnées d'origine. */
  segments: P2[][];
}

/**
 * Nom de réseau sans la direction : « MobiVie D : Les Arloings → Les Biernets »
 * devient « MobiVie D ». Les deux sens portent alors le même nom, et le plus
 * court départage les variantes (« MobiVie D » plutôt que « MobiVie D_Toussaint »).
 */
function networkName(name: string | null): string | null {
  if (!name) return null;
  const cut = name.split(/\s+[:–—]\s+/)[0].trim();
  return cut || null;
}

/** Réunit les relations d'une même ligne en un tracé unique. */
export function mergeBusRoutes(routes: OsmBusRoute[]): BusLine[] {
  const byKey = new Map<string, BusLine>();
  const seenWays = new Map<string, Set<string>>();

  for (const route of routes) {
    // À défaut de numéro, le nom de réseau regroupe encore les deux sens ;
    // en dernier recours la relation reste seule, faute de quoi la rapprocher
    // d'une autre serait une invention.
    const key = route.ref || networkName(route.name) || route.id;
    let line = byKey.get(key);
    if (!line) {
      line = { key, ref: route.ref, name: networkName(route.name), colour: route.colour, segments: [] };
      byKey.set(key, line);
      seenWays.set(key, new Set());
    }
    if (!line.colour && route.colour) line.colour = route.colour;
    const short = networkName(route.name);
    if (short && (!line.name || short.length < line.name.length)) line.name = short;

    const seen = seenWays.get(key)!;
    for (const seg of route.segments) {
      if (seen.has(seg.way)) continue;
      seen.add(seg.way);
      line.segments.push(seg.coords);
    }
  }

  return [...byKey.values()].filter((l) => l.segments.length > 0);
}

/** Un tronçon dessiné, rattaché à sa ligne (index dans le tableau des lignes). */
export interface BusRun {
  line: number;
  points: P2[];
}

/** Distance au-delà de laquelle deux lignes ne partagent plus la même rue (m). */
const SHARE_M = 6;
/**
 * Distance en deçà de laquelle deux tronçons d'une même ligne décrivent les
 * deux chaussées d'un même boulevard, et non deux rues différentes (m).
 */
const TWIN_M = 16;

/** Trois points répartis le long d'un tronçon, pour tester un recouvrement. */
function samplesOf(points: P2[]): { x: number; z: number }[] {
  const len = pathLength(points);
  return [0.25, 0.5, 0.75]
    .map((f) => pointAlong(points, len * f))
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

/**
 * Deux tronçons se superposent si le premier longe le second sur l'essentiel
 * de sa longueur. Deux points de sondage sur trois suffisent : deux tronçons
 * qui se suivent bout à bout ne se touchent qu'à une extrémité, et un simple
 * croisement qu'en un point.
 */
function overlaps(a: P2[], b: P2[], within: number): boolean {
  const near = samplesOf(a).filter((s) => {
    const d = nearestLineDir(s.x, s.z, [b]);
    return d !== null && d.dist <= within;
  }).length;
  return near >= 2;
}

/**
 * Écarte le second tracé d'une ligne qui revient par l'autre chaussée du même
 * boulevard : OSM y décrit une voie par sens, ce qui dédoublait le ruban là où
 * l'usager ne voit qu'une seule ligne de bus. On garde le tronçon le plus long,
 * qui porte le tracé le plus lisible.
 */
export function dropTwinRuns(runs: BusRun[]): BusRun[] {
  const kept: BusRun[] = [];
  for (const run of [...runs].sort((a, b) => pathLength(b.points) - pathLength(a.points))) {
    const twin = kept.some((k) => k.line === run.line && overlaps(run.points, k.points, TWIN_M));
    if (!twin) kept.push(run);
  }
  return kept;
}
/** Écart entre deux rubans voisins (m), resserré si la rue en porte beaucoup. */
const SPACING_M = 1.05;
/** Largeur maximale occupée par un faisceau de lignes (m) : reste sur la chaussée. */
const SPAN_M = 3;

/** Place d'un tronçon dans la rue : son décalage et la largeur qui lui revient. */
export interface BusPlacement {
  /** Décalage perpendiculaire à l'axe de la chaussée (m). */
  offset: number;
  /** Pas du faisceau (m) : borne la largeur du ruban pour éviter qu'ils se touchent. */
  spacing: number;
  /** Lignes qui empruntent ce tronçon, numéro croissant. */
  group: number[];
}

/**
 * Place chaque tronçon dans sa rue. Une ligne seule reçoit un décalage nul et
 * suit donc l'axe de la chaussée ; celles qui se partagent une rue s'écartent
 * symétriquement, dans l'ordre de leur numéro pour que le faisceau garde le
 * même ordre d'un bout à l'autre. Le faisceau ne s'élargit pas indéfiniment :
 * passé quelques lignes, c'est le pas qui se resserre, pas la chaussée.
 */
export function busPlacements(runs: BusRun[], keys: string[]): BusPlacement[] {
  return runs.map((run) => {
    const alone = { offset: 0, spacing: SPACING_M, group: [run.line] };
    if (!samplesOf(run.points).length) return alone;

    const sharing = new Set<number>([run.line]);
    for (const other of runs) {
      if (other.line === run.line || sharing.has(other.line)) continue;
      if (overlaps(run.points, other.points, SHARE_M)) sharing.add(other.line);
    }

    const group = [...sharing].sort((a, b) => keys[a].localeCompare(keys[b], 'fr', { numeric: true }));
    const rank = group.indexOf(run.line);
    const spacing = Math.min(SPACING_M, SPAN_M / Math.max(1, group.length - 1));
    return { offset: (rank - (group.length - 1) / 2) * spacing, spacing, group };
  });
}
