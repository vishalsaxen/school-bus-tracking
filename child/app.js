// Beacon Go (child app).
// Uses the phone's live GPS while sharing is on. With no backend yet, location reaches parents
// by text: "Send" opens the messages app with their numbers and a map link.
// Child Details are kept in this browser's localStorage.

const STORAGE_KEY = 'beacon-go.children';
const BUS_COUNT_KEY = 'beacon-go.busCount';
const MAX_BUSES = 50;
const DEFAULT_BUSES = 7; // the school currently runs Bus No. 1 to Bus No. 7

const state = {
  sharing: true,
  position: null,   // latest GeolocationPosition
  geoError: null,   // 'unsupported' | 'denied' | 'unavailable'
  busNumber: 1,
  children: loadChildren(),
  busCount: loadBusCount(),
};

const frame = document.querySelector('.frame');

// ---------- Tabs ----------
const tabs = document.querySelectorAll('.tab');
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
      document.getElementById(t.dataset.panel).hidden = !active;
    });
    frame.classList.toggle('on-children', tab.id === 'tab-children');
  });
});

// ---------- Tracker ----------
const title = document.getElementById('status-title');
const subtitle = document.getElementById('status-subtitle');
const toggleBtn = document.getElementById('toggle-btn');
const busChip = document.getElementById('bus-chip');
const batteryValue = document.getElementById('battery-value');

const sendBtn = document.getElementById('send-btn');
const mapLink = document.getElementById('map-link');
const sendDialog = document.getElementById('send-dialog');
const sendOptions = document.getElementById('send-options');

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function mapsUrl({ latitude, longitude }) {
  return `https://maps.google.com/?q=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

function renderTracker() {
  const { sharing, position, geoError } = state;
  frame.classList.toggle('is-paused', !sharing || Boolean(geoError));

  if (!sharing) {
    title.textContent = 'Location sharing is off';
    subtitle.textContent = 'Turn it back on so your parents can see where you are';
  } else if (geoError === 'denied') {
    title.textContent = 'Location permission needed';
    subtitle.textContent = 'Allow location for this site in your browser settings, then tap Pause and Start.';
  } else if (geoError) {
    title.textContent = 'Can\'t find your location';
    subtitle.textContent = geoError === 'unsupported'
      ? 'This browser doesn\'t support location. Try Chrome or Safari on your phone.'
      : 'Check that location (GPS) is turned on for your phone.';
  } else if (!position) {
    title.textContent = 'Finding your location…';
    subtitle.textContent = 'Allow location access if your phone asks';
  } else {
    title.textContent = 'Sharing your location';
    subtitle.textContent = `Updated ${timeAgo(position.timestamp)} · accurate to ${Math.round(position.coords.accuracy)} m`;
  }

  const hasFix = sharing && position && !geoError;
  sendBtn.disabled = !hasFix;
  mapLink.hidden = !hasFix;
  if (hasFix) {
    const { latitude, longitude } = position.coords;
    mapLink.href = mapsUrl(position.coords);
    mapLink.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)} · Open in Maps`;
  }

  toggleBtn.textContent = sharing ? 'Pause sharing' : 'Start sharing';
  toggleBtn.setAttribute('aria-pressed', String(sharing));
  busChip.textContent = `Bus No. ${state.busNumber}`;
}

// ---------- Live GPS ----------
let watchId = null;

function startWatching() {
  if (!('geolocation' in navigator)) {
    state.geoError = 'unsupported';
    return;
  }
  state.geoError = null;
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      state.position = position;
      state.geoError = null;
      renderTracker();
    },
    (error) => {
      state.geoError = error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable';
      renderTracker();
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
  );
}

function stopWatching() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

toggleBtn.addEventListener('click', () => {
  state.sharing = !state.sharing;
  if (state.sharing) startWatching(); else stopWatching();
  renderTracker();
});

// Keep "Updated … ago" fresh between GPS fixes.
setInterval(() => { if (state.sharing && state.position) renderTracker(); }, 10000);

// ---------- Send location to parents by text ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

function smsUrl(numbers, body) {
  const to = numbers.map((n) => n.replace(/[\s-]/g, '')).join(',');
  // iOS expects "&body=", Android expects "?body=".
  return `sms:${to}${isIOS ? '&' : '?'}body=${encodeURIComponent(body)}`;
}

function messageFor(child) {
  const link = mapsUrl(state.position.coords);
  return `${child.name} is here (Bus No. ${child.bus || 1}), updated ${new Date(state.position.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${link}`;
}

sendBtn.addEventListener('click', () => {
  if (!state.position) return;
  if (state.children.length === 0) {
    alert('Add your name and your parents\' mobile numbers in Child Details first.');
    document.getElementById('tab-children').click();
    return;
  }
  if (state.children.length === 1) {
    const [child] = state.children;
    window.location.href = smsUrl([child.mobile1, child.mobile2], messageFor(child));
    return;
  }
  sendOptions.replaceChildren(...state.children.map((child) => {
    const option = document.createElement('a');
    option.className = 'sheet-option';
    option.href = smsUrl([child.mobile1, child.mobile2], messageFor(child));
    const name = document.createElement('strong');
    name.textContent = child.name;
    const numbers = document.createElement('span');
    numbers.textContent = `${child.mobile1} · ${child.mobile2}`;
    option.append(name, numbers);
    option.addEventListener('click', () => sendDialog.close());
    return option;
  }));
  sendDialog.showModal();
});

