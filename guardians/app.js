// Guardians app.
// A guardian signs in with their mobile (OTP). Every route whose Bus Captain listed that number for
// a student shows up here: the bus live on a map with an ETA to their stop, the stops, their
// child, transport fee payment by UPI (tick the months, then Pay fee) and a "Child not going"
// button that alerts the Bus Captain.
// Data: routes/{captain}, with students, notices and payments under it (see firestore.rules).

const B = window.Bus;
const ROUTE_KEY = 'guardians.route';
const ALERTS_SEEN_KEY = 'guardians.alertsSeen';
const HONK_FRESH_MS = 10 * 60 * 1000;

const state = {
  fb: null,
  me: null,
  routes: [],
  routeId: null,
  kids: [],
  notices: [],
  payments: [],
  feeKid: null,
  checked: new Set(),
  pendingPay: null,
  seenHonk: null,
  tab: 'panel-live',
};
let routeUnsub = null;
const routeUnsubs = [];
const $ = (id) => document.getElementById(id);
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

const route = () => state.routes.find((r) => r.id === state.routeId) || null;
const sub = (name) => state.fb.collection(state.fb.db, 'routes', state.routeId, name);
const firstName = (name) => name.trim().split(/\s+/)[0];
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
const today = () => B.dateKey(0);
const stopOf = (kid) => ((route() && route().stops) || []).find((s) => s.id === kid.stopId) || null;
const stopNumber = (stop) => ((route() && route().stops) || []).findIndex((s) => s.id === stop.id) + 1;
const tripText = (trip) => (trip === 'both' ? 'pickup and drop' : B.TRIPS[trip].toLowerCase());

function noticeFor(kidId, date, trip) {
  return state.notices.find((n) => n.studentId === kidId && n.date === date && (n.trip === 'both' || n.trip === trip));
}

// ---------- Header and ETA card ----------
function renderHeader() {
  const r = route();
  $('school-name').textContent = r.school || 'School Bus';
  $('who').textContent = `Guardian · ${B.formatMobile(state.me)}`;
  $('route-chip').textContent = r.name || 'Route';
  $('plate').textContent = (r.plate || '').toUpperCase();
  const live = B.isLive(r);
  $('live-badge').textContent = live ? 'LIVE' : 'OFFLINE';
  $('live-badge').classList.toggle('is-off', !live);
  document.querySelectorAll('#trip-seg button').forEach((b) => b.classList.toggle('is-on', b.dataset.trip === (r.trip || 'pickup')));

  const trip = r.trip || 'pickup';
  const away = state.kids.length && state.kids.every((k) => noticeFor(k.id, today(), trip));
  $('notgoing-label').textContent = away ? 'Not going ✓' : 'Not Going';
  $('notgoing-btn').classList.toggle('is-done', Boolean(away));
  $('notgoing-btn').classList.toggle('is-danger', !away);
}

function renderEta() {
  const r = route();
  const live = B.isLive(r);
  $('next-dot').classList.toggle('is-off', !live);
  const eta = $('eta');
  const idle = (kicker, name, subText) => {
    eta.classList.add('is-idle');
    $('eta-min').textContent = '–';
    $('next-kicker').textContent = kicker;
    $('next-name').textContent = name;
    $('next-sub').textContent = subText;
  };
  const seen = B.seenAt(r);
  if (!r.location) return idle('Bus location', 'Waiting for the bus', 'The Bus Captain hasn\'t started sharing yet');
  if (!live) return idle('Bus location', r.sharing === false ? 'Bus is not sharing now' : 'Bus signal lost', seen ? `Last seen ${B.timeAgo(seen)}` : '');

  const next = B.nextStop(r);
  const speedText = `${B.kmh(r.speed)} km/h`;
  const myStops = state.kids.map(stopOf).filter((s) => s && typeof s.lat === 'number');
  const order = B.tripOrder(r, r.trip);
  // The guardian's stop that the bus reaches first and hasn't passed yet.
  const mine = myStops
    .map((s) => ({ stop: s, i: order.findIndex((o) => o.id === s.id) }))
    .filter((m) => next && m.i >= next.index && !(next.arrived && m.i === next.index))
    .sort((a, b) => a.i - b.i)[0];

  if (mine) {
    const dist = B.metresBetween(r.location, mine.stop);
    const before = mine.i - next.index;
    eta.classList.remove('is-idle');
    $('eta-min').textContent = String(B.etaMinutes(dist, r.speed));
    $('next-kicker').textContent = before === 0 ? 'Arriving next' : `Your stop · ${before} ${before === 1 ? 'stop' : 'stops'} before`;
    $('next-name').textContent = `${mine.stop.name} (Your stop)`;
    $('next-sub').textContent = `${B.kmText(dist)} away • ${speedText}`;
  } else if (next && typeof next.distM === 'number' && !next.arrived) {
    eta.classList.remove('is-idle');
    $('eta-min').textContent = String(next.minutes);
    $('next-kicker').textContent = 'Arriving next';
    $('next-name').textContent = next.stop.name;
    $('next-sub').textContent = `${B.kmText(next.distM)} away • ${speedText}`;
  } else if (next && next.arrived) {
    idle('Arrived', next.stop.name, `End of the ${B.TRIPS[r.trip || 'pickup'].toLowerCase()}`);
  } else {
    idle('Bus location', 'Bus is on the way', `${speedText} • updated ${B.timeAgo(seen)}`);
  }
}

