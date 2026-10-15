// Beacon Go (child app).
// UI only for now: location sending and battery are placeholders until the backend exists,
// and Child Details are kept in this browser's localStorage.

const STORAGE_KEY = 'beacon-go.children';

const state = {
  sharing: true,
  busNumber: 1,
  children: loadChildren(),
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

function renderTracker() {
  const { sharing } = state;
  frame.classList.toggle('is-paused', !sharing);
  title.textContent = sharing ? 'Sharing your location' : 'Location sharing is off';
  subtitle.textContent = sharing
    ? 'Updated just now · Your parents can see where you are'
    : 'Turn it back on so your parents can see where you are';
  toggleBtn.textContent = sharing ? 'Pause sharing' : 'Start sharing';
  toggleBtn.setAttribute('aria-pressed', String(sharing));
  busChip.textContent = `Bus No. ${state.busNumber}`;
}

toggleBtn.addEventListener('click', () => {
  state.sharing = !state.sharing;
  renderTracker();
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

function saveChildren() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.children));
  } catch {
    // Storage unavailable (private mode); entries last for this visit only.
  }
}

// Accepts digits with optional leading +, spaces or dashes; 10 to 15 digits.
function isValidMobile(value) {
  const digits = value.replace(/[\s-]/g, '');
  return /^\+?\d{10,15}$/.test(digits);
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}

function renderChildren() {
  list.replaceChildren(...state.children.map((child) => {
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
  }));

  countEl.textContent = String(state.children.length);
  emptyState.hidden = state.children.length > 0;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const mobile1 = mobile1Input.value.trim();
  const mobile2 = mobile2Input.value.trim();

  if (!name) return showError('Please enter the child\'s name.', nameInput);
  if (!isValidMobile(mobile1)) return showError('Mobile number 1 should be 10 to 15 digits.', mobile1Input);
  if (!isValidMobile(mobile2)) return showError('Mobile number 2 should be 10 to 15 digits.', mobile2Input);

  state.children.push({ id: Date.now().toString(36), name, mobile1, mobile2 });
  saveChildren();
  renderChildren();
  form.reset();
  formError.textContent = '';
  nameInput.focus();
});

function showError(message, input) {
  formError.textContent = message;
  input.focus();
}

renderTracker();
renderChildren();
