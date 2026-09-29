// Owns capture registration and persists observations before delivering them
// to the private loopback collector. Downstream paging belongs to the collector.

import {
  DEFAULTS,
  TEAMS_MATCHES,
  OUTLOOK_MATCHES,
  getSettings,
  effectiveSchedule,
} from './settings.js';
import { enqueue, getBatch, acknowledge, pending, getSync, putSync, resetLedgers, stripNotification } from './outbox.js';
import * as diagnostics from './diagnostics.js';

const COLLECTOR_URL = 'http://localhost:4501/capture';
const ALLOWED = {
  teams: [/^teams\.microsoft\.com$/, /^.+\.teams\.microsoft\.com$/, /^teams\.cloud\.microsoft$/],
  outlook: [/^outlook\.office\.com$/, /^outlook\.office365\.com$/, /^outlook\.cloud\.microsoft$/],
};

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
  const teamsMain = [];
  if (['scheduled', 'always_on'].includes(s.keepActiveMode) && !s.keepActiveInvalid) {
    teamsMain.push('keep-active-mask.js', 'keep-active.js');
  }

  const outlookMain = s.captureOutlook ? ['outlook-read.js', 'main-capture.js'] : [];

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

function runtimeConfig(s) {
  return {
    keepActive: effectiveSchedule(s).keepActive,
    keepActiveIntervalSec: s.keepActiveIntervalSec,
    keepActiveMask: s.keepActiveMask,
    captureTeams: s.captureTeams,
    teamsChatsMode: s.teamsChatsMode,
    teamsChannelsMode: s.teamsChannelsMode,
    teamsMeetingsMode: s.teamsMeetingsMode,
    teamsMuteSelf: s.teamsMuteSelf,
    debugProbe: s.debugProbe,
  };
}

function pagingEligible(candidate, s) {
  const age = Date.now() - candidate.sourceTime;
  return effectiveSchedule(s).pagingAllowed && age >= -120000 && age <= 600000;
}

async function syncAlarm() {
  const s = await settings();
  if (['scheduled', 'always_on'].includes(s.keepActiveMode) || s.captureTeams || s.captureOutlook || (await pending()).count) {
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
  await broadcast({ type: 'pager-control', control: 'config', config: runtimeConfig(s) }, [...TEAMS_MATCHES, ...OUTLOOK_MATCHES]);
  if (effectiveSchedule(s).keepActive) await broadcast({ type: 'pager-control', control: 'pulse' }, TEAMS_MATCHES);
  if (s.captureTeams) await broadcast({ type: 'pager-control', control: 'poll' }, TEAMS_MATCHES);
  if (s.captureOutlook) await broadcast({ type: 'pager-control', control: 'poll' }, OUTLOOK_MATCHES);
  await drain();
  await flushDiagnostics();
});

// A worker restart may happen between the source's send and its ack. The
// eventId is generated by the source and is the durable IndexedDB key.
async function recordStatus(patch) {
  const cur = (await chrome.storage.session.get('status')).status || {};
  await chrome.storage.session.set({ status: { ...cur, ...patch } });
}

function validLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/capture';
  } catch { return false; }
}

function trustedSender(sender, source) {
  try {
    const url = new URL(sender.tab.url);
    return url.protocol === 'https:' && ALLOWED[source]?.some((pattern) => pattern.test(url.hostname));
  } catch { return false; }
}

function validEvent(ev, sender) {
  if (!ev || !trustedSender(sender, ev.source)) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ev.eventId || '')) return false;
  if (!ev.accountId || !Number.isSafeInteger(ev.observedAt)) return false;
  return { message: 'message', conversation: 'conversation', status: 'status' }[ev.kind] &&
    !!ev[ev.kind] && ['message', 'conversation', 'status'].filter((field) => ev[field] != null).length === 1;
}

let installation;
async function installationId() {
  if (!installation) installation = (async () => {
    const local = await chrome.storage.local.get('installationId');
    if (local.installationId) return local.installationId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ installationId: id });
    return id;
  })();
  return installation;
}

async function flushDiagnostics() {
  const local = await chrome.storage.local.get(['collectorUrl', 'collectorToken']);
  const collectorUrl = local.collectorUrl || COLLECTOR_URL;
  if (!validLocalUrl(collectorUrl)) return;
  await diagnostics.flush({ collectorUrl, token: local.collectorToken, installationId: await installationId() });
}
let flushTimer;
function scheduleDiagnosticsFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushDiagnostics().catch(() => {}); }, 2000);
}

