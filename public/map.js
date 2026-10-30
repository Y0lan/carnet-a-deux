function label(text, className) {
  const node = document.createElement('span');
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

const position = (stage) => [stage.lat, stage.lng];
const connectionKey = (from, to) => [from, to].sort().join('|');
const samePoint = (a, b) => a.lat === b.lat && a.lng === b.lng;

export function createJourneyMap({ onSelect, onPick }) {
  const warning = document.querySelector('#map-warning');
  if (!globalThis.L) {
    if (warning) warning.hidden = false;
    return { render() {}, fit() {}, select() {}, startPick() {}, cancelPick() {}, resize() {} };
  }
  const map = L.map('map', { scrollWheelZoom: false, zoomControl: true }).setView([47, 11], 5);
  map.createPane('country-outline').style.zIndex = '150';
  fetch(new URL('./vendor/countries.geojson', import.meta.url)).then((response) => {
    if (!response.ok) throw new Error('Fond local absent.');
    return response.json();
  }).then((data) => L.geoJSON(data, {
    pane: 'country-outline', interactive: false,
    style: { color: '#b6c4ae', weight: 1, fillColor: '#eff0e4', fillOpacity: 1 },
  }).addTo(map)).catch(() => {});
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  tiles.on('tileerror', () => { if (warning) warning.hidden = false; });
  tiles.on('tileload', () => { if (warning) warning.hidden = true; });
  const markers = L.layerGroup().addTo(map);
  const routes = L.layerGroup().addTo(map);
  let stages = [];
  let selectedId = '';
  let picking = false;
  let pickMarker;
  let firstRender = true;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const date = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  function cancelPick() {
    picking = false;
    map.getContainer().style.cursor = '';
    if (pickMarker) { pickMarker.remove(); pickMarker = undefined; }
  }
  function pick(latlng) {
    cancelPick();
    pickMarker = L.circleMarker(latlng, { color: '#a84c36', radius: 9, interactive: false }).addTo(map);
    onPick(latlng.lat, latlng.lng);
  }
  map.on('click', (event) => { if (picking) pick(event.latlng); });
  map.getContainer().addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && picking) cancelPick();
  });

  function fit(scope = 'all') {
    let points = stages;
    const index = stages.findIndex((stage) => stage.id === selectedId);
    if (scope === 'selected') points = index < 0 ? [] : [stages[index]];
    if (scope === 'leg') {
      points = index < 0 ? [] : index > 0 ? stages.slice(index - 1, index + 1) : stages.slice(0, 2);
    }
    // Preserve the former shortcut for an already-open version of the interface.
    if (scope === 'italy') points = stages.filter((s) => s.lat > 36 && s.lat < 47.5 && s.lng > 6 && s.lng < 19);
    if (!points.length) return;
    map.invalidateSize();
    map.fitBounds(points.map(position), { padding: [42, 42], maxZoom: scope === 'selected' ? 12 : 10, animate: !reduceMotion });
  }

  function stagePicker(group) {
    const list = document.createElement('div');
    list.className = 'map-stop-picker';
    list.append(label(`${group.length} étapes dans cette zone`, 'map-stop-heading'));
    for (const { stage, index } of group) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'map-stop-choice';
      button.setAttribute('aria-current', String(stage.id === selectedId));
      button.append(label(`${index + 1}. ${stage.title}`), label(
        `${date.format(new Date(`${stage.start}T12:00:00Z`))} au ${date.format(new Date(`${stage.end}T12:00:00Z`))}`,
        'map-stop-date',
      ));
      button.addEventListener('click', () => { map.closePopup(); onSelect(stage.id); });
      list.append(button);
    }
    return list;
  }

  function render(nextStages, nextSelectedId, flights = []) {
    stages = nextStages; selectedId = nextSelectedId;
    routes.clearLayers();
    const byId = new Map(stages.map((stage) => [stage.id, stage]));
    const linkedFlights = flights.filter((flight) => byId.has(flight.fromStageId) && byId.has(flight.toStageId));
    const flightPairs = new Set(linkedFlights.map((flight) => connectionKey(flight.fromStageId, flight.toStageId)));
    for (let index = 1; index < stages.length; index++) {
      const from = stages[index - 1], to = stages[index];
      if (samePoint(from, to) || flightPairs.has(connectionKey(from.id, to.id))) continue;
      const active = to.id === selectedId || (index === 1 && from.id === selectedId);
      const line = L.polyline([position(from), position(to)], {
        color: '#426959', weight: active ? 4 : 2, opacity: active ? .9 : .5, dashArray: '3 7',
      });
      line.bindTooltip(label(`${from.title} → ${to.title} · liaison indicative, transport à choisir`));
      line.on('click', () => { if (!picking) onSelect(to.id); });
      line.addTo(routes);
    }
    for (const flight of linkedFlights) {
      const from = byId.get(flight.fromStageId), to = byId.get(flight.toStageId);
      if (samePoint(from, to)) continue;
      const active = from.id === selectedId || to.id === selectedId;
      const line = L.polyline([position(from), position(to)], {
        color: '#a84c36', weight: active ? 4 : 3, opacity: active ? .95 : .65, dashArray: '11 8',
      });
      line.bindTooltip(label(`${flight.title || 'Vol'} · repères des étapes, pas des aéroports`));
      line.on('click', () => { if (!picking) onSelect(to.id); });
      line.addTo(routes);
    }
    renderMarkers();
    if (firstRender && stages.length) { firstRender = false; requestAnimationFrame(() => fit()); }
  }

  function renderMarkers() {
    markers.clearLayers();
    const remaining = new Set(stages.map((stage, index) => ({
      stage, index, point: map.latLngToContainerPoint(position(stage)),
    })));
    const groups = [];
    // Group overlapping markers at this zoom, without assuming shared cities.
    for (const first of remaining) {
      remaining.delete(first);
      const group = [first];
      for (let i = 0; i < group.length; i++) {
        for (const candidate of remaining) {
          if (Math.hypot(candidate.point.x - group[i].point.x, candidate.point.y - group[i].point.y) > 42) continue;
          remaining.delete(candidate);
          group.push(candidate);
        }
      }
      groups.push(group.sort((a, b) => a.index - b.index));
    }
    for (const group of groups) {
      const selected = group.find(({ stage }) => stage.id === selectedId);
      const { stage, index } = selected ?? group[0];
      const active = Boolean(selected), grouped = group.length > 1;
      const content = label(String(index + 1), 'map-pin-number');
      if (grouped) content.append(label(`+${group.length - 1}`, 'map-pin-count'));
      const size = grouped ? 42 : active ? 36 : 32;
      const marker = L.marker(position(stage), {
        icon: L.divIcon({
          className: `map-pin${active ? ' selected' : ''}${grouped ? ' map-pin-group' : ''}`,
          html: content, iconSize: [size, size], iconAnchor: [size / 2, size / 2],
        }),
        title: grouped ? `${group.length} étapes dans cette zone. Choisir une étape.` : `${index + 1}. ${stage.title}`,
        keyboard: true, zIndexOffset: active ? 1000 : 0,
      });
      marker.bindTooltip(label(grouped ? `${group.length} étapes dans cette zone` : stage.title), { direction: 'top', offset: [0, -17] });
      if (grouped) marker.bindPopup(stagePicker(group), { minWidth: 220, maxWidth: 300 });
      marker.on('click', (event) => {
        if (picking) { map.closePopup(); pick(event.latlng ?? { lat: stage.lat, lng: stage.lng }); return; }
        if (grouped) marker.openPopup();
        else onSelect(stage.id);
      });
      marker.addTo(markers);
    }
  }
  map.on('zoomend', renderMarkers);

  return {
    fit, render, cancelPick,
    resize() { map.invalidateSize(); },
    select(id) {
      const stage = stages.find((item) => item.id === id);
      if (!stage) return;
      selectedId = id;
      map.invalidateSize();
      map.setView(position(stage), 11, { animate: !reduceMotion });
    },
    startPick() {
      cancelPick(); picking = true;
      map.closePopup(); map.getContainer().style.cursor = 'crosshair';
      document.querySelector('#parcours')?.scrollIntoView({ block: 'start' });
    },
  };
}
