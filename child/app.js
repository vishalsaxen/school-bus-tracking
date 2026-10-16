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

// Buses of the children saved on this phone, e.g. "Bus No. 3" or "Bus No. 1, 3".
function busLabel() {
  const buses = [...new Set(state.children.map((c) => c.bus || 1))].sort((a, b) => a - b);
  return `Bus No. ${buses.length ? buses.join(', ') : 1}`;
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
  busChip.textContent = busLabel();
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
const emailInput = document.getElementById('child-email');
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

// Indian mobile: 10 digits starting 6-9. Tolerates a pasted +91, 91 or 0 prefix and spaces.
function mobileDigits(value) {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function isValidMobile(value) {
  return /^[6-9]\d{9}$/.test(mobileDigits(value));
}

function formatMobile(value) {
  const d = mobileDigits(value);
  return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
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
  const extra = document.createElement('div');
  extra.className = 'child-phones';
  extra.textContent = child.email || '';
  const badge = document.createElement('span');
  badge.className = child.verified ? 'verified-badge' : '';
  badge.textContent = child.verified ? ' · OTP verified ✓' : ' · not verified';
  extra.append(badge);
  meta.append(name, phones, extra);

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
    renderTracker();
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

// ---------- OTP for parent mobiles ----------
// Real SMS OTP goes through Firebase Phone Auth once firebase-config.js is filled in.
// Without it, OTP is off and numbers are saved as "not verified".
const OTP_ENABLED = Boolean(window.BEACON_FIREBASE_CONFIG?.apiKey && window.BEACON_FIREBASE_CONFIG?.appId);
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const mobileInputs = { 1: mobile1Input, 2: mobile2Input };
const otp = { 1: { confirmation: null, verified: null }, 2: { confirmation: null, verified: null } };
let firebase = null;

async function loadFirebase() {
  if (firebase) return firebase;
  const [{ initializeApp }, authModule] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
  ]);
  const auth = authModule.getAuth(initializeApp(window.BEACON_FIREBASE_CONFIG));
  const verifier = new authModule.RecaptchaVerifier(auth, 'recaptcha', { size: 'invisible' });
  firebase = { auth, verifier, ...authModule };
  return firebase;
}

const slotEl = (selector, slot) => form.querySelector(`${selector}[data-slot="${slot}"]`);

function setOtpStatus(slot, message, kind = '') {
  const status = slotEl('.otp-status', slot);
  status.textContent = message;
  status.className = `otp-status ${kind}`;
}

function resetOtp(slot) {
  otp[slot] = { confirmation: null, verified: null };
  mobileInputs[slot].closest('.field').classList.remove('is-verified');
  slotEl('.otp-btn', slot).textContent = 'Send OTP';
  slotEl('.otp-row', slot).hidden = true;
  setOtpStatus(slot, '');
}

[1, 2].forEach((slot) => {
  mobileInputs[slot].addEventListener('input', () => {
    if (otp[slot].verified || otp[slot].confirmation) resetOtp(slot);
  });
  // The +91 is shown beside the box, so tidy a pasted "+91 98765 43210" to "98765 43210".
  mobileInputs[slot].addEventListener('blur', () => {
    const input = mobileInputs[slot];
    if (isValidMobile(input.value)) input.value = formatMobile(input.value).slice(4);
  });

  slotEl('.otp-btn', slot).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const value = mobileInputs[slot].value;
    if (!isValidMobile(value)) {
      setOtpStatus(slot, 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9.', 'err');
      return;
    }
    if (!OTP_ENABLED) {
      setOtpStatus(slot, 'OTP is not switched on yet. The number will be saved as not verified.', 'err');
      return;
    }
    button.disabled = true;
    setOtpStatus(slot, 'Sending OTP…');
    try {
      const fb = await loadFirebase();
      const phone = `+91${mobileDigits(value)}`;
      otp[slot].confirmation = await fb.signInWithPhoneNumber(fb.auth, phone, fb.verifier);
      slotEl('.otp-row', slot).hidden = false;
      slotEl('.otp-row', slot).querySelector('input').focus();
      button.textContent = 'Resend';
      setOtpStatus(slot, `OTP sent to ${formatMobile(value)}.`);
    } catch (error) {
      setOtpStatus(slot, 'Could not send the OTP. Check the number and try again.', 'err');
      console.error(error);
    } finally {
      button.disabled = false;
    }
  });

  slotEl('.verify-btn', slot).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const code = slotEl('.otp-row', slot).querySelector('input').value.trim();
    if (!/^\d{6}$/.test(code)) {
      setOtpStatus(slot, 'Enter the 6-digit OTP from the SMS.', 'err');
      return;
    }
    button.disabled = true;
    try {
      await otp[slot].confirmation.confirm(code);
      await firebase.signOut(firebase.auth); // we only needed proof of the number
      otp[slot].verified = formatMobile(mobileInputs[slot].value);
      otp[slot].confirmation = null;
      slotEl('.otp-row', slot).hidden = true;
      mobileInputs[slot].closest('.field').classList.add('is-verified');
      slotEl('.otp-btn', slot).textContent = 'Verified ✓';
      setOtpStatus(slot, 'Number verified.', 'ok');
      formError.textContent = '';
    } catch (error) {
      setOtpStatus(slot, 'That OTP is not right. Check the SMS and try again.', 'err');
    } finally {
      button.disabled = false;
    }
  });
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const bus = parseInt(busSelect.value, 10) || 1;
  const email = emailInput.value.trim();

  if (!name) return showError('Please enter the child\'s name.', nameInput);
  if (!isValidMobile(mobile1Input.value)) return showError('Mother\'s mobile should be +91 and 10 digits starting with 6, 7, 8 or 9.', mobile1Input);
  if (!isValidMobile(mobile2Input.value)) return showError('Father\'s mobile should be +91 and 10 digits starting with 6, 7, 8 or 9.', mobile2Input);
  const mobile1 = formatMobile(mobile1Input.value);
  const mobile2 = formatMobile(mobile2Input.value);
  if (mobile1 === mobile2) return showError('Please enter two different mobile numbers.', mobile2Input);
  if (!isValidEmail(email)) return showError('Please enter a valid email, like parent@example.com.', emailInput);
  if (OTP_ENABLED && otp[1].verified !== mobile1) return showError('Verify the mother\'s mobile with OTP first.', mobile1Input);
  if (OTP_ENABLED && otp[2].verified !== mobile2) return showError('Verify the father\'s mobile with OTP first.', mobile2Input);

  state.children.push({
    id: Date.now().toString(36), name, bus, mobile1, mobile2, email, verified: OTP_ENABLED,
  });
  saveChildren();
  renderChildren();
  renderTracker();
  form.reset();
  resetOtp(1);
  resetOtp(2);
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