// ---------- Map ----------
let map = null;
const layers = {};
let fittedFor = null;

function renderMap() {
  if (!map) {
    map = B.createMap('map');
    $('map-empty').hidden = Boolean(map);
    if (!map) return;
  }
  const r = route();
  B.drawRoute(map, layers, r, { myStopIds: state.kids.map((k) => k.stopId).filter(Boolean) });
  if (fittedFor !== r.id && ((r.stops || []).length || r.location)) { B.fitRoute(map, r); fittedFor = r.id; }
  const order = B.tripOrder(r, r.trip);
  $('chip-route').lastElementChild.textContent = order.length >= 2 ? `${order[0].name} → ${order[order.length - 1].name}` : (r.name || 'Route');
  $('chip-speed').lastElementChild.textContent = `${B.kmh(r.speed)} km/h`;
  const live = B.isLive(r);
  $('chip-gps').classList.toggle('is-off', !live);
  $('chip-gps').lastElementChild.textContent = live ? 'GPS Live' : 'Offline';
  const seen = B.seenAt(r);
  $('live-note').textContent = live
    ? `Bus updated ${B.timeAgo(seen)}. Times are estimates from the bus's distance and speed.`
    : seen ? `The bus was last seen ${B.timeAgo(seen)}.` : 'The bus will show here once the Bus Captain starts sharing.';
}

$('recenter').addEventListener('click', () => {
  const r = route();
  if (!map || !r) return;
  if (r.location) map.setView([r.location.lat, r.location.lng], Math.max(map.getZoom(), 15));
  else B.fitRoute(map, r);
});

// ---------- Stops ----------
function renderStops() {
  const r = route();
  const stops = r.stops || [];
  $('stops-tab').textContent = `Stops (${stops.length})`;
  $('stops-empty').hidden = stops.length > 0;
  $('stops-sub').textContent = `${B.TRIPS[r.trip || 'pickup']} order. ${r.trip === 'drop' ? 'The drop runs the morning stops in reverse.' : ''}`;
  const next = B.nextStop(r);
  const myIds = state.kids.map((k) => k.stopId);
  const ordered = B.tripOrder(r, r.trip);
  const extra = stops.filter((s) => !ordered.includes(s));
  $('stop-list').replaceChildren(...[...ordered, ...extra].map((stop) => {
    const li = B.el('li', 'item');
    const st = r.location ? B.stopState(r, stop.id, next) : 'ahead';
    li.append(B.el('div', `num is-${st}`, String(stopNumber(stop))));
    const main = B.el('div', 'item-main');
    const title = B.el('div', 'item-title', stop.name);
    if (myIds.includes(stop.id)) title.append(B.el('span', 'tag is-amber', 'Your stop'));
    if (st === 'next') title.append(B.el('span', 'tag is-blue', 'Next'));
    if (st === 'done') title.append(B.el('span', 'tag is-green', 'Done'));
    main.append(title);
    if (r.location && B.isLive(r) && st !== 'done' && typeof stop.lat === 'number') {
      const d = B.metresBetween(r.location, stop);
      main.append(B.el('div', 'item-sub', `${B.kmText(d)} · about ${B.etaMinutes(d, r.speed)} min`));
    }
    li.append(main);
    return li;
  }));
}

