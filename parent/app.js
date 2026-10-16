// Beacon (parent app).
// A parent signs in with their mobile (Firebase OTP). Children whose Beacon Go phone lists that
// number as a parent appear on the live map; Firestore pushes every new location as it arrives.

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const STALE_MS = 5 * 60 * 1000; // older than this reads as "last seen", not live

const frame = document.querySelector('.frame');
const signinSection = document.getElementById('signin');
const homeSection = document.getElementById('home');
const signOutBtn = document.getElementById('sign-out');
const signinForm = document.getElementById('signin-form');
const phoneInput = document.getElementById('phone');
const codeField = document.getElementById('code-field');
const codeInput = document.getElementById('code');
const signinStatus = document.getElementById('signin-status');
const signinBtn = document.getElementById('signin-btn');
const familyList = document.getElementById('family-list');
const familyNote = document.getElementById('family-note');
const liveDot = document.getElementById('live-dot');
const recenterBtn = document.getElementById('recenter');
const alertBox = document.getElementById('alert');
const alertTitle = document.getElementById('alert-title');
const alertSub = document.getElementById('alert-sub');
const alertsBtn = document.getElementById('alerts-btn');

let fb = null;
let confirmation = null;
let unsubscribe = null;
let me = null;          // signed-in phone number, +91…
let kids = [];          // [{ id, name, bus, location, updatedAt, ... }]
let selectedId = null;
let map = null;
let followAll = true;   // keep every child in view until the parent moves the map
const markers = new Map();
const seenPings = new Map(); // child id -> last pingAt already alerted
let alertKid = null;
const PING_FRESH_MS = 10 * 60 * 1000; // a Send older than this when the app opens is not news

// ---------- Helpers ----------
function mobileDigits(value) {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}
const isValidMobile = (value) => /^[6-9]\d{9}$/.test(mobileDigits(value));
const formatMobile = (value) => { const d = mobileDigits(value); return `+91 ${d.slice(0, 5)} ${d.slice(5)}`; };

function timeAgo(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
const firstName = (name) => name.trim().split(/\s+/)[0];

// Server time once Firestore has it; the phone's own fix time just before that.
const seenAt = (kid) => (kid.updatedAt?.toMillis ? kid.updatedAt.toMillis() : kid.fixAt || 0);
const isLive = (kid) => kid.sharing !== false && Date.now() - seenAt(kid) < STALE_MS;

const OTP_ERRORS = {
  'auth/invalid-verification-code': 'That OTP is not right. Check the SMS and try again.',
  'auth/code-expired': 'That OTP has expired. Send a new one.',
  'auth/too-many-requests': 'Too many OTP attempts from this phone. Wait a while and try again.',
  'auth/quota-exceeded': 'Today\'s SMS limit for this Firebase project is used up.',
  'auth/invalid-app-credential': 'Firebase could not check this browser (reCAPTCHA). Refresh the page and try again.',
  'auth/captcha-check-failed': 'Firebase could not check this browser (reCAPTCHA). Refresh the page and try again.',
  'auth/network-request-failed': 'No internet connection. Check your network and try again.',
  'auth/unauthorized-domain': 'This website is not in Firebase Authorized domains yet.',
};
const errorText = (error, fallback) => `${OTP_ERRORS[error?.code] || fallback}${error?.code ? ` (${error.code})` : ''}`;

// ---------- Firebase ----------
async function loadFirebase() {
  if (fb) return fb;
  const [{ initializeApp }, auth, store] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
    import(`${FIREBASE_SDK}/firebase-firestore.js`),
  ]);
  // Its own app name, so the parent's sign-in is stored apart from Beacon Go's on the same
  // site: testing both apps in one browser no longer signs the parent in as the child.
  const app = initializeApp(window.BEACON_FIREBASE_CONFIG, 'beacon-parent');
  fb = { auth: auth.getAuth(app), db: store.getFirestore(app), verifier: null, ...auth, ...store };
  return fb;
}

// reCAPTCHA can't render twice in one element, so each send gets a fresh container.
function freshVerifier() {
  try { if (fb.verifier) fb.verifier.clear(); } catch {}
  const container = document.createElement('div');
  document.getElementById('recaptcha').replaceChildren(container);
  fb.verifier = new fb.RecaptchaVerifier(fb.auth, container, { size: 'invisible' });
  return fb.verifier;
}

// ---------- Sign in ----------
function setStatus(message, kind = '') {
  signinStatus.textContent = message;
  signinStatus.className = `status-line ${kind}`;
}

phoneInput.addEventListener('input', () => {
  if (confirmation) {
    confirmation = null;
    codeField.hidden = true;
    signinBtn.textContent = 'Send OTP';
    setStatus('');
  }
});

signinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  signinBtn.disabled = true;
  try {
    if (!confirmation) {
      if (!isValidMobile(phoneInput.value)) {
        setStatus('Enter a 10-digit mobile number starting with 6, 7, 8 or 9.', 'err');
        return;
      }
      setStatus('Sending OTP…');
      await loadFirebase();
      confirmation = await fb.signInWithPhoneNumber(fb.auth, `+91${mobileDigits(phoneInput.value)}`, freshVerifier());
      codeField.hidden = false;
      codeInput.focus();
      signinBtn.textContent = 'Verify and sign in';
      setStatus(`OTP sent to ${formatMobile(phoneInput.value)}.`);
    } else {
      if (!/^\d{6}$/.test(codeInput.value.trim())) {
        setStatus('Enter the 6-digit OTP from the SMS.', 'err');
        return;
      }
      await confirmation.confirm(codeInput.value.trim()); // onAuthStateChanged shows the map
    }
  } catch (error) {
    setStatus(errorText(error, confirmation ? 'Could not sign in.' : 'Could not send the OTP.'), 'err');
    console.error(error);
  } finally {
    signinBtn.disabled = false;
  }
});

signOutBtn.addEventListener('click', () => {
  if (confirm(`Sign out ${formatMobile(me)}?`)) fb.signOut(fb.auth);
});

// ---------- Map ----------
// Returns false when the map library didn't load (offline); the family list still works.
function ensureMap() {
  if (map) return true;
  if (!window.L) return false;
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([22.5, 79], 4); // India until a child shows up
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.on('dragstart', () => { followAll = false; });
  return true;
}

function markerHtml(kid) {
  const pin = document.createElement('div');
  pin.className = `kid-pin${isLive(kid) ? '' : ' is-stale'}`;
  const halo = document.createElement('div');
  halo.className = 'kid-halo';
  const dot = document.createElement('div');
  dot.className = 'kid-dot';
  dot.textContent = initials(kid.name)[0];
  halo.append(dot);
  const label = document.createElement('div');
  label.className = 'kid-label';
  label.textContent = `${firstName(kid.name)} · ${timeAgo(seenAt(kid))}`;
  pin.append(halo, label);
  return pin.outerHTML;
}

function renderMap() {
  if (!ensureMap()) return;
  const seen = new Set();
  kids.filter((k) => k.location).forEach((kid) => {
    seen.add(kid.id);
    const at = [kid.location.lat, kid.location.lng];
    const icon = L.divIcon({ className: 'kid-marker', html: markerHtml(kid), iconSize: [0, 0] });
    let entry = markers.get(kid.id);
    if (!entry) {
      entry = {
        marker: L.marker(at, { icon, keyboard: false }).addTo(map).on('click', () => select(kid.id)),
        circle: L.circle(at, { radius: kid.location.accuracy || 0, color: '#6C4BFF', weight: 1, fillOpacity: 0.08 }).addTo(map),
      };
      markers.set(kid.id, entry);
    } else {
      entry.marker.setLatLng(at).setIcon(icon);
      entry.circle.setLatLng(at).setRadius(kid.location.accuracy || 0);
    }
  });
  markers.forEach((entry, id) => {
    if (!seen.has(id)) { entry.marker.remove(); entry.circle.remove(); markers.delete(id); }
  });
  if (selectedId && markers.has(selectedId)) {
    if (followAll) map.panTo(markers.get(selectedId).marker.getLatLng());
  } else if (followAll) {
    showAll();
  }
}

function showAll() {
  if (!map) return;
  const points = [...markers.values()].map((e) => e.marker.getLatLng());
  if (points.length === 1) map.setView(points[0], 16);
  else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 16 });
}

recenterBtn.addEventListener('click', () => {
  followAll = true;
  selectedId = null;
  showAll();
  renderList();
});

function select(id) {
  selectedId = id;
  followAll = true;
  const entry = markers.get(id);
  if (entry && map) map.setView(entry.marker.getLatLng(), Math.max(map.getZoom(), 16));
  renderList();
}

// ---------- Family list ----------
function batteryText(kid) {
  return typeof kid.battery === 'number' ? `${kid.battery}%` : '';
}

function subText(kid) {
  if (!kid.location) return 'Waiting for the first location';
  if (kid.sharing === false) return `Sharing paused · ${timeAgo(seenAt(kid))}`;
  return `${isLive(kid) ? 'Updated' : 'Last seen'} ${timeAgo(seenAt(kid))}`;
}

