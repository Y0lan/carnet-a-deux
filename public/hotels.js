import { nightsBetween } from './schema.js';

const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const statuses = { explorer: 'À explorer', envie: 'Une envie', retenu: 'Retenu', reserve: 'Réservé' };
const priceLabels = { unknown: 'Origine du prix à préciser', estimate: 'Estimation', historical: 'Ancien tarif', checked: 'Prix vérifié' };

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, String(value));
  }
  node.append(...children);
  return node;
}
function button(text, action, attributes = {}) {
  const node = el('button', { type: 'button', class: 'button', text, ...attributes });
  node.addEventListener('click', action);
  return node;
}
function link(url, text, className = 'hotel-link') {
  return el('a', { href: url, text, class: className, target: '_blank', rel: 'noopener noreferrer' });
}
function select(name, label, options) {
  return el('label', { class: 'hotel-select' }, [document.createTextNode(label), el('select', { name, id: `hotel-${name}` }, Object.entries(options).map(([value, text]) => el('option', { value, text })))]);
}
function basis(idea) { return idea.cost === null ? 'unknown' : idea.priceBasis || 'estimate'; }
function nightPrice(idea) { return idea.cost === null ? 'Prix à rechercher' : `${euro.format(idea.cost)} / nuit`; }
function totalPrice(idea, nights) { return idea.cost === null ? 'À chiffrer' : `${euro.format(idea.cost * nights)} pour ${nights} nuit${nights > 1 ? 's' : ''}`; }
function mapsUrl(idea, stage, directions = false) {
  const url = new URL(directions ? 'https://www.google.com/maps/dir/' : 'https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  const query = `${idea.address || idea.title}, ${stage.place}`;
  url.searchParams.set(directions ? 'destination' : 'query', query);
  if (directions) url.searchParams.set('dir_action', 'navigate');
  return url.href;
}
function priority(idea) {
  return idea.status === 'reserve' ? 4 : idea.status === 'retenu' ? 3 : Number(idea.voteA) + Number(idea.voteB);
}

export function createHotelExplorer({ getData, getStageId, onEdit, onVote, onDelete }) {
  const mount = document.querySelector('#hotel-explorer');
  const selected = new Set();
  let stageId = '', sort = 'preference', filter = 'all';
  const heading = el('h3', { id: 'hotel-explorer-title', text: 'Trouver le bon hôtel', tabindex: -1 });
  const count = el('p', { id: 'hotel-count', class: 'hotel-count' });
  const sorting = select('sort', 'Trier', { preference: 'Nos préférences', ascending: 'Prix croissants', descending: 'Prix décroissants' });
  const filtering = select('filter', 'Afficher', { all: 'Tous les hôtels', retained: 'Retenus ou réservés', both: 'On en a envie tous les deux' });
  const compareButton = button('Comparer', () => {
    panel.hidden = false;
    panel.scrollIntoView({ block: 'start' });
    panelTitle.focus({ preventScroll: true });
  }, { id: 'hotel-open-comparison', class: 'button primary' });
  const reset = button('Vider la sélection', () => { selected.clear(); message.textContent = ''; render(); heading.focus({ preventScroll: true }); }, { id: 'hotel-clear-comparison', class: 'text-button' });
  const selectionCount = el('span', { id: 'hotel-selection-count', class: 'hotel-selection-count', 'aria-live': 'polite' });
  const selectionBar = el('div', { class: 'hotel-selection-bar' }, [selectionCount, compareButton, reset]);
  const message = el('p', { id: 'hotel-message', class: 'hotel-message', role: 'status', 'aria-live': 'polite' });
  const cards = el('div', { id: 'hotel-cards', class: 'hotel-cards' });
  const panelTitle = el('h3', { id: 'hotel-comparison-title', text: 'Nos options côte à côte', tabindex: -1 });
  const comparison = el('div', { class: 'hotel-comparison-scroll', tabindex: 0, role: 'region', 'aria-label': 'Tableau comparatif des hôtels' });
  const panel = el('section', { id: 'hotel-comparison', class: 'hotel-comparison', 'aria-labelledby': 'hotel-comparison-title' });
  panel.hidden = true;
  panel.append(el('div', { class: 'hotel-comparison-heading' }, [panelTitle, button('Fermer le comparatif', () => { panel.hidden = true; compareButton.focus({ preventScroll: true }); }, { class: 'text-button' })]), el('p', { class: 'hotel-comparison-note', text: 'Le total multiplie le prix par nuit par la durée de cette étape. Vérifie les dates, l’occupation et les conditions de chaque offre.' }), comparison);
  mount.append(el('div', { class: 'hotel-explorer-heading' }, [el('div', {}, [heading, count]), el('div', { class: 'hotel-controls' }, [sorting, filtering])]), el('p', { class: 'hotel-help', text: 'Coche deux ou trois hôtels pour comparer les prix, la chambre et le confort.' }), selectionBar, message, cards, panel);
  sorting.querySelector('select').addEventListener('change', (event) => { sort = event.target.value; render(); });
  filtering.querySelector('select').addEventListener('change', (event) => { filter = event.target.value; render(); });

  function focusKey() { return document.activeElement?.closest('[data-hotel-control]')?.getAttribute('data-hotel-control'); }
  function restoreFocus(key) {
    if (!key) return;
    const target = [...mount.querySelectorAll('[data-hotel-control]')].find((node) => node.getAttribute('data-hotel-control') === key);
    (target || heading).focus({ preventScroll: true });
  }
  function choose(id, checked) {
    if (checked && !selected.has(id) && selected.size === 3) {
      message.textContent = 'Trois hôtels sont déjà sélectionnés. Décoche une option avant d’en ajouter une autre.';
      render();
      return;
    }
    if (checked) selected.add(id); else selected.delete(id);
    message.textContent = '';
    render();
  }
  function photo(idea) {
    const figure = el('figure', { class: 'hotel-photo' });
    const placeholder = el('div', { class: 'hotel-photo-empty', text: 'Photo à ajouter' });
    if (!idea.imageUrl) { figure.append(placeholder); return figure; }
    const image = el('img', { src: idea.imageUrl, alt: `Photo de ${idea.title}`, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    const caption = el('figcaption', {}, [idea.imageSource ? link(idea.imageSource, idea.imageCredit || 'Source de la photo', 'hotel-photo-credit') : document.createTextNode(idea.imageCredit || 'Photo ajoutée au carnet')]);
    image.addEventListener('error', () => { placeholder.textContent = 'Photo indisponible'; image.replaceWith(placeholder); caption.hidden = true; }, { once: true });
    figure.append(image, caption);
    return figure;
  }
  function prices(idea, nights) {
    const origin = basis(idea);
    const price = el('div', { class: 'hotel-price', 'data-price-basis': origin }, [el('span', { class: 'hotel-price-basis', text: idea.cost === null ? 'Montant non renseigné' : priceLabels[origin] }), el('strong', { class: 'hotel-night-price', text: nightPrice(idea) })]);
    if (idea.cost !== null) price.append(el('span', { class: 'hotel-stay-price', text: totalPrice(idea, nights) }), el('span', { class: 'hotel-price-caveat', text: origin === 'historical' ? 'Projection depuis l’ancien tarif, à revérifier pour ce séjour.' : 'Total indicatif du logement, selon l’offre renseignée.' }));
    if (idea.priceNote) price.append(el('p', { class: 'hotel-price-note', text: idea.priceNote }));
    return price;
  }
  function votes(idea) {
    const data = getData(), group = el('div', { class: 'hotel-votes', role: 'group', 'aria-label': `Envies pour ${idea.title}` });
    for (const person of ['A', 'B']) {
      const name = data.trip[`person${person}`];
      group.append(button(name, () => {
        onVote(idea.id, person);
        render();
        restoreFocus(`${idea.id}:vote${person}`);
      }, { class: 'hotel-vote', 'data-hotel-control': `${idea.id}:vote${person}`, 'aria-pressed': String(idea[`vote${person}`]), 'aria-label': `${name} : envie de ${idea.title}` }));
    }
    return group;
  }
  function card(idea, stage, nights) {
    const article = el('article', { class: 'hotel-card', 'data-hotel-id': idea.id, 'aria-labelledby': `hotel-title-${idea.id}` });
    const checkbox = el('input', { type: 'checkbox', 'data-hotel-control': `${idea.id}:compare`, 'aria-label': `Comparer ${idea.title}` });
    checkbox.checked = selected.has(idea.id);
    checkbox.addEventListener('change', () => choose(idea.id, checkbox.checked));
    article.append(photo(idea));
    const body = el('div', { class: 'hotel-card-body' }, [
      el('div', { class: 'hotel-card-top' }, [el('span', { class: 'hotel-status', 'data-status': idea.status, text: statuses[idea.status] }), el('label', { class: 'hotel-compare-choice' }, [checkbox, document.createTextNode('Comparer')])]),
      el('h4', { id: `hotel-title-${idea.id}`, text: idea.title }), prices(idea, nights),
      el('dl', { class: 'hotel-features' }, [el('dt', { text: 'Chambre' }), el('dd', { text: idea.room || 'Lit et chambre à préciser' }), el('dt', { text: 'Confort' }), el('dd', { text: idea.comfort || 'Spa, sauna et équipements à vérifier' }), el('dt', { text: 'Emplacement' }), el('dd', { text: idea.locationNote || idea.address || stage.place })]),
    ]);
    if (idea.details) body.append(el('details', { class: 'hotel-details' }, [el('summary', { text: 'Notes et points à vérifier' }), el('p', { text: idea.details })]));
    if (idea.url) body.append(link(idea.url, idea.cost === null ? 'Rechercher le prix sur le site' : 'Consulter l’offre et ses conditions', 'button hotel-booking-link'));
    body.append(el('div', { class: 'hotel-map-links' }, [link(mapsUrl(idea, stage), 'Voir sur Google Maps'), link(mapsUrl(idea, stage, true), 'Y aller')]));
    const actions = el('div', { class: 'hotel-card-actions' }, [button('Modifier', () => onEdit(idea.id), { class: 'text-button', 'data-hotel-control': `${idea.id}:edit`, 'aria-label': `Modifier ${idea.title}` })]);
    if (onDelete) actions.append(button('Retirer', () => { onDelete(idea.id); render(); restoreFocus(`${idea.id}:delete`); }, { class: 'text-button danger', 'data-hotel-control': `${idea.id}:delete`, 'aria-label': `Retirer ${idea.title}` }));
    body.append(el('div', { class: 'hotel-card-bottom' }, [votes(idea), actions]));
    article.append(body);
    return article;
  }
  function renderComparison(hotels, stage, nights) {
    const options = [...selected].map((id) => hotels.find((idea) => idea.id === id)).filter(Boolean);
    if (options.length < 2) panel.hidden = true;
    const table = el('table', { class: 'hotel-comparison-table' });
    const head = el('tr', {}, [el('th', { scope: 'col', text: 'À comparer' }), ...options.map((idea) => el('th', { scope: 'col' }, [el('strong', { text: idea.title }), button('Retirer du comparatif', () => choose(idea.id, false), { class: 'text-button', 'data-hotel-control': `${idea.id}:remove-compare`, 'aria-label': `Retirer ${idea.title} du comparatif` })]))]);
    table.append(el('thead', {}, [head]));
    const rows = [
      ['Prix par nuit', (idea) => el('div', {}, [el('strong', { text: nightPrice(idea) }), el('p', { class: 'hotel-comparison-price-note', text: `${priceLabels[basis(idea)]}${idea.priceNote ? ` · ${idea.priceNote}` : ''}` })])],
      [`Pour ${nights} nuit${nights > 1 ? 's' : ''}`, (idea) => el('div', {}, [el('strong', { text: totalPrice(idea, nights) }), el('p', { class: 'hotel-comparison-price-note', text: idea.cost === null ? 'Tarif à rechercher.' : basis(idea) === 'historical' ? 'Projection depuis l’ancien tarif.' : 'Total indicatif du logement.' })])],
      ['Chambre', (idea) => document.createTextNode(idea.room || 'À préciser')],
      ['Confort', (idea) => document.createTextNode(idea.comfort || 'À vérifier')],
      ['Emplacement', (idea) => document.createTextNode(idea.locationNote || idea.address || stage.place)],
      ['Notre choix', (idea) => document.createTextNode(statuses[idea.status])],
      ['Nos envies', (idea) => document.createTextNode([idea.voteA && getData().trip.personA, idea.voteB && getData().trip.personB].filter(Boolean).join(' et ') || 'Pas encore de préférence')],
      ['Source', (idea) => idea.url ? link(idea.url, 'Voir le site') : document.createTextNode('Lien à ajouter')],
    ];
    table.append(el('tbody', {}, rows.map(([label, value]) => el('tr', {}, [el('th', { scope: 'row', text: label }), ...options.map((idea) => el('td', {}, [value(idea)]))]))));
    comparison.replaceChildren(table);
  }
  function render() {
    const data = getData(); if (!data) return;
    const stage = data.stages[getStageId()];
    if (!stage) { mount.hidden = true; return; }
    mount.hidden = false;
    const focused = focusKey();
    if (stage.id !== stageId) {
      stageId = stage.id; selected.clear(); panel.hidden = true; message.textContent = ''; filter = 'all'; filtering.querySelector('select').value = filter;
    }
    const hotels = Object.values(data.ideas).filter((idea) => idea.stageId === stage.id && idea.kind === 'hotel');
    for (const id of selected) if (!hotels.some((idea) => idea.id === id)) selected.delete(id);
    const shown = hotels.filter((idea) => filter === 'all' || (filter === 'retained' && ['retenu', 'reserve'].includes(idea.status)) || (filter === 'both' && idea.voteA && idea.voteB));
    shown.sort((a, b) => {
      if (sort === 'preference') return priority(b) - priority(a) || a.title.localeCompare(b.title, 'fr');
      if (a.cost === null && b.cost !== null) return 1;
      if (b.cost === null && a.cost !== null) return -1;
      return (sort === 'ascending' ? a.cost - b.cost : b.cost - a.cost) || a.title.localeCompare(b.title, 'fr');
    });
    const nights = nightsBetween(stage.start, stage.end);
    count.textContent = `${shown.length} option${shown.length > 1 ? 's' : ''}${shown.length !== hotels.length ? ` sur ${hotels.length}` : ''} · séjour de ${nights} nuit${nights > 1 ? 's' : ''}`;
    selectionCount.textContent = selected.size ? `${selected.size} hôtel${selected.size > 1 ? 's' : ''} sélectionné${selected.size > 1 ? 's' : ''} sur 3` : 'Aucun hôtel sélectionné';
    compareButton.disabled = selected.size < 2; compareButton.textContent = selected.size >= 2 ? `Comparer ces ${selected.size} hôtels` : 'Choisir au moins deux hôtels';
    reset.hidden = selected.size === 0;
    cards.replaceChildren(...shown.map((idea) => card(idea, stage, nights)));
    if (!shown.length) cards.append(el('p', { class: 'hotel-empty', text: hotels.length ? 'Aucun hôtel avec ce filtre. Affiche toutes les options pour élargir le choix.' : 'Ajoutez vos hôtels avec un prix, une chambre et une photo pour pouvoir les comparer ici.' }));
    renderComparison(hotels, stage, nights);
    restoreFocus(focused);
  }
  return { render };
}