// ---------- Student ----------
function renderStudent() {
  const r = route();
  const trip = r.trip || 'pickup';
  $('kid-list').replaceChildren(...state.kids.map((kid) => {
    const li = B.el('li', 'item');
    li.append(B.el('div', 'avatar', initials(kid.name)));
    const main = B.el('div', 'item-main');
    const title = B.el('div', 'item-title', kid.name);
    const away = noticeFor(kid.id, today(), trip);
    title.append(B.el('span', `tag ${away ? 'is-red' : 'is-green'}`, away ? 'Not going today' : 'Going today'));
    const stop = stopOf(kid);
    main.append(title, B.el('div', 'item-sub', stop ? `Stop ${stopNumber(stop)}. ${stop.name}` : 'Stop not set yet'));
    const thisMonth = today().slice(0, 7);
    const paid = paidMonths(kid.id);
    main.append(B.el('div', 'item-sub', paid.received.has(thisMonth) ? `${B.monthLabel(thisMonth)} fee paid` : paid.reported.has(thisMonth) ? `${B.monthLabel(thisMonth)} fee waiting for Bus Captain` : `${B.monthLabel(thisMonth)} fee due`));
    li.append(main);
    return li;
  }));
  $('captain-phone').textContent = B.formatMobile(r.captain || r.id);
  $('call-captain').href = `tel:${r.captain || r.id}`;

  const mine = state.notices.filter((n) => n.date >= today()).sort((a, b) => a.date.localeCompare(b.date));
  $('my-notices-empty').hidden = mine.length > 0;
  $('my-notices').replaceChildren(...mine.map((n) => {
    const li = B.el('li', 'item');
    const main = B.el('div', 'item-main');
    const title = B.el('div', 'item-title', n.studentName);
    title.append(B.el('span', `tag ${n.date === today() ? 'is-red' : 'is-amber'}`, B.prettyDate(n.date)));
    main.append(title, B.el('div', 'item-sub', `Not going: ${tripText(n.trip)}${n.note ? ` · “${n.note}”` : ''}`));
    const undo = B.el('button', 'mini-btn', 'Undo');
    undo.type = 'button';
    undo.addEventListener('click', async () => {
      try {
        await state.fb.deleteDoc(state.fb.doc(sub('notices'), n.id));
        B.toast(`${firstName(n.studentName)} is marked as going again`, 'ok');
      } catch (error) { B.toast(B.dbErrorText(error), 'err'); }
    });
    li.append(main, undo);
    return li;
  }));
}

// ---------- Child not going ----------
const ng = { kids: new Set(), day: 'today', trip: 'both' };

