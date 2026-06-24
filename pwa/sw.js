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

function idbGet(k) {
  return new Promise((res, rej) => {
    const r = indexedDB.open("pager", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => {
      const t = r.result.transaction("kv").objectStore("kv").get(k);
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    };
    r.onerror = () => rej(r.error);
  });
}

async function handlePush(event) {
  let title = "Pager";
  let opts = { body: "New notification" };
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
    }
  } catch (e) {
    // Swallow: still show a generic notification so iOS keeps the subscription.
  }
  await self.registration.showNotification(title, opts);
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
