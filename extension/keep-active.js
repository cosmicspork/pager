// Keeps the Teams web app from deciding you are idle, by giving it the input
// events its idle timer is watching for. Runs in the page's MAIN world so the
// events land on the same document Teams listens to.
//
// Registered by background.js only while the feature is on — if the toggle is
// off this file is not in the page at all. The config it receives afterwards
// only carries the interval and live on/off for an already-loaded tab.
//
// Pairs with keep-active-mask.js, which handles the other half of the problem:
// Teams also goes away on tab visibility and window focus, not just input.

(function () {
  'use strict';

  const MARK = '__pagerControl';
  const DEFAULT_INTERVAL_MS = 240000;
  // How often the page-side timer wakes. Deliberately shorter than the pulse
  // interval: background tabs get their timers throttled to about once a
  // minute, so a tick that merely *offers* to pulse keeps the real spacing
  // closer to what was configured.
  const TICK_MS = 30000;
  const SLACK_MS = 5000;

  let intervalMs = DEFAULT_INTERVAL_MS;
  let enabled = true;
  // The page just loaded, which is real activity — start the clock rather than
  // firing a synthetic pulse immediately.
  let lastPulse = Date.now();

  // Events dispatched from page JavaScript are always untrusted. Do not try to
  // redefine `isTrusted`: Chromium makes it an own, non-configurable property.
  // These pulses are best-effort activity signals, not user input.
  function synth(Ctor, type, init) {
    return new Ctor(type, init);
  }

  function pulse() {
    if (!enabled) return;
    const now = Date.now();
    // The worker alarm and the page timer both drive this; whichever arrives
    // first wins and the other is a no-op.
    if (now - lastPulse < intervalMs - SLACK_MS) return;
    lastPulse = now;

    // Jitter the coordinates so the stream is not a single repeated point.
    const x = 8 + Math.floor(Math.random() * 40);
    const y = 8 + Math.floor(Math.random() * 40);
    const mouse = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
    };
    // Shift, because it is the one key that cannot alter a focused composer.
    const key = {
      bubbles: true, cancelable: true, key: 'Shift', code: 'ShiftLeft',
      keyCode: 16, which: 16, shiftKey: true,
    };
    try {
      // Dispatching on document bubbles up to window, so listeners on either
      // see it without a second dispatch.
      document.dispatchEvent(synth(MouseEvent, 'mousemove', mouse));
      document.dispatchEvent(synth(KeyboardEvent, 'keydown', key));
      document.dispatchEvent(synth(KeyboardEvent, 'keyup', key));
    } catch (e) {}
  }

  function applyConfig(c) {
    if (!c) return;
    if (typeof c.keepActive === 'boolean') enabled = c.keepActive;
    const n = Number(c.keepActiveIntervalSec);
    if (Number.isFinite(n) && n > 0) intervalMs = n * 1000;
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[MARK] !== true) return;
    if (d.control === 'pulse') pulse();
    else if (d.control === 'config') applyConfig(d.config);
  });

  setInterval(pulse, TICK_MS);

  // relay.js asks the worker for the current config on load and posts it back
  // here; until it arrives the defaults above are in effect.
})();
