// Bus Captain app.
// The Bus Captain signs in with their mobile (OTP). Their route lives at routes/{captain's +91 number}:
// school, route name, bus number, monthly fee, UPI ID, stops, trip and the bus's live location.
// Students (with their guardians' mobiles) are in routes/{captain}/students; guardians listed there
// sign in to the Guardians app by OTP and join this route. "Child not going" alerts arrive in
// routes/{captain}/notices and fee payments in routes/{captain}/payments.
// In the Android app (android/), a background service keeps sending location with the screen locked.

const B = window.Bus;
const SEND_EVERY_MS = 10000;
const SHARING_KEY = 'bus-captain.sharing';

const state = {
  fb: null,
  me: null,               // +91… of the signed-in Bus Captain
  route: null,            // routes/{me} data, or null before it exists
  routeLoaded: false,
  students: [],
  studentsLoaded: false,
  notices: [],
  payments: [],
  sharing: readSharing(),
  position: null,
  lastFix: null,          // { lat, lng, t } for working out speed when the phone doesn't give it
  speed: 0,               // m/s
  heading: null,
  battery: null,
  geoError: null,
  lastPush: 0,
  pushError: null,
  seenNotices: null,      // ids already shown, so new ones can pop up
};
const unsubs = [];
const $ = (id) => document.getElementById(id);

function readSharing() {
  try { return localStorage.getItem(SHARING_KEY) !== 'off'; } catch { return true; }
}
function saveSharing() {
  try { localStorage.setItem(SHARING_KEY, state.sharing ? 'on' : 'off'); } catch {}
}

const routeRef = () => state.fb.doc(state.fb.db, 'routes', state.me);
const sub = (name) => state.fb.collection(state.fb.db, 'routes', state.me, name);

// The route as the rest of the app sees it: saved values, plus this phone's newest fix.
function liveRoute() {
  const r = { stops: [], trip: 'pickup', ...(state.route || {}) };
  if (state.position) {
    r.location = { lat: state.position.coords.latitude, lng: state.position.coords.longitude, accuracy: state.position.coords.accuracy };
    r.speed = state.speed;
    r.heading = state.heading;
    r.fixAt = state.position.timestamp;
  }
  return r;
}

// Fields a brand new route document needs (the rules expect a guardians list).
function baseRoute() {
  return state.route ? {} : { captain: state.me, guardians: guardianList(), stops: [], trip: 'pickup', createdAt: state.fb.serverTimestamp() };
}

async function saveRoute(fields) {
  try {
    await state.fb.setDoc(routeRef(), { ...baseRoute(), ...fields }, { merge: true });
    return true;
  } catch (error) {
    console.error(error);
    B.toast(B.dbErrorText(error), 'err');
    return false;
  }
}

// ---------- Header, trip, next stop ----------
function renderHeader() {
  const r = state.route || {};
  $('school-name').textContent = r.school || 'School Bus';
  $('who').textContent = `Bus Captain · ${B.formatMobile(state.me)}`;
  $('route-chip').textContent = r.name || 'My route';
  $('plate').textContent = (r.plate || '').toUpperCase();
  $('setup-banner').hidden = !state.routeLoaded || Boolean(r.fee && r.upi && r.name);
  const live = state.sharing && state.position && !state.geoError;
  $('live-badge').textContent = live ? 'LIVE' : 'OFF';
  $('live-badge').classList.toggle('is-off', !live);
  document.querySelectorAll('#trip-seg button').forEach((b) => b.classList.toggle('is-on', b.dataset.trip === (r.trip || 'pickup')));
}

