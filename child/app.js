// Beacon Go (child app): tracker screen.
// UI only for now. Location sending, battery and guardians are placeholders
// until the backend exists.

const state = {
  sharing: true,
  guardians: ['Mom', 'Dad'],
  primaryGuardian: 'Mom',
};

const frame = document.querySelector('.frame');
const title = document.getElementById('status-title');
const subtitle = document.getElementById('status-subtitle');
const btn = document.getElementById('toggle-btn');
const batteryValue = document.getElementById('battery-value');
const visibleToValue = document.getElementById('visible-to-value');

function render() {
  const { sharing, primaryGuardian, guardians } = state;
  frame.classList.toggle('is-paused', !sharing);
  title.textContent = sharing ? 'Sharing your location' : 'Location sharing is off';
  subtitle.textContent = sharing
    ? `Updated just now · ${primaryGuardian} can see where you are`
    : `Turn it back on so ${primaryGuardian} can see where you are`;
  btn.textContent = sharing ? 'Pause sharing' : 'Start sharing';
  btn.setAttribute('aria-pressed', String(sharing));
  visibleToValue.textContent = guardians.join(', ');
}

btn.addEventListener('click', () => {
  state.sharing = !state.sharing;
  render();
});

// Show the real battery level where the browser supports it; keep the mockup value otherwise.
if (navigator.getBattery) {
  navigator.getBattery().then((battery) => {
    const show = () => { batteryValue.textContent = `${Math.round(battery.level * 100)}%`; };
    show();
    battery.addEventListener('levelchange', show);
  }).catch(() => {});
}

render();
