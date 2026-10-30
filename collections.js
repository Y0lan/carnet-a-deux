import { flightDurationMinutes, flightInstant, sortedStages } from './schema.js';

const categories = { camping: 'Camping et confort', vetements: 'Vêtements', dj: 'DJ', ordinateur: 'Ordinateur', production: 'Production musicale', autre: 'Autre' };
const shoppingStatuses = { envie: 'Une envie', comparer: 'À comparer', acheter: 'À acheter', commande: 'Commandé', achete: 'Acheté', possede: 'Déjà chez nous' };
const flightStatuses = { explorer: 'À comparer', retenu: 'Retenu', reserve: 'Réservé' };
const currencies = { EUR: 'EUR · euro', USD: 'USD · dollar US', XPF: 'XPF · franc Pacifique', THB: 'THB · baht', PLN: 'PLN · zloty' };
const clone = (value) => structuredClone(value);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key === 'hidden') node.hidden = value;
    else node.setAttribute(key, String(value));
  }
  node.append(...children);
  return node;
}
function button(text, action, attrs = {}) {
  const node = el('button', { type: 'button', class: 'button', text, ...attrs });
  node.addEventListener('click', action);
  return node;
}
function options(values) {
  return Object.entries(values).map(([value, text]) => el('option', { value, text }));
}
function selectField(name, label, values, className = '') {
  return el('label', { class: className }, [document.createTextNode(label), el('select', { name }, options(values))]);
}
function inputField(name, label, attrs = {}, className = '') {
  return el('label', { class: className }, [document.createTextNode(label), el('input', { name, ...attrs })]);
}
function notesField(name, label, placeholder) {
  return el('label', { class: 'field-wide' }, [document.createTextNode(label), el('textarea', { name, rows: 4, maxlength: 12000, placeholder })]);
}
function field(form, name) { return form.elements.namedItem(name); }
function sourceLink(url, text = 'Voir la source') {
  return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'collection-source', text });
}
function money(cost, currency) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(cost);
}
function localTime(value) {
  if (!value) return { date: 'Date à confirmer', time: 'Horaire à confirmer' };
  const [date, time] = value.split('T');
  return { date: new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)), time };
}
function durationLabel(minutes) {
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return `${hours} h${remainder ? ` ${String(remainder).padStart(2, '0')}` : ''}`;
}

