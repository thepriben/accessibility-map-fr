/**
 * Lien vers la fiche Acceslibre d'origine.
 *
 * L'export CSV ouvert ne contient ni URL ni slug de fiche : impossible de
 * construire l'adresse à partir des seules colonnes affichées. Le permalien
 * `acceslibre.beta.gouv.fr/uuid/<id>/` redirige en revanche vers la page
 * canonique, et l'identifiant figure bien dans l'export.
 *
 * Ces identifiants sont aléatoires, donc incompressibles : les charger tous
 * ajouterait une dizaine de mégaoctets avant le premier affichage de la carte.
 * Le pipeline les publie par tranches d'index ; on ne télécharge la tranche
 * (~160 Ko) qu'au moment où quelqu'un ouvre une fiche, et une seule fois.
 */
import { asset } from '../config';
import { state } from '../state';

/** Doit rester synchronisé avec UUID_SHARD du pipeline (build-points.mjs). */
const SHARD = 10000;
const BASE = 'https://acceslibre.beta.gouv.fr/uuid/';

const shards = new Map<number, Promise<Uint8Array | null>>();

/** Répertoire des tranches, déduit de l'emplacement du fichier de points. */
function shardDir(): string | null {
  const src = state.dataConfig?.source;
  if (!src) return null;
  const full = /^https?:\/\//.test(src) ? src : asset(src);
  const cut = full.lastIndexOf('/');
  return cut < 0 ? null : `${full.slice(0, cut)}/acceslibre-uuids/`;
}

function loadShard(n: number): Promise<Uint8Array | null> {
  const cached = shards.get(n);
  if (cached) return cached;
  const dir = shardDir();
  const job = !dir
    ? Promise.resolve(null)
    : fetch(`${dir}${String(n).padStart(4, '0')}.bin`)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => (b ? new Uint8Array(b) : null))
        .catch(() => null);
  shards.set(n, job);
  return job;
}

function format(bytes: Uint8Array): string | null {
  // Un enregistrement sans identifiant exploitable est écrit en zéros.
  if (bytes.every((b) => b === 0)) return null;
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Adresse de la fiche Acceslibre d'un lieu, ou `null` si elle est inconnue.
 * `web_url` est renseigné par l'échantillon de développement ; en production,
 * on passe par l'index du point dans le jeu de données.
 */
export async function acceslibreUrl(props: {
  web_url?: string | null;
  srcIndex?: number | null;
}): Promise<string | null> {
  if (props.web_url) return props.web_url;
  const i = props.srcIndex;
  if (i == null || i < 0) return null;
  const bytes = await loadShard(Math.floor(i / SHARD));
  if (!bytes) return null;
  const at = (i % SHARD) * 16;
  if (at + 16 > bytes.length) return null;
  const id = format(bytes.subarray(at, at + 16));
  return id ? `${BASE}${id}/` : null;
}
