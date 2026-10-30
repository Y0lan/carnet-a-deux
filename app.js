import { API_URL } from './config.js';
import { SyncClient } from './sync.js';
import { validateData, migrateData, nightsBetween, sortedStages, MAX_DOCUMENT_BYTES } from './schema.js';
import { createJourneyMap } from './map.js';
import { createCollections } from './collections.js';
import { createAgenda } from './agenda.js';
import { createHotelExplorer } from './hotels.js';

const $ = (selector) => document.querySelector(selector);
const formField = (form, name) => form.elements.namedItem(name);
const clone = (value) => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const statuses = { explorer: 'À explorer', envie: 'On en a envie', retenu: 'Retenu ensemble', reserve: 'Réservé' };
const moods = { repos: 'Repos', aventure: 'Aventure', fete: 'Fête', culture: 'Culture', mer: 'Bord de mer', trajet: 'Trajet' };
const kinds = { hotel: 'Hôtel', activite: 'Activité', restaurant: 'Restaurant', boutique: 'Boutique', exposition: 'Exposition', lieu: 'Lieu à visiter', evenement: 'Événement', trajet: 'Trajet', materiel: 'Matériel' };
const dayFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const day = (value, full = false) => (full ? fullDate : dayFormat).format(new Date(`${value}T12:00:00Z`));
const range = (s) => `${day(s.start)} au ${day(s.end)}`;
const nightLabel = (n) => `${n} nuit${n > 1 ? 's' : ''}`;
const uid = () => crypto.randomUUID();
let client, token = '', state, selectedId = '', filter = 'all', search = '', lastRendered = '';
let journeyMap, stageOriginal, ideaOriginal, tripOriginal, selectedLocation;
let stageEditing = false, ideaEditing = false;
let ideaReturnView = 'parcours';
let currentView = 'parcours', journeyArea = 'overview', mapReturnArea = 'overview';
const collections = createCollections({ getData: () => state?.data, updateRecord, commit, feedback, onSelectStage: (id) => { showView('parcours'); selectStage(id); } });
const agenda = createAgenda({
  getData: () => state?.data,
  onSelectStage: (id) => { showView('parcours'); selectStage(id); },
  onEditIdea: (id) => { showView('parcours'); selectedId = state.data.ideas[id].stageId; render(); openIdea(id, {}, 'agenda'); },
  onAddIdea: (stageId, defaults = {}) => { showView('parcours'); selectedId = stageId; render(); openIdea(undefined, { kind: 'activite', ...defaults }, 'agenda'); },
});

