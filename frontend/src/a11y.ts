import type { PlaceProperties } from './types';

/** Libelles lisibles des criteres d'accessibilite (pour badges et fiche). */
export const A11Y_LABELS: { key: keyof PlaceProperties; label: string }[] = [
  { key: 'wheelchairEntrance', label: 'Entrée accessible fauteuil' },
  { key: 'stepFreeEntrance', label: 'Entrée de plain-pied' },
  { key: 'accessibleParking', label: 'Stationnement PMR' },
  { key: 'adaptedToilets', label: 'Sanitaires adaptés' },
  { key: 'extStepFreePath', label: 'Cheminement extérieur de plain-pied' },
  { key: 'audioBeacon', label: 'Balise sonore' },
  { key: 'guidePath', label: 'Bande de guidage' },
  { key: 'hearingEquipment', label: 'Équipement pour malentendants' },
  { key: 'callDevice', label: "Dispositif d'appel à l'entrée" },
  { key: 'humanHelp', label: 'Aide humaine possible' },
  { key: 'publicTransport', label: 'Transport en commun à proximité' },
];

/** Renvoie les criteres presents avec leur etat (true/false), null exclus. */
export function knownCriteria(
  props: PlaceProperties
): { label: string; value: boolean }[] {
  const out: { label: string; value: boolean }[] = [];
  for (const { key, label } of A11Y_LABELS) {
    const v = props[key];
    if (v === true || v === false) out.push({ label, value: v });
  }
  return out;
}

/** Texte accessible resumant l'accessibilite (pour aria-label). */
export function a11ySummary(props: PlaceProperties): string {
  const crit = knownCriteria(props);
  const ok = crit.filter((c) => c.value).map((c) => c.label);
  if (ok.length === 0) return "Informations d'accessibilité limitées";
  return `Accessibilité : ${ok.join(', ')}`;
}