function renderNext() {
  const route = liveRoute();
  const next = B.nextStop(route);
  const live = state.sharing && state.position && !state.geoError;
  $('next-dot').classList.toggle('is-off', !live);
  const eta = $('eta');
  if (!next) {
    eta.classList.add('is-idle');
    $('eta-min').textContent = '–';
    $('next-kicker').textContent = 'Next stop';
    $('next-name').textContent = 'Add stops to see ETAs';
    $('next-sub').textContent = live ? `${B.kmh(state.speed)} km/h` : 'Waiting for GPS';
    return;
  }
  const n = (route.stops || []).findIndex((s) => s.id === next.stop.id) + 1;
  $('next-name').textContent = `${n}. ${next.stop.name}`;
  if (next.arrived) {
    $('next-kicker').textContent = 'Arrived';
    eta.classList.add('is-idle');
    $('eta-min').textContent = '0';
    $('next-sub').textContent = `Last stop of the ${B.TRIPS[route.trip].toLowerCase()}`;
  } else if (typeof next.distM === 'number' && live) {
    $('next-kicker').textContent = 'Arriving next';
    eta.classList.remove('is-idle');
    $('eta-min').textContent = String(next.minutes);
    $('next-sub').textContent = `${B.kmText(next.distM)} away • ${B.kmh(state.speed)} km/h`;
  } else {
    $('next-kicker').textContent = 'First stop';
    eta.classList.add('is-idle');
    $('eta-min').textContent = '–';
    $('next-sub').textContent = state.sharing ? 'Waiting for GPS' : 'Sharing is off';
  }
}

document.querySelectorAll('#trip-seg button').forEach((btn) => btn.addEventListener('click', () => {
  if (!state.me || (state.route && state.route.trip === btn.dataset.trip)) return;
  saveRoute({ trip: btn.dataset.trip });
  if (state.route) state.route.trip = btn.dataset.trip; // show it at once; the snapshot confirms
  renderAll();
}));

$('honk-btn').addEventListener('click', async () => {
  B.horn();
  const next = B.nextStop(liveRoute());
  const ok = await saveRoute({ honkAt: Date.now(), honkStop: next && next.stop ? next.stop.name : '' });
  if (ok) B.toast(next && next.stop ? `Honked: guardians near ${next.stop.name} get an alert` : 'Honked: guardians get an alert', 'ok');
});

$('refresh-btn').addEventListener('click', () => {
  const btn = $('refresh-btn');
  btn.classList.remove('is-spinning');
  void btn.offsetWidth;
  btn.classList.add('is-spinning');
  if (state.sharing) { stopWatching(); startWatching(); }
  pushLive(true);
  if (map) B.fitRoute(map, liveRoute());
});

// ---------- Map ----------
let map = null;
const layers = {};
let fitted = false;

function renderMap() {
  if (!map) {
    map = B.createMap('map');
    $('map-empty').hidden = Boolean(map);
    if (!map) return;
  }
  const route = liveRoute();
  B.drawRoute(map, layers, route, { onDragStop: moveStop });
  if (!fitted && ((route.stops || []).length || route.location)) { B.fitRoute(map, route); fitted = true; }

  const order = B.tripOrder(route, route.trip);
  $('chip-route').lastElementChild.textContent = order.length >= 2 ? `${order[0].name} → ${order[order.length - 1].name}` : (order[0] ? order[0].name : 'No stops yet');
  $('chip-speed').lastElementChild.textContent = `${B.kmh(state.speed)} km/h`;
  const live = state.sharing && state.position && !state.geoError;
  $('chip-gps').classList.toggle('is-off', !live);
  $('chip-gps').lastElementChild.textContent = live ? 'GPS Live' : state.sharing ? 'Finding GPS…' : 'Sharing off';
}

$('recenter').addEventListener('click', () => { if (map) B.fitRoute(map, liveRoute()); });

function moveStop(id, lat, lng) {
  const stops = (state.route.stops || []).map((s) => (s.id === id ? { ...s, lat, lng } : s));
  saveRoute({ stops });
}

// ---------- Live GPS ----------
let watchId = null;

