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
const REG_TEAMS_CAPTURE = 'pager-teams-capture';
const REG_OUTLOOK_MAIN = 'pager-outlook-main';
const REG_BRIDGE = 'pager-bridge';
const REG_IDS = [REG_TEAMS_MAIN, REG_TEAMS_CAPTURE, REG_OUTLOOK_MAIN, REG_BRIDGE];

function desiredRegistrations(s) {
  // Teams capture reads IndexedDB, which the isolated world can reach on the
  // page's origin, so it needs neither the MAIN world nor relay.js — it talks
  // to this worker over chrome.runtime directly. Only keep-active still patches
  // page objects, and only for Teams.
  const teamsMain = [];
  if (s.keepActive && s.keepActiveMask) teamsMain.push('keep-active-mask.js');
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
  if (s.captureTeams) {
    // document_idle, not document_start: there is no page global to get ahead
    // of, and the store is not worth reading before the app has opened it.
    regs.push({
      id: REG_TEAMS_CAPTURE,
      matches: TEAMS_MATCHES,
      js: ['teams-idb.js'],
      runAt: 'document_idle',
      world: 'ISOLATED',
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

// Chrome throttles page timers in background tabs, which is exactly where both
// the keep-active pulse and the capture poll matter. An alarm in the worker is
// not throttled the same way, so it pokes the open Teams tabs; each tab also
// runs its own timer and ignores whichever of the two arrives early.
//
// Note the throttling keys on whether the tab is really backgrounded, not on
// what keep-active's mask tells the page — so masking does not help here.
const ALARM_KEEPALIVE = 'pager-keepalive';

async function syncAlarm() {
  const s = await settings();
  if (s.keepActive || s.captureTeams) {
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
  if (s.keepActive) await broadcast({ type: 'pager-control', control: 'pulse' }, TEAMS_MATCHES);
  if (s.captureTeams) await broadcast({ type: 'pager-control', control: 'poll' }, TEAMS_MATCHES);
});

// ---------------------------------------------------------------------------
// event forwarding
// ---------------------------------------------------------------------------

// The notification channel re-emits the same conversation several times (read
// syncs, unread-count flaps). Collapse repeats by conversation + delivery time
// within a short window so one new message is one event.
//
// Teams events carry a real message id, so they collapse on that rather than on
// title/body — otherwise two identical short replies ("ok") in the same chat
// would read as a duplicate and the second would be dropped.
const recent = new Map();
function isDuplicate(ev) {
  if (!ev || ev.source === '__diag') return false;
  const now = ev.ts || Date.now();
  for (const [k, t] of recent) if (now - t > DEDUP_TTL_MS) recent.delete(k);
  const sig = ev.messageId
    ? [ev.source, ev.conversationId || '', ev.messageId].join('|')
    : [ev.source, ev.conversationId || ev.tag || '', ev.lastDelivery || '', ev.title || '', ev.body || ''].join('|');
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
  if (msg.type === 'pager-health') {
    // Its own key, not merged into `status`: forward() rewrites `status` on
    // every event with a read-modify-write, and a health merge racing that
    // loses the teams field to the clobber. A whole-value set on a dedicated
    // key has nothing to race.
    //
    // Returning true holds the message channel — and so the worker — open until
    // sendResponse. Without it the worker can suspend after this listener
    // returns but before the async set flushes, and the write is lost. Event
    // forwarding gets away with fire-and-forget only because its fetch keeps the
    // worker alive; a lone health write has nothing holding it.
    chrome.storage.session.set({ teamsHealth: msg.health }).finally(() => sendResponse());
    return true;
  }
  if (msg.type === 'pager-get-config') {
    // Async reply, so the channel has to be held open.
    settings().then((s) =>
      sendResponse({
        keepActive: s.keepActive,
        keepActiveIntervalSec: s.keepActiveIntervalSec,
        keepActiveMask: s.keepActiveMask,
        captureTeams: s.captureTeams,
        teamsChatsMode: s.teamsChatsMode,
        teamsChannelsMode: s.teamsChannelsMode,
        teamsMeetingsMode: s.teamsMeetingsMode,
        teamsMuteSelf: s.teamsMuteSelf,
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
  // Health is a claim about a capture that is now deliberately off; left in
  // place it decays into a permanent 'stale' warning in the popup.
  if (changes.captureTeams && changes.captureTeams.newValue === false) {
    try { await chrome.storage.session.remove('teamsHealth'); } catch {}
  }
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
        captureTeams: s.captureTeams,
        teamsChatsMode: s.teamsChatsMode,
        teamsChannelsMode: s.teamsChannelsMode,
        teamsMeetingsMode: s.teamsMeetingsMode,
        teamsMuteSelf: s.teamsMuteSelf,
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
