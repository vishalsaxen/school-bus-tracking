// Beacon Go (child app).
// Uses the phone's live GPS while sharing is on. Once this phone is linked to a child (OTP to the
// child's mobile), each fix is saved to Firebase so the parent app (Beacon) shows it live.
// In the Android app (android/), a background service keeps sending with the screen locked.
// "Send" pushes the location now and alerts the parents in Beacon; an unlinked phone can still text a map link.
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
  battery: null,    // 0-100 where the browser reports it
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
      pushLive();
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
  pushLive(true); // tell parents right away that sharing paused or resumed
  if (state.sharing) keepAwake(); else if (wakeLock) wakeLock.release().catch(() => {});
  syncAndroid();
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

const toast = document.getElementById('toast');
let toastTimer = null;

function showToast(message, kind = '') {
  toast.textContent = message;
  toast.className = `toast ${kind}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

// Send: on a linked phone, push the location to Beacon now and flag it so parents get an alert.
// Otherwise offer to link the phone, or text a map link as before.
sendBtn.addEventListener('click', async () => {
  if (!state.position) return;
  if (state.children.length === 0) {
    alert('Add your name and your parents\' mobile numbers in Child Details first.');
    document.getElementById('tab-children').click();
    return;
  }
  if (live.user && live.child) {
    sendBtn.disabled = true;
    await pushLive(true, true);
    sendBtn.disabled = false;
    if (live.error) showToast(`Not sent: ${LIVE_ERRORS[live.error.code] || live.error.code || 'try again'}`, 'err');
    else showToast(`Sent ✓ ${firstNameOf(live.child.name)}'s parents can see it in Beacon now`, 'ok');
    return;
  }
  document.getElementById('send-link').hidden = !OTP_ENABLED;
  sendDialog.querySelector('.sheet-or').hidden = !OTP_ENABLED;
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

document.getElementById('send-link').addEventListener('click', () => {
  sendDialog.close();
  openLinkDialog();
});