function startWatching() {
  if (!('geolocation' in navigator)) { state.geoError = 'unsupported'; return; }
  state.geoError = null;
  watchId = navigator.geolocation.watchPosition(onFix, (error) => {
    state.geoError = error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable';
    renderLive();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}

function stopWatching() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function onFix(position) {
  const { latitude: lat, longitude: lng, speed, heading } = position.coords;
  const prev = state.lastFix;
  const MAX_MPS = 120 / 3.6; // a school bus never goes faster; anything above is GPS jitter
  if (typeof speed === 'number' && !Number.isNaN(speed)) {
    state.speed = Math.min(speed, MAX_MPS);
  } else if (prev && position.timestamp - prev.t >= 2000) {
    const metres = B.metresBetween(prev, { lat, lng });
    const raw = metres / ((position.timestamp - prev.t) / 1000);
    if (raw <= MAX_MPS) state.speed = state.speed * 0.4 + raw * 0.6; // smooth jumps between fixes
  }
  if (typeof heading === 'number' && !Number.isNaN(heading)) state.heading = heading;
  else if (prev && B.metresBetween(prev, { lat, lng }) > 15) state.heading = (Math.atan2(lng - prev.lng, lat - prev.lat) * 180) / Math.PI;
  if (!prev || position.timestamp - prev.t >= 2000) state.lastFix = { lat, lng, t: position.timestamp };
  state.position = position;
  state.geoError = null;
  renderLive();
  pushLive();
}

async function pushLive(force = false) {
  if (!state.fb || !state.me || !state.routeLoaded) return;
  const now = Date.now();
  if (!force && now - state.lastPush < SEND_EVERY_MS) return;
  state.lastPush = now;
  const fields = { sharing: state.sharing && !state.geoError, updatedAt: state.fb.serverTimestamp() };
  if (state.sharing && state.position) {
    const c = state.position.coords;
    Object.assign(fields, {
      location: { lat: c.latitude, lng: c.longitude, accuracy: Math.round(c.accuracy) },
      fixAt: state.position.timestamp,
      speed: Math.round(state.speed * 10) / 10,
      heading: state.heading === null ? null : Math.round(state.heading),
      battery: state.battery,
    });
  }
  try {
    await state.fb.setDoc(routeRef(), { ...baseRoute(), ...fields }, { merge: true });
    state.pushError = null;
  } catch (error) {
    state.pushError = error;
    console.error(error);
  }
  renderShareStats();
}

function renderShareStats() {
  $('share-btn').textContent = state.sharing ? 'Pause sharing' : 'Start sharing';
  $('share-btn').className = state.sharing ? 'secondary-btn' : 'primary-btn';
  const p = state.position;
  $('stat-updated').textContent = state.sharing && p ? B.timeAgo(p.timestamp) : '–';
  $('stat-accuracy').textContent = state.sharing && p ? `${Math.round(p.coords.accuracy)} m` : '–';
  $('stat-battery').textContent = state.battery === null ? '–' : `${state.battery}%`;
  let note = '';
  if (!state.sharing) note = 'Guardians see the bus as offline until you start sharing.';
  else if (state.geoError === 'denied') note = 'Location permission is off. Allow location for this site in your browser settings.';
  else if (state.geoError) note = 'Can\'t find the location. Check that GPS is on.';
  else if (state.pushError) note = B.dbErrorText(state.pushError);
  else if (androidApp) note = 'Sharing keeps going in the background with the screen locked.';
  else note = 'Keep this page open: phone browsers stop GPS when the screen locks.';
  $('share-note').textContent = note;
  $('share-note').className = `hint${state.pushError || state.geoError ? ' form-error' : ''}`;
}

function renderLive() {
  renderHeader();
  renderNext();
  renderMap();
  renderShareStats();
}

$('share-btn').addEventListener('click', () => {
  state.sharing = !state.sharing;
  saveSharing();
  if (state.sharing) { startWatching(); keepAwake(); } else { stopWatching(); if (wakeLock) wakeLock.release().catch(() => {}); }
  renderLive();
  pushLive(true);
  syncAndroid();
});

// Keep the screen on while sharing in a browser: phones stop web GPS once the screen locks.
let wakeLock = null;
async function keepAwake() {
  if (!state.me || !state.sharing || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  if (wakeLock && !wakeLock.released) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', keepAwake);

if (navigator.getBattery) {
  navigator.getBattery().then((battery) => {
    const show = () => { state.battery = Math.round(battery.level * 100); renderShareStats(); };
    show();
    battery.addEventListener('levelchange', show);
  }).catch(() => {});
}

setInterval(() => { if (state.me) renderShareStats(); }, 10000);

// ---------- Android app bridge ----------
// In the Android app the page hands the signed-in Bus Captain to a background service, which keeps
// sending the bus location with the screen locked (a web page can't).
const androidApp = window.BeaconAndroid || null;
$('get-app').hidden = Boolean(androidApp) || !/Android/i.test(navigator.userAgent);

function syncAndroid() {
  if (!androidApp) return;
  const user = state.fb && state.fb.auth.currentUser;
  if (user && state.sharing && state.routeLoaded) {
    const cfg = window.BUS_FIREBASE_CONFIG;
    androidApp.startTracking(JSON.stringify({
      apiKey: cfg.apiKey,
      projectId: cfg.projectId,
      collection: 'routes',
      docId: state.me,
      refreshToken: user.refreshToken,
      label: (state.route && state.route.name) || 'Bus',
    }));
  } else {
    androidApp.stopTracking();
  }
}

// ---------- Stops ----------
function renderStops() {
  const route = liveRoute();
  const stops = route.stops || [];
  $('stops-tab').textContent = `Stops (${stops.length})`;
  $('stops-empty').hidden = stops.length > 0;
  const next = B.nextStop(route);
  $('stop-list').replaceChildren(...stops.map((stop, i) => {
    const li = B.el('li', 'item');
    const st = B.stopState(route, stop.id, next);
    const num = B.el('div', `num is-${st}`, String(i + 1));
    const main = B.el('div', 'item-main');
    const title = B.el('div', 'item-title', stop.name);
    const riders = state.students.filter((s) => s.stopId === stop.id);
    const away = riders.filter((s) => isAwayToday(s.id)).length;
    if (st === 'next') title.append(B.el('span', 'tag is-amber', 'Next'));
    if (st === 'done') title.append(B.el('span', 'tag is-green', 'Done'));
    const subText = [`${riders.length} ${riders.length === 1 ? 'student' : 'students'}`];
    if (away) subText.push(`${away} not going today`);
    if (route.location && typeof stop.lat === 'number') subText.push(B.kmText(B.metresBetween(route.location, stop)));
    main.append(title, B.el('div', 'item-sub', subText.join(' · ')));
    const tools = B.el('div', 'row-between');
    const up = B.el('button', 'mini-btn', '↑');
    up.type = 'button';
    up.disabled = i === 0;
    up.setAttribute('aria-label', `Move ${stop.name} earlier`);
    up.addEventListener('click', () => moveStopOrder(i, -1));
    const del = B.el('button', 'mini-btn is-red', 'Remove');
    del.type = 'button';
    del.addEventListener('click', () => {
      if (!confirm(`Remove the stop ${stop.name}?${riders.length ? ` ${riders.length} student(s) will have no stop.` : ''}`)) return;
      saveRoute({ stops: stops.filter((s) => s.id !== stop.id) });
    });
    tools.append(up, del);
    li.append(num, main, tools);
    return li;
  }));
  renderStopSelect();
}

function moveStopOrder(i, delta) {
  const stops = [...(state.route.stops || [])];
  const [stop] = stops.splice(i, 1);
  stops.splice(i + delta, 0, stop);
  saveRoute({ stops });
}

$('stop-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('stop-name').value.trim();
  if (!name) { $('stop-error').textContent = 'Enter the stop name.'; $('stop-name').focus(); return; }
  let at = null;
  if (state.position) at = { lat: state.position.coords.latitude, lng: state.position.coords.longitude };
  else if (map) { const c = map.getCenter(); at = { lat: c.lat, lng: c.lng }; }
  if (!at) { $('stop-error').textContent = 'No GPS yet. Start sharing or wait for the map.'; return; }
  const stops = [...((state.route && state.route.stops) || []), { id: Date.now().toString(36), name, ...at }];
  if (await saveRoute({ stops })) {
    $('stop-form').reset();
    $('stop-error').textContent = '';
    B.toast(`Added ${name}${state.position ? '' : ' at the middle of the map. Drag it on the map to the right spot.'}`, 'ok');
  }
});

// ---------- Students ----------
function renderStopSelect() {
  const select = $('student-stop');
  const keep = select.value;
  const stops = (state.route && state.route.stops) || [];
  select.replaceChildren(B.el('option', '', stops.length ? 'Pick a stop' : 'Add stops first (optional)'), ...stops.map((s, i) => {
    const o = B.el('option', '', `${i + 1}. ${s.name}`);
    o.value = s.id;
    return o;
  }));
  select.firstElementChild.value = '';
  select.value = stops.some((s) => s.id === keep) ? keep : '';
}

const today = () => B.dateKey(0);
const noticeCovers = (n, trip) => n.trip === 'both' || n.trip === trip;
function isAwayToday(studentId) {
  const trip = (state.route && state.route.trip) || 'pickup';
  return state.notices.some((n) => n.studentId === studentId && n.date === today() && noticeCovers(n, trip));
}

function guardianList() {
  return [...new Set(state.students.flatMap((s) => s.family || []))].sort();
}

// Keep the route's guardians list (who may open it) in step with the students.
function syncGuardians() {
  if (!state.routeLoaded || !state.studentsLoaded || !state.route) return;
  const want = guardianList();
  const have = [...(state.route.guardians || [])].sort();
  if (want.join() !== have.join()) saveRoute({ guardians: want });
}

function renderStudents() {
  const stops = (state.route && state.route.stops) || [];
  $('students-tab').textContent = `Students${state.students.length ? ` (${state.students.length})` : ''}`;
  $('students-empty').hidden = state.students.length > 0;
  const sorted = [...state.students].sort((a, b) => {
    const ia = stops.findIndex((s) => s.id === a.stopId);
    const ib = stops.findIndex((s) => s.id === b.stopId);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.name.localeCompare(b.name);
  });
  $('student-list').replaceChildren(...sorted.map((student) => {
    const li = B.el('li', 'item');
    li.append(B.el('div', 'avatar', initials(student.name)));
    const main = B.el('div', 'item-main');
    const title = B.el('div', 'item-title', student.name);
    if (isAwayToday(student.id)) title.append(B.el('span', 'tag is-red', 'Not going today'));
    const paid = paidMonths(student.id);
    const thisMonth = B.dateKey(0).slice(0, 7);
    if (paid.received.has(thisMonth)) title.append(B.el('span', 'tag is-green', 'Fee paid'));
    else if (paid.reported.has(thisMonth)) title.append(B.el('span', 'tag is-blue', 'Fee to check'));
    const stopIndex = stops.findIndex((s) => s.id === student.stopId);
    main.append(title,
      B.el('div', 'item-sub', stopIndex >= 0 ? `Stop ${stopIndex + 1}. ${stops[stopIndex].name}` : 'No stop'),
      B.el('div', 'item-sub', (student.family || []).map(B.formatMobile).join(' · ')));
    const del = B.el('button', 'mini-btn is-red', 'Remove');
    del.type = 'button';
    del.addEventListener('click', async () => {
      if (!confirm(`Remove ${student.name}? Their guardians lose access to the route unless they have another child on it.`)) return;
      try { await state.fb.deleteDoc(state.fb.doc(sub('students'), student.id)); } catch (error) { B.toast(B.dbErrorText(error), 'err'); }
    });
    li.append(main, del);
    return li;
  }));
}

const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

$('student-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const err = $('student-error');
  const name = $('student-name').value.trim();
  const g1 = $('guardian-1').value;
  const g2 = $('guardian-2').value;
  if (!name) { err.textContent = 'Enter the child\'s name.'; return $('student-name').focus(); }
  if (!B.isValidMobile(g1)) { err.textContent = 'Guardian 1 mobile should be 10 digits starting with 6, 7, 8 or 9.'; return $('guardian-1').focus(); }
  if (g2.trim() && !B.isValidMobile(g2)) { err.textContent = 'Guardian 2 mobile should be 10 digits starting with 6, 7, 8 or 9.'; return $('guardian-2').focus(); }
  const family = [...new Set([B.e164(g1), ...(g2.trim() ? [B.e164(g2)] : [])])];
  if (family.includes(state.me)) { err.textContent = 'Use the guardians\' own numbers, not the Bus Captain\'s.'; return; }
  try {
    await state.fb.addDoc(sub('students'), { name, stopId: $('student-stop').value || null, family, createdAt: state.fb.serverTimestamp() });
    const keepStop = $('student-stop').value;
    $('student-form').reset();
    $('student-stop').value = keepStop;
    err.textContent = '';
    B.toast(`Added ${name}. Guardians can now sign in to the Guardians app.`, 'ok');
  } catch (error) {
    err.textContent = B.dbErrorText(error);
  }
});
['guardian-1', 'guardian-2'].forEach((id) => $(id).addEventListener('blur', () => {
  const input = $(id);
  if (B.isValidMobile(input.value)) input.value = B.formatMobile(input.value).slice(4);
}));

// ---------- Alerts: not going + fees ----------
function paidMonths(studentId) {
  const received = new Set();
  const reported = new Set();
  state.payments.filter((p) => p.studentId === studentId).forEach((p) => {
    if (p.status === 'received') p.months.forEach((m) => received.add(m));
    else if (p.status === 'reported') p.months.forEach((m) => reported.add(m));
  });
  return { received, reported };
}

function renderAlerts() {
  const upcoming = state.notices.filter((n) => n.date >= today())
    .sort((a, b) => a.date.localeCompare(b.date) || a.studentName.localeCompare(b.studentName));
  $('notgoing-count').textContent = upcoming.length ? String(upcoming.length) : '';
  $('notgoing-empty').hidden = upcoming.length > 0;
  $('notgoing-list').replaceChildren(...upcoming.map((n) => {
    const li = B.el('li', 'item');
    li.append(B.el('div', 'avatar', initials(n.studentName)));
    const main = B.el('div', 'item-main');
    const title = B.el('div', 'item-title', n.studentName);
    title.append(B.el('span', `tag ${n.date === today() ? 'is-red' : 'is-amber'}`, B.prettyDate(n.date)));
    const student = state.students.find((s) => s.id === n.studentId);
    const stop = student && ((state.route && state.route.stops) || []).find((s) => s.id === student.stopId);
    const bits = [`Not going: ${n.trip === 'both' ? 'pickup and drop' : B.TRIPS[n.trip].toLowerCase()}`];
    if (stop) bits.push(stop.name);
    main.append(title, B.el('div', 'item-sub', bits.join(' · ')));
    if (n.note) main.append(B.el('div', 'item-sub', `“${n.note}”`));
    main.append(B.el('div', 'item-sub', `From ${B.formatMobile(n.by)}${B.millis(n.at) ? ` · ${B.timeAgo(B.millis(n.at))}` : ''}`));
    li.append(main);
    return li;
  }));

  const payments = [...state.payments].sort((a, b) => B.millis(b.at) - B.millis(a.at));
  const toCheck = payments.filter((p) => p.status === 'reported');
  const received = payments.filter((p) => p.status === 'received').reduce((sum, p) => sum + (p.amount || 0), 0);
  $('fees-summary').textContent = toCheck.length ? `${toCheck.length} to check` : received ? `${B.inr(received)} received` : '';
  $('payments-empty').hidden = payments.length > 0;
  $('payment-list').replaceChildren(...payments.map((p) => {
    const li = B.el('li', 'item');
    li.append(B.el('div', 'avatar', '₹'));
    const main = B.el('div', 'item-main');
    const title = B.el('div', 'item-title', `${p.studentName} · ${B.inr(p.amount)}`);
    const tag = { reported: ['is-blue', 'Check'], received: ['is-green', 'Received'], rejected: ['is-red', 'Not received'] }[p.status] || ['', p.status];
    title.append(B.el('span', `tag ${tag[0]}`, tag[1]));
    main.append(title,
      B.el('div', 'item-sub', p.months.map(B.monthLabel).join(', ')),
      B.el('div', 'item-sub', `${p.ref ? `UPI ref ${p.ref} · ` : ''}${B.formatMobile(p.by)}${B.millis(p.at) ? ` · ${B.timeAgo(B.millis(p.at))}` : ''}`));
    li.append(main);
    if (p.status === 'reported') {
      const tools = B.el('div', 'tools-col');
      const ok = B.el('button', 'mini-btn is-green', 'Received');
      ok.type = 'button';
      ok.addEventListener('click', () => markPayment(p, 'received'));
      const no = B.el('button', 'mini-btn is-red', 'Not received');
      no.type = 'button';
      no.addEventListener('click', () => { if (confirm(`Mark ${B.inr(p.amount)} from ${p.studentName}'s guardian as not received? Those months show as unpaid again.`)) markPayment(p, 'rejected'); });
      tools.append(ok, no);
      li.append(tools);
    }
    return li;
  }));
  $('alerts-dot').hidden = !(upcoming.some((n) => n.date === today()) || toCheck.length);
}

async function markPayment(p, status) {
  try {
    await state.fb.updateDoc(state.fb.doc(sub('payments'), p.id), { status, checkedAt: state.fb.serverTimestamp() });
  } catch (error) {
    B.toast(B.dbErrorText(error), 'err');
  }
}

// Pop up "not going" alerts that arrive while the app is open.
function announceNotices() {
  const ids = new Set(state.notices.map((n) => n.id));
  if (state.seenNotices) {
    const fresh = state.notices.filter((n) => !state.seenNotices.has(n.id) && n.date >= today());
    if (fresh.length) {
      const n = fresh[0];
      B.toast(`${n.studentName} is not going ${B.prettyDate(n.date).toLowerCase()} (${n.trip === 'both' ? 'pickup and drop' : B.TRIPS[n.trip].toLowerCase()})`);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        try { new Notification(`${n.studentName} is not going ${B.prettyDate(n.date).toLowerCase()}`, { body: 'Child not going alert from a guardian', tag: `notice-${n.id}` }); } catch {}
      }
    }
  }
  state.seenNotices = ids;
}

// ---------- Menu and settings ----------
$('menu-btn').addEventListener('click', () => $('menu-sheet').showModal());
$('menu-settings').addEventListener('click', () => { $('menu-sheet').close(); openSettings(); });
$('setup-open').addEventListener('click', openSettings);
$('menu-signout').addEventListener('click', async () => {
  $('menu-sheet').close();
  if (!confirm(`Sign out ${B.formatMobile(state.me)}? Guardians will see the bus as offline.`)) return;
  state.sharing && await pushLive(true).catch(() => {});
  try { await state.fb.setDoc(routeRef(), { sharing: false }, { merge: true }); } catch {}
  if (androidApp) androidApp.stopTracking();
  state.fb.signOut(state.fb.auth);
});

function openSettings() {
  const r = state.route || {};
  $('set-school').value = r.school || '';
  $('set-route').value = r.name || '';
  $('set-plate').value = r.plate || '';
  $('set-fee').value = r.fee || '';
  $('set-upi').value = r.upi || '';
  $('set-payee').value = r.payee || '';
  $('settings-error').textContent = '';
  $('settings-sheet').showModal();
}
$('settings-cancel').addEventListener('click', () => $('settings-sheet').close());

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const err = $('settings-error');
  const fee = Number($('set-fee').value);
  const upi = $('set-upi').value.trim();
  if (!$('set-route').value.trim()) { err.textContent = 'Enter the route name, e.g. Route 12-B.'; return $('set-route').focus(); }
  if (!(fee > 0)) { err.textContent = 'Enter the monthly fee for this route in rupees.'; return $('set-fee').focus(); }
  if (!B.upiAddress(upi)) { err.textContent = 'Enter a UPI ID like name@okhdfcbank, or a 10-digit UPI number.'; return $('set-upi').focus(); }
  const ok = await saveRoute({
    school: $('set-school').value.trim(),
    name: $('set-route').value.trim(),
    plate: $('set-plate').value.trim().toUpperCase(),
    fee: Math.round(fee * 100) / 100,
    upi: B.isValidMobile(upi) ? B.mobileDigits(upi) : upi,
    payee: $('set-payee').value.trim(),
  });
  if (ok) { $('settings-sheet').close(); B.toast('Route saved', 'ok'); }
});

