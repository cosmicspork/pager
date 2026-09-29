// The isolated world bridges page observations to the extension worker.
(() => {
  if (globalThis.__pagerRelayInstalled) return;
  globalThis.__pagerRelayInstalled = true;
  const toPage = (message) => {
    try { window.postMessage({ __pagerControl: true, ...message }, location.origin); } catch {}
  };
  window.addEventListener('message', async (message) => {
    if (message.source !== window || message.origin !== location.origin) return;
    const data = message.data;
    if (!data || typeof data !== 'object') return;
    if (data.__pagerEvent === true) {
      const ev = data.ev;
      if (!ev || typeof ev !== 'object' || !/^[0-9a-f-]{36}$/i.test(ev.eventId || '')) return;
      if (typeof ev.message?.body === 'string' && ev.message.body.length > 4 * 1024 * 1024) return;
      try {
        const ack = await chrome.runtime.sendMessage({ type: 'pager-event', ev });
        toPage({ control: 'ack', eventId: ev.eventId, ack });
      } catch { toPage({ control: 'ack', eventId: ev.eventId, ack: { ok: false, error: 'worker_unavailable' } }); }
    } else if (data.__pagerDiag === true && data.entry && typeof data.entry === 'object') {
      chrome.runtime.sendMessage({ type: 'pager-diag', source: data.source, entry: data.entry }).catch(() => {});
    } else if (data.__pagerRequest === true && /^[0-9a-f-]{36}$/i.test(data.requestId || '') &&
               ['pager-sync-get', 'pager-sync-put', 'pager-lease', 'pager-diag-list'].includes(data.request?.type)) {
      try {
        const response = await chrome.runtime.sendMessage(data.request);
        toPage({ control: 'response', requestId: data.requestId, response });
      } catch { toPage({ control: 'response', requestId: data.requestId, response: { ok: false } }); }
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'pager-control') return;
    if (['pulse', 'config', 'poll', 'reimport'].includes(message.control)) {
      toPage({ control: message.control, config: message.config });
    }
  });
  chrome.runtime.sendMessage({ type: 'pager-get-config' })
    .then((config) => { if (config) toPage({ control: 'config', config }); })
    .catch(() => {});
})();
