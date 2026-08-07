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

  function suppressed(target, type) {
    return (
      (target === document && type === 'visibilitychange') ||
      (target === window && (type === 'freeze' || type === 'resume'))
    );
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
      saved.hasFocus = Document.prototype.hasFocus;
      Document.prototype.hasFocus = function () { return true; };
    } catch (e) {}

    // The on-property form of the same handler, so assigning it is a no-op
    // rather than a second path to the event.
    try {
      saved.onvisibilitychange = Object.getOwnPropertyDescriptor(Document.prototype, 'onvisibilitychange');
      Object.defineProperty(Document.prototype, 'onvisibilitychange', {
        configurable: true,
        get: function () { return null; },
        set: function () {},
      });
    } catch (e) {}

    // Drop the listener registrations outright: overriding visibilityState
    // stops a *read* from betraying the tab, but the event still fires on a
    // real tab switch and Teams acts on the event alone.
    try {
      saved.addEventListener = EventTarget.prototype.addEventListener;
      saved.removeEventListener = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (type) {
        if (suppressed(this, type)) return undefined;
        return saved.addEventListener.apply(this, arguments);
      };
      EventTarget.prototype.removeEventListener = function (type) {
        if (suppressed(this, type)) return undefined;
        return saved.removeEventListener.apply(this, arguments);
      };
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
      if (saved.hidden) Object.defineProperty(Document.prototype, 'hidden', saved.hidden);
      if (saved.visibilityState) Object.defineProperty(Document.prototype, 'visibilityState', saved.visibilityState);
      if (saved.onvisibilitychange) Object.defineProperty(Document.prototype, 'onvisibilitychange', saved.onvisibilitychange);
      if (saved.hasFocus) Document.prototype.hasFocus = saved.hasFocus;
      if (saved.addEventListener) EventTarget.prototype.addEventListener = saved.addEventListener;
      if (saved.removeEventListener) EventTarget.prototype.removeEventListener = saved.removeEventListener;
      if (saved.IdleDetector) Object.defineProperty(window, 'IdleDetector', saved.IdleDetector);
    } catch (e) {}
    // Listeners the app tried to register while the mask was on were dropped,
    // not stashed; it re-registers them on its next reload.
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