// Show the real battery level where the browser supports it; keep the mockup value otherwise.
if (navigator.getBattery) {
  navigator.getBattery().then((battery) => {
    const show = () => {
      state.battery = Math.round(battery.level * 100);
      batteryValue.textContent = `${state.battery}%`;
    };
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
const childPhoneInput = document.getElementById('child-phone');
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
  phones.textContent = `Parents ${child.mobile1} · ${child.mobile2}`;
  const own = document.createElement('div');
  own.className = 'child-phones';
  own.textContent = child.childMobile ? `Child's phone ${child.childMobile}` : 'Child\'s phone not added';
  const extra = document.createElement('div');
  extra.className = 'child-phones';
  extra.textContent = child.email || '';
  const badge = document.createElement('span');
  badge.className = child.verified ? 'verified-badge' : '';
  badge.textContent = child.verified ? ' · OTP verified ✓' : ' · not verified';
  extra.append(badge);
  meta.append(name, own, phones, extra);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-btn';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', `Remove ${child.name}`);
  remove.addEventListener('click', () => {
    if (!confirm(`Remove ${child.name}? Use this when a child leaves the school.`)) return;
    if (live.child && live.child.id === child.id) unlinkPhone();
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
let firebase = null;  // used only to check parent numbers, then signed out
let liveFb = null;    // stays signed in as the child's number to send live location
let sdk = null;

function loadSdk() {
  sdk = sdk || Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
    import(`${FIREBASE_SDK}/firebase-firestore.js`),
  ]);
  return sdk;
}

// Parent numbers are checked on their own Firebase app, so verifying them never signs out
// the child's live session on this phone.
async function loadFirebase() {
  if (firebase) return firebase;
  const [{ initializeApp }, authModule] = await loadSdk();
  const auth = authModule.getAuth(initializeApp(window.BEACON_FIREBASE_CONFIG, 'verify-parents'));
  firebase = { auth, verifier: null, ...authModule };
  return firebase;
}

async function loadLiveFirebase() {
  if (liveFb) return liveFb;
  const [{ initializeApp }, authModule, store] = await loadSdk();
  const app = initializeApp(window.BEACON_FIREBASE_CONFIG);
  liveFb = { auth: authModule.getAuth(app), db: store.getFirestore(app), verifier: null, ...authModule, ...store };
  return liveFb;
}

// A reCAPTCHA verifier can't be reused after a failed send, so make a fresh one each time.
// Each one gets its own new container, since reCAPTCHA refuses to render twice in one element.
function freshVerifier(fb, holderId = 'recaptcha') {
  try {
    if (fb.verifier) fb.verifier.clear();
  } catch {
    // Already cleared or never rendered; a new one replaces it below.
  }
  const holder = document.getElementById(holderId);
  const container = document.createElement('div');
  holder.replaceChildren(container);
  fb.verifier = new fb.RecaptchaVerifier(fb.auth, container, { size: 'invisible' });
  return fb.verifier;
}

// Plain-language reasons for the Firebase errors parents are most likely to hit.
const OTP_ERRORS = {
  'auth/operation-not-allowed': 'Phone sign-in is not turned on in Firebase (Authentication > Sign-in method > Phone).',
  'auth/billing-not-enabled': 'Firebase needs billing (Blaze plan) turned on before it can send SMS.',
  'auth/unauthorized-domain': 'This website is not in Firebase Authorized domains yet.',
  'auth/invalid-app-credential': 'Firebase could not check this browser (reCAPTCHA). Refresh the page and try again.',
  'auth/captcha-check-failed': 'Firebase could not check this browser (reCAPTCHA). Refresh the page and try again.',
  'auth/too-many-requests': 'Too many OTP attempts from this phone. Wait a while and try again.',
  'auth/quota-exceeded': 'Today\'s SMS limit for this Firebase project is used up.',
  'auth/invalid-phone-number': 'Firebase says this mobile number is not valid.',
  'auth/network-request-failed': 'No internet connection. Check your network and try again.',
};

function otpErrorMessage(error) {
  const code = error && error.code;
  if (code) return `${OTP_ERRORS[code] || 'Could not send the OTP.'} (${code})`;
  return `Could not send the OTP.${error && error.message ? ` (${error.message})` : ''}`;
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
    const other = slot === 1 ? 2 : 1;
    if (isValidMobile(mobileInputs[other].value) && mobileDigits(mobileInputs[other].value) === mobileDigits(value)) {
      setOtpStatus(slot, 'Use a different number from the other parent.', 'err');
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
      otp[slot].confirmation = await fb.signInWithPhoneNumber(fb.auth, phone, freshVerifier(fb));
      slotEl('.otp-row', slot).hidden = false;
      slotEl('.otp-row', slot).querySelector('input').focus();
      button.textContent = 'Resend';
      setOtpStatus(slot, `OTP sent to ${formatMobile(value)}.`);
    } catch (error) {
      setOtpStatus(slot, otpErrorMessage(error), 'err');
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

childPhoneInput.addEventListener('blur', () => {
  if (isValidMobile(childPhoneInput.value)) childPhoneInput.value = formatMobile(childPhoneInput.value).slice(4);
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const bus = parseInt(busSelect.value, 10) || 1;
  const email = emailInput.value.trim();

  if (!name) return showError('Please enter the child\'s name.', nameInput);
  if (!isValidMobile(childPhoneInput.value)) return showError('Child\'s mobile should be +91 and 10 digits starting with 6, 7, 8 or 9.', childPhoneInput);
  const childMobile = formatMobile(childPhoneInput.value);
  if (!isValidMobile(mobile1Input.value)) return showError('Mother\'s mobile should be +91 and 10 digits starting with 6, 7, 8 or 9.', mobile1Input);
  if (!isValidMobile(mobile2Input.value)) return showError('Father\'s mobile should be +91 and 10 digits starting with 6, 7, 8 or 9.', mobile2Input);
  const mobile1 = formatMobile(mobile1Input.value);
  const mobile2 = formatMobile(mobile2Input.value);
  if (mobile1 === mobile2) return showError('Please enter two different mobile numbers.', mobile2Input);
  if (childMobile === mobile1 || childMobile === mobile2) return showError('The child\'s mobile should be different from the parents\' numbers.', childPhoneInput);
  if (!isValidEmail(email)) return showError('Please enter a valid email, like parent@example.com.', emailInput);
  if (OTP_ENABLED && otp[1].verified !== mobile1) return showError('Verify the mother\'s mobile with OTP first.', mobile1Input);
  if (OTP_ENABLED && otp[2].verified !== mobile2) return showError('Verify the father\'s mobile with OTP first.', mobile2Input);

  state.children.push({
    id: Date.now().toString(36), name, bus, childMobile, mobile1, mobile2, email, verified: OTP_ENABLED,
  });
  saveChildren();
  renderChildren();
  renderTracker();
  if (!live.child) live.child = childForPhone(live.user?.phoneNumber);
  renderLive();
  pushLive(true);
  syncAndroid();
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

// ---------- Live to parents (Firebase) ----------
// This phone signs in with the child's own number (OTP) and keeps one document per child at
// children/{child's +91 number}: name, bus, both parents' numbers and the latest location.
// The parent app reads it live; firestore.rules lets only those two parents see it.
const SEND_EVERY_MS = 10000;
const liveRow = document.getElementById('live-row');
const liveText = document.getElementById('live-text');
const liveBtn = document.getElementById('live-btn');
const linkDialog = document.getElementById('link-dialog');
const linkOptions = document.getElementById('link-options');
const linkOtp = document.getElementById('link-otp');
const linkCode = document.getElementById('link-code');
const linkVerify = document.getElementById('link-verify');
const linkStatus = document.getElementById('link-status');

const live = { user: null, child: null, lastTry: 0, sentAt: 0, error: null, confirmation: null };
let wakeLock = null;

const e164 = (mobile) => `+91${mobileDigits(mobile)}`;

function childForPhone(phoneNumber) {
  if (!phoneNumber) return null;
  return state.children.find((c) => c.childMobile && e164(c.childMobile) === phoneNumber) || null;
}

const LIVE_ERRORS = {
  'permission-denied': 'Blocked: publish the database rules',
  'not-found': 'Create the Firestore database first',
  'failed-precondition': 'Create the Firestore database first',
  unavailable: 'Offline, will retry',
};

function renderLive() {
  liveRow.hidden = !OTP_ENABLED;
  const linked = Boolean(live.user);
  liveBtn.textContent = linked ? 'Unlink' : 'Link phone';
  liveBtn.classList.toggle('is-linked', linked);
  let text = 'Off';
  let kind = '';
  if (linked && !live.child) {
    text = `${formatMobile(live.user.phoneNumber)} isn't in Child Details`;
    kind = 'err';
  } else if (linked && live.error) {
    text = LIVE_ERRORS[live.error.code] || `Not sent (${live.error.code || 'error'})`;
    kind = 'err';
  } else if (linked && !state.sharing) {
    text = `${live.child.name.split(' ')[0]} · paused`;
  } else if (linked && live.sentAt) {
    text = `${live.child.name.split(' ')[0]} · sent ${timeAgo(live.sentAt)}`;
    kind = 'ok';
  } else if (linked) {
    text = `${live.child.name.split(' ')[0]} · waiting for GPS`;
  }
  liveText.textContent = text;
  liveText.className = `live-text ${kind}`;
}

const firstNameOf = (name) => name.trim().split(/\s+/)[0];

// ping: the child tapped Send, so parents get an alert as well as the map update.
async function pushLive(force = false, ping = false) {
  if (!live.user || !live.child || !state.position || !liveFb) return;
  const now = Date.now();
  if (!force && now - live.lastTry < SEND_EVERY_MS) return;
  live.lastTry = now;
  const { child } = live;
  const { latitude, longitude, accuracy } = state.position.coords;
  try {
    await liveFb.setDoc(liveFb.doc(liveFb.db, 'children', live.user.phoneNumber), {
      name: child.name,
      bus: child.bus || 1,
      parents: [e164(child.mobile1), e164(child.mobile2)],
      sharing: state.sharing && !state.geoError,
      location: { lat: latitude, lng: longitude, accuracy: Math.round(accuracy) },
      fixAt: state.position.timestamp,
      battery: state.battery,
      updatedAt: liveFb.serverTimestamp(),
      ...(ping ? { pingAt: Date.now() } : {}),
    }, { merge: true }); // merge keeps the last pingAt between regular updates
    live.sentAt = Date.now();
    live.error = null;
  } catch (error) {
    live.error = error;
    console.error(error);
  }
  renderLive();
}

// While live, keep the screen awake: phones stop web-page GPS once the screen locks.
async function keepAwake() {
  const want = live.user && state.sharing && document.visibilityState === 'visible';
  if (!want || !('wakeLock' in navigator)) return;
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Not allowed right now (battery saver); GPS still runs while the page is on screen.
  }
}
document.addEventListener('visibilitychange', keepAwake);

async function unlinkPhone() {
  if (!liveFb || !live.user) return;
  try {
    // Leave the parents a clear "sharing off" before this phone stops sending.
    await liveFb.setDoc(liveFb.doc(liveFb.db, 'children', live.user.phoneNumber), { sharing: false, updatedAt: liveFb.serverTimestamp() }, { merge: true });
  } catch {}
  await liveFb.signOut(liveFb.auth);
  if (wakeLock) wakeLock.release().catch(() => {});
}

function setLinkStatus(message, kind = '') {
  linkStatus.textContent = message;
  linkStatus.className = `otp-status ${kind}`;
}

function openLinkDialog() {
  const ready = state.children.filter((c) => c.childMobile);
  live.confirmation = null;
  linkOtp.hidden = true;
  linkCode.value = '';
  setLinkStatus(ready.length ? '' : 'Add the child with their own mobile in Child Details first.', ready.length ? '' : 'err');
  linkOptions.replaceChildren(...ready.map((child) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'sheet-option';
    const name = document.createElement('strong');
    name.textContent = child.name;
    const phone = document.createElement('span');
    phone.textContent = `${child.childMobile} · Bus No. ${child.bus || 1}`;
    option.append(name, phone);
    option.addEventListener('click', () => sendLinkOtp(child, option));
    return option;
  }));
  linkDialog.showModal();
}

async function sendLinkOtp(child, option) {
  linkOptions.querySelectorAll('button').forEach((b) => { b.disabled = true; b.classList.toggle('is-picked', b === option); });
  setLinkStatus(`Sending OTP to ${child.childMobile}…`);
  try {
    const fb = await loadLiveFirebase();
    live.confirmation = await fb.signInWithPhoneNumber(fb.auth, e164(child.childMobile), freshVerifier(fb, 'link-recaptcha'));
    linkOtp.hidden = false;
    linkCode.focus();
    setLinkStatus(`OTP sent to ${child.childMobile}.`);
  } catch (error) {
    setLinkStatus(otpErrorMessage(error), 'err');
    console.error(error);
  } finally {
    linkOptions.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

linkVerify.addEventListener('click', async () => {
  const code = linkCode.value.trim();
  if (!/^\d{6}$/.test(code)) {
    setLinkStatus('Enter the 6-digit OTP from the SMS.', 'err');
    return;
  }
  linkVerify.disabled = true;
  try {
    await live.confirmation.confirm(code); // onAuthStateChanged takes it from here
    linkDialog.close();
  } catch {
    setLinkStatus('That OTP is not right. Check the SMS and try again.', 'err');
  } finally {
    linkVerify.disabled = false;
  }
});

liveBtn.addEventListener('click', () => {
  if (!live.user) {
    openLinkDialog();
  } else if (confirm('Stop sending live location from this phone? Parents will see sharing as off.')) {
    unlinkPhone();
  }
});

// In the Android app, hand the signed-in child to the app's background service, which keeps
// sending location with the screen locked (a web page can't).
const androidApp = window.BeaconAndroid || null;

function syncAndroid() {
  if (!androidApp) return;
  if (live.user && live.child && state.sharing) {
    const cfg = window.BEACON_FIREBASE_CONFIG;
    androidApp.startTracking(JSON.stringify({
      apiKey: cfg.apiKey,
      projectId: cfg.projectId,
      docId: live.user.phoneNumber,
      refreshToken: live.user.refreshToken,
      name: live.child.name,
      bus: live.child.bus || 1,
      parents: [e164(live.child.mobile1), e164(live.child.mobile2)],
    }));
  } else {
    androidApp.stopTracking();
  }
}

// On an Android phone in the browser, point to the app so sharing survives a locked screen.
const getApp = document.getElementById('get-app');
getApp.hidden = Boolean(androidApp) || !/Android/i.test(navigator.userAgent);

async function startLive() {
  renderLive();
  if (!OTP_ENABLED) return;
  try {
    const fb = await loadLiveFirebase();
    fb.onAuthStateChanged(fb.auth, (user) => {
      live.user = user;
      live.child = childForPhone(user?.phoneNumber);
      live.sentAt = 0;
      live.error = null;
      renderLive();
      keepAwake();
      pushLive(true);
      syncAndroid();
    });
  } catch (error) {
    console.error(error); // offline or SDK blocked; the rest of the app still works
  }
}

setInterval(renderLive, 10000);

state.busCount = Math.max(state.busCount, minBusCount());
startWatching();
renderTracker();
renderChildren();
startLive();
