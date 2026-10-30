import { isCivilDate, sortedStages, flightInstant } from './schema.js';

const kinds = { hotel: 'Hôtel', activite: 'Activité', trajet: 'Trajet', materiel: 'Matériel', restaurant: 'Restaurant', boutique: 'Boutique', exposition: 'Exposition', lieu: 'Lieu', evenement: 'Événement' };
const statuses = { explorer: 'À explorer', envie: 'Une envie', retenu: 'Retenu ensemble', reserve: 'Réservé' };
const fullDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDay = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
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
function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function shift(date, amount) {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + amount);
  return next.toISOString().slice(0, 10);
}
function dayLabel(date, short = false) { return (short ? shortDay : fullDay).format(new Date(`${date}T12:00:00Z`)); }
const overnight = (idea) => Boolean(idea.time && idea.endTime && idea.endTime < idea.time);

export function createAgenda({ getData, onSelectStage, onEditIdea, onAddIdea }) {
  const mount = document.querySelector('#agenda-content');
  let selectedDate = '', owner = 'all';
  const ownerButtons = new Map();
  const dateInput = el('input', { id: 'agenda-date', type: 'date', 'aria-label': 'Date à consulter' });
  const dateError = el('p', { id: 'agenda-date-error', class: 'error-message', role: 'alert' });
  dateInput.setAttribute('aria-describedby', 'agenda-date-error');
  const previous = button('La veille', () => move(-1), { id: 'agenda-previous' });
  const next = button('Le lendemain', () => move(1), { id: 'agenda-next' });
  const dayTitle = el('h2', { id: 'agenda-day-title', tabindex: -1, 'aria-live': 'polite', 'aria-atomic': 'true' });
  const dayContext = el('p', { id: 'agenda-day-context', class: 'small-note' });
  const filters = el('div', { class: 'agenda-people', role: 'group', 'aria-label': 'Choisir les envies à consulter' });
  for (const value of ['all', 'A', 'B', 'both']) {
    const node = button('', () => { owner = value; render(); }, { class: 'agenda-person', 'data-agenda-owner': value, 'aria-pressed': String(value === owner) });
    ownerButtons.set(value, node); filters.append(node);
  }
  const stagesLine = el('div', { id: 'agenda-stages', class: 'agenda-stage-actions' });
  const scheduled = section('Le programme du jour', 'agenda-scheduled');
  const flights = section('Les vols de la journée', 'agenda-flights');
  const stay = section('Où dormir ce soir', 'agenda-stay');
  const flexible = section('À choisir sur place', 'agenda-flexible');
  flexible.node.insertBefore(el('p', { class: 'small-note', text: 'Ces idées n’ont pas de date fixée. Elles restent disponibles pendant cette étape.' }), flexible.list);
  mount.append(
    el('div', { class: 'agenda-date-controls' }, [previous, el('label', {}, [document.createTextNode('Quel jour ?'), dateInput]), next, button('Aujourd’hui', () => setDate(today()), { id: 'agenda-today' })]),
    dateError, filters,
    el('div', { class: 'agenda-day-heading' }, [dayTitle, dayContext]), stagesLine,
    el('p', { class: 'small-note agenda-time-note', text: 'Les activités utilisent l’heure locale de leur étape. Chaque vol indique le fuseau de son aéroport. Vérifiez les horaires et les réservations avant de partir.' }),
    scheduled.node, flights.node, stay.node, flexible.node,
  );
  dateInput.addEventListener('change', () => setDate(dateInput.value));
  function section(title, id) {
    const list = el('div', { id, class: 'agenda-items' });
    return { list, node: el('section', { class: 'agenda-section', 'aria-labelledby': `${id}-title` }, [el('h3', { id: `${id}-title`, text: title }), list]) };
  }
  function setDate(value) {
    if (!isCivilDate(value)) { dateError.textContent = 'Choisis une date valide pour consulter le programme.'; return; }
    selectedDate = value; dateError.textContent = ''; render();
  }
  function move(amount) {
    if (!selectedDate) return;
    const value = shift(selectedDate, amount);
    if (isCivilDate(value)) setDate(value);
  }
  const names = () => ({ all: 'Tout voir', A: getData().trip.personA, B: getData().trip.personB, both: 'Nous deux' });
  const includesOwner = (value) => owner === 'all' || owner === (value || 'both');
  function source(url, text) { return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'text-button', text }); }

  function renderIdea(idea, continuation = false) {
    const data = getData(), stage = data.stages[idea.stageId];
    let timing = idea.date ? 'Horaire à choisir' : 'Quand on en a envie';
    if (idea.time) timing = continuation ? `Depuis la veille · jusqu’à ${idea.endTime}` : `${idea.time}${idea.endTime ? ` à ${idea.endTime}${overnight(idea) ? ' le lendemain' : ''}` : ''}`;
    const article = el('article', { class: 'agenda-item', 'data-agenda-idea': idea.id }, [
      el('div', { class: 'agenda-item-meta' }, [el('span', { text: `${kinds[idea.kind] || 'Idée'} · ${names()[idea.owner || 'both']}` }), el('span', { class: 'agenda-status', 'data-status': idea.status, text: statuses[idea.status] })]),
      el('p', { class: 'agenda-time', text: timing }), el('h4', { text: idea.title }),
    ]);
    if (stage) article.append(el('p', { class: 'agenda-place', text: stage.place }));
    if (idea.details) {
      const notes = el('p', { class: 'agenda-notes', text: idea.details });
      article.append(idea.details.length > 220 ? el('details', {}, [el('summary', { text: 'Notes et détails' }), notes]) : notes);
    }
    if (idea.address) article.append(el('p', { class: 'agenda-address', text: idea.address }));
    const actions = el('div', { class: 'agenda-item-actions' });
    if (idea.address) actions.append(source(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${idea.address}${stage ? `, ${stage.place}` : ''}`)}`, 'Ouvrir l’adresse'));
    if (idea.url) actions.append(source(idea.url, 'Voir la source'));
    if (stage) actions.append(button('Voir l’étape', () => onSelectStage(stage.id), { class: 'text-button', 'aria-label': `Voir l’étape ${stage.title}` }));
    actions.append(button('Modifier', () => onEditIdea(idea.id), { class: 'text-button', 'aria-label': `Modifier ${idea.title}`, 'data-agenda-edit': idea.id }));
    article.append(actions);
    return article;
  }
  function flightEndpoint(flight, side) {
    const dateTime = flight[side], departure = side === 'departure';
    const [date, time] = dateTime.split('T');
    return el('p', { class: 'agenda-flight-endpoint' }, [
      el('strong', { text: `${departure ? 'Départ' : 'Arrivée'} ${date === selectedDate ? '' : `le ${dayLabel(date, true)} `}à ${time}` }),
      el('span', { text: `${departure ? flight.from : flight.to} · ${flight[`${side}Zone`]}` }),
    ]);
  }
  function renderFlight(flight) {
    const node = el('article', { class: 'agenda-item agenda-flight', 'data-agenda-flight': flight.id }, [
      el('div', { class: 'agenda-item-meta' }, [el('span', { text: `${names()[flight.traveler]}${flight.number ? ` · ${flight.number}` : ''}` }), el('span', { class: 'agenda-status', 'data-status': flight.status, text: flight.status === 'reserve' ? 'Réservé' : flight.status === 'retenu' ? 'Retenu' : 'À comparer' })]),
      el('h4', { text: flight.title }),
    ]);
    for (const side of ['departure', 'arrival']) if (flight[side]) node.append(flightEndpoint(flight, side));
    if (!flight.departure || !flight.arrival) node.append(el('p', { class: 'small-note', text: 'Un des horaires reste à confirmer.' }));
    if (flight.notes) node.append(el('details', {}, [el('summary', { text: 'Notes du trajet' }), el('p', { class: 'agenda-notes', text: flight.notes })]));
    if (flight.url) node.append(source(flight.url, 'Voir la source du vol'));
    return node;
  }
  function render() {
    const data = getData(); if (!data) return;
    const stages = sortedStages(data);
    if (!selectedDate) {
      const current = today(), start = stages[0]?.start, end = stages.reduce((last, stage) => stage.end > last ? stage.end : last, '');
      selectedDate = start && !(start <= current && current <= end) ? start : current;
    }
    dateInput.value = selectedDate;
    previous.disabled = !isCivilDate(shift(selectedDate, -1)); next.disabled = !isCivilDate(shift(selectedDate, 1));
    const people = names();
    for (const [value, node] of ownerButtons) { node.textContent = people[value]; node.setAttribute('aria-pressed', String(value === owner)); }
    dayTitle.textContent = dayLabel(selectedDate);
    const active = stages.filter((stage) => stage.start <= selectedDate && selectedDate <= stage.end);
    dayContext.textContent = active.length ? active.map((stage) => `${stage.place}${stage.end === selectedDate ? ' (jour de départ)' : stage.start === selectedDate ? ' (jour d’arrivée)' : ''}`).join(' · ') : 'Aucune étape prévue à cette date. Les idées datées restent affichées.';
    stagesLine.replaceChildren(...active.flatMap((stage) => [
      button(stage.title, () => onSelectStage(stage.id), { class: 'button', 'aria-label': `Voir l’étape ${stage.title}` }),
      button(`Ajouter pour ${stage.place}`, () => onAddIdea(stage.id, { date: selectedDate, owner: owner === 'all' ? 'both' : owner, kind: 'activite' }), { class: 'text-button', 'data-agenda-add': stage.id }),
    ]));
    const ideas = Object.values(data.ideas).filter((idea) => includesOwner(idea.owner));
    const scheduledIdeas = ideas.filter((idea) => idea.date === selectedDate || (idea.date && overnight(idea) && shift(idea.date, 1) === selectedDate))
      .map((idea) => ({ idea, continuation: idea.date !== selectedDate }))
      .sort((a, b) => (a.continuation ? '00:00' : a.idea.time || '99:99').localeCompare(b.continuation ? '00:00' : b.idea.time || '99:99') || a.idea.title.localeCompare(b.idea.title, 'fr'));
    scheduled.list.replaceChildren(...scheduledIdeas.map(({ idea, continuation }) => renderIdea(idea, continuation)));
    if (!scheduledIdeas.length) scheduled.list.append(el('p', { class: 'agenda-empty', text: 'Rien n’est fixé pour ce jour. Choisissez une idée ci-dessous, ou ajoutez une adresse depuis l’étape.' }));
    const dailyFlights = Object.values(data.flights || {}).filter((flight) => includesOwner(flight.traveler) && [flight.departure, flight.arrival].some((value) => value?.slice(0, 10) === selectedDate));
    dailyFlights.sort((a, b) => {
      const instant = (flight) => {
        const side = flight.departure?.slice(0, 10) === selectedDate ? 'departure' : 'arrival';
        return flightInstant(flight[side], flight[`${side}Zone`]);
      };
      return instant(a) - instant(b);
    });
    flights.list.replaceChildren(...dailyFlights.map(renderFlight)); flights.node.hidden = !dailyFlights.length;
    const nights = new Set(stages.filter((stage) => stage.start <= selectedDate && selectedDate < stage.end).map((stage) => stage.id));
    const hotels = ideas.filter((idea) => idea.kind === 'hotel' && !idea.date && nights.has(idea.stageId));
    const chosenHotels = hotels.filter((idea) => ['retenu', 'reserve'].includes(idea.status));
    stay.list.replaceChildren(...(chosenHotels.length ? chosenHotels : hotels).map((idea) => renderIdea(idea))); stay.node.hidden = !hotels.length;
    const activeIds = new Set(active.map((stage) => stage.id));
    const freeIdeas = ideas.filter((idea) => !idea.date && idea.kind !== 'hotel' && activeIds.has(idea.stageId))
      .sort((a, b) => Number(b.voteA && b.voteB) - Number(a.voteA && a.voteB) || a.title.localeCompare(b.title, 'fr'));
    flexible.list.replaceChildren(...freeIdeas.map((idea) => renderIdea(idea)));
    if (!freeIdeas.length) flexible.list.append(el('p', { class: 'agenda-empty', text: active.length ? 'Ajoutez des restaurants, boutiques, lieux ou activités sans date pour les retrouver pendant ce séjour.' : 'Consultez le parcours pour retrouver les envies des autres étapes.' }));
  }
  return { render };
}
