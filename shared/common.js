// Helpers shared by the Bus Captain app (bus-captain/) and the Guardians app (guardians/).
// Plain script, no build step: everything hangs off window.Bus.
(function () {
  const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

  // ---------- Mobile numbers (India) ----------
  // 10 digits starting 6-9. Tolerates a pasted +91, 91 or 0 prefix and spaces.
  function mobileDigits(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return digits;
  }
  const isValidMobile = (value) => /^[6-9]\d{9}$/.test(mobileDigits(value));
  const e164 = (value) => `+91${mobileDigits(value)}`;
  const formatMobile = (value) => { const d = mobileDigits(value); return `+91 ${d.slice(0, 5)} ${d.slice(5)}`; };

  // ---------- Time ----------
  function timeAgo(ms) {
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
  }
  const pad = (n) => String(n).padStart(2, '0');
  // Local calendar day, e.g. "2026-10-31".
  function dateKey(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function prettyDate(key) {
    if (key === dateKey(0)) return 'Today';
    if (key === dateKey(1)) return 'Tomorrow';
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const millis = (t) => (t && t.toMillis ? t.toMillis() : typeof t === 'number' ? t : 0);
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Indian school year: April to March. Returns [{ key: '2026-04', label: 'Apr 2026' }, …].
  function schoolYearMonths(now = new Date()) {
    const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(startYear, 3 + i, 1);
      return {
        key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
        short: d.toLocaleDateString('en-IN', { month: 'short' }),
        label: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
        current: d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(),
      };
    });
  }
  const monthLabel = (key) => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }); };

  // "Nov, Dec 2026" or "Dec 2026, Jan 2027": months grouped by year.
  function monthsText(keys) {
    const byYear = new Map();
    [...keys].sort().forEach((k) => {
      const [y, m] = k.split('-').map(Number);
      const short = new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short' });
      byYear.set(y, [...(byYear.get(y) || []), short]);
    });
    return [...byYear].map(([y, names]) => `${names.join(', ')} ${y}`).join(', ');
  }
  // The message the Bus Captain gets for a fee payment.
  const feeMessage = (p) => `${p.studentName} submitted fees of ${inr(p.amount)} for ${monthsText(p.months || [])}`;

  const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  // ---------- Distance and ETA ----------
  function metresBetween(a, b) {
    const R = 6371000;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const kmText = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);
  const kmh = (mps) => Math.round((mps || 0) * 3.6);

  // Rough minutes by road: straight line × 1.3, at the bus's speed (or 20 km/h when it's stopped).
  function etaMinutes(distM, speedMps) {
    const speed = speedMps && speedMps > 2 ? speedMps : 20 / 3.6;
    return Math.max(1, Math.ceil((distM * 1.3) / speed / 60));
  }

  // Stops in the order the bus visits them on this trip.
  function tripOrder(route, trip) {
    const stops = (route.stops || []).filter((s) => typeof s.lat === 'number');
    return trip === 'drop' ? stops.slice().reverse() : stops;
  }

  const AT_STOP_M = 80;

  // Where the bus is along the trip, worked out from its position alone (no history), so the
  // web page, the Android service and the Guardians app all agree: the bus is on the leg between
  // two stops that it is closest to, and the next stop is the end of that leg.
  // Returns { stop, index, distM, minutes, arrived } or null when there are no stops.
  function nextStop(route) {
    const order = tripOrder(route, route.trip);
    if (!order.length) return null;
    const bus = route.location;
    if (!bus) return { stop: order[0], index: 0 };
    // Flat x/y in metres around the bus is accurate enough over a bus route.
    const k = Math.cos((bus.lat * Math.PI) / 180);
    const xy = (p) => ({ x: (p.lng - bus.lng) * 111320 * k, y: (p.lat - bus.lat) * 110540 });
    let index = 0;
    if (order.length > 1) {
      let best = Infinity;
      let bestT = 0;
      for (let i = 0; i < order.length - 1; i += 1) {
        const a = xy(order[i]);
        const b = xy(order[i + 1]);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2));
        const d = Math.hypot(a.x + t * dx, a.y + t * dy);
        if (d <= best + 1) { best = d; bestT = t; index = i + 1; } // ties go to the later leg
      }
      // Still short of the first stop.
      if (index === 1 && bestT === 0 && metresBetween(bus, order[0]) > AT_STOP_M) index = 0;
    }
    let distM = metresBetween(bus, order[index]);
    // Standing at a stop: that stop is done, aim for the one after.
    if (distM <= AT_STOP_M && index < order.length - 1) {
      index += 1;
      distM = metresBetween(bus, order[index]);
    }
    const arrived = index === order.length - 1 && distM <= AT_STOP_M;
    return { stop: order[index], index, distM, minutes: arrived ? 0 : etaMinutes(distM, route.speed), arrived };
  }

  // A stop's state on this trip: 'done' (bus has been), 'next' or 'ahead'.
  function stopState(route, stopId, next = nextStop(route)) {
    if (!next) return 'ahead';
    const order = tripOrder(route, route.trip);
    const i = order.findIndex((s) => s.id === stopId);
    if (i < next.index || (next.arrived && i === next.index)) return 'done';
    return i === next.index ? 'next' : 'ahead';
  }

  const TRIPS = { pickup: 'Morning Pickup', drop: 'Afternoon Drop', both: 'Pickup and drop' };
  const STALE_MS = 3 * 60 * 1000;
  const seenAt = (route) => millis(route.updatedAt) || route.fixAt || 0;
  const isLive = (route) => route.sharing !== false && !!route.location && Date.now() - seenAt(route) < STALE_MS;

  // ---------- UPI ----------
  // A UPI ID like name@bank, or a 10-digit UPI number (paid through the NPCI mapper, number@upi).
  function upiAddress(value) {
    const v = String(value || '').trim();
    if (/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(v)) return v;
    if (isValidMobile(v)) return `${mobileDigits(v)}@upi`;
    return null;
  }
  function upiLink({ upi, payee, amount, note }) {
    const params = new URLSearchParams({ pa: upiAddress(upi), pn: payee || 'School transport', am: Number(amount).toFixed(2), cu: 'INR', tn: note });
    return `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
  }

  // ---------- Firebase ----------
  const firebaseReady = Boolean(window.BUS_FIREBASE_CONFIG && window.BUS_FIREBASE_CONFIG.apiKey);
  // Each app uses its own Firebase app name, so its sign-in is kept apart from the other app
  // on the same site (testing both in one browser doesn't mix up who is signed in).
  async function loadFirebase(appName) {
    const [{ initializeApp }, auth, store] = await Promise.all([
      import(`${FIREBASE_SDK}/firebase-app.js`),
      import(`${FIREBASE_SDK}/firebase-auth.js`),
      import(`${FIREBASE_SDK}/firebase-firestore.js`),
    ]);
    const app = initializeApp(window.BUS_FIREBASE_CONFIG, appName);
    const fb = { auth: auth.getAuth(app), db: store.getFirestore(app), verifier: null, ...auth, ...store };
    // Local testing against the Firebase emulators: open http://localhost:…/bus-captain/?emulator
    if (location.hostname === 'localhost' && new URLSearchParams(location.search).has('emulator')) {
      auth.connectAuthEmulator(fb.auth, 'http://localhost:9099', { disableWarnings: true });
      store.connectFirestoreEmulator(fb.db, 'localhost', 8080);
    }
    return fb;
  }

  const OTP_ERRORS = {
    'auth/invalid-verification-code': 'That OTP is not right. Check the SMS and try again.',
    'auth/code-expired': 'That OTP has expired. Send a new one.',
    'auth/operation-not-allowed': 'Phone sign-in is not turned on in Firebase (Authentication > Sign-in method > Phone).',
    'auth/billing-not-enabled': 'Firebase needs the Blaze plan before it can send SMS.',
    'auth/too-many-requests': 'Too many OTP attempts from this phone. Wait a while and try again.',
    'auth/quota-exceeded': 'Today\'s SMS limit for this Firebase project is used up.',
    'auth/invalid-app-credential': 'Firebase could not check this browser (reCAPTCHA). Refresh the page and try again.',
    'auth/captcha-check-failed': 'Firebase could not check this browser (reCAPTCHA). Refresh the page and try again.',
    'auth/network-request-failed': 'No internet connection. Check your network and try again.',
    'auth/unauthorized-domain': 'This website is not in Firebase Authorized domains yet.',
    'auth/invalid-phone-number': 'Firebase says this mobile number is not valid.',
  };
  const errorText = (error, fallback) => `${OTP_ERRORS[error && error.code] || fallback}${error && error.code ? ` (${error.code})` : ''}`;

  const DB_ERRORS = {
    'permission-denied': 'The database rules are out of date. Publish firestore.rules in the Firebase console.',
    'not-found': 'The Firestore database has not been created yet.',
    'failed-precondition': 'The Firestore database has not been created yet.',
    unavailable: 'Offline. Will retry when the connection is back.',
  };
  const dbErrorText = (error) => `${DB_ERRORS[error && error.code] || 'Something went wrong.'}${error && error.code ? ` (${error.code})` : ''}`;

  // Wires the shared OTP sign-in form (see the #signin markup in each app).
  function setupSignIn(fb) {
    const form = document.getElementById('signin-form');
    const phone = document.getElementById('phone');
    const codeField = document.getElementById('code-field');
    const code = document.getElementById('code');
    const status = document.getElementById('signin-status');
    const btn = document.getElementById('signin-btn');
    let confirmation = null;
    const setStatus = (msg, kind = '') => { status.textContent = msg; status.className = `status-line ${kind}`; };

    function reset() {
      confirmation = null;
      codeField.hidden = true;
      code.value = '';
      btn.textContent = 'Send OTP';
      setStatus('');
    }
    phone.addEventListener('input', () => { if (confirmation) reset(); });

    function freshVerifier() {
      try { if (fb.verifier) fb.verifier.clear(); } catch {}
      const holder = document.createElement('div');
      document.getElementById('recaptcha').replaceChildren(holder);
      fb.verifier = new fb.RecaptchaVerifier(fb.auth, holder, { size: 'invisible' });
      return fb.verifier;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      btn.disabled = true;
      try {
        if (!confirmation) {
          if (!isValidMobile(phone.value)) return setStatus('Enter a 10-digit mobile number starting with 6, 7, 8 or 9.', 'err');
          setStatus('Sending OTP…');
          confirmation = await fb.signInWithPhoneNumber(fb.auth, e164(phone.value), freshVerifier());
          codeField.hidden = false;
          code.focus();
          btn.textContent = 'Verify and sign in';
          setStatus(`OTP sent to ${formatMobile(phone.value)}.`);
        } else {
          if (!/^\d{6}$/.test(code.value.trim())) return setStatus('Enter the 6-digit OTP from the SMS.', 'err');
          await confirmation.confirm(code.value.trim()); // onAuthStateChanged takes over
          reset();
        }
      } catch (error) {
        setStatus(errorText(error, confirmation ? 'Could not sign in.' : 'Could not send the OTP.'), 'err');
        console.error(error);
      } finally {
        btn.disabled = false;
      }
    });
    phone.addEventListener('blur', () => { if (isValidMobile(phone.value)) phone.value = formatMobile(phone.value).slice(4); });
    return { reset, setStatus };
  }

  // ---------- UI bits ----------
  let toastTimer = null;
  function toast(message, kind = '') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  function setupTabs(onChange) {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach((tab) => tab.addEventListener('click', () => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle('is-on', on);
        t.setAttribute('aria-selected', String(on));
        document.getElementById(t.dataset.panel).hidden = !on;
      });
      if (onChange) onChange(tab.dataset.panel);
    }));
  }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };

  // A short two-tone horn, made in the browser so no sound file is needed.
  function horn() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      [0, 0.45].forEach((start) => {
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + 0.35);
        gain.connect(ctx.destination);
        [370, 466].forEach((f) => {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = f;
          osc.connect(gain);
          osc.start(ctx.currentTime + start);
          osc.stop(ctx.currentTime + start + 0.36);
        });
      });
      setTimeout(() => ctx.close(), 1200);
    } catch {}
    if (navigator.vibrate) navigator.vibrate([300, 120, 300]);
  }

  // ---------- Map (Leaflet) ----------
  const STOP_COLORS = { done: '#22c55e', next: '#ffa41b', ahead: '#3b82f6' };

  function createMap(elementId) {
    if (!window.L) return null;
    const map = L.map(elementId, { zoomControl: false, attributionControl: true }).setView([22.5, 79], 4);
    // OpenStreetMap's own tiles need no API key; CSS (theme.css) turns them dark to match the app.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'dark-tiles',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    return map;
  }

  function stopIcon(number, state, label) {
    const html = `<div class="stop-pin is-${state}"><span class="stop-num">${number}</span><span class="stop-label"></span></div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    wrap.querySelector('.stop-label').textContent = label;
    return L.divIcon({ className: 'stop-marker', html: wrap.innerHTML, iconSize: [0, 0] });
  }

  function busIcon(heading) {
    const rot = typeof heading === 'number' && !Number.isNaN(heading) ? heading : 0;
    return L.divIcon({
      className: 'bus-marker',
      iconSize: [0, 0],
      html: `<div class="bus-pin"><div class="bus-halo"></div><div class="bus-dot"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 18v2M16 18v2"/><circle cx="8" cy="14.5" r="1"/><circle cx="16" cy="14.5" r="1"/></svg></div><div class="bus-arrow" style="transform: rotate(${rot}deg)"></div></div>`,
    });
  }

  // Draws stops, the line between them and the bus. Keeps layers between calls.
  function drawRoute(map, layers, route, opts = {}) {
    if (!map) return;
    layers.group = layers.group || L.layerGroup().addTo(map);
    layers.group.clearLayers();
    const stops = (route.stops || []).filter((s) => typeof s.lat === 'number');
    const ordered = tripOrder(route, route.trip);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const state = stopState(route, ordered[i + 1].id);
      L.polyline([[ordered[i].lat, ordered[i].lng], [ordered[i + 1].lat, ordered[i + 1].lng]], {
        color: STOP_COLORS[state === 'done' ? 'done' : state === 'next' ? 'next' : 'ahead'],
        weight: 5, opacity: 0.85, lineCap: 'round',
      }).addTo(layers.group);
    }
    stops.forEach((s) => {
      const number = (route.stops || []).findIndex((x) => x.id === s.id) + 1;
      const mine = opts.myStopIds && opts.myStopIds.includes(s.id);
      const marker = L.marker([s.lat, s.lng], {
        icon: stopIcon(number, `${stopState(route, s.id)}${mine ? ' is-mine' : ''}`, mine ? `${s.name} (Your stop)` : s.name),
        draggable: Boolean(opts.onDragStop),
        keyboard: false,
      }).addTo(layers.group);
      if (opts.onDragStop) marker.on('dragend', () => { const p = marker.getLatLng(); opts.onDragStop(s.id, p.lat, p.lng); });
    });
    if (route.location) {
      L.marker([route.location.lat, route.location.lng], { icon: busIcon(route.heading), keyboard: false, zIndexOffset: 1000 }).addTo(layers.group);
    }
  }

  function fitRoute(map, route) {
    if (!map) return;
    const points = (route.stops || []).filter((s) => typeof s.lat === 'number').map((s) => [s.lat, s.lng]);
    if (route.location) points.push([route.location.lat, route.location.lng]);
    if (points.length === 1) map.setView(points[0], 16);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 16 });
  }

  window.Bus = {
    mobileDigits, isValidMobile, e164, formatMobile,
    timeAgo, dateKey, prettyDate, millis, clock, schoolYearMonths, monthLabel, monthsText, feeMessage, inr,
    metresBetween, kmText, kmh, etaMinutes, tripOrder, nextStop, stopState, TRIPS, seenAt, isLive,
    upiAddress, upiLink,
    firebaseReady, loadFirebase, errorText, dbErrorText, setupSignIn,
    toast, setupTabs, el, horn,
    createMap, drawRoute, fitRoute,
  };
})();
