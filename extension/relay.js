// Isolated-world bridge between the MAIN-world scripts and the extension
// service worker. The MAIN-world scripts can't reach chrome.* APIs; this can.
//
// Both directions run through here: captured events out to the worker, and
// control messages (keep-alive pokes, config changes) back into the page.

const CONTROL = '__pagerControl';

function toPage(msg) {
  try {
    window.postMessage(Object.assign({ [CONTROL]: true }, msg), location.origin);
  } catch (e) {}
}

// MAIN world → service worker.
window.addEventListener('message', function (ev) {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.__pagerEvent !== true || !d.ev) return;
  try { chrome.runtime.sendMessage({ type: 'pager-event', ev: d.ev }); } catch (e) {}
});

// Service worker → MAIN world.
chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.type !== 'pager-control') return;
  if (msg.control === 'pulse') toPage({ control: 'pulse' });
  else if (msg.control === 'config') toPage({ control: 'config', config: msg.config });
});

// The MAIN-world scripts start on their built-in defaults because they can't
// read storage. Pull the real config once on load and hand it over.
try {
  chrome.runtime.sendMessage({ type: 'pager-get-config' }, function (config) {
    if (chrome.runtime.lastError || !config) return;
    toPage({ control: 'config', config: config });
  });
} catch (e) {}
