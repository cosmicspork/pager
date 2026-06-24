// ==UserScript==
// @name         Pager capture spike
// @namespace    pager.local
// @version      0.4.0
// @description  Validate capture of Teams/Outlook web notifications via the Notification API; forward to a local sink.
// @match        https://teams.microsoft.com/*
// @match        https://*.teams.microsoft.com/*
// @match        https://*.cloud.microsoft/*
// @match        https://outlook.office.com/*
// @match        https://outlook.office365.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @noframes
// ==/UserScript==

// We patch the page's real objects directly via unsafeWindow rather than
// injecting a <script> tag: strict CSP (Teams) blocks inline injection, and the
// failed injection was breaking the Teams app shell. GM_xmlhttpRequest runs in
// the extension context, so it bypasses the page's connect-src CSP too.

(function () {
  'use strict';
  const SINK = 'http://localhost:4500/capture';
  const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  function send(data) {
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: SINK,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(Object.assign({ host: location.host }, data)),
        onerror: function () { console.warn('[pager] sink unreachable at ' + SINK); },
      });
    } catch (e) { /* spike: never let forwarding break the page */ }
  }

  function grab(source, title, options) {
    const o = options || {};
    const rec = {
      source,
      title: String(title == null ? '' : title),
      body: o.body || null,
      tag: o.tag || null,
      icon: o.icon || null,
      ts: Date.now(),
    };
    console.log('[pager]', rec.source, rec.title, rec.body || '');
    send(rec);
  }

  // Notification constructor: wrap in a Proxy so native identity (instanceof,
  // .permission, requestPermission) is preserved and the app's init checks pass.
  try {
    const N = w.Notification;
    if (typeof N === 'function' && !N.__pagerWrapped) {
      const Wrapped = new Proxy(N, {
        construct(target, args) {
          try { grab('Notification', args[0], args[1]); } catch (e) {}
          return Reflect.construct(target, args);
        },
        get(target, prop) {
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      try { Object.defineProperty(Wrapped, '__pagerWrapped', { value: true }); } catch (e) {}
      w.Notification = Wrapped;
    }
  } catch (e) { console.warn('[pager] constructor patch skipped', e); }

  // Service-worker showNotification (page-side calls): patch the prototype method.
  try {
    const proto = w.ServiceWorkerRegistration && w.ServiceWorkerRegistration.prototype;
    if (proto && typeof proto.showNotification === 'function' && !proto.showNotification.__pagerWrapped) {
      const orig = proto.showNotification;
      const patched = function (title, options) {
        try { grab('showNotification', title, options); } catch (e) {}
        return orig.apply(this, arguments);
      };
      try { Object.defineProperty(patched, '__pagerWrapped', { value: true }); } catch (e) {}
      proto.showNotification = patched;
    }
  } catch (e) { console.warn('[pager] showNotification patch skipped', e); }

  // The MS apps post their notifications from inside their own service worker
  // (e.g. OWA's sw_webpush.js), which the patches above cannot see. But the page
  // can still read what a registration's SW posted via getNotifications(), so we
  // poll every registration and emit anything we haven't seen. This is the real
  // capture path for SW-origin notifications.
  const seen = new Set();
  let primed = false;
  let polls = 0;
  let maxNotesSeen = 0;
  async function pollSW() {
    try {
      const swc = w.navigator && w.navigator.serviceWorker;
      if (!swc || typeof swc.getRegistrations !== 'function') return;
      polls++;
      const regs = await swc.getRegistrations();
      let backlog = 0;
      let total = 0;
      for (const reg of regs) {
        let notes = [];
        try { notes = await reg.getNotifications(); } catch (e) { continue; }
        total += notes.length;
        for (const n of notes) {
          const key = (n.tag || '') + '|' + (n.timestamp || '') + '|' + (n.title || '') + '|' + (n.body || '');
          if (seen.has(key)) continue;
          seen.add(key);
          if (!primed) { backlog++; continue; } // skip pre-existing backlog on first poll
          grab('getNotifications', n.title, { body: n.body, tag: n.tag, icon: n.icon });
        }
      }
      if (total > maxNotesSeen) maxNotesSeen = total;
      if (!primed) {
        primed = true;
        send({ source: '__diag', title: 'getNotifications poller primed', body: 'registrations=' + regs.length + ' backlog_skipped=' + backlog, ts: Date.now() });
      }
      // Heartbeat every ~30s so we can see liveness, whether the API ever sees a
      // notification, and the tab's visibility (which governs timer throttling).
      if (polls % 20 === 0) {
        send({ source: '__diag', title: 'poller heartbeat', body: 'polls=' + polls + ' regs=' + regs.length + ' notesNow=' + total + ' maxNotesSeen=' + maxNotesSeen + ' visibility=' + (w.document && w.document.visibilityState), ts: Date.now() });
      }
    } catch (e) { /* spike: stay silent on poll errors */ }
  }
  setInterval(pollSW, 1500);
  pollSW();

  send({
    source: '__diag',
    title: 'pager tap installed',
    body: 'Notification=' + (typeof w.Notification) + ' permission=' + ((w.Notification && w.Notification.permission) || 'n/a'),
    ts: Date.now(),
  });
})();
