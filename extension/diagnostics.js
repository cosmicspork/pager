// Redacted operational diagnostics for the capture sources. Entries are
// bounded scalars only (never headers, tokens, subjects, bodies or addresses),
// kept in session storage for the options page and forwarded best effort to
// the collector. They never enter the durable capture outbox.

const KEY = 'diagnostics';
const SENT_KEY = 'diagnosticsSent';
const SEQ_KEY = 'diagnosticsSeq';
const MAX_ENTRIES = 500;
const MAX_SEND = 200;
const SOURCES = ['outlook', 'teams'];
const OUTCOMES = ['ok', 'error', 'info'];
const DETAIL_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

const text = (value, max) => typeof value === 'string' && value ? value.slice(0, max) : null;

export function sanitize(raw, source) {
  if (!raw || typeof raw !== 'object' || !SOURCES.includes(source)) return null;
  const op = text(raw.op, 64);
  if (!op) return null;
  const detail = {};
  if (raw.detail && typeof raw.detail === 'object' && !Array.isArray(raw.detail)) {
    for (const [key, value] of Object.entries(raw.detail).slice(0, 24)) {
      if (!DETAIL_KEY.test(key)) continue;
      if (value === null || typeof value === 'boolean' || Number.isFinite(value)) detail[key] = value;
      else if (typeof value === 'string') detail[key] = value.slice(0, 200);
    }
  }
  return {
    source,
    accountId: text(raw.accountId, 512),
    at: Number.isSafeInteger(raw.at) ? raw.at : Date.now(),
    op,
    outcome: OUTCOMES.includes(raw.outcome) ? raw.outcome : 'info',
    code: text(raw.code, 128),
    message: text(raw.message, 500),
    durationMs: Number.isSafeInteger(raw.durationMs) && raw.durationMs >= 0 ? raw.durationMs : null,
    detail,
  };
}

// Content scripts report in bursts; serialize read-modify-write of the ring.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

export function record(entry) {
  return serial(async () => {
    const stored = await chrome.storage.session.get([KEY, SEQ_KEY]);
    const entries = stored[KEY] || [];
    const seq = (stored[SEQ_KEY] || 0) + 1;
    entries.push({ ...entry, seq });
    await chrome.storage.session.set({ [KEY]: entries.slice(-MAX_ENTRIES), [SEQ_KEY]: seq });
  });
}

export function list(limit = MAX_ENTRIES) {
  return serial(async () => {
    const entries = (await chrome.storage.session.get(KEY))[KEY] || [];
    return entries.slice(-limit).reverse().map(({ seq, ...entry }) => entry);
  });
}

export function clear() {
  return serial(() => chrome.storage.session.set({ [KEY]: [] }));
}

export function flush({ collectorUrl, token, installationId }) {
  return serial(async () => {
    if (!token) return;
    const stored = await chrome.storage.session.get([KEY, SENT_KEY]);
    const sent = stored[SENT_KEY] || 0;
    const unsent = (stored[KEY] || []).filter((entry) => entry.seq > sent).slice(0, MAX_SEND);
    if (!unsent.length) return;
    try {
      const response = await fetch(new URL('/diagnostics', collectorUrl), {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ version: 1, installationId, entries: unsent.map(({ seq, ...entry }) => entry) }),
      });
      // A collector without the endpoint (404) or a rejected batch (400) is not
      // worth retrying forever; either way the options page still has the log.
      if (response.ok || [400, 404, 413].includes(response.status)) {
        await chrome.storage.session.set({ [SENT_KEY]: unsent.at(-1).seq });
      }
    } catch {}
  });
}
