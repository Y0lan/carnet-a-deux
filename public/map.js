const position = (stage) => [stage.lng, stage.lat];
const connectionKey = (from, to) => [from, to].sort().join('|');
const samePoint = (a, b) => a.lat === b.lat && a.lng === b.lng;
const emptyRoutes = () => ({ type: 'FeatureCollection', features: [] });

function label(text, className) {
  const node = document.createElement('span');
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function createJourneyMap({ onSelect, onPick }) {
  const container = document.querySelector('#map');
  const warning = document.querySelector('#map-warning');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const date = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  let library, map, ready = false, failed = false;
  let stages = [], selectedId = '', flights = [], markers = [], popup;
  let picking = false, pickMarker;
  let cameraPending = { type: 'fit', scope: 'all' };

  function warn(message) {
    if (!warning) return;
    warning.textContent = message;
    warning.hidden = !message;
  }
  function closePopup() { popup?.remove(); popup = undefined; }
  function cancelPick() {
    picking = false;
    if (map) map.getCanvas().style.cursor = '';
    pickMarker?.remove(); pickMarker = undefined;
  }
  function pick(lngLat) {
    cancelPick(); closePopup();
    const point = document.createElement('span');
    point.className = 'map-pick-marker';
    point.setAttribute('aria-hidden', 'true');
    pickMarker = new library.Marker({ element: point }).setLngLat([lngLat.lng, lngLat.lat]).addTo(map);
    onPick(lngLat.lat, lngLat.lng);
  }

  function applyCamera() {
    if (!ready || !cameraPending || !stages.length || !container.clientWidth || !container.clientHeight) return;
    const command = cameraPending;
    const index = stages.findIndex((stage) => stage.id === selectedId);
    if (command.type === 'select') {
      const stage = stages.find((item) => item.id === command.id);
      if (stage) map.easeTo({ center: position(stage), zoom: 11, bearing: 0, pitch: 0, duration: reduceMotion ? 0 : 300 });
    } else {
      let points = stages;
      if (command.scope === 'selected') points = index < 0 ? [] : [stages[index]];
      if (command.scope === 'leg') points = index < 0 ? [] : index > 0 ? stages.slice(index - 1, index + 1) : stages.slice(0, 2);
      if (points.length) {
        const bounds = new library.LngLatBounds();
        for (const stage of points) bounds.extend(position(stage));
        map.fitBounds(bounds, { padding: 42, maxZoom: command.scope === 'selected' ? 12 : 10, bearing: 0, pitch: 0, duration: reduceMotion ? 0 : 300 });
      }
    }
    cameraPending = null;
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
      button.addEventListener('click', () => { closePopup(); onSelect(stage.id); });
      list.append(button);
    }
    return list;
  }

  function renderMarkers() {
    if (!ready) return;
    closePopup();
    for (const marker of markers) marker.remove();
    markers = [];
    const remaining = new Set(stages.map((stage, index) => ({ stage, index, point: map.project(position(stage)) })));
    const groups = [];
    // Le regroupement suit la distance à l'écran, sans supposer une ville commune.
    for (const first of remaining) {
      remaining.delete(first);
      const group = [first];
      for (let i = 0; i < group.length; i++) {
        for (const candidate of remaining) {
          if (Math.hypot(candidate.point.x - group[i].point.x, candidate.point.y - group[i].point.y) > 42) continue;
          remaining.delete(candidate); group.push(candidate);
        }
      }
      groups.push(group.sort((a, b) => a.index - b.index));
    }
    for (const group of groups) {
      const selected = group.find(({ stage }) => stage.id === selectedId);
      const { stage, index } = selected ?? group[0];
      const active = Boolean(selected), grouped = group.length > 1;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `map-pin${active ? ' selected' : ''}${grouped ? ' map-pin-group' : ''}`;
      button.setAttribute('aria-label', grouped ? `${group.length} étapes dans cette zone. Choisir une étape.` : `${index + 1}. ${stage.title}`);
      button.setAttribute('aria-current', String(active));
      button.title = grouped ? `${group.length} étapes dans cette zone` : stage.title;
      button.append(label(String(index + 1), 'map-pin-number'));
      if (grouped) button.append(label(`+${group.length - 1}`, 'map-pin-count'));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (picking) { pick({ lat: stage.lat, lng: stage.lng }); return; }
        if (grouped) {
          closePopup();
          popup = new library.Popup({ offset: 24, maxWidth: '310px', closeButton: true, closeOnMove: true })
            .setLngLat(position(stage)).setDOMContent(stagePicker(group)).addTo(map);
        } else onSelect(stage.id);
      });
      markers.push(new library.Marker({ element: button, anchor: 'center' }).setLngLat(position(stage)).addTo(map));
    }
  }

  function routeData() {
    const data = emptyRoutes();
    const byId = new Map(stages.map((stage) => [stage.id, stage]));
    const linked = flights.filter((flight) => byId.has(flight.fromStageId) && byId.has(flight.toStageId));
    const flightPairs = new Set(linked.map((flight) => connectionKey(flight.fromStageId, flight.toStageId)));
    function append(from, to, type, active) {
      if (samePoint(from, to)) return;
      data.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [position(from), position(to)] }, properties: { type, active, destination: to.id } });
    }
    for (let i = 1; i < stages.length; i++) {
      const from = stages[i - 1], to = stages[i];
      if (!flightPairs.has(connectionKey(from.id, to.id))) append(from, to, 'connection', to.id === selectedId || (i === 1 && from.id === selectedId));
    }
    for (const flight of linked) append(byId.get(flight.fromStageId), byId.get(flight.toStageId), 'flight', [flight.fromStageId, flight.toStageId].includes(selectedId));
    return data;
  }
  function draw() {
    if (!ready) return;
    map.getSource('journey-routes').setData(routeData());
    renderMarkers(); applyCamera();
  }
  function initialize(api) {
    library = api;
    api.setWorkerUrl(new URL('./vendor/maplibre-gl-worker.js', import.meta.url).href);
    map = new api.Map({
      container, style: 'https://tiles.openfreemap.org/styles/liberty', center: [11, 47], zoom: 4,
      attributionControl: false, scrollZoom: false, dragRotate: false, pitchWithRotate: false,
      touchPitch: false, cooperativeGestures: true, maxZoom: 18,
      locale: { 'NavigationControl.ZoomIn': 'Zoomer', 'NavigationControl.ZoomOut': 'Dézoomer', 'Map.Title': 'Carte du voyage', 'CooperativeGesturesHandler.MobileHelpText': 'Utilise deux doigts pour déplacer la carte', 'Popup.Close': 'Fermer' },
    });
    map.addControl(new api.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new api.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.addControl(new api.AttributionControl({ compact: false, customAttribution: '<a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · <a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>' }), 'bottom-right');
    map.getCanvas().setAttribute('aria-label', 'Carte du voyage. Utilise les flèches pour te déplacer et les boutons pour zoomer.');
    map.getCanvas().addEventListener('keydown', (event) => { if (event.key === 'Escape') cancelPick(); });
    map.on('click', (event) => {
      if (picking) { pick(event.lngLat); return; }
      if (!ready) return;
      const destination = map.queryRenderedFeatures(event.point, { layers: ['journey-connection', 'journey-flight'] })[0]?.properties?.destination;
      if (destination) onSelect(destination);
    });
    map.on('zoomend', renderMarkers);
    map.on('error', () => warn('La carte ne charge pas complètement. Les étapes et les liens Google Maps restent disponibles.'));
    map.on('load', () => {
      map.addSource('journey-routes', { type: 'geojson', data: emptyRoutes() });
      for (const [type, color, dash] of [['connection', '#376893', [1, 2.5]], ['flight', '#a84c36', [3, 2]]]) {
        map.addLayer({ id: `journey-${type}`, type: 'line', source: 'journey-routes', filter: ['==', ['get', 'type'], type], paint: { 'line-color': color, 'line-width': ['case', ['get', 'active'], 4, 2.5], 'line-opacity': ['case', ['get', 'active'], .95, .55], 'line-dasharray': dash } });
      }
      ready = true; warn(''); draw();
    });
  }

  // Le moteur et les tuiles ne sont chargés qu'après l'ouverture du carnet.
  import('./vendor/maplibre-gl.js').then(initialize).catch(() => {
    failed = true; ready = false;
    try { map?.remove(); } catch { /* La création peut avoir échoué avant l'initialisation WebGL. */ }
    map = undefined;
    warn('Cette carte ne peut pas s’ouvrir sur cet appareil. Utilise les étapes, Google Maps ou la saisie des coordonnées.');
  });

  return {
    render(nextStages, nextSelectedId, nextFlights = []) { stages = nextStages; selectedId = nextSelectedId; flights = nextFlights; draw(); },
    fit(scope = 'all') { cameraPending = { type: 'fit', scope }; map?.resize(); applyCamera(); },
    select(id) { if (!stages.some((stage) => stage.id === id)) return; selectedId = id; cameraPending = { type: 'select', id }; map?.resize(); draw(); },
    resize() { map?.resize(); if (ready) { renderMarkers(); applyCamera(); } },
    cancelPick,
    startPick() {
      if (!ready) { if (!failed) warn('La carte est en cours de chargement. Tu peux aussi saisir les coordonnées.'); return false; }
      cancelPick(); closePopup(); picking = true;
      map.getCanvas().style.cursor = 'crosshair';
      document.querySelector('#parcours')?.scrollIntoView({ block: 'start' });
      map.getCanvas().focus({ preventScroll: true });
      return true;
    },
  };
}
