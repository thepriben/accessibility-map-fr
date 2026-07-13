/**
 * Client + normalisation Acceslibre.
 *
 * La cle API n'est lue que depuis l'environnement (ACCESLIBRE_API_KEY) : elle
 * n'apparait jamais dans un fichier de sortie ni cote navigateur.
 */

const API_BASE = 'https://acceslibre.beta.gouv.fr/api';

/** En-tetes d'authentification (Api-Key), depuis l'environnement. */
function authHeaders() {
  const key = process.env.ACCESLIBRE_API_KEY;
  if (!key) {
    throw new Error(
      "ACCESLIBRE_API_KEY absente. Renseigne-la dans l'environnement (jamais en clair dans le depot)."
    );
  }
  return { Authorization: `Api-Key ${key}`, Accept: 'application/json' };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Itere sur les ERP en suivant les liens `next`. Options :
 *  - params  : filtres de requete (commune, code_postal, q, ...).
 *  - maxPages : borne le nombre de pages (utile pour un echantillon).
 *  - onPage  : callback(features_count, total) pour le suivi.
 */
export async function* iterErps({ params = {}, maxPages = Infinity, pageSize = 50 } = {}) {
  const search = new URLSearchParams({ page_size: String(pageSize), ...params });
  let url = `${API_BASE}/erps/?${search.toString()}`;
  let page = 0;

  while (url && page < maxPages) {
    let res;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      res = await fetch(url, { headers: authHeaders() });
      if (res.status !== 429 && res.status < 500) break;
      await sleep(1000 * (attempt + 1));
    }
    if (!res.ok) {
      throw new Error(`Acceslibre HTTP ${res.status} sur ${url}`);
    }
    const data = await res.json();
    yield { results: data.results || [], count: data.count, page };
    url = data.next;
    page += 1;
  }
}

/** Convertit une valeur Acceslibre (null / bool / str) en booleen tristate. */
function bool(v) {
  if (v === true) return true;
  if (v === false) return false;
  return null;
}

/**
 * Derive un jeu compact de criteres d'accessibilite a partir du gros objet
 * `accessibilite`. Ces flags pilotent les filtres cote carte et la fiche.
 */
export function deriveA11y(acc) {
  if (!acc) return {};
  const t = acc.transport || {};
  const ext = acc.cheminement_ext || {};
  const ent = acc.entree || {};
  const acu = acc.accueil || {};
  const san = acc.sanitaires || {};

  const stepFreeEntrance = bool(ent.entree_plain_pied);
  const entranceElevator = bool(ent.entree_ascenseur);
  const entranceRamp = bool(ent.entree_marches_rampe);

  return {
    // Fauteuil / mobilite reduite
    stepFreeEntrance,
    wheelchairEntrance:
      stepFreeEntrance === true || entranceElevator === true || entranceRamp === true
        ? true
        : stepFreeEntrance === null && entranceElevator === null
        ? null
        : false,
    accessibleParking: bool(t.stationnement_pmr),
    adaptedToilets: bool(san.sanitaires_adaptes),
    extStepFreePath: bool(ext.cheminement_ext_plain_pied),
    // Deficiences visuelles
    audioBeacon: bool(ent.entree_balise_sonore),
    guidePath: bool(ext.cheminement_ext_bande_guidage),
    // Deficiences auditives
    hearingEquipment: bool(acu.accueil_equipements_malentendants_presence),
    // Accueil / divers
    staffTrained: acu.accueil_personnels ? String(acu.accueil_personnels) : null,
    callDevice: bool(ent.entree_dispositif_appel),
    publicTransport: bool(t.transport_station_presence),
    humanHelp: bool(ent.entree_aide_humaine),
  };
}

/**
 * ERP Acceslibre -> Feature GeoJSON compacte (proprietes utiles seulement).
 * On garde `raw` optionnellement pour les usages voisinage/fiche detaillee.
 */
export function erpToFeature(erp, { includeRaw = false } = {}) {
  const geom = erp.geom;
  if (!geom || geom.type !== 'Point' || !Array.isArray(geom.coordinates)) return null;

  const a11y = deriveA11y(erp.accessibilite);
  const properties = {
    uuid: erp.uuid,
    slug: erp.slug,
    nom: erp.nom,
    activite: erp.activite?.nom || null,
    activite_slug: erp.activite?.slug || null,
    adresse: erp.adresse || null,
    commune: erp.commune || null,
    code_insee: erp.code_insee || null,
    code_postal: erp.code_postal || null,
    web_url: erp.web_url || null,
    site_internet: erp.site_internet || null,
    ...a11y,
  };
  if (includeRaw) properties.accessibilite = erp.accessibilite || null;

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [geom.coordinates[0], geom.coordinates[1]] },
    properties,
  };
}
