// GitHub Pages remplace la totalite de ses fichiers a chaque deploiement, et
// leurs noms portent une empreinte (assets/index-XXXX.js). Un onglet ouvert
// avant un deploiement garde donc en memoire des adresses qui viennent de
// disparaitre : le module 3D, telecharge seulement au premier usage, repond
// alors 404. L'echec n'a rien a voir avec la 3D et un simple rechargement le
// resout, encore faut-il le dire a l'usager.

/** Adresse du script d'entree tel que la page courante l'a chargee. */
function currentEntry(): string | null {
  return document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null;
}

/**
 * Meme adresse, mais lue dans du HTML brut. L'ordre des attributs n'est pas
 * garanti (Vite glisse `crossorigin` entre `type` et `src`) : on inspecte donc
 * chaque balise plutot que d'esperer une forme figee.
 */
function entryInHtml(html: string): string | null {
  const tags = /<script\b([^>]*)>/gi;
  for (let tag = tags.exec(html); tag !== null; tag = tags.exec(html)) {
    if (!/type\s*=\s*"module"/i.test(tag[1])) continue;
    const src = /src\s*=\s*"([^"]+)"/i.exec(tag[1]);
    if (src) return src[1];
  }
  return null;
}

/**
 * Vrai si le site publie ne correspond plus a la page ouverte. On compare le
 * script d'entree annonce par un index.html frais a celui reellement charge :
 * une empreinte differente signe un nouveau deploiement.
 *
 * En cas de doute (hors ligne, reponse illisible) on repond false : mieux vaut
 * taire une mise a jour incertaine que reclamer un rechargement inutile.
 */
export async function deployedBuildChanged(): Promise<boolean> {
  const mine = currentEntry();
  if (!mine) return false;
  try {
    const res = await fetch(location.pathname, { cache: 'no-store' });
    if (!res.ok) return false;
    const published = entryInHtml(await res.text());
    return published !== null && published !== mine;
  } catch {
    return false;
  }
}

let notice: HTMLElement | null = null;

/** Bandeau proposant de recharger. Affiche une seule fois. */
export function showUpdateNotice(): void {
  if (notice) return;
  notice = document.createElement('div');
  notice.className = 'update-notice';
  notice.setAttribute('role', 'status');
  notice.innerHTML =
    '<span>Une nouvelle version du site vient d’être publiée.</span>' +
    '<button type="button" class="update-notice-btn">Recharger la page</button>';
  notice.querySelector('button')?.addEventListener('click', () => location.reload());
  // Pas de prise de focus : le bandeau s'annonce seul (role="status") et une
  // frappe en cours dans la recherche ne doit pas etre interrompue.
  document.body.append(notice);
}

/**
 * Signale un nouveau deploiement, s'il explique l'echec en cours. Retourne vrai
 * si le bandeau a ete montre, pour que l'appelant sache que la panne est connue.
 */
export async function noticeIfStale(): Promise<boolean> {
  if (!(await deployedBuildChanged())) return false;
  showUpdateNotice();
  return true;
}