function choice(label, on, onClick) {
  const b = B.el('button', `choice${on ? ' is-on' : ''}`, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function renderNotGoingSheet() {
  $('ng-kids').replaceChildren(...state.kids.map((k) => choice(k.name, ng.kids.has(k.id), () => {
    if (ng.kids.has(k.id)) ng.kids.delete(k.id); else ng.kids.add(k.id);
    renderNotGoingSheet();
  })));
  const days = [['today', 'Today'], ['tomorrow', 'Tomorrow']];
  const dayChoices = days.map(([key, label]) => choice(label, ng.day === key, () => { ng.day = key; renderNotGoingSheet(); }));
  const other = document.createElement('input');
  other.type = 'date';
  other.className = `choice${ng.day.length === 10 ? ' is-on' : ''}`;
  other.min = B.dateKey(0);
  other.value = ng.day.length === 10 ? ng.day : '';
  other.setAttribute('aria-label', 'Another day');
  other.addEventListener('change', () => { ng.day = other.value || 'today'; renderNotGoingSheet(); });
  $('ng-days').replaceChildren(...dayChoices, other);
  $('ng-trips').replaceChildren(...[['both', 'Pickup and drop'], ['pickup', 'Morning pickup'], ['drop', 'Afternoon drop']]
    .map(([key, label]) => choice(label, ng.trip === key, () => { ng.trip = key; renderNotGoingSheet(); })));
}

$('notgoing-btn').addEventListener('click', () => {
  if (!state.kids.length) { B.toast('No child is linked to your number on this route yet.', 'err'); return; }
  ng.kids = new Set(state.kids.map((k) => k.id));
  ng.day = 'today';
  ng.trip = 'both';
  $('ng-note').value = '';
  $('ng-error').textContent = '';
  renderNotGoingSheet();
  $('notgoing-sheet').showModal();
});
$('ng-cancel').addEventListener('click', () => $('notgoing-sheet').close());

$('notgoing-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ng.kids.size) { $('ng-error').textContent = 'Pick at least one child.'; return; }
  const date = ng.day === 'today' ? B.dateKey(0) : ng.day === 'tomorrow' ? B.dateKey(1) : ng.day;
  const kids = state.kids.filter((k) => ng.kids.has(k.id) && !state.notices.some((n) => n.studentId === k.id && n.date === date && (n.trip === 'both' || n.trip === ng.trip)));
  try {
    await Promise.all(kids.map((kid) => state.fb.addDoc(sub('notices'), {
      studentId: kid.id,
      studentName: kid.name,
      date,
      trip: ng.trip,
      note: $('ng-note').value.trim(),
      by: state.me,
      family: kid.family,
      at: state.fb.serverTimestamp(),
    })));
    $('notgoing-sheet').close();
    B.toast(`Bus Captain alerted: ${[...ng.kids].map((id) => firstName(state.kids.find((k) => k.id === id).name)).join(' and ')} not going ${B.prettyDate(date).toLowerCase()}`, 'ok');
  } catch (error) {
    $('ng-error').textContent = B.dbErrorText(error);
  }
});

// ---------- Fees ----------
function paidMonths(kidId) {
  const received = new Set();
  const reported = new Set();
  state.payments.filter((p) => p.studentId === kidId).forEach((p) => {
    if (p.status === 'received') p.months.forEach((m) => received.add(m));
    else if (p.status === 'reported') p.months.forEach((m) => reported.add(m));
  });
  return { received, reported };
}

function renderFees() {
  const r = route();
  if (!state.kids.some((k) => k.id === state.feeKid)) { state.feeKid = state.kids[0] ? state.kids[0].id : null; state.checked.clear(); }
  const kid = state.kids.find((k) => k.id === state.feeKid);
  $('fee-kid-row').hidden = state.kids.length < 2;
  $('fee-kid-row').replaceChildren(...state.kids.map((k) => choice(k.name, k.id === state.feeKid, () => { state.feeKid = k.id; state.checked.clear(); renderFees(); })));

  const ready = Boolean(r.fee && B.upiAddress(r.upi));
  $('fee-setup').hidden = ready;
  $('fee-box').hidden = !ready || !kid;
  if (!ready || !kid) { $('fees-dot').hidden = true; return; }

  const months = B.schoolYearMonths();
  const paid = paidMonths(kid.id);
  $('fee-rate').textContent = `${B.inr(r.fee)} a month · ${r.name || 'this route'}`;
  $('fee-year').textContent = `${months[0].label.split(' ')[1]}–${months[11].label.split(' ')[1].slice(2)}`;
  $('months').replaceChildren(...months.map((m) => {
    const label = B.el('label', 'month');
    const box = document.createElement('input');
    box.type = 'checkbox';
    const text = B.el('span', '', m.short);
    if (paid.received.has(m.key)) {
      label.classList.add('is-paid');
      box.checked = true;
      box.disabled = true;
      text.append(B.el('small', '', 'Paid'));
    } else if (paid.reported.has(m.key)) {
      label.classList.add('is-pending');
      box.checked = true;
      box.disabled = true;
      text.append(B.el('small', '', 'Checking'));
    } else {
      box.checked = state.checked.has(m.key);
      label.classList.toggle('is-checked', box.checked);
      box.addEventListener('change', () => {
        if (box.checked) state.checked.add(m.key); else state.checked.delete(m.key);
        renderFees();
      });
    }
    if (m.current) label.classList.add('is-now');
    box.setAttribute('aria-label', `${m.label}${box.disabled ? (paid.received.has(m.key) ? ', paid' : ', waiting for Bus Captain') : ''}`);
    label.append(box, text);
    return label;
  }));

  const count = state.checked.size;
  const total = count * r.fee;
  $('fee-total').textContent = B.inr(total);
  $('fee-count').textContent = count ? `${count} ${count === 1 ? 'month' : 'months'} × ${B.inr(r.fee)}` : 'Tick the months to pay';
  $('pay-btn').disabled = count === 0;
  $('pay-btn').textContent = count ? `Pay fee · ${B.inr(total)}` : 'Pay fee';
  $('upi-id').textContent = `${B.upiAddress(r.upi)}${r.payee ? ` · ${r.payee}` : ''}`;
  const thisMonth = months.find((m) => m.current);
  $('fees-dot').hidden = !(thisMonth && !paid.received.has(thisMonth.key) && !paid.reported.has(thisMonth.key));

  const history = state.payments.filter((p) => p.studentId === kid.id).sort((a, b) => B.millis(b.at) - B.millis(a.at));
  $('pay-history-empty').hidden = history.length > 0;
  $('pay-history').replaceChildren(...history.map((p) => {
    const li = B.el('li', 'item');
    const main = B.el('div', 'item-main');
    const title = B.el('div', 'item-title', B.inr(p.amount));
    const tag = { reported: ['is-blue', 'Waiting for Bus Captain'], received: ['is-green', 'Received'], rejected: ['is-red', 'Not received'] }[p.status] || ['', p.status];
    title.append(B.el('span', `tag ${tag[0]}`, tag[1]));
    main.append(title, B.el('div', 'item-sub', p.months.map(B.monthLabel).join(', ')),
      B.el('div', 'item-sub', `${B.millis(p.at) ? new Date(B.millis(p.at)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'Just now'}${p.ref ? ` · UPI ref ${p.ref}` : ''}`));
    li.append(main);
    return li;
  }));
}

$('pay-btn').addEventListener('click', () => {
  const r = route();
  const kid = state.kids.find((k) => k.id === state.feeKid);
  if (!kid || !state.checked.size) return;
  const months = [...state.checked].sort();
  const amount = months.length * r.fee;
  state.pendingPay = { kid, months, amount, perMonth: r.fee };
  const note = `${r.name || 'Bus'} fee ${kid.name} ${months.map(B.monthLabel).join(' ')}`.slice(0, 70);
  $('paid-sub').textContent = `${B.inr(amount)} for ${kid.name}: ${months.map(B.monthLabel).join(', ')}. The Bus Captain checks it and marks it received.`;
  $('paid-ref').value = '';
  $('paid-error').textContent = '';
  // Open the UPI app; the question waits here for when the guardian comes back.
  window.location.href = B.upiLink({ upi: r.upi, payee: r.payee, amount, note });
  setTimeout(() => { if (state.pendingPay && !$('paid-sheet').open) $('paid-sheet').showModal(); }, 800);
});

$('paid-no').addEventListener('click', () => {
  state.pendingPay = null;
  $('paid-sheet').close();
  B.toast('Nothing recorded. Tick the months and tap Pay fee to try again.');
});

$('paid-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const p = state.pendingPay;
  if (!p) return $('paid-sheet').close();
  try {
    await state.fb.addDoc(sub('payments'), {
      studentId: p.kid.id,
      studentName: p.kid.name,
      months: p.months,
      perMonth: p.perMonth,
      amount: p.amount,
      ref: $('paid-ref').value.replace(/\s/g, '').slice(0, 24),
      by: state.me,
      family: p.kid.family,
      status: 'reported',
      at: state.fb.serverTimestamp(),
    });
    state.pendingPay = null;
    state.checked.clear();
    $('paid-sheet').close();
    B.toast('Payment recorded. The Bus Captain will confirm it.', 'ok');
  } catch (error) {
    $('paid-error').textContent = B.dbErrorText(error);
  }
});