export function createCollections({ getData, updateRecord, commit, feedback, onSelectStage }) {
  const mounts = { flight: document.querySelector('#flights-content'), shopping: document.querySelector('#shopping-content') };
  const editors = {}, lists = {}, summaries = {}, filters = {};
  let shoppingOwner = 'all';
  const shoppingLists = new Map();
  const names = () => ({ both: 'Nous deux', A: getData().trip.personA, B: getData().trip.personB });
  const stageOptions = () => Object.fromEntries([['', 'Aucune étape associée'], ...sortedStages(getData()).map((s) => [s.id, s.title])]);

  function makeFilter(kind, name, label, values) {
    const node = selectField(name, label, values);
    node.querySelector('select').id = `${kind}-filter-${name}`;
    node.addEventListener('change', () => renderList(kind));
    return node;
  }
  function buildSection(kind) {
    const isFlight = kind === 'flight';
    const add = button(isFlight ? 'Ajouter un vol' : 'Ajouter une envie', () => openEditor(kind), { id: `add-${kind}`, class: 'button primary' });
    const search = inputField('search', isFlight ? 'Rechercher un vol' : 'Rechercher un achat', { type: 'search', placeholder: isFlight ? 'Lieu, compagnie, numéro…' : 'Article, marque, notes…', id: `${kind}-search` });
    search.addEventListener('input', () => renderList(kind));
    const statusFilter = makeFilter(kind, 'status', 'Avancement', { all: 'Tous les états', ...(isFlight ? flightStatuses : shoppingStatuses) });
    const toolbar = el('div', { class: 'collection-filters', role: 'group', 'aria-label': isFlight ? 'Filtrer les vols' : 'Filtrer le shopping' }, [search]);
    if (isFlight) toolbar.append(makeFilter(kind, 'traveler', 'Voyageurs', { all: 'Tout le monde' }));
    if (!isFlight) toolbar.append(makeFilter(kind, 'category', 'Catégorie', { all: 'Toutes les catégories', ...categories }));
    toolbar.append(statusFilter);
    filters[kind] = toolbar;
    summaries[kind] = el('p', { id: `${kind}-summary`, class: 'small-note collection-summary', 'aria-live': 'polite' });
    lists[kind] = el('div', { id: `${kind}-list`, class: `${kind}-list collection-list` });
    const editor = el('section', { id: `${kind}-editor`, class: 'editor-section collection-editor', hidden: true, 'aria-labelledby': `${kind}-form-heading` });
    if (!isFlight) {
      const choices = el('div', { class: 'shopping-lists', role: 'group', 'aria-label': 'Choisir une liste shopping' });
      for (const owner of ['A', 'B', 'both', 'all']) {
        const choice = button('', () => { shoppingOwner = owner; renderList('shopping'); }, { class: 'shopping-list-button', 'data-shopping-owner': owner, 'aria-pressed': String(owner === shoppingOwner) });
        shoppingLists.set(owner, choice); choices.append(choice);
      }
      mounts[kind].append(choices);
    }
    mounts[kind].append(el('div', { class: 'collection-actions' }, [add]), editor, toolbar, summaries[kind], lists[kind]);
    editors[kind] = { node: editor, original: null, form: null, dirty: false };
  }
  buildSection('flight');
  buildSection('shopping');

  const zoneList = el('datalist', { id: 'flight-time-zones' });
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* Free text remains available in older browsers. */ }
  zoneList.append(...options(Object.fromEntries(['UTC', ...zones].map((zone) => [zone, zone]))));
  mounts.flight.append(zoneList);

  function closeEditor(kind, abandon = true) {
    const editor = editors[kind];
    if (abandon && editor.dirty && !confirm('Fermer ce formulaire et abandonner sa saisie ?')) return;
    editor.node.hidden = true;
    editor.dirty = false;
    editor.form = null;
    editor.original = null;
    document.querySelector(`#add-${kind}`).focus({ preventScroll: true });
  }
  function openEditor(kind, id) {
    const editor = editors[kind], isFlight = kind === 'flight';
    if (editor.dirty && !confirm('Remplacer la saisie en cours par cette fiche ?')) return;
    const table = isFlight ? 'flights' : 'shopping';
    if (id && !getData()[table][id]) { feedback('Cette fiche a été supprimée. Actualise la liste.', true); return; }
    editor.original = id ? clone(getData()[table][id]) : null;
    const values = editor.original ?? (isFlight ? {
      title: '', from: '', to: '', departure: '', arrival: '', departureZone: '', arrivalZone: '', number: '', traveler: 'both', status: 'explorer', url: '', notes: '', fromStageId: '', toStageId: '',
    } : { title: '', category: 'autre', owner: shoppingOwner === 'all' ? 'both' : shoppingOwner, status: 'envie', url: '', cost: null, currency: 'EUR', notes: '', stageId: '', voteA: false, voteB: false });
    const form = el('form', { id: `${kind}-form`, class: 'editor-grid' });
    const heading = el('h3', { id: `${kind}-form-heading`, text: isFlight ? (id ? 'Modifier le vol' : 'Un nouveau vol') : (id ? 'Modifier cette envie' : 'Une nouvelle envie') });
    editor.node.replaceChildren(el('div', { class: 'section-heading' }, [heading, button('Fermer', () => closeEditor(kind), { class: 'text-button', id: `close-${kind}-editor` })]), form);
    if (isFlight) {
      form.append(
        inputField('title', 'Nom de cette option', { required: '', maxlength: 160, placeholder: 'Compagnie ou trajet à comparer' }, 'field-wide'),
        inputField('from', 'Aéroport ou ville de départ', { required: '', maxlength: 160 }),
        inputField('to', 'Aéroport ou ville d’arrivée', { required: '', maxlength: 160 }),
        inputField('departure', 'Départ · date et heure locales', { type: 'datetime-local', step: 60 }),
        inputField('arrival', 'Arrivée · date et heure locales', { type: 'datetime-local', step: 60 }),
        inputField('departureZone', 'Fuseau horaire du départ', { list: 'flight-time-zones', maxlength: 100, placeholder: 'Choisir ou saisir un fuseau' }),
        inputField('arrivalZone', 'Fuseau horaire de l’arrivée', { list: 'flight-time-zones', maxlength: 100, placeholder: 'Choisir ou saisir un fuseau' }),
        el('p', { class: 'small-note field-wide', text: 'Recopie les heures locales du billet et le fuseau de chaque aéroport. La durée tient compte du décalage horaire. Si les horaires ne sont pas connus, laisse-les vides. Pour une correspondance, ajoute un vol par segment.' }),
        inputField('number', 'Compagnie et numéro de vol', { maxlength: 80, placeholder: 'Facultatif' }),
        selectField('traveler', 'Qui voyage ?', names()),
        selectField('status', 'Avancement', flightStatuses),
        inputField('url', 'Lien de recherche ou de réservation', { type: 'url', maxlength: 2048, placeholder: 'https://…' }),
        selectField('fromStageId', 'Étape de départ sur la carte', stageOptions()),
        selectField('toStageId', 'Étape d’arrivée sur la carte', stageOptions()),
        notesField('notes', 'Bagages, escale, prix et points à vérifier', 'Garde ici les conditions utiles pour comparer les options.'),
      );
    } else {
      form.append(
        inputField('title', 'Article ou envie', { required: '', maxlength: 160, placeholder: 'Matelas, veste, ordinateur…' }, 'field-wide'),
        selectField('category', 'Catégorie', categories),
        selectField('owner', 'Pour qui ?', names()),
        selectField('status', 'Avancement', shoppingStatuses),
        selectField('stageId', 'Où aimerait-on l’acheter ?', stageOptions()),
        inputField('cost', 'Prix indicatif de cet article', { type: 'number', min: 0, max: 1000000000, step: '0.01', placeholder: 'Facultatif' }),
        selectField('currency', 'Devise du prix', currencies),
        inputField('url', 'Lien vers le produit ou la boutique', { type: 'url', maxlength: 2048, placeholder: 'https://…' }, 'field-wide'),
        notesField('notes', 'Modèle, alternatives et notes', 'Ce qu’on cherche, les tailles, ce qu’on possède déjà, les modèles à comparer…'),
      );
    }
    const error = el('p', { id: `${kind}-error`, class: 'error-message', role: 'alert' });
    form.append(el('div', { class: 'field-wide form-actions' }, [el('button', { type: 'submit', class: 'button primary', text: isFlight ? 'Enregistrer le vol' : 'Enregistrer l’envie' }), button('Annuler', () => closeEditor(kind), { class: 'text-button', id: `cancel-${kind}` }), error]));
    for (const [name, value] of Object.entries(values)) if (field(form, name)) field(form, name).value = value ?? '';
    editor.form = form;
    editor.dirty = false;
    editor.node.hidden = false;
    form.addEventListener('input', () => { editor.dirty = true; });
    form.addEventListener('change', () => { editor.dirty = true; });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      error.textContent = '';
      try {
        const nextValues = Object.fromEntries(new FormData(form));
        const nextId = editor.original?.id ?? crypto.randomUUID();
        if (!isFlight) Object.assign(nextValues, { cost: nextValues.cost === '' ? null : Number(nextValues.cost), voteA: editor.original?.voteA ?? false, voteB: editor.original?.voteB ?? false });
        if (updateRecord(table, nextId, editor.original, { ...nextValues, id: nextId })) {
          closeEditor(kind, false);
          feedback(isFlight ? 'Vol ajouté au carnet. Les horaires restent ceux que vous renseignez.' : 'Envie enregistrée dans votre liste partagée.');
          renderList(kind);
        }
      } catch (failure) { error.textContent = failure.message; }
    });
    editor.node.scrollIntoView({ block: 'start' });
    field(form, 'title').focus({ preventScroll: true });
  }
  function removeRecord(kind, record) {
    if (!confirm(`Retirer « ${record.title} » du carnet partagé ?`)) return;
    const data = clone(getData());
    delete data[kind === 'flight' ? 'flights' : 'shopping'][record.id];
    if (commit(data)) {
      renderList(kind);
      document.querySelector(`#add-${kind}`).focus({ preventScroll: true });
    }
  }
  function actions(kind, record) {
    return el('div', { class: 'collection-record-actions' }, [
      button('Modifier', () => openEditor(kind, record.id), { class: 'text-button', 'aria-label': `Modifier ${record.title}`, 'data-edit-record': record.id }),
      button('Retirer', () => removeRecord(kind, record), { class: 'text-button danger', 'aria-label': `Retirer ${record.title}`, 'data-remove-record': record.id }),
    ]);
  }
  function stageButton(id, label) {
    const stage = getData().stages[id];
    return stage ? button(`${label} : ${stage.title}`, () => onSelectStage(id), { class: 'text-button collection-stage-link' }) : null;
  }
  function renderFlight(flight) {
    const article = el('article', { class: 'flight-record collection-record', 'data-flight-id': flight.id }, [
      el('div', { class: 'collection-record-heading' }, [el('h3', { text: flight.title }), el('span', { class: 'collection-status', 'data-status': flight.status, text: flightStatuses[flight.status] })]),
      el('p', { class: 'collection-meta', text: [names()[flight.traveler], flight.number].filter(Boolean).join(' · ') }),
    ]);
    const timing = el('div', { class: 'flight-timing' });
    for (const [place, value, zone, label] of [[flight.from, flight.departure, flight.departureZone, 'Départ'], [flight.to, flight.arrival, flight.arrivalZone, 'Arrivée']]) {
      const time = localTime(value);
      timing.append(el('div', { class: 'flight-endpoint' }, [el('span', { class: 'small-note', text: label }), el('h4', { text: place }), el('strong', { class: 'flight-time', text: time.time }), el('span', { text: time.date }), el('span', { class: 'small-note', text: zone ? `${zone} · heure locale` : 'Fuseau à confirmer' })]));
    }
    article.append(timing);
    const minutes = flightDurationMinutes(flight);
    article.append(el('p', { class: 'flight-duration', text: minutes === null ? 'Durée à confirmer' : `Durée du vol : ${durationLabel(minutes)}` }));
    if (flight.notes) article.append(el('p', { class: 'collection-notes', text: flight.notes }));
    const links = el('div', { class: 'collection-links' });
    if (flight.url) links.append(sourceLink(flight.url));
    for (const item of [stageButton(flight.fromStageId, 'Départ'), stageButton(flight.toStageId, 'Arrivée')]) if (item) links.append(item);
    article.append(links, actions('flight', flight));
    return article;
  }
  function renderShopping(item) {
    const article = el('article', { class: 'shopping-record collection-record', 'data-shopping-id': item.id }, [
      el('div', { class: 'collection-record-heading' }, [el('h3', { text: item.title }), el('span', { class: 'collection-status', 'data-status': item.status, text: shoppingStatuses[item.status] })]),
      el('p', { class: 'collection-meta', text: `${categories[item.category]} · ${names()[item.owner]}` }),
      el('p', { class: 'shopping-price', text: item.cost === null ? 'Prix à comparer' : `${money(item.cost, item.currency)} · prix indicatif` }),
    ]);
    if (item.notes) article.append(el('p', { class: 'collection-notes', text: item.notes }));
    const links = el('div', { class: 'collection-links' });
    if (item.url) links.append(sourceLink(item.url, 'Voir le produit ou la boutique'));
    const stage = stageButton(item.stageId, 'Achat prévu'); if (stage) links.append(stage);
    article.append(links);
    const votes = el('div', { class: 'votes', role: 'group', 'aria-label': `Envies pour ${item.title}` });
    for (const person of ['A', 'B']) {
      const voteField = `vote${person}`, key = `${item.id}-${person}`;
      const vote = button(names()[person], () => {
        const data = clone(getData()), current = data.shopping[item.id];
        if (!current) { feedback('Cette envie a été supprimée sur un autre appareil.', true); return; }
        current[voteField] = !current[voteField];
        if (commit(data)) { renderList('shopping'); document.querySelector(`[data-shopping-vote="${key}"]`)?.focus({ preventScroll: true }); }
      }, { class: 'vote-button', 'aria-pressed': String(item[voteField]), 'aria-label': `${names()[person]} : envie de ${item.title}`, 'data-shopping-vote': key });
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 20 20'); icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(icon.namespaceURI, 'path'); path.setAttribute('d', 'M10 17 3 10C-2 4 6-1 10 5c4-6 12-1 7 5Z'); icon.append(path); vote.prepend(icon); votes.append(vote);
    }
    article.append(el('div', { class: 'collection-record-footer' }, [votes, actions('shopping', item)]));
    return article;
  }
  function renderList(kind) {
    const data = getData(); if (!data) return;
    const isFlight = kind === 'flight', table = isFlight ? 'flights' : 'shopping';
    const filterValues = Object.fromEntries([...filters[kind].querySelectorAll('input,select')].map((input) => [input.name, input.value]));
    const search = filterValues.search.trim().toLocaleLowerCase('fr');
    const ownerKey = isFlight ? 'traveler' : 'owner';
    if (!isFlight) {
      filterValues.owner = shoppingOwner;
      for (const [owner, choice] of shoppingLists) {
        const label = owner === 'all' ? 'Tout voir' : names()[owner];
        const count = Object.values(data.shopping ?? {}).filter((item) => owner === 'all' || item.owner === owner).length;
        choice.textContent = `${label} · ${count}`;
        choice.setAttribute('aria-label', `${label} : ${count} envie${count > 1 ? 's' : ''}`);
        choice.setAttribute('aria-pressed', String(owner === shoppingOwner));
      }
    }
    const items = Object.values(data[table] ?? {}).filter((item) =>
      (filterValues[ownerKey] === 'all' || item[ownerKey] === filterValues[ownerKey]) &&
      (filterValues.status === 'all' || item.status === filterValues.status) &&
      (isFlight || filterValues.category === 'all' || item.category === filterValues.category) &&
      (!search || [item.title, item.notes, item.from, item.to, item.number].filter(Boolean).join(' ').toLocaleLowerCase('fr').includes(search))
    );
    if (isFlight) items.sort((a, b) => {
      const first = a.departure ? flightInstant(a.departure, a.departureZone) : Infinity;
      const second = b.departure ? flightInstant(b.departure, b.departureZone) : Infinity;
      return (first - second || a.title.localeCompare(b.title, 'fr'));
    });
    else items.sort((a, b) => a.title.localeCompare(b.title, 'fr'));
    lists[kind].replaceChildren(...items.map(isFlight ? renderFlight : renderShopping));
    if (!items.length) lists[kind].append(el('p', { class: 'empty-state', text: Object.keys(data[table] ?? {}).length ? 'Aucun résultat avec ces filtres. Élargis la recherche pour retrouver les autres fiches.' : isFlight ? 'Commencez par les trajets envisagés. Les dates, heures et numéros pourront être complétés après comparaison.' : 'Ajoutez chacun vos envies : confort au camp, vêtements, musique ou matériel. Vous pourrez comparer les modèles et marquer ce que vous avez déjà.' }));
    if (isFlight) {
      const booked = items.filter((item) => item.status === 'reserve').length;
      summaries[kind].textContent = `${items.length} vol${items.length > 1 ? 's' : ''} affiché${items.length > 1 ? 's' : ''} · ${booked} réservé${booked > 1 ? 's' : ''}. Les horaires sont renseignés par vous, sans suivi en direct.`;
    } else {
      const totals = new Map(); let priced = 0;
      for (const item of items) if (item.cost !== null && item.status !== 'possede') { totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.cost); priced++; }
      summaries[kind].textContent = `${items.length} envie${items.length > 1 ? 's' : ''} affichée${items.length > 1 ? 's' : ''}. ${priced ? `Somme des prix renseignés : ${[...totals].map(([currency, total]) => money(total, currency)).join(' + ')}. Sans conversion, hors objets déjà possédés ; les alternatives peuvent se cumuler.` : 'Les prix restent à renseigner ou les objets sont déjà possédés.'}`;
    }
  }
  function refreshPeople(kind) {
    const name = kind === 'flight' ? 'traveler' : 'owner';
    const select = filters[kind].querySelector(`[name="${name}"]`);
    if (select) { const previous = select.value; select.replaceChildren(...options({ all: 'Tout le monde', ...names() })); select.value = previous; }
    const editorSelect = editors[kind].form && field(editors[kind].form, name);
    if (editorSelect) { const value = editorSelect.value; editorSelect.replaceChildren(...options(names())); editorSelect.value = value; }
    for (const reference of kind === 'flight' ? ['fromStageId', 'toStageId'] : ['stageId']) {
      const stageSelect = editors[kind].form && field(editors[kind].form, reference);
      if (!stageSelect) continue;
      const value = stageSelect.value, choices = stageOptions();
      if (value && !Object.hasOwn(choices, value)) choices[value] = 'Étape supprimée · choisir une autre étape';
      stageSelect.replaceChildren(...options(choices)); stageSelect.value = value;
    }
  }
  return {
    render() { for (const kind of ['flight', 'shopping']) { refreshPeople(kind); renderList(kind); } },
    isDirty() { return Object.values(editors).some((editor) => editor.dirty); },
    isEditing() { return Object.values(editors).some((editor) => !editor.node.hidden); },
  };
}