const hotelExplorer = createHotelExplorer({ getData: () => state?.data, getStageId: () => selectedId, onEdit: openIdea,
  onVote: (id, suffix) => { const next = clone(state.data); if (next.ideas[id]) { next.ideas[id][`vote${suffix}`] = !next.ideas[id][`vote${suffix}`]; commit(next); } },
  onDelete: (id) => { const idea = state.data.ideas[id]; if (idea && confirm(`Retirer « ${idea.title} » du carnet partagé ?`)) { const next = clone(state.data); delete next.ideas[id]; commit(next); } },
});
function showJourneyArea(area) {
  journeyArea = area; $('#journey-overview').hidden = area !== 'overview'; $('#stage-workspace').hidden = area !== 'stage'; $('#parcours').hidden = area !== 'map';
  if (area === 'map') requestAnimationFrame(() => journeyMap?.resize());
}
function openMap(scope = 'all') {
  if (journeyArea !== 'map') mapReturnArea = journeyArea;
  showJourneyArea('map'); journeyMap?.resize(); journeyMap?.fit(scope); setMapScope(scope); $('#parcours').scrollIntoView({ block: 'start' });
  $('#map-back').textContent = mapReturnArea === 'stage' ? 'Revenir à l’étape' : 'Revenir au parcours';
  $('#map-title').tabIndex = -1; $('#map-title').focus({ preventScroll: true });
}
function renderGallery(stages) {
  $('#trip-gallery').replaceChildren(...stages.map((stage, index) => {
    const card = el('button', { type: 'button', class: 'trip-card', 'data-gallery-stage': stage.id, 'aria-label': `Explorer ${stage.title}, ${range(stage)}` });
    const visual = el('div', { class: 'trip-card-photo' });
    if (stage.imageUrl) { const image = el('img', { src: stage.imageUrl, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }); image.addEventListener('error', () => image.remove()); visual.append(image); }
    visual.append(el('span', { class: 'trip-card-number', text: String(index + 1).padStart(2, '0') }), el('span', { class: 'trip-card-nights', text: nightLabel(nightsBetween(stage.start, stage.end)) }));
    const options = Object.values(state.data.ideas).filter((idea) => idea.stageId === stage.id), hotels = options.filter((idea) => idea.kind === 'hotel'), prices = hotels.filter((idea) => idea.cost !== null).map((idea) => idea.cost);
    const priceLabel = hotels.filter((idea) => idea.cost !== null).every((idea) => idea.priceBasis === 'historical') ? 'Anciens tarifs' : 'Tarifs à vérifier';
    const price = prices.length ? `${priceLabel} : ${euro.format(Math.min(...prices))}${Math.max(...prices) !== Math.min(...prices) ? ` à ${euro.format(Math.max(...prices))}` : ''} / nuit` : 'Hébergements à chiffrer';
    card.append(visual, el('div', { class: 'trip-card-copy' }, [el('p', { class: 'trip-card-dates', text: `${range(stage)} · ${moods[stage.mood]}` }), el('h2', { text: stage.title }), el('p', { text: `${hotels.length} hébergement${hotels.length > 1 ? 's' : ''} · ${options.length - hotels.length} autres idées` }), el('strong', { class: 'trip-card-price', text: price })]));
    if (stage.imageCredit) card.append(el('span', { class: 'trip-card-credit', text: stage.imageCredit }));
    card.addEventListener('click', () => selectStage(stage.id)); return card;
  }));
  if (!stages.length) $('#trip-gallery').append(el('p', { class: 'empty-state', text: 'Ajoutez votre première étape pour commencer le parcours.' }));
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else node.setAttribute(name, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}
function feedback(message, error = false) {
  $('#feedback').textContent = message; $('#feedback').dataset.error = String(error); $('#feedback').hidden = !message;
}
function commit(next) {
  if (!client || !state?.data) return false;
  if (state.status === 'conflict') { feedback('Choisis d\'abord les champs à conserver dans le conflit affiché.', true); return false; }
  try { validateData(next); client.change(next); return true; }
  catch (error) { feedback(error.message, true); return false; }
}
function updateRecord(table, id, original, values) {
  const current = state.data[table][id];
  if (original && !current) { throw new Error('Cette fiche a été supprimée sur un autre appareil. Copie tes notes avant de fermer le formulaire.'); }
  const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => !same(original?.[key], value)));
  const conflicts = Object.keys(changes).filter((key) => original && !same(current[key], original[key]) && !same(current[key], changes[key]));
  if (conflicts.length && !confirm(`Un autre appareil a modifié ces champs : ${conflicts.join(', ')}. Remplacer ces champs par ton formulaire ?`)) return false;
  const next = clone(state.data); next[table][id] = { ...(current ?? {}), ...changes, id };
  validateData(next);
  return commit(next);
}
function onState(next) {
  state = next;
  const labels = { connecting: 'Connexion au carnet...', saving: 'Enregistrement...', saved: 'Enregistré en ligne', offline: 'Hors ligne · brouillon local', conflict: 'Changements à départager', error: 'Sauvegarde à vérifier' };
  $('#sync-state').textContent = labels[next.status] ?? 'Carnet privé';
  $('#sync-state').dataset.status = next.status;
  $('#conflict-panel').hidden = next.status !== 'conflict';
  $('#conflict-list').replaceChildren(...(next.conflicts ?? []).map((path) => el('li', { text: describePath(path) })));
  if (next.error) { if (next.data) feedback(next.error, true); else $('#login-error').textContent = next.error; }
  if (!next.data) return;
  $('#welcome').hidden = true; $('#notebook').hidden = false; $('#navigation').hidden = false;
  const serialized = JSON.stringify(next.data);
  if (serialized !== lastRendered) { lastRendered = serialized; render(); }
}
function describePath(path) {
  const [, section, id, field] = path.split('/');
  if (section === 'stages') return `${state.data.stages[id]?.title ?? 'Étape'} : ${field ?? 'fiche entière'}`;
  if (section === 'ideas') return `${state.data.ideas[id]?.title ?? 'Idée'} : ${field ?? 'fiche entière'}`;
  if (section === 'flights' || section === 'shopping') return `${state.data[section][id]?.title ?? 'Fiche'} : ${field ?? 'fiche entière'}`;
  return path === '/' ? 'Deux changements rendent le calendrier ou les liens entre fiches incompatibles.' : `Informations du voyage : ${field ?? id ?? ''}`;
}
function render() {
  const data = state.data, stages = sortedStages(data);
  const places = new Map(stages.map((stage) => [`${stage.lat},${stage.lng}`, stage.place]));
  const previousPlace = $('#known-place').value;
  $('#known-place').replaceChildren(el('option', { value: '', text: 'Choisir un lieu du carnet...' }), ...[...places].map(([value, text]) => el('option', { value, text })));
  if (places.has(previousPlace)) $('#known-place').value = previousPlace;
  const ideaOwner = $('#idea-owner'), ownerValue = ideaOwner.value;
  ideaOwner.replaceChildren(...Object.entries({ both: 'Nous deux', A: data.trip.personA, B: data.trip.personB }).map(([value, text]) => el('option', { value, text })));
  ideaOwner.value = ownerValue || 'both';
  if (!data.stages[selectedId]) selectedId = stages[0]?.id ?? '';
  $('#trip-title').textContent = data.trip.title;
  document.title = `${data.trip.title} · carnet à deux`;
  $('#journey-range').textContent = stages.length ? `${day(stages[0].start, true)} au ${day(stages.reduce((last, s) => s.end > last ? s.end : last, stages[0].end), true)}` : 'Un voyage à imaginer';
  const nights = stages.reduce((sum, s) => sum + nightsBetween(s.start, s.end), 0);
  $('#journey-summary').textContent = `${stages.length} étape${stages.length > 1 ? 's' : ''} · ${Object.keys(data.ideas).length} idées`;
  $('#nights-summary').textContent = `${nightLabel(nights)} réparties entre les étapes`;
  const oldScroll = $('#stage-list').scrollTop;
  $('#stage-list').replaceChildren(...stages.map((stage, index) => {
    const button = el('button', { type: 'button', class: 'stage-select', 'aria-current': String(stage.id === selectedId), 'data-stage-id': stage.id }, [el('span', { class: 'stop-number', text: String(index + 1).padStart(2, '0') }), el('span', { class: 'stop-copy' }, [el('strong', { text: stage.title }), el('span', { text: `${range(stage)} · ${moods[stage.mood]}` })]), el('span', { class: 'stop-nights', text: nightLabel(nightsBetween(stage.start, stage.end)) })]);
    button.addEventListener('click', () => selectStage(stage.id)); return el('li', { class: 'route-stop' }, [button]);
  }));
  $('#stage-list').scrollTop = oldScroll;
  renderGallery(stages);
  $('#timeline').replaceChildren(...stages.map((stage) => {
    const n = nightsBetween(stage.start, stage.end);
    const button = el('button', { type: 'button', class: 'timeline-block', 'data-mood': stage.mood, 'aria-current': String(stage.id === selectedId), 'aria-label': `${stage.title}, ${range(stage)}, ${nightLabel(n)}` }, [el('strong', { text: stage.place }), el('span', { text: `${nightLabel(n)} · ${moods[stage.mood]}` }), el('span', { class: 'timeline-dates', text: range(stage) })]);
    button.style.flex = `${n} 0 ${Math.min(160, 70 + n * 9)}px`; button.addEventListener('click', () => selectStage(stage.id)); return button;
  }));
  const warnings = [];
  for (let i = 1; i < stages.length; i++) {
    if (stages[i].start > stages[i - 1].end) warnings.push(`Du ${day(stages[i - 1].end)} au ${day(stages[i].start)} : des nuits restent à répartir.`);
    if (stages[i].start < stages[i - 1].end) warnings.push(`${stages[i - 1].title} et ${stages[i].title} se chevauchent. Vérifier s'il s'agit de variantes.`);
  }
  $('#schedule-warning').textContent = warnings.join(' '); $('#schedule-warning').hidden = !warnings.length;
  if (!journeyMap) journeyMap = createJourneyMap({ onSelect: (id) => { selectStage(id, false); $('#explore-stage').focus({ preventScroll: true }); }, onPick: setLocation });
  journeyMap.render(stages, selectedId, Object.values(data.flights));
  renderDetail();
  collections.render();
  agenda.render();
}
function selectStage(id, reveal = true) {
  if (!state.data.stages[id]) return;
  selectedId = id; filter = 'all'; search = ''; $('#idea-search').value = '';
  render(); journeyMap.select(id);
  setMapScope('selected');
  if (reveal) {
    showJourneyArea('stage');
    $('#etape').scrollIntoView({ block: 'start', behavior: 'instant' });
    $('#detail-title').focus({ preventScroll: true });
  }
}
function showView(view, focus = false) {
  currentView = ['parcours', 'agenda', 'vols', 'shopping'].includes(view) ? view : 'parcours';
  for (const name of ['parcours', 'agenda', 'vols', 'shopping']) {
    $(name === 'parcours' ? '#view-parcours' : `#${name}`).hidden = name !== currentView;
    const link = $(`[data-view="${name}"]`);
    if (name === currentView) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (currentView === 'parcours') showJourneyArea('overview');
  if (focus) {
    const heading = $({ parcours: '#trip-title', agenda: '#agenda-title', vols: '#flights-title', shopping: '#shopping-title' }[currentView]);
    heading.tabIndex = -1; heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start' });
  }
}
function setMapScope(scope) {
  for (const [name, value] of [['all', 'all'], ['stage', 'selected'], ['leg', 'leg']]) $(`#map-${name}`).setAttribute('aria-pressed', String(value === scope));
}
function renderDetail() {
  const stage = state.data.stages[selectedId];
  $('#etape').hidden = !stage;
  if (!stage) return;
  $('#detail-place').textContent = `${stage.place} · ${moods[stage.mood]} · ${statuses[stage.status]}`;
  $('#detail-title').textContent = stage.title;
  $('#detail-dates').textContent = `${range(stage)} · ${nightLabel(nightsBetween(stage.start, stage.end))} · départ le ${day(stage.end)}`;
  $('#stage-notes').textContent = stage.notes;
  $('#stage-notes').textContent ||= 'Ajoute ici vos bonnes adresses, les questions à trancher et les détails utiles.';
  $('#detail-title').tabIndex = -1;
  const stages = sortedStages(state.data), index = stages.findIndex((s) => s.id === stage.id);
  $('#stage-position').textContent = `Étape ${index + 1} sur ${stages.length}`;
  $('#previous-stage').disabled = index === 0; $('#next-stage').disabled = index === stages.length - 1;
  $('#map-caption').textContent = `${index + 1}. ${stage.title} · ${nightLabel(nightsBetween(stage.start, stage.end))}`;
  $('#stage-experience').textContent = stage.experience || `Comment imagine-t-on ces ${nightLabel(nightsBetween(stage.start, stage.end))} à ${stage.place} ? Ajoute un rythme de journée et les moments qu'on aimerait partager dans « Modifier l'étape ».`;
  const image = $('#stage-image');
  if (image.getAttribute('src') !== (stage.imageUrl || null)) {
    if (stage.imageUrl) image.src = stage.imageUrl; else image.removeAttribute('src');
    $('#stage-photo').hidden = !stage.imageUrl;
  }
  image.alt = `Ambiance à ${stage.place}`;
  $('#stage-image-credit').textContent = stage.imageCredit || 'Voir la source';
  if (stage.imageSource) $('#stage-image-credit').href = stage.imageSource; else $('#stage-image-credit').removeAttribute('href');
  renderHighlights();
  hotelExplorer.render();
  $('#maps-link').href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${stage.lat},${stage.lng}`)}`;
  $('#map-google').href = $('#maps-link').href;
  for (const button of $('#kind-filters').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.kind === filter));
  const ideas = Object.values(state.data.ideas).filter((idea) => idea.stageId === selectedId && idea.kind !== 'hotel' && (filter === 'all' || idea.kind === filter) && (!search || `${idea.title} ${idea.details}`.toLocaleLowerCase('fr').includes(search)));
  $('#idea-list').replaceChildren(...ideas.map(renderIdea));
  if (!ideas.length) $('#idea-list').append(el('p', { class: 'empty-state', text: filter === 'all' && !search ? 'Ajoutez une balade, un restaurant ou une adresse à explorer ensemble.' : 'Aucune idée ne correspond à ce filtre.' }));
}
function renderHighlights() {
  $('#stage-highlights').replaceChildren(...[['Hébergements', '#hotels-title'], ['Adresses et activités', '#ideas-title'], ['Notes du séjour', '#stage-notebook']].map(([text, target]) => {
    const button = el('button', { type: 'button', class: 'text-button', text });
    button.addEventListener('click', () => { const node = $(target); if (node.tagName === 'DETAILS') node.open = true; node.tabIndex = -1; node.scrollIntoView({ block: 'start' }); node.focus({ preventScroll: true }); }); return button;
  }));
}
function renderIdea(idea) {
  const title = el('h4', { text: idea.title });
  const description = el('p', { class: 'idea-details', text: idea.details });
  const detail = idea.details.length > 260 ? el('details', { class: 'idea-more' }, [el('summary', { text: 'Voir les détails et points à comparer' }), description]) : description;
  const article = el('article', { class: 'idea', 'data-idea-id': idea.id }, [el('div', { class: 'idea-meta' }, [el('span', { text: kinds[idea.kind] }), el('span', { class: 'idea-status', 'data-status': idea.status, text: statuses[idea.status] })]), title, detail]);
  const owner = idea.owner === 'A' ? state.data.trip.personA : idea.owner === 'B' ? state.data.trip.personB : 'Nous deux';
  const planned = idea.date ? `${day(idea.date)}${idea.time ? ` · ${idea.time}${idea.endTime ? ` à ${idea.endTime}${idea.endTime < idea.time ? ' le lendemain' : ''}` : ''} (heure locale)` : ''}` : 'À choisir sur place';
  article.append(el('p', { class: 'idea-schedule', text: `${owner} · ${planned}` }));
  if (idea.address) article.append(el('a', { class: 'idea-source', text: idea.address, href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(idea.address + ', ' + state.data.stages[idea.stageId].place)}`, target: '_blank', rel: 'noopener noreferrer' }));
  if (idea.cost !== null) article.append(el('p', { class: 'idea-price' }, [el('strong', { text: euro.format(idea.cost) }), el('small', { text: ` · ${{ historical: 'ancien tarif', checked: 'offre vérifiée', estimate: 'estimation', unknown: 'origine à préciser' }[idea.priceBasis || 'estimate']}` })]));
  if (idea.priceNote) article.append(el('p', { class: 'small-note', text: idea.priceNote }));
  if (idea.url) article.append(el('a', { class: 'idea-source', href: idea.url, target: '_blank', rel: 'noopener noreferrer', text: 'Voir la source ↗' }));
  const votes = el('div', { class: 'votes', role: 'group', 'aria-label': `Envies pour ${idea.title}` });
  for (const suffix of ['A', 'B']) {
    const name = state.data.trip[`person${suffix}`], field = `vote${suffix}`;
    const button = el('button', { type: 'button', class: 'vote-button', 'aria-pressed': String(idea[field]), 'aria-label': `${name} : envie de ${idea.title}`, 'data-vote': `${idea.id}-${suffix}` });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', 'M10 17 3 10C-2 4 6-1 10 5c4-6 12-1 7 5Z'); svg.append(path); button.append(svg, document.createTextNode(name));
    button.addEventListener('click', () => { const next = clone(state.data); next.ideas[idea.id][field] = !next.ideas[idea.id][field]; if (commit(next)) requestAnimationFrame(() => document.querySelector(`[data-vote="${idea.id}-${suffix}"]`)?.focus({ preventScroll: true })); }); votes.append(button);
  }
  const edit = el('button', { type: 'button', class: 'text-button', text: 'Modifier', 'aria-label': `Modifier ${idea.title}` }); edit.addEventListener('click', () => openIdea(idea.id));
  const remove = el('button', { type: 'button', class: 'text-button danger', text: 'Retirer', 'aria-label': `Retirer ${idea.title}` }); remove.addEventListener('click', () => { if (!confirm(`Retirer « ${idea.title} » du carnet partagé ?`)) return; const next = clone(state.data); delete next.ideas[idea.id]; commit(next); });
  article.append(el('div', { class: 'idea-bottom' }, [votes, el('div', { class: 'idea-controls' }, [edit, remove])])); return article;
}
function closeEditor(kind) {
  const editing = kind === 'stage' ? stageEditing : ideaEditing;
  const form = $(`#${kind}-form`);
  if (editing && form.dataset.dirty === 'true' && !confirm('Fermer ce formulaire et abandonner sa saisie ?')) return;
  $(`#${kind}-editor`).hidden = true;
  if (kind === 'stage') { stageEditing = false; journeyMap?.cancelPick(); } else ideaEditing = false;
  form.dataset.dirty = 'false';
  const returnTarget = journeyArea === 'overview' ? '#add-stage-overview' : journeyArea === 'map' ? '#map-back' : kind === 'stage' ? '#edit-stage' : '#add-idea';
  $(returnTarget).focus({ preventScroll: true });
  if (kind === 'idea' && ideaReturnView === 'agenda') showView('agenda', true);
}
function openStage(id) {
  if (stageEditing && $('#stage-form').dataset.dirty === 'true' && !confirm('Remplacer la saisie en cours par cette étape ?')) return;
  const form = $('#stage-form'); form.reset(); form.dataset.dirty = 'false'; $('#stage-error').textContent = '';
  stageOriginal = id ? clone(state.data.stages[id]) : null;
  const stages = sortedStages(state.data), last = stages.at(-1);
  const start = last?.end ?? new Date().toISOString().slice(0, 10);
  const end = new Date(`${start}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 2);
  const values = stageOriginal ?? { title: '', place: '', start, end: end.toISOString().slice(0, 10), mood: 'repos', status: 'explorer', notes: '', experience: '', imageUrl: '', imageCredit: '', imageSource: '' };
  for (const [key, value] of Object.entries(values)) if (formField(form, key)) formField(form, key).value = value;
  selectedLocation = stageOriginal ? { lat: stageOriginal.lat, lng: stageOriginal.lng } : null;
  $('#known-place').value = ''; updateLocationLabel();
  $('#stage-form-heading').textContent = id ? 'Modifier l\'étape' : 'Une nouvelle étape';
  $('#stage-editor').hidden = false; stageEditing = true;
  $('#stage-editor').scrollIntoView({ block: 'start' }); formField(form, 'title').focus({ preventScroll: true });
}
function setLocation(lat, lng) {
  if (!stageEditing) return;
  journeyMap?.cancelPick();
  selectedLocation = { lat, lng }; $('#stage-form').dataset.dirty = 'true'; updateLocationLabel();
  $('#stage-editor').scrollIntoView({ block: 'start' });
}
function updateLocationLabel() {
  $('#location-label').textContent = selectedLocation ? 'Le repère est placé. Tu peux le déplacer en cliquant sur la carte.' : 'Choisis une ville, ou place le repère sur la carte.';
  for (const key of ['lat', 'lng']) formField($('#stage-form'), key).value = selectedLocation?.[key] ?? '';
}
function openIdea(id, defaults = {}, returnView = 'parcours') {
  if (ideaEditing && $('#idea-form').dataset.dirty === 'true' && !confirm('Remplacer l\'idée en cours de saisie ?')) return;
  ideaReturnView = returnView;
  showJourneyArea('stage');
  const form = $('#idea-form'); form.reset(); form.dataset.dirty = 'false'; $('#idea-error').textContent = '';
  ideaOriginal = id ? clone(state.data.ideas[id]) : null;
  const values = ideaOriginal ?? { title: '', kind: filter === 'all' ? 'activite' : filter, url: '', cost: null, status: 'explorer', details: '', owner: 'both', date: '', time: '', endTime: '', address: '', imageUrl: '', imageCredit: '', imageSource: '', room: '', comfort: '', locationNote: '', priceBasis: 'unknown', priceNote: '', ...defaults };
  for (const [key, value] of Object.entries(values)) if (formField(form, key)) formField(form, key).value = value ?? '';
  form.dataset.stageId = ideaOriginal?.stageId ?? selectedId;
  $('#idea-form-heading').textContent = id ? 'Modifier l\'idée' : `Une nouvelle idée pour ${state.data.stages[form.dataset.stageId].title}`;
  $('#idea-editor').hidden = false; ideaEditing = true;
  $('#idea-editor').scrollIntoView({ block: 'start' }); formField(form, 'title').focus({ preventScroll: true });
}
$('#stage-form').addEventListener('submit', (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try {
    const fields = Object.fromEntries(new FormData(form));
    if (fields.lat === '' || fields.lng === '') throw new Error('Place le repère sur la carte, choisis un lieu du carnet ou indique ses coordonnées.');
    const coordinates = { lat: Number(fields.lat), lng: Number(fields.lng) };
    const id = stageOriginal?.id ?? uid();
    if (updateRecord('stages', id, stageOriginal, { ...fields, ...coordinates, id })) { journeyMap?.cancelPick(); selectedId = id; stageEditing = false; form.dataset.dirty = 'false'; $('#stage-editor').hidden = true; render(); showJourneyArea('stage'); $('#etape').scrollIntoView({ block: 'start' }); $('#detail-title').focus({ preventScroll: true }); }
  } catch (error) { $('#stage-error').textContent = error.message; }
});
$('#idea-form').addEventListener('submit', (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try {
    const fields = Object.fromEntries(new FormData(form));
    const id = ideaOriginal?.id ?? uid(), stageId = ideaOriginal?.stageId ?? form.dataset.stageId;
    if (!state.data.stages[stageId]) throw new Error('L\'étape de cette idée a été supprimée. Copie tes notes avant de fermer le formulaire.');
    const values = { ...fields, id, stageId, cost: fields.cost === '' ? null : Number(fields.cost), voteA: ideaOriginal?.voteA ?? false, voteB: ideaOriginal?.voteB ?? false };
    if (updateRecord('ideas', id, ideaOriginal, values)) {
      ideaEditing = false; form.dataset.dirty = 'false'; $('#idea-editor').hidden = true;
      if (ideaReturnView === 'agenda') showView('agenda', true);
      else { $('#etape').scrollIntoView({ block: 'start' }); $('#add-idea').focus({ preventScroll: true }); }
    }
  } catch (error) { $('#idea-error').textContent = error.message; }
});
for (const kind of ['stage', 'idea']) {
  $(`#${kind}-form`).addEventListener('input', (event) => { event.currentTarget.dataset.dirty = 'true'; });
  $(`#close-${kind}-editor`).addEventListener('click', () => closeEditor(kind));
  $(`#cancel-${kind}`).addEventListener('click', () => closeEditor(kind));
}
$('#add-stage').addEventListener('click', () => openStage());
$('#add-stage-overview').addEventListener('click', () => openStage());
$('#add-hotel').addEventListener('click', () => openIdea(undefined, { kind: 'hotel' }));
$('#overview-map').addEventListener('click', () => openMap('all'));
$('#stage-map').addEventListener('click', () => openMap('selected'));
$('#back-overview').addEventListener('click', () => { showJourneyArea('overview'); $('#trip-title').tabIndex = -1; $('#trip-title').focus(); });
$('#map-back').addEventListener('click', () => {
  const area = mapReturnArea === 'stage' && state.data.stages[selectedId] ? 'stage' : 'overview';
  showJourneyArea(area);
  const title = $(area === 'stage' ? '#detail-title' : '#trip-title'); title.tabIndex = -1; title.focus();
});
$('#edit-stage').addEventListener('click', () => openStage(selectedId));
$('#add-idea').addEventListener('click', () => openIdea());
$('#delete-stage').addEventListener('click', () => {
  const stage = state.data.stages[selectedId];
  const count = Object.values(state.data.ideas).filter((idea) => idea.stageId === stage.id).length;
  if (!confirm(`Supprimer « ${stage.title} » et les ${count} idées associées du carnet partagé ?`)) return;
  const next = clone(state.data); delete next.stages[stage.id];
  for (const [id, idea] of Object.entries(next.ideas)) if (idea.stageId === stage.id) delete next.ideas[id];
  for (const flight of Object.values(next.flights)) for (const key of ['fromStageId', 'toStageId']) if (flight[key] === stage.id) flight[key] = '';
  for (const item of Object.values(next.shopping)) if (item.stageId === stage.id) item.stageId = '';
  commit(next);
});
$('#known-place').addEventListener('change', (event) => { if (event.target.value) setLocation(...event.target.value.split(',').map(Number)); });
$('#pick-location').addEventListener('click', () => { openMap('all'); if (!journeyMap?.startPick()) { $('#stage-error').textContent = 'La carte se prépare ou ne peut pas être affichée. Réessaie dans un instant, ou utilise les coordonnées.'; return; } feedback('Clique sur la carte pour placer cette étape.'); });
for (const [name, scope] of [['all', 'all'], ['stage', 'selected'], ['leg', 'leg']]) $(`#map-${name}`).addEventListener('click', () => { journeyMap?.fit(scope); setMapScope(scope); });
$('#map-expand').addEventListener('click', () => {
  const expanded = $('#map-shell').classList.toggle('expanded');
  $('#map-expand').textContent = expanded ? 'Réduire' : 'Agrandir'; $('#map-expand').setAttribute('aria-expanded', String(expanded));
  journeyMap?.resize();
});
$('#explore-stage').addEventListener('click', () => { showJourneyArea('stage'); $('#etape').scrollIntoView({ block: 'start' }); $('#detail-title').focus({ preventScroll: true }); });
for (const [direction, delta] of [['previous', -1], ['next', 1]]) $(`#${direction}-stage`).addEventListener('click', () => {
  const stages = sortedStages(state.data), next = stages[stages.findIndex((s) => s.id === selectedId) + delta]; if (next) selectStage(next.id);
});
$('#stage-image').addEventListener('error', () => { $('#stage-photo').hidden = true; });
for (const link of document.querySelectorAll('[data-view]')) link.addEventListener('click', (event) => {
  event.preventDefault(); history.replaceState(null, '', `${location.pathname}${location.search}#${link.dataset.view}`); showView(link.dataset.view, true);
});
$('#kind-filters').addEventListener('click', (event) => { const button = event.target.closest('button'); if (!button) return; filter = button.dataset.kind; renderDetail(); });
$('#idea-search').addEventListener('input', (event) => { search = event.target.value.toLocaleLowerCase('fr').trim(); renderDetail(); });

$('#tools-toggle').addEventListener('click', () => {
  const open = $('#tools').hidden; $('#tools').hidden = !open; $('#tools-toggle').setAttribute('aria-expanded', String(open));
  if (open) { tripOriginal = clone(state.data.trip); for (const [key, value] of Object.entries(tripOriginal)) formField($('#trip-form'), key).value = value; }
});
$('#trip-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== tripOriginal[key]));
  const conflicts = Object.keys(changes).filter((key) => state.data.trip[key] !== tripOriginal[key] && state.data.trip[key] !== changes[key]);
  if (conflicts.length && !confirm('Les noms ont aussi changé sur un autre appareil. Remplacer ces champs par ta saisie ?')) return;
  const next = clone(state.data); Object.assign(next.trip, changes); if (commit(next)) {
    tripOriginal = clone(next.trip);
    for (const [key, value] of Object.entries(tripOriginal)) formField(event.currentTarget, key).value = value;
    feedback('Les noms sont mis à jour.');
  }
});
function exportNotebook() {
  if (!state?.data) return;
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = el('a', { href: url, download: `carnet-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#export-button').addEventListener('click', exportNotebook);
$('#export-conflict').addEventListener('click', exportNotebook);
$('#import-file').addEventListener('change', async (event) => {
  try {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > MAX_DOCUMENT_BYTES) throw new Error('Ce fichier dépasse 512 Kio.');
    const imported = migrateData(JSON.parse(await file.text()));
    if (confirm('Remplacer le contenu du carnet partagé par ce fichier ? Exporte le carnet actuel avant de le remplacer.')) commit(imported);
  } catch (error) { feedback(`Import refusé : ${error.message}`, true); }
  finally { event.target.value = ''; }
});
$('#invite-button').addEventListener('click', async () => {
  const invitation = new URL(location.href); invitation.hash = new URLSearchParams({ code: token }).toString();
  try { await navigator.clipboard.writeText(invitation.href); feedback('Lien d\'invitation copié. Il permet de lire et de modifier le carnet.'); }
  catch { feedback('La copie est bloquée par le navigateur. Utilise le code partagé sur l\'autre appareil.', true); }
});
$('#keep-local').addEventListener('click', () => client.resolveConflict('local'));
$('#keep-remote').addEventListener('click', () => client.resolveConflict('remote'));
$('#logout-button').addEventListener('click', () => {
  if ((['saving', 'offline', 'conflict', 'error'].includes(state?.status) || stageEditing || ideaEditing || collections.isEditing()) && !confirm('Certaines modifications sont encore en cours. Fermer le carnet ? Les brouillons déjà enregistrés dans ce navigateur seront conservés.')) return;
  client?.stop(); sessionStorage.removeItem('carnet-session'); location.replace(location.pathname + location.search);
});
window.addEventListener('beforeunload', (event) => {
  if ($('#stage-form').dataset.dirty === 'true' || $('#idea-form').dataset.dirty === 'true' || collections.isDirty() || state?.status === 'saving') { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('focus', () => client?.refresh());
window.addEventListener('pagehide', (event) => { if (!event.persisted) client?.stop(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) client?.refresh(); });

async function connect(code) {
  if (!API_URL) { $('#setup-message').hidden = false; return; }
  token = code.trim(); $('#login-error').textContent = ''; $('#login-form button').disabled = true;
  try {
    client?.stop(); client = new SyncClient({ endpoint: new URL(API_URL, location.href).href, token, onChange: onState });
    await client.start();
    if (state?.data) { sessionStorage.setItem('carnet-session', token); $('#access-code').value = ''; }
  } catch { $('#login-error').textContent = 'Le carnet ne peut pas être ouvert. Vérifie le code et la connexion.'; }
  finally { $('#login-form button').disabled = false; }
}
$('#login-form').addEventListener('submit', (event) => { event.preventDefault(); connect($('#access-code').value); });
const invitationCode = new URLSearchParams(location.hash.slice(1)).get('code');
if (invitationCode) history.replaceState(null, '', location.pathname + location.search);
showView(location.hash.slice(1));
const rememberedCode = sessionStorage.getItem('carnet-session');
if (!API_URL) { $('#setup-message').hidden = false; $('#login-form button').disabled = true; }
else if (invitationCode || rememberedCode) connect(invitationCode || rememberedCode);
