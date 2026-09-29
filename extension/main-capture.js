// MAIN-world Outlook observation. The adapter's authentication templates stay
// inside outlook-read.js; only normalized archive events cross postMessage.
(() => {
  'use strict';
  if (globalThis.__pagerOutlookCaptureInstalled) return;
  globalThis.__pagerOutlookCaptureInstalled = true;
  if (!/(^|\.)outlook\./.test(location.host)) return;
  const adapter = window.__pagerOutlookRead;
  if (!adapter) return;
  const RS = String.fromCharCode(30);
  const pending = new Map();
  const unattributed = [];
  const requests = new Map();

  function emit(event) {
    const key = event.kind + ':' + event.accountId + ':' + (event.message?.messageId || event.conversation?.conversationId || event.status?.state);
    let item = pending.get(key);
    if (!item) {
      item = { event: { ...event, eventId: crypto.randomUUID() }, done: null };
      pending.set(key, item);
    }
    return new Promise((resolve) => {
      item.done = resolve;
      const send = () => window.postMessage({ __pagerEvent: true, ev: item.event }, location.origin);
      send();
      setTimeout(() => { if (pending.get(key) === item) { send(); resolve(false); } }, 5000);
    });
  }
  function worker(request) {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      requests.set(requestId, resolve);
      window.postMessage({ __pagerRequest: true, requestId, request }, location.origin);
      setTimeout(() => { if (requests.delete(requestId)) resolve({ ok: false }); }, 10000);
    });
  }
  function diag(entry) {
    window.postMessage({ __pagerDiag: true, source: 'outlook', entry }, location.origin);
  }
  adapter.install({ emit, worker, diag });
  // Console surface for debugging capture; only present while enabled in settings.
  const debugApi = Object.freeze({
    probe: (action, body) => adapter.probe(action, body),
    diagnostics: async (limit = 50) => {
      const response = await worker({ type: 'pager-diag-list', source: 'outlook', limit });
      if (!response?.ok) throw new Error(response?.error || 'diagnostics unavailable');
      return response.entries;
    },
  });
  function setDebug(enabled) {
    adapter.setProbeEnabled(enabled);
    if (enabled) Object.defineProperty(window, '__pagerDebug', { value: debugApi, configurable: true });
    else delete window.__pagerDebug;
  }
  window.addEventListener('message', (message) => {
    if (message.source !== window || message.origin !== location.origin || message.data?.__pagerControl !== true) return;
    const data = message.data;
    if (data.control === 'ack' && data.eventId) {
      for (const [key, item] of pending) {
        if (item.event.eventId !== data.eventId) continue;
        if (data.ack?.ok && data.ack.eventId === data.eventId) pending.delete(key);
        item.done?.(!!data.ack?.ok);
        break;
      }
    }
    if (data.control === 'response' && requests.has(data.requestId)) {
      requests.get(data.requestId)(data.response);
      requests.delete(data.requestId);
    }
    if (data.control === 'config' && typeof data.config?.captureOutlook === 'boolean') adapter.setEnabled(data.config.captureOutlook);
    if (data.control === 'config' && typeof data.config?.debugProbe === 'boolean') setDebug(data.config.debugProbe);
    if (data.control === 'poll') adapter.poll();
    if (data.control === 'reimport') adapter.reimport();
  });

  function handleFrame(frame) {
    let text = frame.trim();
    if (text.startsWith('data:')) text = text.slice(5).trim();
    let object;
    try { object = JSON.parse(text); } catch { return; }
    if (object?.type !== 1 || object.target !== 'syncMessage' || !Array.isArray(object.arguments?.[0])) return;
    for (const item of object.arguments[0]) {
      const conversation = item?.Conversation;
      if (!conversation) continue;
      if (!adapter.hasAccount()) {
        if (unattributed.length < 500) unattributed.push(conversation);
      } else adapter.conversation(conversation);
    }
  }
  function drainUnattributed() {
    if (!adapter.hasAccount()) return;
    for (const item of unattributed.splice(0)) adapter.conversation(item);
  }
  const originalFetch = window.fetch;
  if (!originalFetch || originalFetch.__pagerWrapped) return;
  const wrapped = function (input, init) {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input?.url || '', location.origin); } catch {}
    try { adapter.observe(input, init, originalFetch); drainUnattributed(); } catch {}
    const response = originalFetch.apply(this, arguments);
    if (url?.origin === location.origin && url.pathname.includes('/owa/notificationchannel') && !url.pathname.includes('negotiate')) {
      response.then((value) => {
        const reader = value.clone().body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffered = '';
        const pump = () => reader.read().then(({ done, value: chunk }) => {
          if (done) return;
          buffered += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffered.indexOf(RS)) !== -1) {
            handleFrame(buffered.slice(0, end));
            buffered = buffered.slice(end + 1);
          }
          pump();
        }).catch(() => {});
        pump();
      }).catch(() => {});
    }
    return response;
  };
  Object.defineProperty(wrapped, '__pagerWrapped', { value: true });
  window.fetch = wrapped;
})();
