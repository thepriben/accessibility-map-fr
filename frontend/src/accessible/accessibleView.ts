import { a11ySummary, knownCriteria } from '../a11y';
import type { Place } from '../types';

export const MAX_RENDER = 400;

export interface ListResult {
  total: number;
  places: Place[];
}

/**
 * Vue liste accessible (RGAA/WCAG) : liste navigable au clavier couvrant les
 * memes lieux que la carte. Chaque element est un bouton avec libelle explicite.
 * Les donnees (total + premiers lieux) sont fournies par l'appelant.
 */
export function renderAccessibleList(
  container: HTMLElement,
  result: ListResult,
  onSelect: (place: Place) => void
): void {
  const shown = result.places.slice(0, MAX_RENDER);

  const frag = document.createDocumentFragment();

  const info = document.createElement('p');
  info.className = 'list-info';
  info.textContent =
    result.total > MAX_RENDER
      ? `${result.total} lieux dans la zone affichée. Les ${MAX_RENDER} premiers sont listés ; zoomez pour affiner.`
      : `${result.total} lieu(x) dans la zone affichée.`;
  frag.appendChild(info);

  const list = document.createElement('ul');
  list.className = 'place-list';
  list.setAttribute('role', 'list');

  for (const p of shown) {
    list.appendChild(renderItem(p, onSelect));
  }
  frag.appendChild(list);
  container.replaceChildren(frag);
}

function renderItem(p: Place, onSelect: (place: Place) => void): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'place-list-item';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'place-list-button';
  btn.setAttribute('aria-label', `${p.properties.nom}. ${a11ySummary(p.properties)}`);
  btn.addEventListener('click', () => onSelect(p));

  const name = document.createElement('span');
  name.className = 'place-name';
  name.textContent = p.properties.nom;

  const meta = document.createElement('span');
  meta.className = 'place-meta';
  meta.textContent = [p.properties.activite, p.properties.adresse].filter(Boolean).join(' - ');

  const badges = document.createElement('span');
  badges.className = 'badge-row';
  for (const c of knownCriteria(p.properties).slice(0, 4)) {
    const b = document.createElement('span');
    b.className = c.value ? 'badge badge-ok' : 'badge badge-no';
    b.textContent = c.label;
    badges.appendChild(b);
  }

  btn.append(name, meta, badges);
  li.appendChild(btn);
  return li;
}