$('copy-upi').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(B.upiAddress(route().upi)); B.toast('UPI ID copied', 'ok'); } catch { B.toast('Could not copy. Long-press the UPI ID instead.'); }
});

// ---------- Alerts ----------
function alertItems() {
  const r = route();
  const items = [];
  if (r.honkAt && Date.now() - r.honkAt < 24 * 3600 * 1000) items.push({ at: r.honkAt, title: 'Bus Captain honked', sub: r.honkStop ? `Near ${r.honkStop}` : 'The bus is close', tag: ['is-amber', 'Honk'] });
  state.payments.forEach((p) => {
    if (p.status === 'received' || p.status === 'rejected') {
      items.push({ at: B.millis(p.checkedAt) || B.millis(p.at), title: `${B.inr(p.amount)} ${p.status === 'received' ? 'received' : 'not received'}`, sub: `${p.studentName} · ${p.months.map(B.monthLabel).join(', ')}`, tag: p.status === 'received' ? ['is-green', 'Fee'] : ['is-red', 'Fee'] });
    }
  });
  state.notices.forEach((n) => items.push({ at: B.millis(n.at), title: `${n.studentName} not going ${B.prettyDate(n.date).toLowerCase()}`, sub: `${tripText(n.trip)} · sent by ${n.by === state.me ? 'you' : B.formatMobile(n.by)}`, tag: ['is-red', 'Not going'] }));
  return items.filter((i) => i.at).sort((a, b) => b.at - a.at).slice(0, 30);
}