let draining;
let paused = false;
async function drain() {
  if (draining || paused) return draining;
  draining = (async () => {
    const local = await chrome.storage.local.get(['collectorUrl', 'collectorToken', 'archiveId']);
    const collectorUrl = local.collectorUrl || COLLECTOR_URL;
    if (!validLocalUrl(collectorUrl) || !local.collectorToken) {
      await recordStatus({ collectorOk: false, collectorError: 'collector_not_configured', pending: (await pending()).count });
      return;
    }
    const health = await fetch(new URL('/health', collectorUrl), { redirect: 'error' });
    if (!health.ok) throw new Error('collector_unavailable');
    const identity = await health.json();
    if (!identity.ok || !identity.archiveId) throw new Error('collector_unavailable');
    if (local.archiveId && local.archiveId !== identity.archiveId) {
      await resetLedgers();
      await broadcast({ type: 'pager-control', control: 'reimport' }, [...TEAMS_MATCHES, ...OUTLOOK_MATCHES]);
    }
    await chrome.storage.local.set({ archiveId: identity.archiveId });
    const s = await settings();
    const id = await installationId();
    while (true) {
      const batch = await getBatch(id, s.bridgeUrl);
      let stripped = false;
      const current = await settings();
      for (const event of batch) {
        if (event.notification && !pagingEligible(event.notification, current)) {
          await stripNotification(event.eventId);
          stripped = true;
        }
      }
      if (stripped) continue;
      if (!batch.length) break;
      const response = await fetch(collectorUrl, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${local.collectorToken}` },
        body: JSON.stringify({ version: 1, installationId: id, bridgeUrl: s.bridgeUrl, events: batch }),
      });
      if (!response.ok) {
        if ([400, 401, 409, 413].includes(response.status)) paused = true;
        throw new Error('collector_http_' + response.status);
      }
      const result = await response.json();
      if (result.archiveId !== identity.archiveId || !Array.isArray(result.acceptedEventIds)) throw new Error('collector_bad_ack');
      const submitted = new Set(batch.map((event) => event.eventId));
      const accepted = result.acceptedEventIds.filter((eventId) => submitted.has(eventId));
      if (!accepted.length) throw new Error('collector_bad_ack');
      await acknowledge(accepted);
      await recordStatus({ collectorOk: true, collectorError: null, pending: (await pending()).count, lastEventAt: Date.now() });
    }
    await recordStatus({ collectorOk: true, collectorError: null, pending: 0 });
  })().catch(async (error) => {
    await recordStatus({ collectorOk: false, collectorError: error.message?.startsWith('collector_') ? error.message : 'collector_unavailable', pending: (await pending()).count });
  }).finally(() => { draining = null; });
  return draining;
}

const leases = new Map();
function lease(key, tabId) {
  const now = Date.now();
  const holders = leases.get(key) || new Map();
  for (const [id, at] of holders) if (now - at > 90000) holders.delete(id);
  holders.set(tabId, now);
  leases.set(key, holders);
  return tabId === Math.min(...holders.keys());
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'pager-event') {
    if (!validEvent(msg.ev, sender)) { sendResponse({ ok: false, error: 'invalid_capture', eventId: msg.ev?.eventId }); return; }
    settings().then((s) => {
      const event = structuredClone(msg.ev);
      if (event.notification && !pagingEligible(event.notification, s)) delete event.notification;
      return enqueue(event);
    }).then(async (eventId) => {
      if (msg.ev.kind === 'status' && msg.ev.source === 'outlook') {
        await chrome.storage.session.set({ outlookHealth: { state: msg.ev.status.state, reason: msg.ev.status.reason, at: Date.now() } }).catch(() => {});
      }
      sendResponse({ ok: true, eventId });
      drain();
      await syncAlarm();
    }).catch(async (error) => {
      const reason = error.message === 'outbox_full' ? 'outbox_full' : 'outbox_error';
      await recordStatus({ collectorOk: false, collectorError: reason });
      sendResponse({ ok: false, eventId: msg.ev.eventId, error: reason });
    });
    return true;
  }
  if (msg.type === 'pager-diag') {
    if (!trustedSender(sender, msg.source)) return;
    const entry = diagnostics.sanitize(msg.entry, msg.source);
    if (entry) diagnostics.record(entry).then(scheduleDiagnosticsFlush).catch(() => {});
    return;
  }
  if (msg.type === 'pager-diag-list') {
    const fromExtension = sender.url?.startsWith('chrome-extension://');
    if (!fromExtension && !trustedSender(sender, msg.source)) return;
    settings().then(async (s) => {
      if (!fromExtension && !s.debugProbe) return sendResponse({ ok: false, error: 'debug_disabled' });
      const limit = Number.isSafeInteger(msg.limit) && msg.limit > 0 ? Math.min(msg.limit, 500) : 500;
      sendResponse({ ok: true, entries: await diagnostics.list(limit) });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'pager-diag-clear' && sender.url?.startsWith('chrome-extension://')) {
    diagnostics.clear().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'pager-health') {
    if (!trustedSender(sender, 'teams')) return;
    chrome.storage.session.set({ teamsHealth: msg.health }).finally(() => sendResponse());
    return true;
  }
  if (msg.type === 'pager-lease') {
    if (!trustedSender(sender, msg.source) || !msg.accountId || !sender.tab?.id) return;
    sendResponse({ elected: lease(msg.source + ':' + msg.accountId, sender.tab.id) });
    return;
  }
  if (msg.type === 'pager-sync-get' || msg.type === 'pager-sync-put') {
    if (!trustedSender(sender, msg.source) || !msg.accountId || typeof msg.key !== 'string' ||
        !/^(revision|import|body):/.test(msg.key) || msg.key.length > 4096 ||
        !msg.key.includes(':' + msg.source + ':' + msg.accountId + ':')) return;
    const op = msg.type === 'pager-sync-get' ? getSync(msg.key) :
      putSync(msg.key, msg.value).then(() => true);
    op.then((value) => sendResponse({ ok: true, value }))
      .catch(() => sendResponse({ ok: false, error: 'sync_error' }));
    return true;
  }
  if (msg.type === 'pager-reimport' && sender.url?.startsWith('chrome-extension://')) {
    resetLedgers().then(async () => {
      await broadcast({ type: 'pager-control', control: 'reimport' }, [...TEAMS_MATCHES, ...OUTLOOK_MATCHES]);
      sendResponse({ ok: true });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'pager-outbox-status' && sender.url?.startsWith('chrome-extension://')) {
    pending().then((value) => sendResponse(value));
    return true;
  }
  if (msg.type === 'pager-get-config') {
    settings().then((s) => sendResponse(runtimeConfig(s)));
    return true;
  }
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

async function activateOpenTeams(s) {
  if (!['scheduled', 'always_on'].includes(s.keepActiveMode) || s.keepActiveInvalid) return;
  for (const tab of await chrome.tabs.query({ url: TEAMS_MATCHES })) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['relay.js'], world: 'ISOLATED' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['keep-active-mask.js', 'keep-active.js'], world: 'MAIN' });
      await chrome.tabs.sendMessage(tab.id, { type: 'pager-control', control: 'config', config: runtimeConfig(s) });
    } catch {}
  }
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && (changes.collectorUrl || changes.collectorToken)) {
    paused = false;
    await drain();
    return;
  }
  if (area !== 'sync') return;
  if (!Object.keys(changes).some((k) => k in DEFAULTS)) return;
  cached = null;
  const s = await settings();
  await syncRegistrations();
  if (changes.keepActiveMode || changes.keepActiveMask) await activateOpenTeams(s);
  await syncAlarm();
  // Health is a claim about a capture that is now deliberately off; left in
  // place it decays into a permanent 'stale' warning in the popup.
  if (changes.captureTeams && changes.captureTeams.newValue === false) {
    try { await chrome.storage.session.remove('teamsHealth'); } catch {}
  }
  if (changes.captureOutlook && changes.captureOutlook.newValue === false) {
    try { await chrome.storage.session.remove('outlookHealth'); } catch {}
  }
  // Tabs already open still have the old scripts in them; tell them the new
  // config so a toggle takes effect without a reload.
  await broadcast({ type: 'pager-control', control: 'config', config: runtimeConfig(s) }, [...TEAMS_MATCHES, ...OUTLOOK_MATCHES]);
  await drain();
});

chrome.runtime.onInstalled.addListener(async () => {
  await syncRegistrations();
  await syncAlarm();
  await drain();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncRegistrations();
  await syncAlarm();
  await drain();
});
