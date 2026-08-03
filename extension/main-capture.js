// Runs in the page's MAIN world (declared in the manifest), so it patches the
// objects the app actually calls without inline <script> injection — which
// Teams' CSP blocks. It only reads; it never alters the app's behavior. Captured
// events are posted to the isolated relay via window.postMessage; the relay and
// service worker handle getting them to the local bridge (page CSP blocks a
// direct localhost fetch from here).

(function () {
  'use strict';
  const MARK = '__pagerEvent';
  const RS = String.fromCharCode(30); // SignalR frame terminator (\x1e)
  const IS_OUTLOOK = /(^|\.)outlook\./.test(location.host);

  function emit(ev) {
    try {
      window.postMessage({ [MARK]: true, ev: Object.assign({ host: location.host, ts: Date.now() }, ev) }, location.origin);
    } catch (e) {}
  }

  // Teams posts chat notifications through the page-context Notification API.
  try {
    const N = window.Notification;
    if (typeof N === 'function' && !N.__pagerWrapped) {
      const Wrapped = new Proxy(N, {
        construct(target, args) {
          try {
            const o = args[1] || {};
            emit({ source: 'teams', title: String(args[0] == null ? '' : args[0]), body: o.body || null, tag: o.tag || null });
          } catch (e) {}
          return Reflect.construct(target, args);
        },
        get(target, prop) { const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v; },
      });
      try { Object.defineProperty(Wrapped, '__pagerWrapped', { value: true }); } catch (e) {}
      window.Notification = Wrapped;
    }
  } catch (e) {}

  // Outlook pushes new-mail events over /owa/notificationchannel as SignalR
  // over SSE: one long-lived streaming GET whose body is a sequence of
  // RS-terminated, "data:"-prefixed SignalR frames. We read the stream
  // incrementally, buffering across chunks since a frame can span reads.
  //
  // The fetch patch below is gated to Outlook hosts: nothing on Teams matches
  // that URL, so there the wrapper would sit in the hot path of every request
  // and put this file at the top of every failed-fetch stack trace — which
  // reads as "the extension broke Teams" when the failure is Teams' own.
  function handleFrame(frame) {
    let s = frame.trim();
    if (!s) return;
    if (s.indexOf('data:') === 0) s = s.slice(5).trim();
    let obj;
    try { obj = JSON.parse(s); } catch (e) { return; }
    if (!obj || obj.type !== 1 || obj.target !== 'syncMessage') return;
    const list = obj.arguments && obj.arguments[0];
    if (!Array.isArray(list)) return;
    list.forEach(function (item) {
      const c = item && item.Conversation;
      if (!c) return;
      const sender = Array.isArray(c.UniqueSenders) ? c.UniqueSenders.join(', ') : '';
      if (!sender && !c.ConversationTopic) return; // drop folder/non-mail syncs
      emit({
        source: 'outlook',
        title: sender + ' — ' + (c.ConversationTopic || '(no subject)'),
        body: 'unread=' + (c.GlobalUnreadCount != null ? c.GlobalUnreadCount : '?'),
        sender: c.UniqueSenders || null,
        subject: c.ConversationTopic || null,
        conversationId: (c.ConversationId && c.ConversationId.Id) || null,
        lastDelivery: c.LastDeliveryTime || null,
        unread: c.GlobalUnreadCount,
        hasAttachments: c.HasAttachments,
        importance: c.Importance,
      });
    });
  }

  try {
    const origFetch = window.fetch;
    if (IS_OUTLOOK && origFetch && !origFetch.__pagerWrapped) {
      const wrapped = function (input, init) {
        let url;
        try { url = (typeof input === 'string') ? input : (input && input.url); } catch (e) {}
        const p = origFetch.apply(this, arguments);
        try {
          if (url && /\/owa\/notificationchannel/.test(url) && !/negotiate/.test(url)) {
            p.then(function (resp) {
              try {
                const body = resp.clone().body;
                if (!body || !body.getReader) return;
                const reader = body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                (function pump() {
                  reader.read().then(function (r) {
                    if (r.done) return;
                    try {
                      buf += dec.decode(r.value, { stream: true });
                      let i;
                      while ((i = buf.indexOf(RS)) >= 0) {
                        handleFrame(buf.slice(0, i));
                        buf = buf.slice(i + 1);
                      }
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
      window.fetch = wrapped;
    }
  } catch (e) {}

  emit({ source: '__diag', title: 'pager extension capture installed', body: 'host=' + location.host });
})();