// Show the real battery level where the browser supports it; keep the mockup value otherwise.
if (navigator.getBattery) {
  navigator.getBattery().then((battery) => {
    const show = () => { batteryValue.textContent = `${Math.round(battery.level * 100)}%`; };
    show();
    battery.addEventListener('levelchange', show);
  }).catch(() => {});
}

// ---------- Child Details ----------
const form = document.getElementById('child-form');
const nameInput = document.getElementById('child-name');
const busSelect = document.getElementById('child-bus');
const busCountEl = document.getElementById('bus-count');
const busMinus = document.getElementById('bus-minus');
const busPlus = document.getElementById('bus-plus');
const mobile1Input = document.getElementById('child-mobile1');
const mobile2Input = document.getElementById('child-mobile2');
const formError = document.getElementById('form-error');
const list = document.getElementById('child-list');
const countEl = document.getElementById('child-count');
const emptyState = document.getElementById('empty-state');

function loadChildren() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function loadBusCount() {
  try {
    const saved = parseInt(localStorage.getItem(BUS_COUNT_KEY), 10);
    return saved >= 1 ? Math.min(saved, MAX_BUSES) : DEFAULT_BUSES;
  } catch {
    return DEFAULT_BUSES;
  }
}

function saveChildren() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.children));
  } catch {
    // Storage unavailable (private mode); entries last for this visit only.
  }
}

function saveBusCount() {
  try {
    localStorage.setItem(BUS_COUNT_KEY, String(state.busCount));
  } catch {}
}

// The bus count can't drop below the highest bus a child is assigned to.
function minBusCount() {
  return Math.max(1, ...state.children.map((c) => c.bus || 1));
}

function renderBuses() {
  busCountEl.textContent = String(state.busCount);
  busMinus.disabled = state.busCount <= minBusCount();
  busPlus.disabled = state.busCount >= MAX_BUSES;

  const selected = parseInt(busSelect.value, 10) || 1;
  busSelect.replaceChildren(...Array.from({ length: state.busCount }, (_, i) => {
    const option = document.createElement('option');
    option.value = String(i + 1);
    option.textContent = `Bus No. ${i + 1}`;
    return option;
  }));
  busSelect.value = String(Math.min(selected, state.busCount));
}

busMinus.addEventListener('click', () => {
  if (state.busCount <= minBusCount()) return;
  state.busCount -= 1;
  saveBusCount();
  renderBuses();
});

busPlus.addEventListener('click', () => {
  if (state.busCount >= MAX_BUSES) return;
  state.busCount += 1;
  saveBusCount();
  renderBuses();
});

// Accepts digits with optional leading +, spaces or dashes; 10 to 15 digits.
function isValidMobile(value) {
  const digits = value.replace(/[\s-]/g, '');
  return /^\+?\d{10,15}$/.test(digits);
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}

function childItem(child) {
  const item = document.createElement('li');
  item.className = 'child-item';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = initials(child.name);

  const meta = document.createElement('div');
  meta.className = 'child-meta';
  const name = document.createElement('div');
  name.className = 'child-name';
  name.textContent = child.name;
  const phones = document.createElement('div');
  phones.className = 'child-phones';
  phones.textContent = `${child.mobile1} · ${child.mobile2}`;
  meta.append(name, phones);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-btn';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', `Remove ${child.name}`);
  remove.addEventListener('click', () => {
    if (!confirm(`Remove ${child.name}? Use this when a child leaves the school.`)) return;
    state.children = state.children.filter((c) => c.id !== child.id);
    saveChildren();
    renderChildren();
  });

  item.append(avatar, meta, remove);
  return item;
}

// Children grouped by bus, in bus order.
function renderChildren() {
  const buses = [...new Set(state.children.map((c) => c.bus || 1))].sort((a, b) => a - b);
  list.replaceChildren(...buses.map((bus) => {
    const group = document.createElement('section');
    group.className = 'bus-group';
    const heading = document.createElement('div');
    heading.className = 'bus-group-title';
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `Bus No. ${bus}`;
    const riders = state.children.filter((c) => (c.bus || 1) === bus);
    heading.append(chip, `${riders.length} ${riders.length === 1 ? 'child' : 'children'}`);
    const ul = document.createElement('ul');
    ul.className = 'child-list';
    ul.append(...riders.map(childItem));
    group.append(heading, ul);
    return group;
  }));

  renderBuses();
  countEl.textContent = String(state.children.length);
  emptyState.hidden = state.children.length > 0;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const bus = parseInt(busSelect.value, 10) || 1;
  const mobile1 = mobile1Input.value.trim();
  const mobile2 = mobile2Input.value.trim();

  if (!name) return showError('Please enter the child\'s name.', nameInput);
  if (!isValidMobile(mobile1)) return showError('Mobile number 1 should be 10 to 15 digits.', mobile1Input);
  if (!isValidMobile(mobile2)) return showError('Mobile number 2 should be 10 to 15 digits.', mobile2Input);

  state.children.push({ id: Date.now().toString(36), name, bus, mobile1, mobile2 });
  saveChildren();
  renderChildren();
  form.reset();
  busSelect.value = String(bus); // keep the bus picked for the next child
  formError.textContent = '';
  nameInput.focus();
});

function showError(message, input) {
  formError.textContent = message;
  input.focus();
}

state.busCount = Math.max(state.busCount, minBusCount());
startWatching();
renderTracker();
renderChildren();