function renderList() {
  familyList.replaceChildren(...kids.map((kid) => {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `member${kid.id === selectedId ? ' is-selected' : ''}`;
    row.addEventListener('click', () => select(kid.id));

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(kid.name);

    const meta = document.createElement('div');
    meta.className = 'member-meta';
    const name = document.createElement('div');
    name.className = 'member-name';
    const chip = document.createElement('span');
    chip.className = 'bus-chip';
    chip.textContent = `Bus No. ${kid.bus || 1}`;
    name.append(kid.name, chip);
    const sub = document.createElement('div');
    sub.className = `member-sub${kid.sharing === false ? ' is-paused' : ''}`;
    sub.textContent = subText(kid);
    meta.append(name, sub);

    const battery = document.createElement('div');
    battery.className = 'battery';
    battery.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 10v4"/></svg>';
    battery.append(batteryText(kid));

    row.append(avatar, meta, battery);
    li.append(row);
    return li;
  }));

  liveDot.classList.toggle('is-off', !kids.some(isLive));
  liveDot.textContent = kids.some(isLive) ? 'Live' : 'Not live';
  if (!kids.length && !familyNote.classList.contains('err')) {
    familyNote.hidden = false;
    familyNote.textContent = `No child is linked to ${formatMobile(me)} yet. On your child's phone, open Beacon Go, add this number in Child Details, then tap Link phone on the Tracker tab.`;
  } else if (kids.length) {
    familyNote.hidden = true;
  }
}

const READ_ERRORS = {
  'permission-denied': 'The database rules are not published yet, so the map can\'t load. (permission-denied)',
  'not-found': 'The Firestore database has not been created yet. (not-found)',
  'failed-precondition': 'The Firestore database has not been created yet. (failed-precondition)',
};

// ---------- "Sent you their location" alerts ----------
function canNotify() {
  return 'Notification' in window && Notification.permission === 'granted';
}

function renderAlertsBtn() {
  alertsBtn.hidden = !('Notification' in window) || Notification.permission !== 'default';
}

alertsBtn.addEventListener('click', async () => {
  try { await Notification.requestPermission(); } catch {}
  renderAlertsBtn();
});

function showPing(kid) {
  alertKid = kid.id;
  const time = new Date(kid.pingAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  alertTitle.textContent = `${firstName(kid.name)} sent you their location`;
  alertSub.textContent = `Bus No. ${kid.bus || 1} · ${time}`;
  alertBox.hidden = false;
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (canNotify() && document.visibilityState !== 'visible') {
    try {
      const note = new Notification(`${firstName(kid.name)} sent you their location`, { body: `Bus No. ${kid.bus || 1} · ${time}`, tag: `ping-${kid.id}` });
      note.onclick = () => { window.focus(); select(kid.id); note.close(); };
    } catch {}
  }
}

// Alert once per new Send. On the first load only a recent Send counts.
function checkPings() {
  kids.forEach((kid) => {
    if (typeof kid.pingAt !== 'number') return;
    const seen = seenPings.get(kid.id);
    seenPings.set(kid.id, kid.pingAt);
    const isNew = seen === undefined ? Date.now() - kid.pingAt < PING_FRESH_MS : kid.pingAt > seen;
    if (isNew) showPing(kid);
  });
}

document.getElementById('alert-view').addEventListener('click', () => {
  alertBox.hidden = true;
  if (alertKid) select(alertKid);
});
document.getElementById('alert-close').addEventListener('click', () => { alertBox.hidden = true; });

function watchChildren() {
  const q = fb.query(fb.collection(fb.db, 'children'), fb.where('parents', 'array-contains', me));
  unsubscribe = fb.onSnapshot(q, (snap) => {
    kids = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
    familyNote.classList.remove('err');
    renderList();
    renderMap();
    checkPings();
  }, (error) => {
    console.error(error);
    familyNote.hidden = false;
    familyNote.classList.add('err');
    familyNote.textContent = READ_ERRORS[error.code] || `Could not load live locations (${error.code || error.message}).`;
    liveDot.classList.add('is-off');
    liveDot.textContent = 'Not live';
  });
}

// Keep "x min ago" labels fresh between updates.
setInterval(() => { if (me && kids.length) { renderList(); renderMap(); } }, 15000);

// ---------- Start ----------
function show(signedIn) {
  frame.classList.toggle('signed-out', !signedIn);
  signinSection.hidden = signedIn;
  homeSection.hidden = !signedIn;
  signOutBtn.hidden = !signedIn;
}

async function start() {
  try {
    await loadFirebase();
  } catch (error) {
    show(false);
    setStatus('Could not reach Firebase. Check your internet and refresh.', 'err');
    return;
  }
  fb.onAuthStateChanged(fb.auth, (user) => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    me = user?.phoneNumber || null;
    kids = [];
    selectedId = null;
    markers.forEach((e) => { e.marker.remove(); e.circle.remove(); });
    markers.clear();
    seenPings.clear();
    alertBox.hidden = true;
    show(Boolean(me));
    if (!me) {
      confirmation = null;
      codeField.hidden = true;
      codeInput.value = '';
      signinBtn.textContent = 'Send OTP';
      return;
    }
    signOutBtn.textContent = `${formatMobile(me)} · Sign out`;
    if (ensureMap()) map.invalidateSize();
    familyNote.classList.remove('err');
    renderAlertsBtn();
    renderList();
    watchChildren();
  });
}

start();
