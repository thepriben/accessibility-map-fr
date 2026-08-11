/**
 * Carte et vue 3D reposent toutes deux sur WebGL. Quand le navigateur ne peut
 * pas en ouvrir de contexte - acceleration graphique desactivee, pilote sur
 * liste noire, processus graphique tombe - MapLibre echoue des sa creation et
 * l'application n'affichait qu'un objet d'erreur brut, illisible.
 *
 * On verifie donc avant de construire la carte, et on l'annonce en francais avec
 * la marche a suivre. La liste accessible, elle, ne demande aucun WebGL : elle
 * devient la vue principale, et le site reste utilisable.
 */

let verdict: boolean | null = null;

/** Vrai si le navigateur ouvre un contexte WebGL (resultat memorise). */
export function hasWebGL(): boolean {
  if (verdict !== null) return verdict;
  try {
    const canvas = document.createElement('canvas');
    const ctx =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl');
    verdict = ctx !== null;
    // Le contexte de test n'a plus lieu d'occuper la memoire graphique.
    (ctx as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    verdict = false;
  }
  return verdict;
}

let notice: HTMLElement | null = null;

/**
 * Explique l'absence de carte et renvoie vers la liste. Le bandeau reste a
 * l'ecran : la cause ne disparaitra pas d'elle-meme.
 */
export function showNoWebGLNotice(onList: () => void): void {
  if (notice) return;
  notice = document.createElement('div');
  notice.className = 'webgl-notice';
  notice.setAttribute('role', 'status');
  notice.innerHTML = `
    <h2>Carte indisponible sur ce navigateur</h2>
    <p>
      La carte et la vue 3D ont besoin de l’accélération graphique (WebGL), que ce
      navigateur ne parvient pas à activer.
    </p>
    <p>
      Deux pistes : relancer le navigateur (le composant graphique tombe parfois
      en panne), ou vérifier que l’accélération matérielle est activée dans ses
      réglages — sous Chrome, <em>Paramètres · Système · Utiliser l’accélération
      graphique quand elle est disponible</em>.
    </p>
    <p>
      En attendant, la <strong>liste des lieux</strong> donne accès aux mêmes
      données d’accessibilité, sans carte.
    </p>
    <button type="button" class="webgl-notice-btn">Afficher la liste des lieux</button>
  `;
  notice.querySelector('button')?.addEventListener('click', () => {
    onList();
    notice?.remove();
    notice = null;
  });
  document.body.append(notice);
}
