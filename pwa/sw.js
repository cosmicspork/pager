// Pager service worker. On each push it decrypts the sealed payload with the
// device identity (re-derived from the mnemonic in IndexedDB) and shows the
// notification. iOS revokes the subscription if a push shows nothing, so EVERY
// path ends in showNotification — including a generic fallback when decryption
// fails or the device isn't paired yet.

importScripts("/wasm/pager_wasm.js");

const AAD = new TextEncoder().encode("pager/v0/notify");

let wasmReady;
function ensureWasm() {
  // No `document` in a worker, so point the loader at the .wasm explicitly.
  wasmReady ||= wasm_bindgen({ module_or_path: "/wasm/pager_wasm_bg.wasm" });
  return wasmReady;
}

// Keep the schema in sync with app.js: db "pager" v2, stores "kv" + "log".
const LOG_MAX = 200; // cap the on-device history; oldest entries pruned past this.

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("pager", 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("log"))
        db.createObjectStore("log", { keyPath: "id", autoIncrement: true });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbGet(k) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction("kv").objectStore("kv").get(k);
    t.onsuccess = () => res(t.result);
    t.onerror = () => rej(t.error);
  });
}

// Append a decrypted notif to the local log, then prune to the newest LOG_MAX.
async function logNotif(n) {
  const db = await idbOpen();
  await new Promise((res, rej) => {
    const tx = db.transaction("log", "readwrite");
    const store = tx.objectStore("log");
    store.add({ title: n.title || "", body: n.body || "", source: n.source || "", ts: n.ts || 0 });
    const keys = store.getAllKeys();
    keys.onsuccess = () => {
      const extra = keys.result.length - LOG_MAX; // ids ascend, so the first keys are oldest
      for (let i = 0; i < extra; i++) store.delete(keys.result[i]);
    };
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// Nudge any open app windows to refresh their list.
async function notifyClients() {
  const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of cs) c.postMessage({ type: "notif" });
}

async function handlePush(event) {
  let title = "Pager";
  let opts = { body: "New notification" };
  let notif = null;
  try {
    const raw = event.data ? event.data.text() : "";
    const mnemonic = await idbGet("device_mnemonic");
    if (raw && mnemonic) {
      await ensureWasm();
      const dev = wasm_bindgen.DeviceIdentity.from_mnemonic(mnemonic);
      const plain = dev.open(raw, AAD); // Uint8Array of the notif JSON
      const n = JSON.parse(new TextDecoder().decode(plain));
      title = n.title || "Pager";
      opts = { body: n.body || "", tag: n.source || undefined, data: n };
      notif = n;
    }
  } catch (e) {
    // Swallow: still show a generic notification so iOS keeps the subscription.
  }
  // showNotification first and unconditionally — iOS revokes the subscription if a
  // push shows nothing, so persistence must never be able to preempt it.
  await self.registration.showNotification(title, opts);
  if (notif) {
    try {
      await logNotif(notif);
      await notifyClients();
    } catch (e) {
      // A logging failure is non-fatal; the banner already showed.
    }
  }
}

self.addEventListener("push", (event) => event.waitUntil(handlePush(event)));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if ("focus" in c) return c.focus();
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
