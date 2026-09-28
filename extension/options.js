import {
  DEFAULTS, INTERVAL_MIN_SEC, INTERVAL_MAX_SEC,
  getSettings, setSettings, getCollectorSettings, setCollectorSettings,
  isValidBridgeUrl, isValidCollectorUrl, validWindows,
} from './settings.js';

const BOOLS = ['captureTeams', 'captureOutlook', 'keepActiveMask', 'teamsMuteSelf'];
const MODES = ['teamsChatsMode', 'teamsChannelsMode', 'teamsMeetingsMode'];
const WINDOWS = [
  { key: 'pagingSilenceWindows', add: 'addPagingWindow', error: 'pagingScheduleError' },
  { key: 'keepActiveWindows', add: 'addActivityWindow', error: 'activityScheduleError' },
];

function flash() {
  const element = document.getElementById('saved');
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 900);
}

function rowFor(field, window) {
  const row = document.createElement('div');
  row.className = 'row window-row';
  for (const part of ['start', 'end']) {
    const label = document.createElement('label');
    label.textContent = part === 'start' ? 'From ' : 'Until ';
    const input = document.createElement('input');
    input.type = 'time';
    input.className = part;
    input.value = window[part] || '';
    input.addEventListener('change', () => saveWindows(field));
    label.append(input);
    row.append(label);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => { row.remove(); saveWindows(field); });
  row.append(remove);
  return row;
}

async function saveWindows(field) {
  const windows = [...document.querySelectorAll(`#${field} .window-row`)].map((row) => ({
    start: row.querySelector('.start').value, end: row.querySelector('.end').value,
  }));
  const invalid = !validWindows(windows);
  document.getElementById(field).classList.toggle('invalid', invalid);
  const error = document.getElementById(WINDOWS.find((value) => value.key === field).error);
  error.textContent = invalid ? 'Enter distinct start and end times in HH:MM before saving.' : '';
  if (invalid) return;
  await setSettings({ [field]: windows });
  flash();
}

async function render() {
  const settings = await getSettings();
  const collector = await getCollectorSettings();
  for (const key of BOOLS) document.getElementById(key).checked = settings[key];
  for (const key of MODES) document.getElementById(key).value = settings[key];
  for (const { key, error } of WINDOWS) {
    const container = document.getElementById(key);
    container.replaceChildren(...(Array.isArray(settings[key]) ? settings[key].map((window) => rowFor(key, window)) : []));
    document.getElementById(error).textContent = key === 'pagingSilenceWindows' && settings.pagingInvalid ||
      key === 'keepActiveWindows' && settings.keepActiveInvalid ? 'Invalid saved schedule: feature is off until corrected.' : '';
  }
  document.getElementById('keepActiveIntervalSec').value = settings.keepActiveIntervalSec;
  document.getElementById('bridgeUrl').value = settings.bridgeUrl;
  document.getElementById('collectorUrl').value = collector.collectorUrl;
  document.getElementById('collectorToken').value = collector.collectorToken;
  for (const key of [...MODES, 'teamsMuteSelf']) document.getElementById(key).disabled = !settings.captureTeams;
}

for (const key of BOOLS) {
  document.getElementById(key).addEventListener('change', async (event) => {
    await setSettings({ [key]: event.target.checked });
    flash(); await render();
  });
}
for (const key of MODES) {
  document.getElementById(key).addEventListener('change', async (event) => {
    await setSettings({ [key]: event.target.value });
    flash(); await render();
  });
}
for (const { key, add } of WINDOWS) {
  document.getElementById(add).addEventListener('click', () => {
    document.getElementById(key).append(rowFor(key, { start: '', end: '' }));
  });
}
document.getElementById('keepActiveIntervalSec').addEventListener('change', async (event) => {
  const value = Number(event.target.value);
  if (!Number.isFinite(value)) return render();
  const clamped = Math.min(INTERVAL_MAX_SEC, Math.max(INTERVAL_MIN_SEC, Math.round(value)));
  await setSettings({ keepActiveIntervalSec: clamped });
  event.target.value = clamped;
  flash();
});
for (const [key, validator, setter] of [
  ['bridgeUrl', isValidBridgeUrl, setSettings],
  ['collectorUrl', isValidCollectorUrl, setCollectorSettings],
]) {
  const input = document.getElementById(key);
  input.addEventListener('input', () => input.classList.toggle('invalid', !validator(input.value)));
  input.addEventListener('change', async () => {
    if (!validator(input.value)) return;
    await setter({ [key]: input.value }); flash();
  });
}
document.getElementById('collectorToken').addEventListener('change', async (event) => {
  await setCollectorSettings({ collectorToken: event.target.value.trim() });
  flash();
});
document.getElementById('reimport').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'pager-reimport' });
  document.getElementById('reimportStatus').textContent = response?.ok ? 'Re-import requested in open source tabs.' : 'Re-import failed; check the collector.';
});
document.getElementById('reset').addEventListener('click', async () => {
  await setSettings(DEFAULTS);
  flash(); await render();
});
render();
