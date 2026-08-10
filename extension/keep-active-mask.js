// The other half of keep-active: input events alone do not stop Teams going
// Away, because it also watches whether the tab is visible, whether the window
// has focus, and — where the browser offers it — the Idle Detection API.
//
// This masks those three signals. It has to run synchronously at
// document_start, before the app reads or caches any of them, which is why it
// is a separate file from keep-active.js: its "am I enabled?" answer is
// whether background.js registered it at all, with no async settings read in
// between.
//
// This is the most invasive thing the extension does — it changes what the
// page observes rather than only reading. Everything patched here is restored
// on a live toggle-off, and it is only ever registered for Teams hosts.

(function () {
  'use strict';

  const MARK = '__pagerControl';
  const saved = {};
  let active = false;

  const LIFECYCLE_EVENTS = ['visibilitychange', 'freeze', 'resume', 'focus', 'blur'];

  function blockLifecycleEvent(ev) {
    ev.stopImmediatePropagation();
  }

  function setLifecycleBlockers(enabled) {
    const method = enabled ? 'addEventListener' : 'removeEventListener';
    for (const target of [window, document]) {
      for (const type of LIFECYCLE_EVENTS) target[method](type, blockLifecycleEvent, true);
    }
  }

  function install() {
    if (active) return;
    active = true;

    try {
      saved.hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      saved.visibilityState = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
      Object.defineProperty(Document.prototype, 'hidden', {
        configurable: true,
        get: function () { return false; },
      });
      Object.defineProperty(Document.prototype, 'visibilityState', {
        configurable: true,
        get: function () { return 'visible'; },
      });
    } catch (e) {}

    try {
      saved.hasFocus = Object.getOwnPropertyDescriptor(Document.prototype, 'hasFocus');
      Object.defineProperty(Document.prototype, 'hasFocus', {
        configurable: true,
        value: function () { return true; },
      });
    } catch (e) {}

    // Register capturing handlers before the app's scripts. This blocks every
    // supported focus/visibility path without discarding registrations, so a
    // live toggle-off restores the page's original listeners as well as APIs.
    try {
      setLifecycleBlockers(true);
    } catch (e) {}

    // Idle Detection reports OS-level idle, which no amount of synthetic page
    // input affects. Where the app can reach it, answer active/unlocked.
    try {
      saved.IdleDetector = Object.getOwnPropertyDescriptor(window, 'IdleDetector');
      if (saved.IdleDetector) {
        const Fake = class extends EventTarget {
          get userState() { return 'active'; }
          get screenState() { return 'unlocked'; }
          async start() { return undefined; }
          static async requestPermission() { return 'granted'; }
        };
        Object.defineProperty(window, 'IdleDetector', {
          configurable: true, writable: true, value: Fake,
        });
      }
    } catch (e) {}
  }

  function restore() {
    if (!active) return;
    active = false;
    try {
      setLifecycleBlockers(false);
      if (saved.hidden) Object.defineProperty(Document.prototype, 'hidden', saved.hidden);
      if (saved.visibilityState) Object.defineProperty(Document.prototype, 'visibilityState', saved.visibilityState);
      if (saved.hasFocus) Object.defineProperty(Document.prototype, 'hasFocus', saved.hasFocus);
      if (saved.IdleDetector) Object.defineProperty(window, 'IdleDetector', saved.IdleDetector);
    } catch (e) {}
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[MARK] !== true || d.control !== 'config') return;
    const c = d.config || {};
    if (c.keepActive && c.keepActiveMask) install();
    else restore();
  });

  install();
})();