// ---------- Start ----------
function renderAll() {
  renderLive();
  renderStops();
  renderStudents();
  renderAlerts();
}

B.setupTabs((panel) => { if (panel === 'panel-live' && map) setTimeout(() => map.invalidateSize(), 0); });

function show(signedIn) {
  $('signin').hidden = signedIn;
  $('home').hidden = !signedIn;
}

function watchData() {
  const fb = state.fb;
  const fail = (error) => { console.error(error); B.toast(B.dbErrorText(error), 'err'); };
  unsubs.push(fb.onSnapshot(routeRef(), (snap) => {
    state.route = snap.exists() ? snap.data() : null;
    const first = !state.routeLoaded;
    state.routeLoaded = true;
    renderAll();
    syncGuardians();
    if (first) {
      syncAndroid();
      pushLive(true);
      if (!state.route) openSettings();
    }
  }, fail));
  unsubs.push(fb.onSnapshot(sub('students'), (snap) => {
    state.students = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    state.studentsLoaded = true;
    renderAll();
    syncGuardians();
  }, fail));
  unsubs.push(fb.onSnapshot(fb.query(sub('notices'), fb.where('date', '>=', B.dateKey(0))), (snap) => {
    state.notices = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    announceNotices();
    renderAll();
  }, fail));
  unsubs.push(fb.onSnapshot(sub('payments'), (snap) => {
    state.payments = snap.docs.map((d) => ({ id: d.id, ...d.data(), months: d.data().months || [] }));
    renderAll();
  }, fail));
}

async function start() {
  try {
    state.fb = await B.loadFirebase('bus-captain');
  } catch (error) {
    show(false);
    $('signin-status').textContent = 'Could not reach Firebase. Check your internet and refresh.';
    $('signin-status').className = 'status-line err';
    return;
  }
  B.setupSignIn(state.fb);
  state.fb.onAuthStateChanged(state.fb.auth, (user) => {
    unsubs.splice(0).forEach((u) => u());
    Object.assign(state, { me: user ? user.phoneNumber : null, route: null, routeLoaded: false, students: [], studentsLoaded: false, notices: [], payments: [], seenNotices: null, pushError: null });
    show(Boolean(state.me));
    if (!state.me) { stopWatching(); syncAndroid(); return; }
    fitted = false;
    if (state.sharing) { startWatching(); keepAwake(); }
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    renderAll();
    if (map) setTimeout(() => map.invalidateSize(), 0);
    watchData();
  });
}

start();
