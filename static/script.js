/* DroneX — flight operations console.
   Single accent hue (#E8A33D). Monospace on data only. No ambient animation. */

let planMap, miniMap;
let homeMarker, candidateMarkers = [], routeLine, droneMarker;
let missionsCache = [];
let richDataById = {};
let selectedMissionId = null;
let selectedEntry = null;
let droneHome = { lat: 35.7796, lon: -78.6382 };
let userRangeOverride = null;

const SETTINGS_KEY = 'dronex_settings';

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (s.lat !== undefined && s.lat !== '' && !isNaN(s.lat)) droneHome.lat = parseFloat(s.lat);
    if (s.lon !== undefined && s.lon !== '' && !isNaN(s.lon)) droneHome.lon = parseFloat(s.lon);
    if (s.range !== undefined && s.range !== '' && !isNaN(s.range)) userRangeOverride = parseFloat(s.range);
  } catch (e) { /* ignore */ }
}

function openSettings() {
  const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  document.getElementById('setHomeLat').value = s.lat ?? droneHome.lat;
  document.getElementById('setHomeLon').value = s.lon ?? droneHome.lon;
  document.getElementById('setRange').value = s.range ?? (userRangeOverride ?? '');
  document.getElementById('settingsModal').style.display = 'flex';
}

function closeSettings() {
  document.getElementById('settingsModal').style.display = 'none';
}

function saveSettings() {
  const lat = document.getElementById('setHomeLat').value;
  const lon = document.getElementById('setHomeLon').value;
  const range = document.getElementById('setRange').value;
  const s = { lat, lon, range };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  if (lat !== '' && !isNaN(parseFloat(lat))) droneHome.lat = parseFloat(lat);
  if (lon !== '' && !isNaN(parseFloat(lon))) droneHome.lon = parseFloat(lon);
  userRangeOverride = (range !== '' && !isNaN(parseFloat(range))) ? parseFloat(range) : null;
  if (planMap) { homeMarker.setLatLng([droneHome.lat, droneHome.lon]); drawRangeRing(); drawNoFlyZones(); drawFlightHistory(); planMap.setView([droneHome.lat, droneHome.lon], 12); }
  closeSettings();
}

function resetSettings() {
  localStorage.removeItem(SETTINGS_KEY);
  droneHome = { lat: 35.7796, lon: -78.6382 };
  userRangeOverride = null;
  document.getElementById('setHomeLat').value = droneHome.lat;
  document.getElementById('setHomeLon').value = droneHome.lon;
  document.getElementById('setRange').value = '';
  if (planMap) { homeMarker.setLatLng([droneHome.lat, droneHome.lon]); drawRangeRing(); planMap.setView([droneHome.lat, droneHome.lon], 12); }
}

// ---------------- helpers ----------------

function aqiColor(aqi) {
  if (aqi === null || aqi === undefined) return '#55585F';
  if (aqi <= 50) return '#8A8D93';
  if (aqi <= 100) return '#E8A33D';
  if (aqi <= 150) return '#C9A227';
  if (aqi <= 200) return '#B8493B';
  if (aqi <= 300) return '#B8493B';
  return '#B8493B';
}

