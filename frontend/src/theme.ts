/**
 * Thème clair/sombre. Applique `data-theme` sur <html>, persiste le choix et
 * suit `prefers-color-scheme` par défaut. Notifie les abonnés (ex. la scène 3D)
 * quand le thème change afin de resynchroniser leur rendu.
 */
export type Theme = 'light' | 'dark';

const KEY = 'access-map-theme';
const listeners = new Set<(t: Theme) => void>();

function systemPref(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme) || 'light';
}

export function onThemeChange(fn: (t: Theme) => void): void {
  listeners.add(fn);
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* stockage indisponible : on ignore */
  }
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  for (const fn of listeners) fn(theme);
}

export function toggleTheme(): void {
  applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

/** À appeler au démarrage : thème initial + câblage du bouton. */
export function initTheme(): void {
  let stored: Theme | null = null;
  try {
    stored = localStorage.getItem(KEY) as Theme | null;
  } catch {
    /* ignore */
  }
  applyTheme(stored ?? systemPref());
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
}
