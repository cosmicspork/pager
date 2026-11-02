// Replaces the Teams/Outlook web notification sound with the user's own file.
// Runs in the page's MAIN world. Both apps download their sound and read the
// response body before playing it (Teams: blob() → new Audio(blobUrl); Outlook:
// arrayBuffer() → decodeAudioData), so the swap happens at that read, keyed on
// the response URL. Teams fetches through a reference it captured at load, so
// patching window.fetch alone would miss it; the Response prototype does not.
// Call ringtones use other files and are left alone.
(function () {
  'use strict';
  if (globalThis.__pagerSoundSwapInstalled) return;
  globalThis.__pagerSoundSwapInstalled = true;

  const MARK = '__pagerControl';
  const SOUNDS = {
    // Observed: /evergreen-assets/audio/00_teams_basic_notification_r4_default.mp3
    teams: (path) => /\/evergreen-assets\/audio\/[^/]*notification[^/]*\.mp3$/i.test(path) && !/ring|call/i.test(path),
    // Observed: /owamail/<build>/resources/sounds/notifications/newmail.mp3
    outlook: (path) => /\/resources\/sounds\/notifications\/[^/]+\.mp3$/i.test(path),
  };
  const source = /(^|\.)teams\.(microsoft\.com|cloud\.microsoft)$/.test(location.hostname) ? 'teams' :
    /^outlook\.(office\.com|office365\.com|cloud\.microsoft)$/.test(location.hostname) ? 'outlook' : null;
  if (!source) return;

  // Until the extension answers, a matching read waits briefly rather than
  // racing the original sound; after that it falls through to the original.
  const WAIT_MS = 1500;
  let sound = null;
  let known = false;
  let waiters = [];

  function settle() {
    known = true;
    for (const resolve of waiters) resolve();
    waiters = [];
  }
  function current() {
    if (known) return Promise.resolve(sound);
    return new Promise((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, WAIT_MS);
    }).then(() => sound);
  }

  function decode(value) {
    if (!value || typeof value.data !== 'string' || typeof value.type !== 'string') return null;
    try {
      const binary = atob(value.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return { type: value.type, bytes };
    } catch { return null; }
  }

  function isSound(response) {
    try { return SOUNDS[source](new URL(response.url).pathname); } catch { return false; }
  }

  const proto = Response.prototype;
  const originalBlob = proto.blob;
  const originalArrayBuffer = proto.arrayBuffer;
  proto.blob = async function blob() {
    if (isSound(this)) {
      const replacement = await current();
      if (replacement) return new Blob([replacement.bytes], { type: replacement.type });
    }
    return originalBlob.apply(this, arguments);
  };
  proto.arrayBuffer = async function arrayBuffer() {
    if (isSound(this)) {
      const replacement = await current();
      if (replacement) return replacement.bytes.slice().buffer;
    }
    return originalArrayBuffer.apply(this, arguments);
  };

  const requestId = crypto.randomUUID();
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data[MARK] !== true) return;
    if (data.control === 'sound') {
      sound = decode(data.sound);
      settle();
    } else if (data.control === 'response' && data.requestId === requestId && data.response) {
      sound = data.response.ok ? decode(data.response.sound) : null;
      settle();
    }
  });

  // The relay may install before or after this script, so ask once here; the
  // relay also pushes the current sound when it starts.
  window.postMessage({ __pagerRequest: true, requestId, request: { type: 'pager-sound-get', source } }, location.origin);
})();