function divIcon(html, size) {
  return L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function showError(msg) {
  toast(msg, 'error');
}
function toast(msg, type = 'info', timeout = 6000) {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="t-dot"></span><span class="t-msg"></span><button class="t-close" aria-label="Dismiss">&times;</button>`;
  el.querySelector('.t-msg').textContent = msg;
  const close = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 120); };
  el.querySelector('.t-close').onclick = close;
  stack.appendChild(el);
  if (timeout) setTimeout(close, timeout);
}

function aqiCategoryInfo(aqi) {
  if (aqi === null || aqi === undefined) return { label: 'Unknown', color: '#55585F', badge: 'sb-wait' };
  if (aqi <= 50) return { label: 'Good', color: '#8A8D93', badge: 'sb-ok' };
  if (aqi <= 100) return { label: 'Moderate', color: '#E8A33D', badge: 'sb-active' };
  if (aqi <= 150) return { label: 'USG', color: '#C9A227', badge: 'sb-wait' };
  if (aqi <= 200) return { label: 'Unhealthy', color: '#B8493B', badge: 'sb-fail' };
  if (aqi <= 300) return { label: 'Very USG', color: '#B8493B', badge: 'sb-fail' };
  return { label: 'Hazardous', color: '#B8493B', badge: 'sb-fail' };
}

function fmtDate(iso) {
  if (!iso) return 'No date';
  const clean = String(iso).replace(/\.\d+/, '');
  const d = new Date(clean);
  if (isNaN(d.getTime())) return 'No date';
  let time = '';
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (t && t !== 'Invalid Date') time = t + ' \u00b7 ';
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return time + date;
}

function statusFor(entry) {
  if (entry.aqi_after !== null && entry.aqi_after !== undefined) {
    return { cls: 'complete', label: 'Complete', sbCls: 'sb-ok' };
  }
  if (window.__latestTelemetry && window.__latestTelemetry.mission_id === entry.mission_id) {
    return { cls: 'transit', label: 'In flight', sbCls: 'sb-active' };
  }
  return { cls: 'awaiting', label: 'Awaiting', sbCls: 'sb-wait' };
}

// ---------------- header / toolbar ----------------

function updateHeader() {
  const last = missionsCache[missionsCache.length - 1];
  let candidateCount = 'N/A';
  if (last) {
    const rich = richDataById[last.mission_id];
    if (rich && Array.isArray(rich.candidates)) candidateCount = rich.candidates.length;
    else if (typeof last.num_candidates === 'number') candidateCount = last.num_candidates;
  } else {
    candidateCount = '--';
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('mDrones', '1');
  set('mMissions', missionsCache.length);
  set('mCandidates', candidateCount);

  const noMissions = missionsCache.length === 0;
  const progress = document.getElementById('planProgress');
  if (progress) progress.classList.toggle('show', noMissions);
  const coach = document.getElementById('mapCoach');
  if (coach) coach.classList.toggle('show', noMissions && !coachDismissed && !userInteracted);
  if (noMissions && !userInteracted) setStepper(1);
  else if (!noMissions) setStepper(3);
}

// ---------------- list column ----------------

function renderList() {
  const cards = document.getElementById('missionCards');
  const empty = document.getElementById('listEmpty');
  if (!cards) return;
  cards.innerHTML = '';
  if (missionsCache.length === 0) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  missionsCache.slice().reverse().forEach(entry => {
    const status = statusFor(entry);
    const card = document.createElement('div');
    card.className = `mission-card status-${status.cls}` + (entry.mission_id === selectedMissionId ? ' selected' : '');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-pressed', entry.mission_id === selectedMissionId ? 'true' : 'false');
    card.onclick = () => selectMission(entry.mission_id);
    card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMission(entry.mission_id); } };
    const locText = (entry.address_resolved || entry.address || 'Unknown address');
    const title = entry.location_label || 'Air quality survey';
    const rt = entry.range_info ? entry.range_info.round_trip_miles + ' mi' : '--';
    const cat = aqiCategoryInfo(entry.aqi_before);
    const aqiVal = entry.aqi_before ?? 0;
    const circ = 100.53;
    const offset = circ * (1 - Math.min(aqiVal / 300, 1));
    card.innerHTML = `
      <div class="mc-gauge">
        <div class="mc-gauge-ring">
          <svg viewBox="0 0 36 36">
            <circle class="gauge-bg" cx="18" cy="18" r="16"/>
            <circle class="gauge-fill" cx="18" cy="18" r="16" style="--circ:${circ};--offset:${offset};stroke:${cat.color}"/>
          </svg>
          <span class="mc-gauge-val">${aqiVal}</span>
        </div>
        <div class="mc-gauge-info">
          <div class="mc-gauge-cat" style="color:${cat.color}">${cat.label}</div>
          <div class="mc-loc" title="${locText}">${locText}</div>
        </div>
      </div>
      <div class="mc-body">
        <div class="mc-top">
          <span class="mc-title">${title}</span>
          <span class="status-badge ${status.sbCls}"><span class="sb-indicator"></span>${status.label}</span>
        </div>
        <div class="mc-meta">
          <span class="data-val">#${entry.mission_id}</span>
          <span class="data-val">${rt}</span>
          <span>${fmtDate(entry.created)}</span>
        </div>
        <div class="mc-actions">
          <button class="mc-resume" onclick="event.stopPropagation(); selectMission('${entry.mission_id}')">Resume &rarr;</button>
        </div>
      </div>
    `;
    cards.appendChild(card);
  });
}

// ---------------- main map ----------------

function initPlanMap() {
  if (planMap) return;
  planMap = L.map('planMap', { zoomControl: true }).setView([droneHome.lat, droneHome.lon], 12);
  planMap.createPane('labelPane');
  planMap.getPane('labelPane').style.zIndex = 350;
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(planMap);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 20, pane: 'labelPane',
  }).addTo(planMap);
  homeMarker = L.marker([droneHome.lat, droneHome.lon], {
    icon: divIcon('<div class="home-marker"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg></div>', 30),
  }).addTo(planMap).bindPopup('Home base');
  drawRangeRing();
  drawNoFlyZones();
  drawFlightHistory();
  planMap.on('move zoom', positionFloatCard);
  planMap.on('click', onMapClick);
  planMap.on('dblclick', (e) => { onMapClick(e); document.getElementById('address')?.focus(); });
  planMap.on('contextmenu', onMapContextMenu);
  planMap.on('movestart zoomstart click', hideContextMenu);
  planMap.on('mousemove', onMapHover);
  planMap.on('mouseout', () => { if (hoverPreview) { planMap.removeLayer(hoverPreview); hoverPreview = null; } });
  setupTemplateDnd();
}

let noFlyLayer = null;
function drawNoFlyZones() {
  if (!planMap) return;
  if (noFlyLayer) { planMap.removeLayer(noFlyLayer); }
  noFlyLayer = L.layerGroup().addTo(planMap);
  const zones = [
    { lat: droneHome.lat + 0.045, lon: droneHome.lon + 0.03, r: 1400, label: 'Restricted airspace' },
    { lat: droneHome.lat - 0.035, lon: droneHome.lon + 0.055, r: 1000, label: 'Airport approach' },
    { lat: droneHome.lat + 0.02, lon: droneHome.lon - 0.06, r: 900, label: 'No-fly zone' },
  ];
  zones.forEach(z => {
    L.circle([z.lat, z.lon], {
      radius: z.r, color: 'rgba(184,73,59,0.3)', weight: 1,
      fillColor: '#B8493B', fillOpacity: 0.03, dashArray: '4 6', interactive: true,
    }).addTo(noFlyLayer).bindTooltip(z.label, { className: 'nfz-tip', direction: 'top' });
  });
}

let historyLayer = null;
function drawFlightHistory() {
  if (!planMap) return;
  if (historyLayer) { planMap.removeLayer(historyLayer); }
  historyLayer = L.layerGroup().addTo(planMap);
  missionsCache.forEach(m => {
    if (m.mission_id === selectedMissionId) return;
    if (!m.target || m.target.lat == null) return;
    L.polyline([[droneHome.lat, droneHome.lon], [m.target.lat, m.target.lon]], {
      color: 'rgba(138,141,147,0.12)', weight: 1, dashArray: '1 6', interactive: false,
    }).addTo(historyLayer);
    L.circleMarker([m.target.lat, m.target.lon], {
      radius: 2.5, color: 'rgba(138,141,147,0.3)', weight: 1, fillOpacity: 0.3, interactive: false,
    }).addTo(historyLayer);
  });
}

let hoverPreview = null;
function onMapHover(e) {
  if (selectedMissionId) { if (hoverPreview) { planMap.removeLayer(hoverPreview); hoverPreview = null; } return; }
  const { lat, lng } = e.latlng;
  if (!hoverPreview) {
    hoverPreview = L.marker([lat, lng], {
      icon: divIcon('<div class="drop-pin"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><line x1="12" y1="3" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>', 28),
      interactive: false, keyboard: false,
    }).addTo(planMap);
  } else {
    hoverPreview.setLatLng([lat, lng]);
  }
}

let dropMarker = null;
let userInteracted = false;

function onMapClick(e) {
  if (selectedMissionId) return;
  const { lat, lng } = e.latlng;
  if (dropMarker) planMap.removeLayer(dropMarker);
  dropMarker = L.marker([lat, lng], {
    icon: divIcon('<div class="drop-pin"><span class="drop-pulse"></span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><line x1="12" y1="3" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>', 34),
    zIndexOffset: 1000,
  }).addTo(planMap);
  dropMarker._icon?.querySelector('.drop-pin')?.classList.add('dropped');
  markInteracted();
  updatePlanBtn();
  toast('This is a preview marker \u2014 choose Virginia or California above to plan the mission.', 'info');
}

function markInteracted() {
  if (userInteracted) return;
  userInteracted = true;
  dismissCoach();
}

let coachDismissed = false;
function dismissCoach() {
  coachDismissed = true;
  const coach = document.getElementById('mapCoach');
  if (coach) coach.classList.remove('show');
}

// Step indicator: phases 1-4, dots ON the track
function setStepper(step) {
  document.querySelectorAll('.plan-progress .pp-phase').forEach(el => {
    const s = parseInt(el.getAttribute('data-phase'), 10);
    el.classList.toggle('active', s === step);
    el.classList.toggle('done', s < step);
  });
  document.querySelectorAll('.plan-progress .pp-track').forEach((track, i) => {
    const phaseBefore = i + 1;
    const fill = track.querySelector('.pp-fill');
    if (fill) {
      fill.style.width = phaseBefore < step ? '100%' : '0%';
    }
    track.classList.toggle('done', phaseBefore < step);
  });
}

function positionFloatCard() {
  const card = document.getElementById('targetFloatCard');
  if (!card || card.style.display === 'none' || !planMap) return;
  const entry = missionsCache.find(m => m.mission_id === selectedMissionId);
  if (!entry) return;
  const pt = planMap.latLngToContainerPoint([entry.target.lat, entry.target.lon]);
  card.style.left = Math.min(Math.max(pt.x - 90, 10), planMap.getSize().x - 210) + 'px';
  card.style.top = Math.max(pt.y - 70, 10) + 'px';
}

// ---------------- map context menu ----------------

let ctxLatLng = null;

function onMapContextMenu(e) {
  e.originalEvent?.preventDefault?.();
  ctxLatLng = e.latlng;
  const menu = document.getElementById('mapContextMenu');
  if (!menu) return;
  const size = planMap.getSize();
  const pt = planMap.mouseEventToContainerPoint(e.originalEvent);
  menu.style.display = 'block';
  const w = menu.offsetWidth || 190, h = menu.offsetHeight || 160;
  menu.style.left = Math.min(pt.x, size.x - w - 8) + 'px';
  menu.style.top = Math.min(pt.y, size.y - h - 8) + 'px';
}

function hideContextMenu() {
  const menu = document.getElementById('mapContextMenu');
  if (menu) menu.style.display = 'none';
}

function ctxAction(action) {
  hideContextMenu();
  if (!ctxLatLng || !planMap) return;
  const { lat, lng } = ctxLatLng;
  if (action === 'pin') {
    onMapClick({ latlng: ctxLatLng });
  } else if (action === 'center') {
    planMap.flyTo([lat, lng], planMap.getZoom(), { duration: 0.5 });
  } else if (action === 'home') {
    droneHome = { lat, lon: lng };
    if (homeMarker) homeMarker.setLatLng([lat, lng]);
    drawRangeRing();
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    s.lat = lat; s.lon = lng;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    toast(`Home base set to ${lat.toFixed(4)}, ${lng.toFixed(4)}.`, 'success');
  } else if (action === 'copy') {
    navigator.clipboard?.writeText(`${lat.toFixed(6)}, ${lng.toFixed(6)}`)
      .then(() => toast('Coordinates copied.', 'success'))
      .catch(() => showError('Could not copy coordinates.'));
  }
}

// ---------------- drag templates ----------------

let dragTemplate = null;

function setupTemplateDnd() {
  document.querySelectorAll('.template-item').forEach(item => {
    const input = item.querySelector('input.tpl');
    item.setAttribute('draggable', 'true');
    item.addEventListener('dragstart', (ev) => {
      dragTemplate = input ? input.value : null;
      item.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'copy';
      try { ev.dataTransfer.setData('text/plain', dragTemplate || ''); } catch (e) {}
    });
    item.addEventListener('dragend', () => { item.classList.remove('dragging'); });
  });

  const mapEl = document.getElementById('planMap');
  if (!mapEl) return;
  mapEl.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; mapEl.classList.add('drop-target'); });
  mapEl.addEventListener('dragleave', () => mapEl.classList.remove('drop-target'));
  mapEl.addEventListener('drop', (ev) => {
    ev.preventDefault();
    mapEl.classList.remove('drop-target');
    const tpl = dragTemplate || ev.dataTransfer.getData('text/plain');
    const rect = mapEl.getBoundingClientRect();
    const pt = L.point(ev.clientX - rect.left, ev.clientY - rect.top);
    const latlng = planMap.containerPointToLatLng(pt);
    if (tpl) {
      const cb = document.querySelector(`.template-item input.tpl[value="${tpl}"]`);
      if (cb) cb.checked = true;
    }
    onMapClick({ latlng });
    const name = tpl ? tpl.replace(/^\w/, c => c.toUpperCase()) : 'Mission';
    toast(`${name} template dropped \u2014 pick a location, then Plan mission.`, 'info');
    dragTemplate = null;
  });
}

// ---------------- location picker ----------------

const LOC_KEY = 'dronex_locations';
const LOCATIONS = [
  { value: 'virginia', label: 'Virginia' },
  { value: 'california', label: 'California' },
];

function getLocStore() {
  try { return JSON.parse(localStorage.getItem(LOC_KEY) || '{}'); }
  catch (e) { return {}; }
}
function setLocStore(s) { localStorage.setItem(LOC_KEY, JSON.stringify(s)); }

function pushRecent(value) {
  const s = getLocStore();
  s.recents = (s.recents || []).filter(v => v !== value);
  s.recents.unshift(value);
  s.recents = s.recents.slice(0, 5);
  setLocStore(s);
  renderLocPanel();
}

function toggleFavorite(value, ev) {
  if (ev) ev.stopPropagation();
  const s = getLocStore();
  s.favs = s.favs || [];
  if (s.favs.includes(value)) s.favs = s.favs.filter(v => v !== value);
  else s.favs.push(value);
  setLocStore(s);
  renderLocPanel();
}

function labelFor(value) {
  const l = LOCATIONS.find(x => x.value === value);
  return l ? l.label : value;
}

function chooseLocation(value) {
  const sel = document.getElementById('address');
  if (sel) sel.value = value;
  pushRecent(value);
  hideLocPanel();
  markInteracted();
  setStepper(2);
  updatePlanBtn();
}

function openLocPanel() {
  const panel = document.getElementById('locPanel');
  if (!panel) return;
  panel.style.display = 'block';
  const input = document.getElementById('locSearchInput');
  if (input) { input.value = ''; input.focus(); }
  renderLocPanel();
}
function hideLocPanel() {
  const panel = document.getElementById('locPanel');
  if (panel) panel.style.display = 'none';
}

function renderLocPanel(filter = '') {
  const panel = document.getElementById('locPanel');
  if (!panel) return;
  const body = panel.querySelector('.loc-body');
  const s = getLocStore();
  const favs = s.favs || [];
  const recents = (s.recents || []);
  const f = filter.trim().toLowerCase();
  const matches = LOCATIONS.filter(l => !f || l.label.toLowerCase().includes(f));

  const row = (l, tag) => `
    <div class="loc-row" onclick="chooseLocation('${l.value}')">
      <span class="loc-star ${favs.includes(l.value) ? 'on' : ''}" title="Favorite" onclick="toggleFavorite('${l.value}', event)">${favs.includes(l.value) ? '\u2605' : '\u2606'}</span>
      <span class="loc-name">${l.label}</span>
      ${tag ? `<span class="loc-tag">${tag}</span>` : ''}
    </div>`;

  let html = '';
  if (!f && favs.length) {
    html += `<div class="loc-group">Favorites</div>` + favs.map(v => LOCATIONS.find(l => l.value === v)).filter(Boolean).map(l => row(l, '\u2605')).join('');
  }
  if (!f && recents.length) {
    html += `<div class="loc-group">Recent</div>` + recents.map(v => LOCATIONS.find(l => l.value === v)).filter(Boolean).map(l => row(l, 'recent')).join('');
  }
  html += `<div class="loc-group">${f ? 'Results' : 'All locations'}</div>`;
  html += matches.length ? matches.map(l => row(l)).join('') : `<div class="loc-empty">No matches.</div>`;
  body.innerHTML = html;
}

function clearMissionLayers() {
  candidateMarkers.forEach(m => planMap.removeLayer(m));
  candidateMarkers = [];
  if (routeLine) { planMap.removeLayer(routeLine); routeLine = null; }
  document.getElementById('targetFloatCard').style.display = 'none';
}

function plotMissionOnMap(entry, rich) {
  initPlanMap();
  clearMissionLayers();
  const targetLat = entry.target.lat, targetLon = entry.target.lon;

  if (rich) {
    rich.candidates.forEach(c => {
      const isChosen = c.lat === rich.chosen.lat && c.lon === rich.chosen.lon;
      const html = isChosen
        ? '<div class="package-marker chosen"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3L3 8.5v7L12 21l9-5.5v-7L12 3z"/></svg></div>'
        : '<div class="package-marker"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3L3 8.5v7L12 21l9-5.5v-7L12 3z"/></svg></div>';
      const marker = L.marker([c.lat, c.lon], { icon: divIcon(html, 30) })
        .addTo(planMap)
        .bindPopup(`AQI ${c.worst_aqi} (${c.worst_param})<br>${c.distance_miles} mi from address`);
      candidateMarkers.push(marker);
    });
  }

  routeLine = L.polyline([[droneHome.lat, droneHome.lon], [targetLat, targetLon]], {
    color: '#E8A33D', weight: 1.5, opacity: 0.7, dashArray: '2 8',
  }).addTo(planMap);

  const bounds = L.latLngBounds([[droneHome.lat, droneHome.lon], [targetLat, targetLon]]);
  planMap.fitBounds(bounds.pad(0.35));

  const card = document.getElementById('targetFloatCard');
  card.style.display = 'flex';
  document.getElementById('tfcTitle').textContent = '#' + entry.mission_id;
  document.getElementById('tfcSub').textContent = `${entry.aqi_param || 'AQI'} \u00b7 ${entry.aqi_before ?? '--'}`;
  const pt = planMap.latLngToContainerPoint([targetLat, targetLon]);
  card.style.left = Math.min(Math.max(pt.x - 90, 10), planMap.getSize().x - 210) + 'px';
  card.style.top = Math.max(pt.y - 70, 10) + 'px';

  placeDroneMarker();
}

let rangeRing = null;
function drawRangeRing() {
  if (!planMap) return;
  if (rangeRing) { planMap.removeLayer(rangeRing); rangeRing = null; }
  const miles = userRangeOverride != null ? userRangeOverride : 3;
  const meters = (miles / 2) * 1609.34;
  rangeRing = L.circle([droneHome.lat, droneHome.lon], {
    radius: meters,
    color: 'rgba(232,163,61,0.18)', weight: 1, fillColor: 'transparent',
    dashArray: '3 7', interactive: false,
  }).addTo(planMap);
  // Solid boundary ring
  L.circle([droneHome.lat, droneHome.lon], {
    radius: meters,
    color: 'rgba(232,163,61,0.25)', weight: 1, fillColor: 'transparent',
    interactive: false,
  }).addTo(planMap);
}

function placeDroneMarker() {
  const t = window.__latestTelemetry;
  if (!planMap) return;
  if (droneMarker) { planMap.removeLayer(droneMarker); droneMarker = null; }
  if (t && t.lat && t.lon && t.mission_id === selectedMissionId) {
    droneMarker = L.marker([t.lat, t.lon], {
      icon: divIcon('<div class="drone-marker"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3L3 8.5v7L12 21l9-5.5v-7L12 3z"/></svg></div>', 34),
    }).addTo(planMap).bindPopup('Live position');
  }
}

// ---------------- detail column ----------------

function selectMission(missionId) {
  selectedMissionId = missionId;
  const entry = missionsCache.find(m => m.mission_id === missionId);
  if (!entry) return;
  renderList();
  showDetailPanel(true);
  renderDetail(entry, richDataById[missionId]);
  plotMissionOnMap(entry, richDataById[missionId]);
  if (hoverPreview) { planMap.removeLayer(hoverPreview); hoverPreview = null; }
  drawFlightHistory();
}

function deselectMission() {
  selectedMissionId = null;
  renderList();
  showDetailPanel(false);
  if (planMap) { clearMissionLayers(); drawFlightHistory(); }
  updatePlanBtn();
}

function showDetailPanel(show) {
  const col = document.getElementById('detailCol');
  const empty = document.getElementById('detailEmpty');
  const content = document.getElementById('detailContent');
  const mapCol = document.getElementById('mapCol');
  if (show) {
    col.style.display = 'flex';
    empty.style.display = 'none';
    content.style.display = 'block';
    if (mapCol) { mapCol.classList.remove('full'); mapCol.classList.add('has-mission'); }
  } else {
    col.style.display = 'none';
    empty.style.display = 'flex';
    content.style.display = 'none';
    if (mapCol) { mapCol.classList.add('full'); mapCol.classList.remove('has-mission'); }
  }
}

function renderDetail(entry, rich) {
  document.getElementById('detailEmpty').style.display = 'none';
  document.getElementById('detailContent').style.display = 'block';

  const status = statusFor(entry);
  document.getElementById('d-id').textContent = entry.mission_id;
  const statusBadge = document.getElementById('d-status');
  statusBadge.className = 'status-badge ' + status.sbCls;
  document.getElementById('d-status-label').textContent = status.label;

  document.getElementById('d-address').textContent = (entry.address_resolved || entry.address || '--').slice(0, 60);
  document.getElementById('d-pollutant').textContent = entry.aqi_param || '--';
  document.getElementById('d-created').textContent = fmtDate(entry.created);
  const aqiVal = entry.aqi_before !== null && entry.aqi_before !== undefined ? entry.aqi_before : null;
  const cat = aqiCategoryInfo(aqiVal);
  document.getElementById('d-aqi').innerHTML = aqiVal !== null
    ? `<span class="data-val" style="color:${cat.color};font-weight:600">${aqiVal}</span> <span class="status-badge ${cat.badge}"><span class="sb-indicator"></span>${cat.label}</span>`
    : '--';

  renderCandidateBars(rich);

  document.getElementById('d-drone').textContent = `DRN-01`;

  const r = entry.range_info;
  document.getElementById('d-range-badge').innerHTML = r
    ? `<span class="data-val">${r.round_trip_miles} mi round trip</span> \u00b7 <span style="color:${r.in_range ? '#8A8D93' : '#B8493B'}">${r.in_range ? 'in range' : 'out of range'}</span>`
    : 'not calculated';

  const a = rich ? rich.airspace : null;
  document.getElementById('d-airspace-badge').innerHTML = a
    ? (a.warning ? `<span style="color:#E8A33D">${a.checked ? 'Airspace flagged' : 'Airspace unverified'}</span>` : `<span style="color:#8A8D93">Airspace clear</span>`)
    : 'Only checked for missions planned this session';

  document.getElementById('d-home-coords').textContent = `${droneHome.lat.toFixed(4)}, ${droneHome.lon.toFixed(4)}`;
  document.getElementById('d-target-coords').textContent = `${entry.target.lat.toFixed(4)}, ${entry.target.lon.toFixed(4)}`;
  document.getElementById('miniMapLabel').textContent = (entry.address_resolved || entry.address || 'Target').slice(0, 28);

  document.getElementById('downloadLink').href = `/api/plan/${entry.mission_id}`;

  renderMiniMap(entry.target.lat, entry.target.lon);
  loadTrend(entry.target.lat, entry.target.lon);
}

function renderMiniMap(lat, lon) {
  if (miniMap) { miniMap.remove(); miniMap = null; }
  miniMap = L.map('miniMap', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false }).setView([lat, lon], 14);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 20 }).addTo(miniMap);
  L.marker([lat, lon], { icon: divIcon('<div class="package-marker chosen"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3L3 8.5v7L12 21l9-5.5v-7L12 3z"/></svg></div>', 28) }).addTo(miniMap);
}

function renderCandidateBars(rich) {
  const box = document.getElementById('candidateBars');
  if (!box) return;
  if (!rich || !rich.candidates || !rich.candidates.length) {
    box.innerHTML = '<p class="dim" style="font-size:12px;margin:0;">Only available for missions planned this session.</p>';
    return;
  }
  const maxAqi = Math.max(...rich.candidates.map(c => c.worst_aqi || 0), 1);
  box.innerHTML = rich.candidates.map((c, i) => {
    const cat = aqiCategoryInfo(c.worst_aqi);
    const pct = Math.round((c.worst_aqi / maxAqi) * 100);
    const isChosen = c.lat === rich.chosen.lat && c.lon === rich.chosen.lon;
    return `
      <div class="cbar ${isChosen ? 'chosen' : ''}">
        <div class="cbar-top"><span>${isChosen ? '\u2605 Chosen' : 'Cand. ' + (i + 1)}</span><b style="color:${cat.color}">${c.worst_aqi}</b></div>
        <div class="cbar-track"><div class="cbar-fill" style="width:${pct}%; background:${cat.color}"></div></div>
        <div class="cbar-sub">${c.worst_param || 'AQI'} \u00b7 ${c.distance_miles} mi</div>
      </div>`;
  }).join('');
}

async function loadTrend(lat, lon) {
  const box = document.getElementById('trendChart');
  if (!box) return;
  box.innerHTML = '<div class="dim" style="height:90px;width:100%;display:flex;align-items:center;justify-content:center;">Loading...</div>';
  try {
    const res = await fetch(`/api/trend?lat=${lat}&lon=${lon}&hours=12`);
    const data = await res.json();
    const pts = (data.points || []).filter(p => p.aqi != null);
    if (!pts.length) { box.innerHTML = '<p class="dim" style="font-size:12px;margin:0;">No historical AQI for this area yet.</p>'; return; }
    const max = Math.max(...pts.map(p => p.aqi), 1);
    const bars = pts.map(p => {
      const cat = aqiCategoryInfo(p.aqi);
      const h = Math.max(3, Math.round((p.aqi / max) * 80));
      return `<div class="tbar" title="${p.aqi} AQI" style="height:${h}px;background:${cat.color}"></div>`;
    }).join('');
    box.innerHTML = `<div class="trend-bars">${bars}</div><div class="trend-axis"><span>-12h</span><span>now</span></div>`;
  } catch (e) {
    box.innerHTML = '<p class="dim" style="font-size:12px;margin:0;">Trend unavailable.</p>';
  }
}

function copyMissionJson() {
  if (!selectedMissionId || !richDataById[selectedMissionId]) {
    showError('Plan a mission first to copy its details.');
    return;
  }
  const data = richDataById[selectedMissionId];
  navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    .then(() => toast('Mission JSON copied to clipboard.', 'success'))
    .catch(() => showError('Could not copy to clipboard.'));
}

// ---------------- plan mission ----------------

function updatePlanBtn() {
  const btn = document.getElementById('planBtn');
  if (!btn) return;
  const loc = document.getElementById('address')?.value;
  const armed = !!loc;
  btn.classList.toggle('disabled', !armed);
  btn.setAttribute('aria-disabled', armed ? 'false' : 'true');
}

async function planMission() {
  const location = document.getElementById('address').value;
  const rangeInput = document.getElementById('range').value;
  const btn = document.getElementById('planBtn');
  showError(null);

  if (!location) { showError('Choose Virginia or California first.'); return; }

  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span>Planning...';

  try {
    const res = await fetch('/api/plan_mission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location, max_round_trip_miles: userRangeOverride !== null ? userRangeOverride : (rangeInput ? parseFloat(rangeInput) : null) }),
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error || 'Something went wrong.'); return; }

    toast(`Mission #${data.mission_id} planned \u2014 target AQI ${data.chosen.worst_aqi}.`, 'success');
    pushRecent(location);
    markInteracted();
    if (dropMarker) { planMap.removeLayer(dropMarker); dropMarker = null; }
    droneHome = data.home;
    richDataById[data.mission_id] = data;
    await refreshHistory();
    selectMission(data.mission_id);
  } catch (e) {
    showError('Request failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

function exportSelected() {
  if (!selectedMissionId) return;
  window.open(`/api/plan/${selectedMissionId}`, '_blank');
}

// ---------------- history / telemetry ----------------

async function refreshHistory() {
  try {
    const res = await fetch('/api/history');
    missionsCache = await res.json();
    updateHeader();
    renderList();
    drawFlightHistory();
  } catch (e) { /* ignore */ }
}

async function pollTelemetry() {
  try {
    const res = await fetch('/api/telemetry/latest');
    const data = await res.json();
    window.__latestTelemetry = data && data.received_at ? data : null;
    renderList();
    placeDroneMarker();
  } catch (e) { /* ignore */ }
}

// ---------------- map toolbar ----------------

document.getElementById('recenterBtn')?.addEventListener('click', () => {
  if (!planMap) return;
  if (selectedMissionId) {
    const entry = missionsCache.find(m => m.mission_id === selectedMissionId);
    if (entry) {
      const bounds = L.latLngBounds([[droneHome.lat, droneHome.lon], [entry.target.lat, entry.target.lon]]);
      planMap.fitBounds(bounds.pad(0.35));
      return;
    }
  }
  planMap.setView([droneHome.lat, droneHome.lon], 12);
});

document.getElementById('expandBtn')?.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.getElementById('planBody')?.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
  setTimeout(() => planMap && planMap.invalidateSize(), 250);
});

document.getElementById('locateBtn')?.addEventListener('click', () => {
  if (!planMap) return;
  planMap.flyTo([droneHome.lat, droneHome.lon], 12, { duration: 0.6 });
  if (dropMarker) { planMap.removeLayer(dropMarker); dropMarker = null; }
});

document.getElementById('miniExpandBtn')?.addEventListener('click', () => {
  if (!planMap) return;
  const entry = missionsCache.find(m => m.mission_id === selectedMissionId);
  if (entry && entry.target) planMap.flyTo([entry.target.lat, entry.target.lon], 15, { duration: 0.5 });
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); document.getElementById('address')?.focus(); markInteracted(); }
  if (e.key === 'l' || e.key === 'L') { if (selectedMissionId) toast('Mission already planned \u2014 launch from the drone.', 'info'); }
});

