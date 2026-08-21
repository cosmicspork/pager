// Pager service worker. On each push it decrypts the sealed payload with the
// device identity (re-derived from the mnemonic in IndexedDB) and shows the
// notification. iOS revokes the subscription if a push shows nothing, so EVERY
// path calls showNotification — including a generic fallback when decryption
// fails or the device isn't paired yet.
//
// Every push also stamps health markers in IndexedDB (`last_push_at`,
// `last_push_shown`) and appends to the log, both independently of whether the
// banner actually rendered. showNotification() rejects when notification
// permission is not "granted", and when that rejection was allowed to escape it
// took the log write with it — leaving a device that silently stopped alerting
// and stopped recording that anything had arrived at all.

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

async function idbSet(k, v) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readwrite").objectStore("kv").put(v, k);
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
  });
}

// Health markers are best-effort: a storage failure must never be the reason a
// notification doesn't get shown.
async function mark(k, v) {
  try {
    await idbSet(k, v);
  } catch (e) {
    // Nothing to do — the app degrades to "unknown" for this field.
  }
}

// Append an arrived push to the local log, then prune to the newest LOG_MAX.
// `shown` and `fault` record what happened to it, so a log that keeps growing
// while nothing appears on screen is itself the diagnosis.
async function logNotif(n) {
  const db = await idbOpen();
  await new Promise((res, rej) => {
    const tx = db.transaction("log", "readwrite");
    const store = tx.objectStore("log");
    store.add({
      title: n.title || "",
      body: n.body || "",
      source: n.source || "",
      ts: n.ts || 0,
      shown: n.shown !== false,
      fault: n.fault || "",
    });
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

const errText = (e) => (e && e.message ? e.message : String(e));

// Tell the relay this push reached the worker. `shown` separates "the app is
// alive" from "the alert made it to the screen" — without it, a device with
// notifications switched off is indistinguishable from one that was deleted.
// Signed with the device's own key over the same canonical bytes the bridge
// uses, so the relay learns liveness and nothing else.
async function ack(dev, shown) {
  const relay = await idbGet("relay");
  if (!relay || !dev) return;
  const path = "/api/ack/" + dev.x25519_hex;
  const body = new TextEncoder().encode(JSON.stringify({ shown }));
  const h = JSON.parse(dev.sign_headers("POST", path, body, BigInt(Math.floor(Date.now() / 1000))));
  await fetch(relay + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svastha-pubkey": h.pubkey,
      "svastha-signature": h.signature,
      "svastha-timestamp": String(h.timestamp),
    },
    body,
  });
}

async function handlePush(event) {
  const at = Date.now();
  // Stamped before anything that can fail, so "a push arrived" is recorded even
  // if every step after this one goes wrong.
  await mark("last_push_at", at);

  let title = "Pager";
  let opts = { body: "New notification" };
  let notif = null;
  let dev = null;
  let fault = "";
  try {
    const raw = event.data ? event.data.text() : "";
    const mnemonic = await idbGet("device_mnemonic");
    if (!raw) {
      fault = "push carried no payload";
    } else if (!mnemonic) {
      fault = "device identity missing — re-register";
    } else {
      await ensureWasm();
      dev = wasm_bindgen.DeviceIdentity.from_mnemonic(mnemonic);
      const plain = dev.open(raw, AAD); // Uint8Array of the notif JSON
      const n = JSON.parse(new TextDecoder().decode(plain));
      title = n.title || "Pager";
      opts = { body: n.body || "", tag: n.source || undefined, data: n };
      notif = n;
    }
  } catch (e) {
    fault = "could not open page: " + errText(e);
  }

  // Still unconditional — iOS revokes the subscription if a push shows nothing.
  // But the rejection is caught: when notification permission has been revoked
  // this throws, and everything below it is the only remaining evidence of that.
  let shown = true;
  try {
    await self.registration.showNotification(title, opts);
  } catch (e) {
    shown = false;
    fault = fault || "alerts are off on this device: " + errText(e);
  }
  await mark("last_push_shown", shown);

  try {
    await logNotif(
      notif
        ? { ...notif, shown, fault }
        : { title, body: opts.body, source: "fault", ts: at, shown, fault }
    );
    await notifyClients();
  } catch (e) {
    // A logging failure is non-fatal; the markers above already recorded arrival.
  }

  try {
    await ack(dev, shown);
  } catch (e) {
    // Offline, or a relay too old to accept acks. The local markers stand.
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
