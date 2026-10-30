export const MAX_DOCUMENT_BYTES = 512 * 1024;
export const MOODS = Object.freeze(['repos', 'aventure', 'fete', 'culture', 'mer', 'trajet']);
export const STAGE_STATUSES = Object.freeze(['explorer', 'envie', 'retenu', 'reserve']);
export const IDEA_STATUSES = STAGE_STATUSES;
export const IDEA_KINDS = Object.freeze(['hotel', 'activite', 'trajet', 'materiel']);

export class ValidationError extends Error {
  constructor(message, path = '') {
    super(path ? `${message} (${path})` : message);
    this.name = 'ValidationError';
    this.path = path;
  }
}

export function emptyData() {
  return { schemaVersion: 1, trip: { title: 'Notre voyage en Europe', personA: 'Personne A', personB: 'Personne B' }, stages: {}, ideas: {} };
}

export function isCivilDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function nightsBetween(start, end) {
  if (!isCivilDate(start) || !isCivilDate(end) || end <= start) throw new ValidationError('Les dates du séjour sont invalides.');
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
}

export function sortedStages(data) {
  return Object.values(data.stages).sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const identifier = /^[a-zA-Z0-9_-]{1,80}$/;
const dangerous = new Set(['__proto__', 'constructor', 'prototype']);
function fail(message, path) { throw new ValidationError(message, path); }
function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Un objet est attendu.', path);
  for (const key of Object.keys(value)) if (dangerous.has(key)) fail('Cette clé est interdite.', path);
}
function fields(value, names, path) {
  object(value, path);
  const actual = Object.keys(value);
  if (actual.length !== names.length || actual.some(key => !names.includes(key))) fail('Les champs sont invalides.', path);
}
function text(value, max, path, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('Le texte est vide ou trop long.', path);
}
function choice(value, choices, path) { if (!choices.includes(value)) fail('Cette valeur est invalide.', path); }
function id(value, path) { if (typeof value !== 'string' || !identifier.test(value) || dangerous.has(value)) fail('Cet identifiant est invalide.', path); }

export function validateData(data) {
  fields(data, ['schemaVersion', 'trip', 'stages', 'ideas'], '/');
  if (data.schemaVersion !== 1) fail('La version du document est inconnue.', '/schemaVersion');
  fields(data.trip, ['title', 'personA', 'personB'], '/trip');
  text(data.trip.title, 160, '/trip/title', true);
  text(data.trip.personA, 80, '/trip/personA', true);
  text(data.trip.personB, 80, '/trip/personB', true);
  object(data.stages, '/stages');
  object(data.ideas, '/ideas');
  if (Object.keys(data.stages).length > 60 || Object.keys(data.ideas).length > 500) fail('Le carnet contient trop de fiches.', '/');
  for (const [key, stage] of Object.entries(data.stages)) {
    const path = `/stages/${key}`;
    id(key, path);
    fields(stage, ['id', 'title', 'place', 'lat', 'lng', 'start', 'end', 'mood', 'status', 'notes'], path);
    if (stage.id !== key) fail('L’identifiant ne correspond pas à la fiche.', path);
    text(stage.title, 160, `${path}/title`, true);
    text(stage.place, 240, `${path}/place`, true);
    for (const [field, bound] of [['lat', 90], ['lng', 180]]) {
      if (typeof stage[field] !== 'number' || !Number.isFinite(stage[field]) || Math.abs(stage[field]) > bound) fail('Les coordonnées sont invalides.', `${path}/${field}`);
    }
    if (!isCivilDate(stage.start) || !isCivilDate(stage.end) || stage.end <= stage.start) fail('La date de départ doit suivre une date d’arrivée valide.', path);
    choice(stage.mood, MOODS, `${path}/mood`);
    choice(stage.status, STAGE_STATUSES, `${path}/status`);
    text(stage.notes, 12000, `${path}/notes`);
  }
  for (const [key, idea] of Object.entries(data.ideas)) {
    const path = `/ideas/${key}`;
    id(key, path);
    fields(idea, ['id', 'stageId', 'kind', 'title', 'url', 'details', 'cost', 'status', 'voteA', 'voteB'], path);
    if (idea.id !== key) fail('L’identifiant ne correspond pas à la fiche.', path);
    id(idea.stageId, `${path}/stageId`);
    if (!Object.hasOwn(data.stages, idea.stageId)) fail('L’étape de cette idée est absente.', path);
    choice(idea.kind, IDEA_KINDS, `${path}/kind`);
    choice(idea.status, IDEA_STATUSES, `${path}/status`);
    text(idea.title, 160, `${path}/title`, true);
    text(idea.details, 12000, `${path}/details`);
    text(idea.url, 2048, `${path}/url`);
    if (idea.url) {
      let url;
      try { url = new URL(idea.url); } catch { fail('Le lien est invalide.', `${path}/url`); }
      if (!/^https?:\/\//i.test(idea.url) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\u0000-\u0020\u007f]/.test(idea.url)) fail('Le lien doit utiliser HTTP ou HTTPS sans identifiant.', `${path}/url`);
    }
    if (idea.cost !== null && (typeof idea.cost !== 'number' || !Number.isFinite(idea.cost) || idea.cost < 0 || idea.cost > 1000000000)) fail('Le prix indicatif est invalide.', `${path}/cost`);
    if (typeof idea.voteA !== 'boolean' || typeof idea.voteB !== 'boolean') fail('Les préférences sont invalides.', path);
  }
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_DOCUMENT_BYTES) fail('Le document dépasse 512 Kio.', '/');
  return data;
}
