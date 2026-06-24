// ==UserScript==
// @name         Pager — channel discovery
// @namespace    pager.local
// @version      0.1.0
// @description  Inventory WebSocket/fetch/XHR channels on Teams/Outlook web to find the one carrying chat/mail events. Logs structure (URLs, sizes, JSON top-level keys) only — never message content.
// @match        https://teams.microsoft.com/*
// @match        https://*.teams.microsoft.com/*
// @match        https://*.teams.cloud.microsoft/*
// @match        https://*.cloud.microsoft/*
// @match        https://outlook.office.com/*
// @match        https://outlook.office365.com/*
// @match        https://outlook.cloud.microsoft/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @noframes
// ==/UserScript==

// Discovery only: identify which channel carries new chat/mail events. We log
// connection URLs, per-channel message counts/sizes, and the top-level JSON keys
// of messages (keys, not values). No message bodies leave the page. Patches are
// pure wrappers via unsafeWindow: always call through, never alter args/returns.

(function () {
  'use strict';
  const SINK = 'http://localhost:4500/capture';
  const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const FETCH_INTEREST = /trouter|notif|stream|poll|messag|event|presence|mail|push|websocket|inbox|channel|long/i;

  function send(source, title, body) {
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: SINK,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ host: location.host, source, title: String(title || ''), body: body == null ? null : String(body), ts: Date.now() }),
        onerror: function () {},
      });
    } catch (e) {}
  }

  function shortUrl(u) {
    try { const x = new URL(u, location.href); return x.host + x.pathname; } catch (e) { return String(u).slice(0, 120); }
  }
  function topKeys(str) {
    try {
      const o = JSON.parse(str);
      if (o && typeof o === 'object') return Object.keys(Array.isArray(o) ? (o[0] || {}) : o).slice(0, 16);
    } catch (e) {}
    return null;
  }

  // Per-channel rollups, flushed every 10s so a chatty socket can't flood the sink.
  const chans = new Map();
  function bump(kind, url, len, keys) {
    const key = kind + ' ' + shortUrl(url);
    let c = chans.get(key);
    if (!c) { c = { count: 0, bytes: 0, max: 0, keys: new Set() }; chans.set(key, c); }
    c.count++; c.bytes += len || 0; if (len > c.max) c.max = len;
    if (keys) keys.forEach((k) => c.keys.add(k));
  }
  setInterval(function () {
    for (const [key, c] of chans) {
      send('chan', key, 'msgs=' + c.count + ' max=' + c.max + 'B keys=[' + Array.from(c.keys).slice(0, 20).join(',') + ']');
    }
  }, 10000);

  // WebSocket — the prime suspect for real-time chat. Tap every inbound message.
  try {
    const OrigWS = w.WebSocket;
    if (OrigWS && !OrigWS.__pagerWrapped) {
      const WrappedWS = new Proxy(OrigWS, {
        construct(target, args) {
          const url = args[0];
          try { send('ws-open', shortUrl(url), 'protocols=' + JSON.stringify(args[1] || null)); } catch (e) {}
          const ws = Reflect.construct(target, args);
          try {
            ws.addEventListener('message', function (ev) {
              try {
                const d = ev.data;
                if (typeof d === 'string') {
                  const keys = topKeys(d);
                  bump('WS', url, d.length, keys);
                  if (d.length > 600) send('ws-big', shortUrl(url), 'len=' + d.length + ' keys=[' + (keys ? keys.join(',') : '?') + ']');
                } else if (d && d.byteLength != null) {
                  bump('WS-bin', url, d.byteLength, null);
                } else {
                  bump('WS-other', url, 0, null);
                }
              } catch (e) {}
            });
          } catch (e) {}
          return ws;
        },
        get(target, prop) { const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v; },
      });
      try { Object.defineProperty(WrappedWS, '__pagerWrapped', { value: true }); } catch (e) {}
      w.WebSocket = WrappedWS;
    }
  } catch (e) { send('__diag', 'ws patch skipped', String(e)); }

  // fetch — inventory only requests whose path looks notification/stream-ish.
  try {
    const origFetch = w.fetch;
    if (origFetch && !origFetch.__pagerWrapped) {
      const wrapped = function (input, init) {
        try {
          const url = (typeof input === 'string') ? input : (input && input.url);
          const method = (init && init.method) || (input && input.method) || 'GET';
          if (url && FETCH_INTEREST.test(url)) bump('fetch:' + method, url, 0, null);
        } catch (e) {}
        return origFetch.apply(this, arguments);
      };
      try { Object.defineProperty(wrapped, '__pagerWrapped', { value: true }); } catch (e) {}
      w.fetch = wrapped;
    }
  } catch (e) { send('__diag', 'fetch patch skipped', String(e)); }

  // XHR — same interest filter (OWA has historically used a streaming XHR channel).
  try {
    const XP = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
    if (XP && XP.open && !XP.open.__pagerWrapped) {
      const origOpen = XP.open;
      const newOpen = function (method, url) {
        try { this.__pagerMU = { method: method, url: url }; } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      try { Object.defineProperty(newOpen, '__pagerWrapped', { value: true }); } catch (e) {}
      XP.open = newOpen;
      const origSend = XP.send;
      XP.send = function () {
        try {
          const mu = this.__pagerMU;
          if (mu && mu.url && FETCH_INTEREST.test(mu.url)) bump('xhr:' + mu.method, mu.url, 0, null);
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) { send('__diag', 'xhr patch skipped', String(e)); }

  send('__diag', 'discovery tap installed', 'host=' + location.host);
})();
