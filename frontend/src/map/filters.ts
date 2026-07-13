import { FILTERS } from '../config';
import { state } from '../state';

/** Construit le panneau de filtres (cases a cocher groupees par famille). */
export function renderFilters(container: HTMLElement, onChange: () => void): void {
  const groups = new Map<string, typeof FILTERS>();
  for (const f of FILTERS) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group)!.push(f);
  }

  const frag = document.createDocumentFragment();
  const heading = document.createElement('h2');
  heading.className = 'filters-title';
  heading.textContent = "Filtrer par besoin d'accessibilité";
  frag.appendChild(heading);

  for (const [group, items] of groups) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'filter-group';
    const legend = document.createElement('legend');
    legend.textContent = group;
    fieldset.appendChild(legend);

    for (const item of items) {
      const id = `flt-${item.key}`;
      const label = document.createElement('label');
      label.className = 'filter-item';
      label.htmlFor = id;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.checked = state.activeFilters.has(item.key);
      input.addEventListener('change', () => {
        state.toggleFilter(item.key);
        onChange();
      });

      const span = document.createElement('span');
      span.textContent = item.label;
      label.append(input, span);
      fieldset.appendChild(label);
    }
    frag.appendChild(fieldset);
  }

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'filters-reset';
  reset.textContent = 'Réinitialiser les filtres';
  reset.addEventListener('click', () => {
    state.activeFilters.clear();
    container
      .querySelectorAll<HTMLInputElement>('input[type=checkbox]')
      .forEach((i) => (i.checked = false));
    state.emit();
    onChange();
  });
  frag.appendChild(reset);

  container.replaceChildren(frag);
}
