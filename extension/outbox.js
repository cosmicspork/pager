const DATABASE = 'pager-capture';
const MAX_EVENTS = 10000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = Math.floor(3.5 * 1024 * 1024);
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
let database;
let enqueueTail = Promise.resolve();

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openOutbox() {
  if (database) return database;
  database = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DATABASE, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('events', { keyPath: 'eventId' });
      db.createObjectStore('sync', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  database.onversionchange = () => { database.close(); database = null; };
  return database;
}

async function transaction(stores, mode, action) {
  const db = await openOutbox();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    let failure;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(failure || tx.error);
    tx.onabort = () => reject(failure || tx.error || new Error('transaction aborted'));
    Promise.resolve().then(() => action(tx, (value) => { result = value; })).catch((error) => {
      failure = error;
      tx.abort();
    });
  });
}

function fitEvent(original) {
  const event = structuredClone(original);
  if (bytes(event) <= MAX_EVENT_BYTES) return event;
  const message = event.message;
  if (!message || typeof message.body !== 'string') throw new Error('capture metadata exceeds event limit');
  const chars = Array.from(message.body);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    message.body = chars.slice(0, midpoint).join('');
    message.bodyStatus = 'truncated';
    if (bytes(event) <= MAX_EVENT_BYTES) low = midpoint;
    else high = midpoint - 1;
  }
  message.body = chars.slice(0, low).join('');
  message.bodyStatus = 'truncated';
  if (bytes(event) > MAX_EVENT_BYTES) throw new Error('capture metadata exceeds event limit');
  return event;
}

export async function enqueue(original) {
  const operation = enqueueTail.then(async () => {
    const event = fitEvent(original);
    const size = bytes(event);
    return transaction(['events', 'sync'], 'readwrite', async (tx, done) => {
      const events = tx.objectStore('events');
      const sync = tx.objectStore('sync');
      const previous = await request(events.get(event.eventId));
      const usage = (await request(sync.get('outbox:usage')))?.value || { count: 0, bytes: 0 };
      const next = { count: usage.count + (previous ? 0 : 1), bytes: usage.bytes - (previous?.size || 0) + size };
      if (next.count > MAX_EVENTS || next.bytes > MAX_BYTES) throw new Error('outbox_full');
      events.put({ eventId: event.eventId, event, size });
      sync.put({ key: 'outbox:usage', value: next });
      done(event.eventId);
    });
  });
  enqueueTail = operation.catch(() => {});
  return operation;
}

export async function getBatch(installationId, bridgeUrl) {
  return transaction(['events'], 'readonly', (tx, done) => {
    const selected = [];
    let size = bytes({ version: 1, installationId, bridgeUrl, events: [] });
    const cursor = tx.objectStore('events').openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item || selected.length >= 50) { done(selected); return; }
      const next = bytes(item.value.event) + 1;
      if (size + next > MAX_ENVELOPE_BYTES) { done(selected); return; }
      selected.push(item.value.event);
      size += next;
      item.continue();
    };
  });
}

export async function acknowledge(ids) {
  if (!ids.length) return;
  await transaction(['events', 'sync'], 'readwrite', async (tx) => {
    const events = tx.objectStore('events');
    const sync = tx.objectStore('sync');
    const usage = (await request(sync.get('outbox:usage')))?.value || { count: 0, bytes: 0 };
    for (const id of new Set(ids)) {
      const prior = await request(events.get(id));
      if (!prior) continue;
      events.delete(id);
      usage.count--;
      usage.bytes -= prior.size;
    }

    sync.put({ key: 'outbox:usage', value: usage });
  });
}

export async function stripNotification(eventId) {
  return transaction(['events', 'sync'], 'readwrite', async (tx) => {
    const events = tx.objectStore('events');
    const sync = tx.objectStore('sync');
    const row = await request(events.get(eventId));
    if (!row?.event.notification) return;
    const usage = (await request(sync.get('outbox:usage')))?.value || { count: 0, bytes: 0 };
    delete row.event.notification;
    const nextSize = bytes(row.event);
    usage.bytes += nextSize - row.size;
    row.size = nextSize;
    events.put(row);
    sync.put({ key: 'outbox:usage', value: usage });
  });
}

export async function pending() {
  return (await getSync('outbox:usage')) || { count: 0, bytes: 0 };
}

export async function getSync(key) {
  return transaction(['sync'], 'readonly', async (tx, done) => {
    done((await request(tx.objectStore('sync').get(key)))?.value);
  });
}

export async function putSync(key, value) {
  return transaction(['sync'], 'readwrite', (tx) => {
    tx.objectStore('sync').put({ key, value });
  });
}

export async function resetLedgers() {
  return transaction(['sync'], 'readwrite', (tx) => {
    const store = tx.objectStore('sync');
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      if (item.key.startsWith('revision:') || item.key.startsWith('import:') || item.key.startsWith('body:')) item.delete();
      item.continue();
    };
  });
}