function renderAlerts() {
  const items = alertItems();
  $('alerts-empty').hidden = items.length > 0;
  $('alert-list').replaceChildren(...items.map((i) => {
    const li = B.el('li', 'item');
    const main = B.el('div', 'item-main');
    const title = B.el('div', 'item-title', i.title);
    title.append(B.el('span', `tag ${i.tag[0]}`, i.tag[1]));
    main.append(title, B.el('div', 'item-sub', `${i.sub} · ${B.timeAgo(i.at)}`));
    li.append(main);
    return li;
  }));
  const seen = Number(store.get(ALERTS_SEEN_KEY)) || 0;
  if (state.tab === 'panel-alerts' && items[0]) store.set(ALERTS_SEEN_KEY, String(items[0].at));
  $('alerts-dot').hidden = state.tab === 'panel-alerts' || !items.some((i) => i.at > seen && i.title.indexOf('not going') === -1);
  $('notify-btn').hidden = !('Notification' in window) || Notification.permission !== 'default';
}

$('notify-btn').addEventListener('click', async () => {
  try { await Notification.requestPermission(); } catch {}
  renderAlerts();
});

function checkHonk() {
  const r = route();
  const at = r.honkAt || 0;
  if (state.seenHonk === null) state.seenHonk = Date.now() - at < HONK_FRESH_MS ? 0 : at; // first load: only a recent honk counts
  if (at > state.seenHonk) {
    state.seenHonk = at;
    $('honk-title').textContent = 'The Bus Captain honked';
    $('honk-sub').textContent = `${r.honkStop ? `Near ${r.honkStop} · ` : ''}${B.clock(at)}. Please bring your child out.`;
    $('honk-banner').hidden = false;
    B.horn();
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      try { new Notification('The school bus is close', { body: $('honk-sub').textContent, tag: 'honk' }); } catch {}
    }
  }
}
$('honk-close').addEventListener('click', () => { $('honk-banner').hidden = true; });

// ---------- Menu, refresh ----------
$('menu-btn').addEventListener('click', () => {
  $('route-switch').replaceChildren(...(state.routes.length > 1 ? state.routes.map((r) => {
    const b = B.el('button', 'menu-item', `${r.name || 'Route'} · ${r.school || 'School bus'}${r.id === state.routeId ? ' ✓' : ''}`);
    b.type = 'button';
    b.addEventListener('click', () => { $('menu-sheet').close(); selectRoute(r.id); });
    return b;
  }) : []));
  $('signout-label').textContent = `Sign out ${B.formatMobile(state.me)}`;
  $('menu-sheet').showModal();
});
const signOut = () => { if (confirm(`Sign out ${B.formatMobile(state.me)}?`)) state.fb.signOut(state.fb.auth); };
$('menu-signout').addEventListener('click', () => { $('menu-sheet').close(); signOut(); });
$('no-route-signout').addEventListener('click', signOut);

