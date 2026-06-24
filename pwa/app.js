// Pager PWA controller. Two contexts share this file:
//  - Safari landing at /pair#<code> (not installed): offer to copy the code.
//  - The installed/home-screen app (or root): pair via pasted code, or show the
//    paired state. All key generation, push subscription, and enrollment sealing
//    happen here, in the app, where iOS Web Push actually works.

const $ = (s) => document.querySelector(s);
const status = (t) => { $("#status").textContent = t; };
const show = (sel, on = true) => $(sel).classList.toggle("hidden", !on);

const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// ---- tiny IndexedDB kv (shared shape with sw.js) ----
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("pager", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("kv").objectStore("kv").get(k);
    t.onsuccess = () => res(t.result);
    t.onerror = () => rej(t.error);
  });
}
async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readwrite").objectStore("kv").put(v, k);
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
  });
}

// ---- encoding helpers ----
const b64urlToBytes = (s) => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};
const b64urlToText = (s) => new TextDecoder().decode(b64urlToBytes(s));
const enc = (s) => new TextEncoder().encode(s);

function deviceLabel() {
  const u = navigator.userAgent;
  if (/iPhone/.test(u)) return "iPhone";
  if (/iPad/.test(u)) return "iPad";
  if (/Android/.test(u)) return "Android";
  if (/Macintosh/.test(u)) return "Mac";
  return "device";
}

let wasmReady;
function ensureWasm() {
  // The no-modules glue auto-resolves the .wasm relative to its own <script> src.
  wasmReady ||= wasm_bindgen();
  return wasmReady;
}

async function main() {
  if (!("serviceWorker" in navigator)) { status("This browser can't run the app."); return; }
  await navigator.serviceWorker.register("/sw.js");

  const hash = location.hash.slice(1);
  const landing = location.pathname.replace(/\/$/, "") === "/pair" && hash;

  if (landing && !isStandalone) {
    renderCopy(hash);
  } else {
    await renderApp(hash);
  }
}

// Safari, opened from the QR: let the user copy the code into the installed app.
function renderCopy(code) {
  show("#copy", true);
  status("");
  $("#copyBtn").onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      $("#copyMsg").textContent = "Copied ✓ — now open the Pager app and tap Paste & pair.";
    } catch {
      $("#copyMsg").textContent = "Copy failed — select and copy the URL manually.";
    }
  };
}

async function renderApp(prefill) {
  show("#app", true);
  const mnemonic = await idbGet("device_mnemonic");
  if (mnemonic) {
    await ensureWasm();
    const dev = wasm_bindgen.DeviceIdentity.from_mnemonic(mnemonic);
    $("#devId").textContent = dev.x25519_hex.slice(0, 16) + "…";
    show("#pairing", false);
    show("#paired", true);
    status("Ready");
  } else {
    if (prefill) $("#code").value = prefill;
    show("#pairing", true);
    show("#paired", false);
    status("Not paired");
  }

  $("#pasteBtn").onclick = async () => {
    try { $("#code").value = (await navigator.clipboard.readText()).trim(); }
    catch { status("Paste blocked — long-press the box and paste."); }
  };
  $("#pairBtn").onclick = () => pair($("#code").value.trim());
  $("#repairBtn").onclick = () => { show("#pairing", true); show("#paired", false); };
}

async function pair(code) {
  if (!code) { status("Paste the pairing code first."); return; }
  $("#pairBtn").disabled = true;
  try {
    // The code may be a raw payload or a full /pair#<payload> URL.
    const frag = code.includes("#") ? code.split("#").pop() : code;
    const payload = JSON.parse(b64urlToText(frag));
    if (payload.contract_version !== 0) throw new Error("pairing code version mismatch — update the app");

    status("Requesting notification permission…");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { status("Permission " + perm + " — enable notifications and retry."); return; }

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64urlToBytes(payload.vapid_public_key),
    });
    const j = sub.toJSON();

    await ensureWasm();
    const dev = wasm_bindgen.DeviceIdentity.generate();
    await idbSet("device_mnemonic", dev.mnemonic);

    const enrollment = {
      device_x25519: dev.x25519_hex,
      label: deviceLabel(),
      subscription: { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } },
    };
    const blobJson = wasm_bindgen.seal_to(
      payload.bridge_x25519,
      enc(JSON.stringify(enrollment)),
      enc(payload.token),
    );

    const r = await fetch(`${payload.relay}/api/pair/${payload.token}`, { method: "POST", body: blobJson });
    if (!r.ok) throw new Error("relay rejected enrollment (" + r.status + ")");

    $("#devId").textContent = dev.x25519_hex.slice(0, 16) + "…";
    show("#pairing", false);
    show("#paired", true);
    status("Paired ✓ — the bridge will confirm shortly.");
  } catch (e) {
    status("Pairing failed: " + e.message);
  } finally {
    $("#pairBtn").disabled = false;
  }
}

main().catch((e) => status("Error: " + e.message));
