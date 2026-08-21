// The health panel's job is to name what is wrong, in the order a human should
// act on it. The build check earns its place because a phone running cached
// code looks identical to a healthy one from every other angle — which is how a
// stale app.js kept enrolling devices that could not acknowledge deliveries.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// A DOM permissive enough that app.js loads and its top-level main() can fail
// harmlessly. Only the declarations matter here, not the rendering.
function fakeDom() {
  const el = () =>
    new Proxy(
      { textContent: '', dataset: {}, hidden: false, disabled: false, classList: { toggle() {}, add() {}, remove() {} } },
      { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) },
    );
  const cache = new Map();
  return {
    querySelector: (sel) => (cache.has(sel) ? cache.get(sel) : (cache.set(sel, el()), cache.get(sel))),
    addEventListener() {},
    currentScript: { src: 'https://relay.example/app.js?v=deadbeef' },
  };
}

async function load() {
  const src = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    document: fakeDom(),
    navigator: { serviceWorker: { register: async () => {}, ready: new Promise(() => {}) } },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    location: { origin: 'https://relay.example', hash: '' },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    indexedDB: { open: () => ({ onsuccess: null, onerror: null, onupgradeneeded: null }) },
    Notification: { permission: 'granted' },
    setInterval: () => 0,
    setTimeout: () => 0,
    console,
    TextEncoder,
    URL,
  });
  vm.runInContext(src, ctx);
  // `const` lives in the context's global lexical scope, not on the global
  // object, so it has to be read back by evaluating in the same context.
  return { ...ctx, BUILD: vm.runInContext('BUILD', ctx) };
}

const healthy = { perm: 'granted', subscribed: true, at: 1, shown: true, build: 'aaa', serverBuild: 'aaa' };

test('a healthy device reports no fault', async () => {
  const { faultOf } = await load();
  assert.equal(faultOf(healthy), null);
});

test('a build the relay no longer serves is reported as an update to apply', async () => {
  const { faultOf } = await load();
  const fault = faultOf({ ...healthy, build: 'old', serverBuild: 'new' });
  assert.equal(fault.title, 'Update waiting');
  assert.match(fault.hint, /reopen/i);
});

test('an unknown build on either side is not mistaken for a stale one', async () => {
  const { faultOf } = await load();
  // A relay too old to report a build, and a page loaded without a stamped URL:
  // neither is evidence of staleness, and guessing would cry wolf forever.
  assert.equal(faultOf({ ...healthy, build: 'old', serverBuild: '' }), null);
  assert.equal(faultOf({ ...healthy, build: '', serverBuild: 'new' }), null);
});

test('blocked alerts outrank a stale build', async () => {
  const { faultOf } = await load();
  const fault = faultOf({ ...healthy, perm: 'denied', build: 'old', serverBuild: 'new' });
  assert.equal(fault.title, 'Alerts blocked');
});

test('the page reads its build from its own script URL', async () => {
  const { BUILD } = await load();
  assert.equal(BUILD, 'deadbeef');
});
