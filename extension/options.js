import {
  DEFAULTS, INTERVAL_MIN_SEC, INTERVAL_MAX_SEC,
  getSettings, setSettings, getCollectorSettings, setCollectorSettings,
  isValidBridgeUrl, isValidCollectorUrl, validWindows,
  SOUND_MAX_BYTES, getSound, setSound,
} from './settings.js';

const BOOLS = ['captureTeams', 'captureOutlook', 'keepActiveMask', 'teamsMuteSelf', 'debugProbe', 'soundTeams', 'soundOutlook'];
// Capture toggles show what is stored, not the simple-mode effective value, so
// switching modes never looks like it changed them.
const STORED = { captureTeams: 'storedCaptureTeams', captureOutlook: 'storedCaptureOutlook' };
const SOUND_IDS = { teams: { toggle: 'soundTeams', name: 'soundTeamsName', file: 'soundTeamsFile' },
  outlook: { toggle: 'soundOutlook', name: 'soundOutlookName', file: 'soundOutlookFile' } };
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
  document.body.classList.toggle('simple', settings.mode !== 'full');
  document.getElementById('mode').value = settings.mode;
  for (const key of BOOLS) document.getElementById(key).checked = settings[STORED[key] || key];
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
  for (const [source, ids] of Object.entries(SOUND_IDS)) {
    const sound = await getSound(source);
    document.getElementById(ids.name).textContent = sound ? `${sound.name} · ${Math.ceil(sound.size / 1024)} KB` : 'No file chosen.';
    document.getElementById(ids.toggle).disabled = !sound;
    for (const button of document.querySelectorAll(`.sound[data-source="${source}"] button:not([data-action="choose"])`)) button.disabled = !sound;
  }
}

function soundError(message) {
  document.getElementById('soundError').textContent = message || '';
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Outlook decodes with Web Audio and Teams plays through an audio element, so a
// file has to pass both before it is kept.
async function checkPlayable(file) {
  const context = new AudioContext();
  try { await context.decodeAudioData(await file.arrayBuffer()); } finally { context.close(); }
  const url = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      const audio = new Audio();
      audio.addEventListener('canplaythrough', resolve, { once: true });
      audio.addEventListener('error', reject, { once: true });
      audio.preload = 'auto';
      audio.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}

let playing;
for (const [source, ids] of Object.entries(SOUND_IDS)) {
  const input = document.getElementById(ids.file);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    soundError();
    if (!file) return;
    if (!file.type.startsWith('audio/')) return soundError(`${file.name} is not an audio file.`);
    if (file.size > SOUND_MAX_BYTES) return soundError(`${file.name} is larger than 1 MB.`);
    try { await checkPlayable(file); } catch { return soundError(`${file.name} could not be played by the browser.`); }
    await setSound(source, { name: file.name, type: file.type, size: file.size, data: toBase64(await file.arrayBuffer()) });
    await setSettings({ [ids.toggle]: true });
    flash(); await render();
  });
  const section = document.querySelector(`.sound[data-source="${source}"]`);
  section.querySelector('[data-action="choose"]').addEventListener('click', () => input.click());
  section.querySelector('[data-action="test"]').addEventListener('click', async () => {
    const sound = await getSound(source);
    if (!sound) return;
    playing?.pause();
    playing = new Audio(`data:${sound.type};base64,${sound.data}`);
    playing.play().catch(() => soundError('The browser could not play that file.'));
  });
  section.querySelector('[data-action="remove"]').addEventListener('click', async () => {
    await setSettings({ [ids.toggle]: false });
    await setSound(source, null);
    soundError(); flash(); await render();
  });
}

document.getElementById('mode').addEventListener('change', async (event) => {
  await setSettings({ mode: event.target.value });
  flash(); await render();
});

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
  if (!Number.isFinite(value)) return;
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
  // Restoring defaults is about tuning; the mode and the sounds have their own controls.
  const { mode, soundTeams, soundOutlook, ...defaults } = DEFAULTS;
  await setSettings(defaults);
  flash(); await render();
});
function describe(entry) {
  const time = new Date(entry.at).toLocaleTimeString();
  const facts = Object.entries(entry.detail || {}).map(([key, value]) => `${key}=${value}`).join(' ');
  return [time, entry.source, entry.op, entry.outcome, entry.code, entry.durationMs != null ? entry.durationMs + 'ms' : null,
    facts, entry.message ? '— ' + entry.message : null].filter(Boolean).join(' · ');
}
let diagEntries = [];
async function renderDiagnostics() {
  const response = await chrome.runtime.sendMessage({ type: 'pager-diag-list', limit: 200 });
  diagEntries = response?.ok ? response.entries : [];
  const list = document.getElementById('diagList');
  list.replaceChildren(...diagEntries.map((entry) => {
    const row = document.createElement('div');
    row.className = 'diag-row' + (entry.outcome === 'error' ? ' error' : '');
    row.textContent = describe(entry);
    return row;
  }));
  document.getElementById('diagStatus').textContent = response?.ok ? `${diagEntries.length} recent entries` : 'Diagnostics unavailable.';
}
document.getElementById('diagRefresh').addEventListener('click', renderDiagnostics);
document.getElementById('diagCopy').addEventListener('click', async () => {
  await renderDiagnostics();
  await navigator.clipboard.writeText(JSON.stringify(diagEntries, null, 2));
  document.getElementById('diagStatus').textContent = `Copied ${diagEntries.length} entries.`;
});
document.getElementById('diagClear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'pager-diag-clear' });
  await renderDiagnostics();
});
render();
renderDiagnostics();
