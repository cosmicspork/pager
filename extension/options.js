// Every control writes on change — there is no Save button, so nothing can be
// half-applied between here and the registration sync in background.js.

import {
  DEFAULTS,
  INTERVAL_MIN_SEC,
  INTERVAL_MAX_SEC,
  getSettings,
  setSettings,
  isValidBridgeUrl,
} from './settings.js';

const BOOLS = ['captureTeams', 'captureOutlook', 'keepActive', 'keepActiveMask', 'diagnostics'];

function flash() {
  const el = document.getElementById('saved');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 900);
}

async function render() {
  const s = await getSettings();
  for (const key of BOOLS) document.getElementById(key).checked = s[key];
  document.getElementById('keepActiveIntervalSec').value = s.keepActiveIntervalSec;
  document.getElementById('bridgeUrl').value = s.bridgeUrl;
  syncEnabled(s);
}

// The keep-active sub-settings only mean anything while the feature is on.
function syncEnabled(s) {
  const on = s.keepActive;
  document.getElementById('keepActiveIntervalSec').disabled = !on;
  document.getElementById('keepActiveMask').disabled = !on;
}

for (const key of BOOLS) {
  document.getElementById(key).addEventListener('change', async (e) => {
    await setSettings({ [key]: e.target.checked });
    flash();
    await render();
  });
}

document.getElementById('keepActiveIntervalSec').addEventListener('change', async (e) => {
  const n = Number(e.target.value);
  if (!Number.isFinite(n)) return render();
  const clamped = Math.min(INTERVAL_MAX_SEC, Math.max(INTERVAL_MIN_SEC, Math.round(n)));
  await setSettings({ keepActiveIntervalSec: clamped });
  e.target.value = clamped;
  flash();
});

// Rejected input is left in the box marked invalid rather than reverted, so a
// near-miss stays there to be corrected.
document.getElementById('bridgeUrl').addEventListener('input', (e) => {
  e.target.classList.toggle('invalid', !isValidBridgeUrl(e.target.value));
});

document.getElementById('bridgeUrl').addEventListener('change', async (e) => {
  if (!isValidBridgeUrl(e.target.value)) return;
  await setSettings({ bridgeUrl: e.target.value });
  flash();
});

document.getElementById('reset').addEventListener('click', async () => {
  await setSettings(DEFAULTS);
  document.getElementById('bridgeUrl').classList.remove('invalid');
  flash();
  await render();
});

render();
