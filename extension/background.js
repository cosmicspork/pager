// Forwards captured events to the local Pager bridge. Runs in the extension
// context, so its fetch is not subject to the page's connect-src CSP.

const BRIDGE_URL = "http://localhost:4500/capture";
const DEDUP_TTL_MS = 120000;

// The notification channel re-emits the same conversation several times (read
// syncs, unread-count flaps). Collapse repeats by conversation + delivery time
// within a short window so one new message is one event.
const recent = new Map();
function isDuplicate(ev) {
  if (!ev || ev.source === "__diag") return false;
  const now = ev.ts || Date.now();
  for (const [k, t] of recent) if (now - t > DEDUP_TTL_MS) recent.delete(k);
  const sig = [ev.source, ev.conversationId || ev.tag || "", ev.lastDelivery || "", ev.title || "", ev.body || ""].join("|");
  if (recent.has(sig)) return true;
  recent.set(sig, now);
  return false;
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.type !== "pager-event") return;
  if (isDuplicate(msg.ev)) return;
  fetch(BRIDGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg.ev),
  }).catch(function () {});
});
