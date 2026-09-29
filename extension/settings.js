export const DEFAULTS = {
  captureTeams: true,
  captureOutlook: true,
  teamsChatsMode: 'all',
  teamsChannelsMode: 'mentions',
  teamsMeetingsMode: 'off',
  teamsMuteSelf: true,
  pagingMode: 'always_notify',
  pagingSilenceWindows: [],
  keepActiveMode: 'always_off',
  keepActiveWindows: [],
  keepActiveIntervalSec: 240,
  keepActiveMask: true,
  bridgeUrl: 'http://localhost:4500/capture',
  debugProbe: false,
};

export const TEAMS_MATCHES = ['https://teams.microsoft.com/*', 'https://*.teams.microsoft.com/*', 'https://teams.cloud.microsoft/*'];
export const OUTLOOK_MATCHES = ['https://outlook.office.com/*', 'https://outlook.office365.com/*', 'https://outlook.cloud.microsoft/*'];
export const CAPTURE_MODES = ['off', 'mentions', 'all'];
export const INTERVAL_MIN_SEC = 30;
export const INTERVAL_MAX_SEC = 900;
export const COLLECTOR_DEFAULT_URL = 'http://localhost:4501/capture';
const PAGING_MODES = ['scheduled', 'always_notify', 'always_silent'];
const ACTIVITY_MODES = ['scheduled', 'always_on', 'always_off'];

export function isValidBridgeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === '/capture';
  } catch { return false; }
}
export const isValidCollectorUrl = isValidBridgeUrl;

export function parseTime(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
export function validWindows(value) {
  return Array.isArray(value) && value.every((window) => window && typeof window === 'object' &&
    parseTime(window.start) !== null && parseTime(window.end) !== null && window.start !== window.end);
}

export function isWithinWindows(windows, date) {
  if (!validWindows(windows)) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  return windows.some(({ start, end }) => {
    const from = parseTime(start);
    const to = parseTime(end);
    return from < to ? minute >= from && minute < to : minute >= from || minute < to;
  });
}

export function normalize(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  const mode = (value, fallback) => CAPTURE_MODES.includes(value) ? value : fallback;
  const interval = Number(s.keepActiveIntervalSec);
  return {
    captureTeams: !!s.captureTeams, captureOutlook: !!s.captureOutlook,
    teamsChatsMode: mode(s.teamsChatsMode, DEFAULTS.teamsChatsMode),
    teamsChannelsMode: mode(s.teamsChannelsMode, DEFAULTS.teamsChannelsMode),
    teamsMeetingsMode: mode(s.teamsMeetingsMode, DEFAULTS.teamsMeetingsMode),
    teamsMuteSelf: !!s.teamsMuteSelf,
    pagingMode: s.pagingMode, pagingSilenceWindows: s.pagingSilenceWindows,
    keepActiveMode: s.keepActiveMode, keepActiveWindows: s.keepActiveWindows,
    pagingInvalid: !PAGING_MODES.includes(s.pagingMode) || !validWindows(s.pagingSilenceWindows),
    keepActiveInvalid: !ACTIVITY_MODES.includes(s.keepActiveMode) || !validWindows(s.keepActiveWindows),
    keepActiveIntervalSec: Number.isFinite(interval) ? Math.min(INTERVAL_MAX_SEC, Math.max(INTERVAL_MIN_SEC, Math.round(interval))) : DEFAULTS.keepActiveIntervalSec,
    keepActiveMask: !!s.keepActiveMask,
    bridgeUrl: isValidBridgeUrl(s.bridgeUrl) ? s.bridgeUrl : DEFAULTS.bridgeUrl,
    debugProbe: !!s.debugProbe,
  };
}

export function effectiveSchedule(settings, date = new Date()) {
  const pagingAllowed = !settings.pagingInvalid && (settings.pagingMode === 'always_notify' ||
    settings.pagingMode === 'scheduled' && !isWithinWindows(settings.pagingSilenceWindows, date));
  const keepActive = !settings.keepActiveInvalid && (settings.keepActiveMode === 'always_on' ||
    settings.keepActiveMode === 'scheduled' && isWithinWindows(settings.keepActiveWindows, date));
  return { pagingAllowed, keepActive, pagingInvalid: !!settings.pagingInvalid, keepActiveInvalid: !!settings.keepActiveInvalid };
}

export function nextScheduleChange(settings, date = new Date()) {
  if ((settings.pagingMode !== 'scheduled' || settings.pagingInvalid) &&
      (settings.keepActiveMode !== 'scheduled' || settings.keepActiveInvalid)) return null;
  const initial = effectiveSchedule(settings, date);
  const start = Math.floor(date.getTime() / 60000) * 60000 + 60000;
  for (let minute = 0; minute < 48 * 60; minute++) {
    const instant = new Date(start + minute * 60000);
    const state = effectiveSchedule(settings, instant);
    if (settings.pagingMode === 'scheduled' && state.pagingAllowed !== initial.pagingAllowed ||
        settings.keepActiveMode === 'scheduled' && state.keepActive !== initial.keepActive) return instant;
  }
  return null;
}

export async function getSettings() {
  const raw = await chrome.storage.sync.get(null);
  if (!Object.hasOwn(raw, 'keepActiveMode')) {
    raw.keepActiveMode = raw.keepActive === true ? 'always_on' : 'always_off';
    await chrome.storage.sync.set({ keepActiveMode: raw.keepActiveMode });
    if (Object.hasOwn(raw, 'keepActive')) await chrome.storage.sync.remove('keepActive');
  }
  return normalize(raw);
}
export async function setSettings(patch) {
  for (const [mode, values] of [['pagingMode', PAGING_MODES], ['keepActiveMode', ACTIVITY_MODES]]) {
    if (Object.hasOwn(patch, mode) && !values.includes(patch[mode])) throw new Error('invalid ' + mode);
  }
  for (const field of ['pagingSilenceWindows', 'keepActiveWindows']) {
    if (Object.hasOwn(patch, field) && !validWindows(patch[field])) throw new Error('invalid ' + field);
  }
  if (Object.hasOwn(patch, 'bridgeUrl') && !isValidBridgeUrl(patch.bridgeUrl)) throw new Error('invalid bridgeUrl');
  await chrome.storage.sync.set(patch);
}
export async function getCollectorSettings() {
  const data = await chrome.storage.local.get(['collectorUrl', 'collectorToken']);
  return { collectorUrl: data.collectorUrl || COLLECTOR_DEFAULT_URL, collectorToken: data.collectorToken || '' };
}
export async function setCollectorSettings(patch) {
  if (Object.hasOwn(patch, 'collectorUrl') && !isValidCollectorUrl(patch.collectorUrl)) throw new Error('invalid collectorUrl');
  await chrome.storage.local.set(patch);
}
