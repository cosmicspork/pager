// The other half of keep-active: input events alone do not stop Teams going
// Away, because it also watches whether the tab is visible, whether the window
// has focus, and — where the browser offers it — the Idle Detection API.
//
// Installed inert: configuration activates masking only while scheduled
// activity and the mask preference are both enabled.

(function () {
  'use strict';
  if (globalThis.__pagerKeepActiveMaskInstalled) return;
  globalThis.__pagerKeepActiveMaskInstalled = true;

  const MARK = '__pagerControl';
  const saved = {};
  let active = false;

  const LIFECYCLE_EVENTS = ['visibilitychange', 'freeze', 'resume', 'focus', 'blur'];

  // focus and blur reach their target through the capture phase on window, so
  // stopping every one of them here would take out focus handling for every
  // element on the page. Only the window/document-targeted events are the
  // presence signals this is meant to hide.
  function blockLifecycleEvent(ev) {
    if (ev.target !== window && ev.target !== document) return;
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
      for (const key of ['hidden', 'visibilityState', 'hasFocus']) {
        if (saved[key]) Object.defineProperty(Document.prototype, key, saved[key]);
        else delete Document.prototype[key];
      }
      if (saved.IdleDetector) Object.defineProperty(window, 'IdleDetector', saved.IdleDetector);
    } catch (e) {}
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d[MARK] !== true || d.control !== 'config') return;
    const c = d.config || {};
    if (c.keepActive && c.keepActiveMask) install();
    else restore();
  });

})();
