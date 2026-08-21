// Service-worker push handling, run against a fake IndexedDB / registration.
// The property under test is that *every* push leaves evidence behind: the
// health markers and the on-device log must survive a decryption failure and,
// above all, a showNotification() that rejects because alerts are switched off.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// --- a minimal IndexedDB good enough for sw.js's two stores -----------------
// Request callbacks fire on the microtask queue and transaction completion on a
// timer, so a transaction always completes after the requests inside it.
function fakeIndexedDB(kv = new Map(), log = []) {
  const request = (result) => {
    const r = { result, onsuccess: null, onerror: null };
    queueMicrotask(() => r.onsuccess && r.onsuccess());
    return r;
  };
  const store = (name) => ({
    get: (k) => request(kv.get(k)),
    put: (v, k) => request(kv.set(k, v)),
    add: (v) => request(log.push({ id: log.length + 1, ...v })),
    getAllKeys: () => request(log.map((e) => e.id)),
    delete: (id) => request((log = log.filter((e) => e.id !== id))),
    _name: name,
  });
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    transaction(name) {
      const tx = { objectStore: store, oncomplete: null, onerror: null, error: null };
      setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
      return tx;
    },
  };
  return {
    idb: {
      open() {
        const r = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null };
        queueMicrotask(() => r.onsuccess && r.onsuccess());
        return r;
      },
    },
    kv,
    log: () => log,
  };
}

// --- load sw.js into a context we control ----------------------------------
async function loadWorker({ notif = { title: 'Alice', body: 'hi', source: 'teams', ts: 42 }, mnemonic = 'word '.repeat(24).trim(), showNotification, open } = {}) {
  const { idb, kv, log } = fakeIndexedDB();
  if (mnemonic) kv.set('device_mnemonic', mnemonic);

  const shown = [];
  const listeners = new Map();
  const self = {
    addEventListener: (t, fn) => listeners.set(t, fn),
    registration: {
      showNotification:
        showNotification ||
        ((title, opts) => {
          shown.push({ title, opts });
          return Promise.resolve();
        }),
    },
    clients: { matchAll: async () => [] },
  };

  const wasm_bindgen = Object.assign(() => Promise.resolve(), {
    DeviceIdentity: {
      from_mnemonic: () => ({
        open: open || (() => new TextEncoder().encode(JSON.stringify(notif))),
      }),
    },
  });

  const context = vm.createContext({
    self,
    indexedDB: idb,
    importScripts: () => {},
    wasm_bindgen,
    TextEncoder,
    TextDecoder,
    queueMicrotask,
    setTimeout,
    Date,
  });
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);

  // Fire a push and wait for whatever the handler passed to waitUntil.
  const push = async (payload = 'sealed-blob') => {
    let pending;
    listeners.get('push')({ data: { text: () => payload }, waitUntil: (p) => (pending = p) });
    await pending;
  };
  return { push, kv, log, shown };
}

test('a delivered page is logged, marked shown, and stamps the health markers', async () => {
  const { push, kv, log, shown } = await loadWorker();
  await push();

  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Alice');
  assert.equal(log().length, 1);
  assert.equal(log()[0].title, 'Alice');
  assert.equal(log()[0].shown, true);
  assert.equal(log()[0].fault, '');
  assert.equal(kv.get('last_push_shown'), true);
  assert.ok(kv.get('last_push_at') > 0);
});

test('a rejected showNotification still records the page and the reason', async () => {
  // The regression: notification permission revoked on the device. The push
  // arrives and decrypts, but the banner throws — and before this the rejection
  // escaped handlePush and took the log write with it, so the app went silent
  // *and* stopped recording that anything was arriving.
  const { push, kv, log } = await loadWorker({
    showNotification: () => Promise.reject(new TypeError('permission not granted')),
  });
  await push();

  assert.equal(log().length, 1, 'the page must be logged even though it never displayed');
  assert.equal(log()[0].title, 'Alice');
  assert.equal(log()[0].shown, false);
  assert.match(log()[0].fault, /alerts are off/);
  assert.equal(kv.get('last_push_shown'), false);
  assert.ok(kv.get('last_push_at') > 0, 'arrival is stamped before anything that can fail');
});

test('an unopenable payload logs a fault page and still shows the generic banner', async () => {
  const { push, log, shown } = await loadWorker({
    open: () => {
      throw new Error('aead failure');
    },
  });
  await push();

  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Pager', 'iOS revokes a subscription that shows nothing');
  assert.equal(log().length, 1);
  assert.equal(log()[0].source, 'fault');
  assert.match(log()[0].fault, /could not open page: aead failure/);
});

test('an unpaired device records why rather than logging nothing', async () => {
  const { push, log, shown } = await loadWorker({ mnemonic: null });
  await push();

  assert.equal(shown.length, 1);
  assert.equal(log().length, 1);
  assert.match(log()[0].fault, /device identity missing/);
});
