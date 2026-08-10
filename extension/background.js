// Forwards captured events to the local Pager bridge, and owns which content
// scripts are registered. Runs in the extension context, so its fetch is not
// subject to the page's connect-src CSP.

import {
  DEFAULTS,
  TEAMS_MATCHES,
  OUTLOOK_MATCHES,
  getSettings,
} from './settings.js';

const DEDUP_TTL_MS = 120000;

// ---------------------------------------------------------------------------
// settings cache
// ---------------------------------------------------------------------------

// The service worker is torn down between events, so this is a within-wakeup
// cache, not state. Every entry point awaits it rather than reading it.
let cached = null;
async function settings() {
  if (!cached) cached = await getSettings();
  return cached;
}

// ---------------------------------------------------------------------------
// content script registration
// ---------------------------------------------------------------------------

// Registrations are declared here instead of in the manifest so the toggles
// mean what they say: a disabled feature is never injected into the page.
// Chrome persists these across browser restarts and applies them at
// document_start, same as a manifest-declared script.
const REG_TEAMS_MAIN = 'pager-teams-main';
const REG_OUTLOOK_MAIN = 'pager-outlook-main';
const REG_BRIDGE = 'pager-bridge';
const REG_IDS = [REG_TEAMS_MAIN, REG_OUTLOOK_MAIN, REG_BRIDGE];

function desiredRegistrations(s) {
  // Order is execution order. The mask patches the APIs Teams reads on
  // startup, so it goes first.
  const teamsMain = [];
  if (s.keepActive && s.keepActiveMask) teamsMain.push('keep-active-mask.js');
  if (s.captureTeams) teamsMain.push('main-capture.js');
  if (s.keepActive) teamsMain.push('keep-active.js');

  const outlookMain = s.captureOutlook ? ['main-capture.js'] : [];

  const regs = [];
  if (teamsMain.length) {
    regs.push({
      id: REG_TEAMS_MAIN,
      matches: TEAMS_MATCHES,
      js: teamsMain,
      runAt: 'document_start',
      world: 'MAIN',
    });
  }
  if (outlookMain.length) {
    regs.push({
      id: REG_OUTLOOK_MAIN,
      matches: OUTLOOK_MATCHES,
      js: outlookMain,
      runAt: 'document_start',
      world: 'MAIN',
    });
  }

  // The isolated-world relay is what gets MAIN-world messages to this worker
  // (and control messages back), so it is needed wherever any MAIN script runs.
  const bridgeMatches = [];
  if (teamsMain.length) bridgeMatches.push(...TEAMS_MATCHES);
  if (outlookMain.length) bridgeMatches.push(...OUTLOOK_MATCHES);
  if (bridgeMatches.length) {
    regs.push({
      id: REG_BRIDGE,
      matches: bridgeMatches,
      js: ['relay.js'],
      runAt: 'document_start',
      world: 'ISOLATED',
    });
  }
  return regs;
}

async function syncRegistrations() {
  const s = await settings();
  const desired = desiredRegistrations(s);
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ours = existing.filter((r) => REG_IDS.includes(r.id)).map((r) => r.id);
    if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
    if (desired.length) await chrome.scripting.registerContentScripts(desired);
  } catch (e) {
    console.error('[pager] failed to sync content script registrations', e);
  }
}

// ---------------------------------------------------------------------------
// keep-alive poke
// ---------------------------------------------------------------------------

// Chrome throttles page timers in background tabs, which is exactly where the
// pulse matters. An alarm in the worker is not throttled the same way, so it
// pokes the open Teams tabs; the page also runs its own timer and ignores
// whichever of the two arrives early.
const ALARM_KEEPALIVE = 'pager-keepalive';

async function syncAlarm() {
  const s = await settings();
  if (s.keepActive) {
    await chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(ALARM_KEEPALIVE);
  }
}

async function broadcast(msg, matches) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: matches });
  } catch {
    return;
  }
  for (const tab of tabs) {
    // A tab with no relay injected yet just has no receiver; that is expected,
    // not an error worth surfacing.
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_KEEPALIVE) return;
  const s = await settings();
  if (!s.keepActive) return;
  await broadcast({ type: 'pager-control', control: 'pulse' }, TEAMS_MATCHES);
});

// ---------------------------------------------------------------------------
// event forwarding
// ---------------------------------------------------------------------------

// The notification channel re-emits the same conversation several times (read
// syncs, unread-count flaps). Collapse repeats by conversation + delivery time
// within a short window so one new message is one event.
const recent = new Map();
function isDuplicate(ev) {
  if (!ev || ev.source === '__diag') return false;
  const now = ev.ts || Date.now();
  for (const [k, t] of recent) if (now - t > DEDUP_TTL_MS) recent.delete(k);
  const sig = [ev.source, ev.conversationId || ev.tag || '', ev.lastDelivery || '', ev.title || '', ev.body || ''].join('|');
  if (recent.has(sig)) return true;
  recent.set(sig, now);
  return false;
}

// Surfaced in the popup so "is this thing on?" has an answer that does not
// involve opening the bridge log. session storage outlives a worker teardown
// but not the browser session, which is the right lifetime for a status line.
async function recordStatus(patch) {
  try {
    const cur = (await chrome.storage.session.get('status')).status || {};
    await chrome.storage.session.set({ status: { ...cur, ...patch } });
  } catch {}
}

async function forward(ev) {
  const s = await settings();
  if (ev && ev.source === '__diag' && !s.diagnostics) return;
  if (isDuplicate(ev)) return;
  try {
    const resp = await fetch(s.bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    const prev = (await chrome.storage.session.get('status')).status || {};
    await recordStatus({
      lastEventAt: Date.now(),
      lastEventSource: ev && ev.source,
      bridgeOk: resp.ok,
      bridgeError: resp.ok ? null : 'HTTP ' + resp.status,
      forwarded: (prev.forwarded || 0) + 1,
    });
  } catch (e) {
    await recordStatus({
      lastEventAt: Date.now(),
      lastEventSource: ev && ev.source,
      bridgeOk: false,
      bridgeError: String((e && e.message) || e),
    });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'pager-event') {
    forward(msg.ev);
    return;
  }
  if (msg.type === 'pager-get-config') {
    // Async reply, so the channel has to be held open.
    settings().then((s) =>
      sendResponse({
        keepActive: s.keepActive,
        keepActiveIntervalSec: s.keepActiveIntervalSec,
        keepActiveMask: s.keepActiveMask,
      }),
    );
    return true;
  }
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  if (!Object.keys(changes).some((k) => k in DEFAULTS)) return;
  cached = null;
  const s = await settings();
  await syncRegistrations();
  await syncAlarm();
  // Tabs already open still have the old scripts in them; tell them the new
  // config so a toggle takes effect without a reload.
  await broadcast(
    {
      type: 'pager-control',
      control: 'config',
      config: {
        keepActive: s.keepActive,
        keepActiveIntervalSec: s.keepActiveIntervalSec,
        keepActiveMask: s.keepActiveMask,
      },
    },
    [...TEAMS_MATCHES, ...OUTLOOK_MATCHES],
  );
});

chrome.runtime.onInstalled.addListener(async () => {
  await syncRegistrations();
  await syncAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncRegistrations();
  await syncAlarm();
});
