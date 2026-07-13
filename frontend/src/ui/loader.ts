// Indicateur de chargement global (spinner) pour les operations longues :
// telechargement des donnees, du voisinage OSM, ou du module 3D (WASM ~10 Mo).

let count = 0;

function els(): { root: HTMLElement | null; msg: HTMLElement | null } {
  return {
    root: document.getElementById('loader'),
    msg: document.getElementById('loader-msg'),
  };
}

/** Affiche le spinner avec un message. Reference-compte : superposable. */
export function showLoader(message = 'Chargement…'): void {
  count += 1;
  const { root, msg } = els();
  if (msg) msg.textContent = message;
  if (root) root.hidden = false;
}

/** Met a jour le message du spinner sans changer le compteur. */
export function setLoaderMessage(message: string): void {
  const { msg } = els();
  if (msg) msg.textContent = message;
}

/** Masque le spinner (quand toutes les operations en cours sont terminees). */
export function hideLoader(): void {
  count = Math.max(0, count - 1);
  if (count === 0) {
    const { root } = els();
    if (root) root.hidden = true;
  }
}

/** Enveloppe une promesse en affichant le spinner pendant son execution. */
export async function withLoader<T>(message: string, task: () => Promise<T>): Promise<T> {
  showLoader(message);
  try {
    return await task();
  } finally {
    hideLoader();
  }
}