// ---------------- wind indicator ----------------

const WIND_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function updateWind() {
  const arrow = document.getElementById('windArrow');
  const val = document.getElementById('windVal');
  const dir = document.getElementById('windDir');
  if (!arrow) return;
  const t = Date.now() / 1000;
  const baseDeg = 210 + Math.sin(t / 40) * 30;
  const speed = 6 + Math.abs(Math.sin(t / 25)) * 5;
  arrow.style.transform = `rotate(${baseDeg}deg)`;
  val.textContent = speed.toFixed(0) + ' kt';
  dir.textContent = WIND_DIRS[Math.round(((baseDeg % 360) / 45)) % 8];
}

// ---------------- init ----------------

updateHeader();
loadSettings();
initPlanMap();
updateWind();
setInterval(updateWind, 5000);
updatePlanBtn();
if (homeMarker) homeMarker.setLatLng([droneHome.lat, droneHome.lon]);
refreshHistory();
showDetailPanel(false);

['address', 'range'].forEach(id => {
  document.getElementById(id)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); planMission(); }
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSettings(); hideLocPanel(); hideContextMenu(); }
});

document.getElementById('address')?.addEventListener('change', () => { if (document.getElementById('address').value) { markInteracted(); setStepper(2); } updatePlanBtn(); });
document.getElementById('locSearchInput')?.addEventListener('input', (e) => renderLocPanel(e.target.value));
document.getElementById('locSearchInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = document.querySelector('#locPanel .loc-body .loc-row');
    first?.click();
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#locPickerWrap')) hideLocPanel();
  if (!e.target.closest('#mapContextMenu') && !e.target.closest('#planMap')) hideContextMenu();
});

pollTelemetry();
setInterval(pollTelemetry, 4000);