$('refresh-btn').addEventListener('click', () => {
  const btn = $('refresh-btn');
  btn.classList.remove('is-spinning');
  void btn.offsetWidth;
  btn.classList.add('is-spinning');
  fittedFor = null;
  if (route()) renderAll();
});

// ---------- Data ----------
function renderAll() {
  if (!route()) return;
  renderHeader();
  renderEta();
  renderMap();
  renderStops();
  renderStudent();
  renderFees();
  renderAlerts();
}

function show(view) {
  $('signin').hidden = view !== 'signin';
  $('no-route').hidden = view !== 'no-route';
  $('home').hidden = view !== 'home';
}

function selectRoute(id) {
  if (state.routeId === id) return;
  state.routeId = id;
  store.set(ROUTE_KEY, id);
  routeUnsubs.splice(0).forEach((u) => u());
  Object.assign(state, { kids: [], notices: [], payments: [], feeKid: null, seenHonk: null });
  state.checked.clear();
  fittedFor = null;
  show('home');
  if (map) setTimeout(() => map.invalidateSize(), 0);
  renderAll();

  const fb = state.fb;
  const mine = (name) => fb.query(sub(name), fb.where('family', 'array-contains', state.me));
  const fail = (error) => { console.error(error); B.toast(B.dbErrorText(error), 'err'); };
  routeUnsubs.push(fb.onSnapshot(mine('students'), (snap) => {
    state.kids = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
    renderAll();
  }, fail));
  routeUnsubs.push(fb.onSnapshot(mine('notices'), (snap) => {
    state.notices = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  }, fail));
  routeUnsubs.push(fb.onSnapshot(mine('payments'), (snap) => {
    state.payments = snap.docs.map((d) => ({ id: d.id, ...d.data(), months: d.data().months || [] }));
    renderAll();
  }, fail));
}

function watchRoutes() {
  const fb = state.fb;
  const q = fb.query(fb.collection(fb.db, 'routes'), fb.where('guardians', 'array-contains', state.me));
  routeUnsub = fb.onSnapshot(q, (snap) => {
    state.routes = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!state.routes.length) {
      routeUnsubs.splice(0).forEach((u) => u());
      state.routeId = null;
      $('no-route-text').textContent = `No Bus Captain has added ${B.formatMobile(state.me)} for a child yet. Ask your Bus Captain to add this number in their app under Students, then open this page again.`;
      show('no-route');
      return;
    }
    const saved = store.get(ROUTE_KEY);
    const pick = state.routes.some((r) => r.id === state.routeId) ? state.routeId : state.routes.some((r) => r.id === saved) ? saved : state.routes[0].id;
    selectRoute(pick);
    checkHonk();
    renderAll();
  }, (error) => {
    console.error(error);
    $('no-route-text').textContent = B.dbErrorText(error);
    show('no-route');
  });
}

// Keep "x min ago" and ETAs fresh between updates.
setInterval(() => { if (route()) { renderHeader(); renderEta(); renderMap(); } }, 15000);

B.setupTabs((panel) => {
  state.tab = panel;
  if (panel === 'panel-live' && map) setTimeout(() => map.invalidateSize(), 0);
  if (route()) renderAlerts();
});

async function start() {
  try {
    state.fb = await B.loadFirebase('guardians');
  } catch (error) {
    show('signin');
    $('signin-status').textContent = 'Could not reach Firebase. Check your internet and refresh.';
    $('signin-status').className = 'status-line err';
    return;
  }
  B.setupSignIn(state.fb);
  state.fb.onAuthStateChanged(state.fb.auth, (user) => {
    if (routeUnsub) { routeUnsub(); routeUnsub = null; }
    routeUnsubs.splice(0).forEach((u) => u());
    Object.assign(state, { me: user ? user.phoneNumber : null, routes: [], routeId: null, kids: [], notices: [], payments: [], seenHonk: null });
    if (!state.me) { show('signin'); return; }
    watchRoutes();
  });
}

start();
