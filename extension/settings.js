// Shared settings contract for the popup, the options page, and the service
// worker. Kept as an ES module so the service worker (`"type": "module"`) and
// the two extension pages can all import the same defaults and clamps rather
// than each re-deriving them.

export const DEFAULTS = {
  // Script injection. Each of these decides whether the corresponding content
  // scripts are registered at all — off means nothing is injected into the
  // page, not a no-op script that loaded and then checked a flag.
  captureTeams: true,
  captureOutlook: true,

  // What Teams traffic is worth a page, per conversation kind. Teams' own
  // `type` field is the discriminator: Chat covers both 1:1 and group, Topic
  // and Space are channels, Meeting is a meeting's chat.
  //
  // Meetings default off because a busy meeting chat is a lot of traffic that
  // is rarely worth a phone buzz, and nothing else in the app makes that
  // choice visible — so it is a setting rather than a silent rule.
  teamsChatsMode: 'all',
  teamsChannelsMode: 'mentions',
  teamsMeetingsMode: 'off',

  // Your own messages arrive in the store the same as anyone else's, and
  // paging yourself for something you just typed is never useful.
  teamsMuteSelf: true,

  // Keep the Teams web app from reporting you idle/away.
  keepActive: false,
  keepActiveIntervalSec: 240,
  keepActiveMask: true,

  // Where background.js POSTs captured events.
  bridgeUrl: 'http://localhost:4500/capture',

  // The `__diag` "capture installed" event, one per tab load. Handy while
  // wiring things up, noise once it works.
  diagnostics: true,
};

// Split by app, because the capture toggles are per-app. The old manifest used
// a single `https://*.cloud.microsoft/*` wildcard covering both; that can't be
// attributed to one toggle, so the two Microsoft 365 hosts are named instead.
export const TEAMS_MATCHES = [
  'https://teams.microsoft.com/*',
  'https://*.teams.microsoft.com/*',
  'https://teams.cloud.microsoft/*',
];

export const OUTLOOK_MATCHES = [
  'https://outlook.office.com/*',
  'https://outlook.office365.com/*',
  'https://outlook.cloud.microsoft/*',
];

// Per-kind capture modes. 'mentions' only means anything where Teams tells us
// who was mentioned, which is every conversation kind.
export const CAPTURE_MODES = ['off', 'mentions', 'all'];

// Teams flips to Away at ~5 minutes idle, so the useful range sits under that.
// The ceiling is only there to keep a typo from silently disabling the pulse.
export const INTERVAL_MIN_SEC = 30;
export const INTERVAL_MAX_SEC = 900;

// The bridge is a loopback listener by design (see bridge/): it holds the only
// long-term identity key and must not be reachable off the machine. Accept only
// hosts granted in manifest.json, so a bad paste cannot send captured message
// text to another host or a URL the extension cannot fetch.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

export function isValidBridgeUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
}

// Storage can hold anything a previous version wrote, so every read is clamped
// back into range instead of trusting what comes out.
export function normalize(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  const mode = (v, fallback) => (CAPTURE_MODES.includes(v) ? v : fallback);
  const out = {
    captureTeams: !!s.captureTeams,
    captureOutlook: !!s.captureOutlook,
    keepActive: !!s.keepActive,
    keepActiveMask: !!s.keepActiveMask,
    diagnostics: !!s.diagnostics,
    teamsChatsMode: mode(s.teamsChatsMode, DEFAULTS.teamsChatsMode),
    teamsChannelsMode: mode(s.teamsChannelsMode, DEFAULTS.teamsChannelsMode),
    teamsMeetingsMode: mode(s.teamsMeetingsMode, DEFAULTS.teamsMeetingsMode),
    teamsMuteSelf: !!s.teamsMuteSelf,
    keepActiveIntervalSec: DEFAULTS.keepActiveIntervalSec,
    bridgeUrl: DEFAULTS.bridgeUrl,
  };
  const n = Number(s.keepActiveIntervalSec);
  if (Number.isFinite(n)) {
    out.keepActiveIntervalSec = Math.min(INTERVAL_MAX_SEC, Math.max(INTERVAL_MIN_SEC, Math.round(n)));
  }
  if (typeof s.bridgeUrl === 'string' && isValidBridgeUrl(s.bridgeUrl)) {
    out.bridgeUrl = s.bridgeUrl;
  }
  return out;
}

export async function getSettings() {
  return normalize(await chrome.storage.sync.get(DEFAULTS));
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}
