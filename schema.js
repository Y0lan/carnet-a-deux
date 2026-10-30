export const MAX_DOCUMENT_BYTES = 512 * 1024;
export const MOODS = Object.freeze(['repos', 'aventure', 'fete', 'culture', 'mer', 'trajet']);
export const STAGE_STATUSES = Object.freeze(['explorer', 'envie', 'retenu', 'reserve']);
export const IDEA_STATUSES = STAGE_STATUSES;
const LEGACY_IDEA_KINDS = Object.freeze(['hotel', 'activite', 'trajet', 'materiel']);
export const IDEA_KINDS = Object.freeze([...LEGACY_IDEA_KINDS, 'restaurant', 'boutique', 'exposition', 'lieu', 'evenement']);
export const PRICE_BASES = Object.freeze(['unknown', 'estimate', 'historical', 'checked']);
const IDEA_DEFAULTS = Object.freeze({
  date: '', time: '', endTime: '', address: '', owner: 'both',
  imageUrl: '', imageCredit: '', imageSource: '', room: '', comfort: '', locationNote: '',
  priceBasis: 'unknown', priceNote: '',
});
const ideaDefaults = (idea) => ({ ...IDEA_DEFAULTS, priceBasis: idea.cost === null ? 'unknown' : 'estimate' });
export const FLIGHT_STATUSES = Object.freeze(['explorer', 'retenu', 'reserve']);
export const SHOPPING_CATEGORIES = Object.freeze(['camping', 'vetements', 'dj', 'ordinateur', 'production', 'autre']);
export const SHOPPING_STATUSES = Object.freeze(['envie', 'comparer', 'acheter', 'commande', 'achete', 'possede']);
export const CURRENCIES = Object.freeze(['EUR', 'USD', 'XPF', 'THB', 'PLN']);
export const PEOPLE = Object.freeze(['both', 'A', 'B']);

export class ValidationError extends Error {
  constructor(message, path = '') {
    super(path ? `${message} (${path})` : message);
    this.name = 'ValidationError';
    this.path = path;
  }
}

