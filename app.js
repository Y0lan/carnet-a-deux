import { API_URL } from './config.js';
import { SyncClient } from './sync.js';
import { validateData, nightsBetween, sortedStages, MAX_DOCUMENT_BYTES } from './schema.js';
import { createJourneyMap } from './map.js';

const $ = (selector) => document.querySelector(selector);
const formField = (form, name) => form.elements.namedItem(name);
const clone = (value) => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const statuses = { explorer: 'À explorer', envie: 'On en a envie', retenu: 'Retenu ensemble', reserve: 'Réservé' };
const moods = { repos: 'Repos', aventure: 'Aventure', fete: 'Fête', culture: 'Culture', mer: 'Bord de mer', trajet: 'Trajet' };
const kinds = { hotel: 'Hôtel', activite: 'Activité', trajet: 'Trajet', materiel: 'Matériel' };
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
  return path === '/' ? 'Deux changements rendent le calendrier ou les liens entre fiches incompatibles.' : `Informations du voyage : ${field ?? id ?? ''}`;
}
function render() {
  const data = state.data, stages = sortedStages(data);
  const places = new Map(stages.map((stage) => [`${stage.lat},${stage.lng}`, stage.place]));
  const previousPlace = $('#known-place').value;
  $('#known-place').replaceChildren(el('option', { value: '', text: 'Choisir un lieu du carnet...' }), ...[...places].map(([value, text]) => el('option', { value, text })));
  if (places.has(previousPlace)) $('#known-place').value = previousPlace;
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
  if (!journeyMap) journeyMap = createJourneyMap({ onSelect: selectStage, onPick: setLocation });
  journeyMap.render(stages, selectedId);
  renderDetail();
}
function selectStage(id) {
  selectedId = id; filter = 'all'; search = ''; $('#idea-search').value = '';
  render(); journeyMap.select(id);
}
function renderDetail() {
  const stage = state.data.stages[selectedId];
  $('#etape').hidden = !stage;
  if (!stage) return;
  $('#detail-place').textContent = `${stage.place} · ${moods[stage.mood]} · ${statuses[stage.status]}`;
  $('#detail-title').textContent = stage.title;
  $('#detail-dates').textContent = `${range(stage)} · ${nightLabel(nightsBetween(stage.start, stage.end))} · départ le ${day(stage.end)}`;
  $('#stage-notes').textContent = stage.notes;
  $('#maps-link').href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${stage.lat},${stage.lng}`)}`;
  for (const button of $('#kind-filters').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.kind === filter));
  const ideas = Object.values(state.data.ideas).filter((idea) => idea.stageId === selectedId && (filter === 'all' || idea.kind === filter) && (!search || `${idea.title} ${idea.details}`.toLocaleLowerCase('fr').includes(search)));
  $('#idea-list').replaceChildren(...ideas.map(renderIdea));
  if (!ideas.length) $('#idea-list').append(el('p', { class: 'empty-state', text: filter === 'all' && !search ? 'La page est ouverte. Ajoutez un hôtel, une balade ou une adresse à explorer ensemble.' : 'Aucune idée ne correspond à ce filtre.' }));
}
function renderIdea(idea) {
  const title = el('h4', { text: idea.title });
  const article = el('article', { class: 'idea', 'data-idea-id': idea.id }, [el('div', { class: 'idea-meta' }, [el('span', { text: kinds[idea.kind] }), el('span', { class: 'idea-status', 'data-status': idea.status, text: statuses[idea.status] })]), title, el('p', { class: 'idea-details', text: idea.details })]);
  if (idea.cost !== null) article.append(el('p', { class: 'idea-price' }, [el('strong', { text: euro.format(idea.cost) }), el('small', { text: idea.kind === 'hotel' ? ' / nuit pour deux · à confirmer' : ' pour deux · à confirmer' })]));
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
  if (kind === 'stage') stageEditing = false; else ideaEditing = false;
  form.dataset.dirty = 'false';
}
function openStage(id) {
  if (stageEditing && $('#stage-form').dataset.dirty === 'true' && !confirm('Remplacer la saisie en cours par cette étape ?')) return;
  const form = $('#stage-form'); form.reset(); form.dataset.dirty = 'false'; $('#stage-error').textContent = '';
  stageOriginal = id ? clone(state.data.stages[id]) : null;
  const stages = sortedStages(state.data), last = stages.at(-1);
  const start = last?.end ?? new Date().toISOString().slice(0, 10);
  const end = new Date(`${start}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 2);
  const values = stageOriginal ?? { title: '', place: '', start, end: end.toISOString().slice(0, 10), mood: 'repos', status: 'explorer', notes: '' };
  for (const [key, value] of Object.entries(values)) if (formField(form, key)) formField(form, key).value = value;
  selectedLocation = stageOriginal ? { lat: stageOriginal.lat, lng: stageOriginal.lng } : null;
  $('#known-place').value = ''; updateLocationLabel();
  $('#stage-form-heading').textContent = id ? 'Modifier l\'étape' : 'Une nouvelle étape';
  $('#stage-editor').hidden = false; stageEditing = true;
  $('#stage-editor').scrollIntoView({ block: 'start' }); formField(form, 'title').focus({ preventScroll: true });
}
function setLocation(lat, lng) {
  if (!stageEditing) return;
  selectedLocation = { lat, lng }; $('#stage-form').dataset.dirty = 'true'; updateLocationLabel();
  $('#stage-editor').scrollIntoView({ block: 'start' });
}
function updateLocationLabel() {
  $('#location-label').textContent = selectedLocation ? 'Le repère est placé. Tu peux le déplacer en cliquant sur la carte.' : 'Choisis une ville, ou place le repère sur la carte.';
}
function openIdea(id) {
  if (ideaEditing && $('#idea-form').dataset.dirty === 'true' && !confirm('Remplacer l\'idée en cours de saisie ?')) return;
  const form = $('#idea-form'); form.reset(); form.dataset.dirty = 'false'; $('#idea-error').textContent = '';
  ideaOriginal = id ? clone(state.data.ideas[id]) : null;
  const values = ideaOriginal ?? { title: '', kind: filter === 'all' ? 'hotel' : filter, url: '', cost: null, status: 'explorer', details: '' };
  for (const [key, value] of Object.entries(values)) if (formField(form, key)) formField(form, key).value = value ?? '';
  form.dataset.stageId = ideaOriginal?.stageId ?? selectedId;
  $('#idea-form-heading').textContent = id ? 'Modifier l\'idée' : `Une nouvelle idée pour ${state.data.stages[form.dataset.stageId].title}`;
  $('#idea-editor').hidden = false; ideaEditing = true;
  $('#idea-editor').scrollIntoView({ block: 'start' }); formField(form, 'title').focus({ preventScroll: true });
}
$('#stage-form').addEventListener('submit', (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try {
    if (!selectedLocation) throw new Error('Place d\'abord le repère sur la carte, ou choisis une ville.');
    const fields = Object.fromEntries(new FormData(form));
    const id = stageOriginal?.id ?? uid();
    if (updateRecord('stages', id, stageOriginal, { ...fields, ...selectedLocation, id })) { selectedId = id; stageEditing = false; form.dataset.dirty = 'false'; $('#stage-editor').hidden = true; render(); $('#etape').scrollIntoView({ block: 'start' }); }
  } catch (error) { $('#stage-error').textContent = error.message; }
});
$('#idea-form').addEventListener('submit', (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try {
    const fields = Object.fromEntries(new FormData(form));
    const id = ideaOriginal?.id ?? uid(), stageId = ideaOriginal?.stageId ?? form.dataset.stageId;
    if (!state.data.stages[stageId]) throw new Error('L\'étape de cette idée a été supprimée. Copie tes notes avant de fermer le formulaire.');
    const values = { ...fields, id, stageId, cost: fields.cost === '' ? null : Number(fields.cost), voteA: ideaOriginal?.voteA ?? false, voteB: ideaOriginal?.voteB ?? false };
    if (updateRecord('ideas', id, ideaOriginal, values)) { ideaEditing = false; form.dataset.dirty = 'false'; $('#idea-editor').hidden = true; $('#etape').scrollIntoView({ block: 'start' }); }
  } catch (error) { $('#idea-error').textContent = error.message; }
});
for (const kind of ['stage', 'idea']) {
  $(`#${kind}-form`).addEventListener('input', (event) => { event.currentTarget.dataset.dirty = 'true'; });
  $(`#close-${kind}-editor`).addEventListener('click', () => closeEditor(kind));
  $(`#cancel-${kind}`).addEventListener('click', () => closeEditor(kind));
}
$('#add-stage').addEventListener('click', () => openStage());
$('#edit-stage').addEventListener('click', () => openStage(selectedId));
$('#add-idea').addEventListener('click', () => openIdea());
$('#delete-stage').addEventListener('click', () => {
  const stage = state.data.stages[selectedId];
  const count = Object.values(state.data.ideas).filter((idea) => idea.stageId === stage.id).length;
  if (!confirm(`Supprimer « ${stage.title} » et les ${count} idées associées du carnet partagé ?`)) return;
  const next = clone(state.data); delete next.stages[stage.id];
  for (const [id, idea] of Object.entries(next.ideas)) if (idea.stageId === stage.id) delete next.ideas[id];
  commit(next);
});
$('#known-place').addEventListener('change', (event) => { if (event.target.value) setLocation(...event.target.value.split(',').map(Number)); });
$('#pick-location').addEventListener('click', () => { if (!globalThis.L) { $('#stage-error').textContent = 'La carte ne charge pas. Choisis une ville dans la liste.'; return; } journeyMap.startPick(); feedback('Clique sur la carte pour placer cette étape.'); });
$('#map-all').addEventListener('click', () => journeyMap?.fit());
$('#map-italy').addEventListener('click', () => journeyMap?.fit('italy'));
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
    const imported = JSON.parse(await file.text()); validateData(imported);
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
  if ((['saving', 'offline', 'conflict', 'error'].includes(state?.status) || stageEditing || ideaEditing) && !confirm('Certaines modifications sont encore en cours. Fermer le carnet ? Les brouillons déjà enregistrés dans ce navigateur seront conservés.')) return;
  client?.stop(); sessionStorage.removeItem('carnet-session'); location.replace(location.pathname + location.search);
});
window.addEventListener('beforeunload', (event) => {
  if ($('#stage-form').dataset.dirty === 'true' || $('#idea-form').dataset.dirty === 'true' || state?.status === 'saving') { event.preventDefault(); event.returnValue = ''; }
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
const rememberedCode = sessionStorage.getItem('carnet-session');
if (!API_URL) { $('#setup-message').hidden = false; $('#login-form button').disabled = true; }
else if (invitationCode || rememberedCode) connect(invitationCode || rememberedCode);
