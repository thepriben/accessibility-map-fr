/**
 * Thème unique (clair). Le mode sombre a été retiré : `getTheme()` renvoie
 * toujours 'light'. Conservé pour les modules qui adaptent leur rendu (carte,
 * scène 3D) à une chaîne de thème.
 */
export function getTheme(): string {
  return 'light';
}