export function emptyData() {
  return { schemaVersion: 2, trip: { title: 'Notre voyage en Europe', personA: 'Personne A', personB: 'Personne B' }, stages: {}, ideas: {}, flights: {}, shopping: {} };
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
function fields(value, names, path, optional = []) {
  object(value, path);
  const actual = Object.keys(value);
  if (names.some(key => !Object.hasOwn(value, key)) || actual.some(key => !names.includes(key) && !optional.includes(key))) fail('Les champs sont invalides.', path);
}
function text(value, max, path, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('Le texte est vide ou trop long.', path);
}
function choice(value, choices, path) { if (!choices.includes(value)) fail('Cette valeur est invalide.', path); }
function id(value, path) { if (typeof value !== 'string' || !identifier.test(value) || dangerous.has(value)) fail('Cet identifiant est invalide.', path); }
function link(value, path, httpsOnly = false) {
  text(value, 2048, path);
  if (!value) return;
  let url;
  try { url = new URL(value); } catch { fail('Le lien est invalide.', path); }
  if (!/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(url.protocol) || (httpsOnly && url.protocol !== 'https:') || !url.hostname || url.username || url.password || /[\u0000-\u0020\u007f]/.test(value)) fail(httpsOnly ? 'Le lien de la photo doit utiliser HTTPS sans identifiant.' : 'Le lien doit utiliser HTTP ou HTTPS sans identifiant.', path);
}
function price(value, path) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000000)) fail('Le prix indicatif est invalide.', path);
}
function preferences(value, path) {
  if (typeof value.voteA !== 'boolean' || typeof value.voteB !== 'boolean') fail('Les préférences sont invalides.', path);
}
function stageReference(value, stages, path) {
  if (value === '') return;
  id(value, path);
  if (!Object.hasOwn(stages, value)) fail('L’étape associée est absente.', path);
}
const timeFormatters = new Map();
const flightInstants = new Map();
function timeFormatter(zone, path = '') {
  text(zone, 100, path, true);
  // Named zones keep daylight-saving rules explicit.
  if (!/^(?:[A-Za-z_+-]+\/)*[A-Za-z_+-]+(?:\d{1,2})?$/.test(zone)) fail('Choisis un fuseau horaire valide, par exemple Europe/Paris.', path);
  if (timeFormatters.has(zone)) return timeFormatters.get(zone);
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (timeFormatters.size >= 64) timeFormatters.clear();
    timeFormatters.set(zone, formatter);
    return formatter;
  } catch { fail('Choisis un fuseau horaire valide, par exemple Europe/Paris.', path); }
}
function localParts(formatter, instant) {
  const values = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
  return `${values.year.padStart(4, '0')}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

// Candidate offsets on both sides of the date detect skipped and repeated local hours.
export function flightInstant(local, zone) {
  if (local === '') return null;
  if (typeof local !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) || !isCivilDate(local.slice(0, 10)) || Number(local.slice(11, 13)) > 23 || Number(local.slice(14, 16)) > 59) fail('La date et l’heure du vol sont invalides.');
  const formatter = timeFormatter(zone);
  const key = `${zone}\n${local}`;
  if (flightInstants.has(key)) return flightInstants.get(key);
  const nominal = Date.parse(`${local}:00Z`);
  const offsets = new Set();
  const candidates = new Set();
  for (let hours = -48; hours <= 48; hours += 12) {
    const sample = nominal + hours * 3600000;
    offsets.add(Date.parse(`${localParts(formatter, sample)}Z`) - sample);
  }
  for (const offset of offsets) {
    const candidate = nominal - offset;
    if (localParts(formatter, candidate) === `${local}:00`) candidates.add(candidate);
  }
  if (!candidates.size) fail('Cette heure locale n’existe pas à cette date. Vérifie le changement d’heure.');
  if (candidates.size > 1) fail('Cette heure locale se répète lors du changement d’heure. Garde l’horaire précis en notes et laisse ce champ vide.');
  const instant = [...candidates][0];
  if (flightInstants.size >= 512) flightInstants.clear();
  flightInstants.set(key, instant);
  return instant;
}

export function flightDurationMinutes(flight) {
  const start = flightInstant(flight.departure, flight.departureZone);
  const end = flightInstant(flight.arrival, flight.arrivalZone);
  return start === null || end === null ? null : (end - start) / 60000;
}

export function validateData(data) {
  object(data, '/');
  if (![1, 2].includes(data.schemaVersion)) fail('La version du document est inconnue.', '/schemaVersion');
  const current = data.schemaVersion === 2;
  fields(data, ['schemaVersion', 'trip', 'stages', 'ideas', ...(current ? ['flights', 'shopping'] : [])], '/');
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
    fields(stage, ['id', 'title', 'place', 'lat', 'lng', 'start', 'end', 'mood', 'status', 'notes', ...(current ? ['experience', 'imageUrl', 'imageCredit', 'imageSource'] : [])], path);
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
    if (current) {
      text(stage.experience, 12000, `${path}/experience`);
      link(stage.imageUrl, `${path}/imageUrl`, true);
      text(stage.imageCredit, 240, `${path}/imageCredit`);
      link(stage.imageSource, `${path}/imageSource`);
    }
  }
  for (const [key, idea] of Object.entries(data.ideas)) {
    const path = `/ideas/${key}`;
    id(key, path);
    fields(idea, ['id', 'stageId', 'kind', 'title', 'url', 'details', 'cost', 'status', 'voteA', 'voteB'], path, current ? Object.keys(IDEA_DEFAULTS) : []);
    if (idea.id !== key) fail('L’identifiant ne correspond pas à la fiche.', path);
    id(idea.stageId, `${path}/stageId`);
    if (!Object.hasOwn(data.stages, idea.stageId)) fail('L’étape de cette idée est absente.', path);
    choice(idea.kind, current ? IDEA_KINDS : LEGACY_IDEA_KINDS, `${path}/kind`);
    choice(idea.status, IDEA_STATUSES, `${path}/status`);
    text(idea.title, 160, `${path}/title`, true);
    text(idea.details, 12000, `${path}/details`);
    link(idea.url, `${path}/url`);
    price(idea.cost, `${path}/cost`);
    preferences(idea, path);
    if (current) {
      const agenda = { ...ideaDefaults(idea), ...idea };
      if (agenda.date !== '' && !isCivilDate(agenda.date)) fail('La date de cette idée est invalide.', `${path}/date`);
      for (const field of ['time', 'endTime']) {
        if (agenda[field] !== '' && (typeof agenda[field] !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(agenda[field]))) fail('L’heure doit être au format HH:mm.', `${path}/${field}`);
      }
      if (agenda.time && !agenda.date) fail('Indique une date avant de choisir une heure.', `${path}/date`);
      if (agenda.endTime && !agenda.time) fail('Indique l’heure de début avant l’heure de fin.', `${path}/time`);
      text(agenda.address, 500, `${path}/address`);
      choice(agenda.owner, PEOPLE, `${path}/owner`);
      link(agenda.imageUrl, `${path}/imageUrl`, true);
      text(agenda.imageCredit, 240, `${path}/imageCredit`);
      link(agenda.imageSource, `${path}/imageSource`);
      text(agenda.room, 500, `${path}/room`);
      text(agenda.comfort, 1000, `${path}/comfort`);
      text(agenda.locationNote, 1000, `${path}/locationNote`);
      choice(agenda.priceBasis, PRICE_BASES, `${path}/priceBasis`);
      text(agenda.priceNote, 2000, `${path}/priceNote`);
      if (agenda.priceBasis === 'checked' && (idea.cost === null || !idea.url || !agenda.priceNote.trim())) fail('Pour un prix vérifié, indique son montant, son lien source et une note avec la date de vérification.', `${path}/priceBasis`);
    }
  }
  if (current) {
    object(data.flights, '/flights');
    object(data.shopping, '/shopping');
    if (Object.keys(data.flights).length > 100 || Object.keys(data.shopping).length > 500) fail('Le carnet contient trop de fiches.', '/');
    for (const [key, flight] of Object.entries(data.flights)) {
      const path = `/flights/${key}`;
      id(key, path);
      fields(flight, ['id', 'title', 'from', 'to', 'departure', 'arrival', 'departureZone', 'arrivalZone', 'number', 'traveler', 'status', 'url', 'notes', 'fromStageId', 'toStageId'], path);
      if (flight.id !== key) fail('L’identifiant ne correspond pas à la fiche.', path);
      text(flight.title, 160, `${path}/title`, true);
      text(flight.from, 160, `${path}/from`, true);
      text(flight.to, 160, `${path}/to`, true);
      text(flight.number, 80, `${path}/number`);
      text(flight.notes, 12000, `${path}/notes`);
      const instants = {};
      for (const side of ['departure', 'arrival']) {
        text(flight[`${side}Zone`], 100, `${path}/${side}Zone`);
        if (!flight[side] && flight[`${side}Zone`]) timeFormatter(flight[`${side}Zone`], `${path}/${side}Zone`);
        try { instants[side] = flightInstant(flight[side], flight[`${side}Zone`]); }
        catch (error) { fail(error.message, `${path}/${side}`); }
      }
      if (instants.departure !== null && instants.arrival !== null && instants.arrival <= instants.departure) fail('L’arrivée doit suivre le départ, en tenant compte des fuseaux horaires.', path);
      choice(flight.traveler, PEOPLE, `${path}/traveler`);
      choice(flight.status, FLIGHT_STATUSES, `${path}/status`);
      link(flight.url, `${path}/url`);
      stageReference(flight.fromStageId, data.stages, `${path}/fromStageId`);
      stageReference(flight.toStageId, data.stages, `${path}/toStageId`);
    }
    for (const [key, item] of Object.entries(data.shopping)) {
      const path = `/shopping/${key}`;
      id(key, path);
      fields(item, ['id', 'title', 'category', 'owner', 'status', 'url', 'cost', 'currency', 'notes', 'stageId', 'voteA', 'voteB'], path);
      if (item.id !== key) fail('L’identifiant ne correspond pas à la fiche.', path);
      text(item.title, 160, `${path}/title`, true);
      text(item.notes, 12000, `${path}/notes`);
      choice(item.category, SHOPPING_CATEGORIES, `${path}/category`);
      choice(item.owner, PEOPLE, `${path}/owner`);
      choice(item.status, SHOPPING_STATUSES, `${path}/status`);
      choice(item.currency, CURRENCIES, `${path}/currency`);
      price(item.cost, `${path}/cost`);
      preferences(item, path);
      link(item.url, `${path}/url`);
      stageReference(item.stageId, data.stages, `${path}/stageId`);
    }
  }
  checkSize(data);
  return data;
}

function checkSize(data) {
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_DOCUMENT_BYTES) fail('Le document dépasse 512 Kio.', '/');
}

export function migrateData(data) {
  validateData(data);
  const next = structuredClone(data);
  if (next.schemaVersion === 1) {
    next.schemaVersion = 2;
    next.flights = {};
    next.shopping = {};
    for (const stage of Object.values(next.stages)) Object.assign(stage, { experience: '', imageUrl: '', imageCredit: '', imageSource: '' });
  }
  for (const idea of Object.values(next.ideas)) {
    for (const [field, value] of Object.entries(ideaDefaults(idea))) if (!Object.hasOwn(idea, field)) idea[field] = value;
  }
  // The defaults are valid by construction; only the serialized size can grow.
  checkSize(next);
  return next;
}
