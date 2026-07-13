import { a11ySummary, knownCriteria } from '../a11y';
import { state } from '../state';
import type { Place } from '../types';

const MAX_RENDER = 400;

/**
 * Vue liste accessible (RGAA/WCAG) : liste navigable au clavier couvrant les
 * memes lieux que la carte. Chaque element est un bouton avec libelle explicite.
 */
export function renderAccessibleList(
  container: HTMLElement,
  onSelect: (uuid: string) => void
): void {
  const places = state.filteredPlaces();
  const shown = places.slice(0, MAX_RENDER);

  const frag = document.createDocumentFragment();

  const info = document.createElement('p');
  info.className = 'list-info';
  info.textContent =
    places.length > MAX_RENDER
      ? `${places.length} lieux trouvés. Les ${MAX_RENDER} premiers sont listés ; affinez les filtres pour réduire.`
      : `${places.length} lieu(x) trouvé(s).`;
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

function renderItem(p: Place, onSelect: (uuid: string) => void): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'place-list-item';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'place-list-button';
  btn.setAttribute('aria-label', `${p.properties.nom}. ${a11ySummary(p.properties)}`);
  btn.addEventListener('click', () => onSelect(p.properties.uuid));

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
