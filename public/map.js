export function createJourneyMap({ onSelect, onPick }) {
  if (!globalThis.L) {
    document.querySelector('#map-warning').hidden = false;
    return { render() {}, fit() {}, select() {}, startPick() {} };
  }
  const map = L.map('map', { scrollWheelZoom: false, zoomControl: true }).setView([47, 11], 5);
  map.createPane('country-outline').style.zIndex = '150';
  fetch(new URL('./vendor/countries.geojson', import.meta.url)).then((response) => {
    if (!response.ok) throw new Error('Fond local absent.');
    return response.json();
  }).then((data) => L.geoJSON(data, { pane: 'country-outline', interactive: false, style: { color: '#b6c4ae', weight: 1, fillColor: '#eff0e4', fillOpacity: 1 } }).addTo(map)).catch(() => {});
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  tiles.on('tileerror', () => { document.querySelector('#map-warning').hidden = false; });
  tiles.on('tileload', () => { document.querySelector('#map-warning').hidden = true; });
  const markers = L.layerGroup().addTo(map);
  const routes = L.layerGroup().addTo(map);
  let stages = [];
  let picking = false;
  let pickMarker;
  let firstRender = true;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  map.on('click', (event) => {
    if (!picking) return;
    picking = false;
    map.getContainer().style.cursor = '';
    if (pickMarker) pickMarker.remove();
    pickMarker = L.circleMarker(event.latlng, { color: '#a84c36', radius: 9 }).addTo(map);
    onPick(event.latlng.lat, event.latlng.lng);
  });
  function fit(scope = 'all') {
    const points = stages.filter((s) => scope !== 'italy' || (s.lat > 36 && s.lat < 47.5 && s.lng > 6 && s.lng < 19));
    if (!points.length) return;
    map.invalidateSize();
    map.fitBounds(points.map((s) => [s.lat, s.lng]), { padding: [45, 45], maxZoom: 10, animate: !reduceMotion });
  }
  return {
    fit,
    render(nextStages, selectedId) {
      stages = nextStages;
      markers.clearLayers(); routes.clearLayers();
      for (let index = 1; index < stages.length; index++) {
        const a = stages[index - 1], b = stages[index];
        const distant = Math.abs(a.lat - b.lat) + Math.abs(a.lng - b.lng) > 5;
        L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: '#426959', weight: 2, opacity: .7, dashArray: distant ? '5 7' : undefined }).addTo(routes);
      }
      stages.forEach((stage, index) => {
        const active = stage.id === selectedId;
        const marker = L.marker([stage.lat, stage.lng], {
          icon: L.divIcon({ className: `map-pin${active ? ' selected' : ''}`, html: String(index + 1), iconSize: [active ? 34 : 29, active ? 34 : 29], iconAnchor: [15, 15] }),
          title: `${index + 1}. ${stage.title}`, keyboard: true, zIndexOffset: active ? 1000 : 0,
        });
        const label = document.createElement('span'); label.textContent = stage.title;
        marker.bindTooltip(label, { direction: 'top', offset: [0, -17] });
        marker.on('click', () => { if (!picking) onSelect(stage.id); }); marker.addTo(markers);
      });
      if (firstRender && stages.length) { firstRender = false; requestAnimationFrame(() => fit()); }
    },
    select(id) {
      const stage = stages.find((s) => s.id === id);
      if (stage) map.setView([stage.lat, stage.lng], Math.max(map.getZoom(), 9), { animate: !reduceMotion });
    },
    startPick() {
      picking = true; map.getContainer().style.cursor = 'crosshair';
      document.querySelector('#parcours').scrollIntoView({ block: 'start' });
    },
  };
}
