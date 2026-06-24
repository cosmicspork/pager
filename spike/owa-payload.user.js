// ==UserScript==
// @name         Pager — OWA notificationchannel payload
// @namespace    pager.local
// @version      0.2.0
// @description  Read Outlook web's notificationchannel responses to see the new-mail event shape. Outlook only. Captures real event content to the LOCAL sink (your own mail data).
// @match        https://outlook.office.com/*
// @match        https://outlook.office365.com/*
// @match        https://outlook.cloud.microsoft/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @noframes
// ==/UserScript==

// Discovery step 2: the channel-inventory spike showed OWA pushes live events
// over /owa/notificationchannel (SignalR-style long-poll). Here we clone those
// fetch responses and forward the body so we can see what a new-mail event
// actually contains. We clone (never consume) the app's stream. Snippets are
// capped; this is your own mailbox data going only to the local sink.

(function () {
  'use strict';
  const SINK = 'http://localhost:4500/capture';
  const CAP = 4000;
  const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  function send(source, title, body) {
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: SINK,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ host: location.host, source, title: String(title || ''), body: body == null ? null : String(body).slice(0, CAP), ts: Date.now() }),
        onerror: function () {},
      });
    } catch (e) {}
  }
  function shortUrl(u) {
    try { const x = new URL(u, location.href); return x.host + x.pathname; } catch (e) { return String(u).slice(0, 120); }
  }

  try {
    const origFetch = w.fetch;
    if (origFetch && !origFetch.__pagerWrapped) {
      const wrapped = function (input, init) {
        let url;
        try { url = (typeof input === 'string') ? input : (input && input.url); } catch (e) {}
        const p = origFetch.apply(this, arguments);
        try {
          if (url && /\/owa\/notificationchannel/.test(url) && !/negotiate/.test(url)) {
            p.then(function (resp) {
              try {
                // The channel is a single long-lived streaming GET: read the body
                // incrementally and forward each chunk as events arrive, rather
                // than awaiting the whole response (which never finishes).
                const body = resp.clone().body;
                if (!body || !body.getReader) {
                  resp.clone().text().then(function (t) { if (t) send('owa-nc', shortUrl(url), t); }).catch(function () {});
                  return;
                }
                const reader = body.getReader();
                const dec = new TextDecoder();
                (function pump() {
                  reader.read().then(function (r) {
                    if (r.done) { send('__diag', 'owa-nc stream ended', shortUrl(url)); return; }
                    try {
                      const chunk = dec.decode(r.value, { stream: true });
                      if (chunk && chunk.trim()) send('owa-nc', shortUrl(url), chunk);
                    } catch (e) {}
                    pump();
                  }).catch(function () {});
                })();
              } catch (e) {}
            }).catch(function () {});
          }
        } catch (e) {}
        return p;
      };
      try { Object.defineProperty(wrapped, '__pagerWrapped', { value: true }); } catch (e) {}
      w.fetch = wrapped;
    }
  } catch (e) { send('__diag', 'owa fetch patch skipped', String(e)); }

  send('__diag', 'owa payload tap installed', 'host=' + location.host);
})();
