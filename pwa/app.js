// Pager PWA controller. Two contexts share this file:
//  - Safari landing at /pair#<code> (not installed): offer to copy the code.
//  - The installed/home-screen app (or root): pair via pasted code, or show the
//    paired state. All key generation, push subscription, and enrollment sealing
//    happen here, in the app, where iOS Web Push actually works.
//
// The UI is a single "device": one full-screen LCD whose visible region is driven
// by data-state on .device — boot | qr | register | service | empty.

const $ = (s) => document.querySelector(s);
const device = () => $(".device");
const status = (t) => { $("#status").textContent = t; };

const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// Set the visible screen and the matching header text. renderLog() narrows
// "service" to "empty" (or back) based on how many pages are stored.
function applyState(s) {
  device().dataset.state = s;
  const inService = s === "service" || s === "empty";
  $("#svcTxt").textContent = inService ? "IN SERVICE" : "OUT OF SERVICE";
}

// ---- tiny IndexedDB (shared schema with sw.js: v2, stores "kv" + "log") ----
function idb() {
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
async function logAll() {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("log").objectStore("log").getAll();
    t.onsuccess = () => res(t.result || []);
    t.onerror = () => rej(t.error);
  });
}
async function logClear() {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("log", "readwrite").objectStore("log").clear();
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
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
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

// Show the device identity as a pager "cap code": short in the header, full in Function.
function setIdentity(hex) {
  $("#capShort").textContent = hex.slice(0, 8).toUpperCase();
  $("#capFull").textContent = hex.toUpperCase();
}

let wasmReady;
function ensureWasm() {
  // The no-modules glue auto-resolves the .wasm relative to its own <script> src.
  wasmReady ||= wasm_bindgen();
  return wasmReady;
}

// ---- clock: a pager always shows the time ----
function startClock() {
  const c = $("#clock");
  const tick = () => {
    const d = new Date();
    c.textContent = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };
  tick();
  setInterval(tick, 15000);
}

// ---- FUNCTION sheet ----
const openFunc = () => device().classList.add("func-open");
const closeFunc = () => device().classList.remove("func-open");

// ---- stored-pages rendering ----
const SOURCE_LABEL = { teams: "Teams", outlook: "Outlook", msg: "Message", test: "Test" };

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return mins + "m";
  if (mins < 1440) return Math.round(mins / 60) + "h";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Page title/body originate from external senders — build with textContent only.
async function renderLog() {
  const list = $("#logList");
  if (!list) return;
  const items = (await logAll()).sort((a, b) => b.ts - a.ts);
  $("#count").textContent = items.length + (items.length === 1 ? " page" : " pages");
  list.replaceChildren();
  items.forEach((it, i) => {
    const li = document.createElement("li");
    li.className = i === 0 ? "page fresh" : "page";
    const head = document.createElement("div");
    head.className = "phead";
    const src = document.createElement("span");
    src.className = "from";
    src.textContent = SOURCE_LABEL[it.source] || it.source || "Pager";
    const time = document.createElement("span");
    time.className = "when";
    time.textContent = fmtTime(it.ts);
    head.append(src, time);
    const title = document.createElement("div");
    title.className = "ptitle";
    title.textContent = it.title || "";
    li.append(head, title);
    if (it.body) {
      const body = document.createElement("div");
      body.className = "pbody";
      body.textContent = it.body;
      li.append(body);
    }
    list.append(li);
  });
  // Only flip between the two paired screens; never override register/qr/boot.
  const s = device().dataset.state;
  if (s === "service" || s === "empty") applyState(items.length ? "service" : "empty");
}

async function main() {
  startClock();

  // FUNCTION sheet is reachable from the paired screen (footer key or CAP row).
  $("#funcBtn").onclick = openFunc;
  $("#capRow").onclick = openFunc;
  $("#funcClose").onclick = closeFunc;

  if (!("serviceWorker" in navigator)) { applyState("register"); status("This browser can't run the app."); return; }

  // Paint the right screen first — it doesn't depend on the service worker, so
  // don't make the user stare at the boot screen while registration settles.
  const hash = location.hash.slice(1);
  const landing = location.pathname.replace(/\/$/, "") === "/pair" && hash;
  if (landing && !isStandalone) {
    renderCopy(hash);
  } else {
    await renderApp(hash);
  }

  // Then register the worker and start listening for delivered pages.
  await navigator.serviceWorker.register("/sw.js");
  // The service worker pings us after it logs a freshly arrived push.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "notif") renderLog().catch(() => {});
  });
  // Returning to the foreground may have missed live pings — refresh then.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderLog().catch(() => {});
  });
}

// Safari, opened from the QR: let the user copy the code into the installed app.
function renderCopy(code) {
  applyState("qr");
  $("#copyBtn").onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      $("#copyMsg").textContent = "Copied ✓ — open Pager and tap Register.";
    } catch {
      $("#copyMsg").textContent = "Copy failed — select and copy the URL manually.";
    }
  };
}

async function renderApp(prefill) {
  const mnemonic = await idbGet("device_mnemonic");

  // Wire the register panel + the Function-sheet actions up front.
  $("#pasteBtn").onclick = async () => {
    try { $("#code").value = (await navigator.clipboard.readText()).trim(); }
    catch { status("Paste blocked — long-press the box and paste."); }
  };
  $("#pairBtn").onclick = () => pair($("#code").value.trim());
  $("#repairBtn").onclick = () => { closeFunc(); applyState("register"); status(""); };
  $("#clearLogBtn").onclick = async () => { await logClear(); closeFunc(); await renderLog(); };

  if (mnemonic) {
    await ensureWasm();
    const dev = wasm_bindgen.DeviceIdentity.from_mnemonic(mnemonic);
    setIdentity(dev.x25519_hex);
    const relay = await idbGet("relay");
    if (relay) $("#relayHost").textContent = hostOf(relay);
    applyState("service"); // renderLog narrows to "empty" when there are no pages
    await renderLog();
  } else {
    if (prefill) $("#code").value = prefill;
    applyState("register");
    status("");
  }
}

async function pair(code) {
  if (!code) { status("Paste the registration code first."); return; }
  $("#pairBtn").disabled = true;
  try {
    // The code may be a raw payload or a full /pair#<payload> URL.
    const frag = code.includes("#") ? code.split("#").pop() : code;
    const payload = JSON.parse(b64urlToText(frag));
    if (payload.contract_version !== 0) throw new Error("code version mismatch — update the app");

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
    await idbSet("relay", payload.relay); // surfaced in the Function sheet

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

    setIdentity(dev.x25519_hex);
    $("#relayHost").textContent = hostOf(payload.relay);
    status("Paired ✓");
    applyState("service");
    await renderLog();
  } catch (e) {
    status("Pairing failed: " + e.message);
  } finally {
    $("#pairBtn").disabled = false;
  }
}

main().catch((e) => { applyState("register"); status("Error: " + e.message); });
