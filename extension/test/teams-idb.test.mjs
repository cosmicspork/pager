import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../teams-idb.js', import.meta.url), 'utf8');
const TENANT = '1ad003c4-8913-4c2e-b120-62aef88b6ccd';
const USER = '7777a9f2-c6d7-4d56-8e9b-19be6a2afb8d';
const BASE = `Teams:conversation-manager:react-web-client:${TENANT}:${USER}:en-us`;
const now = Date.now();
const conv = { id: '19:fixture@thread.v2', type: 'Chat', chatTitle: { shortTitle: 'Fixture group' },
  members: [{ id: '8:orgid:member' }], lastMessageTimeUtc: now,
  lastMessage: { id: 'old', content: 'initial text', imdisplayname: 'Other Person', originalarrivaltime: new Date(now - 1000).toISOString() } };
const cached = (id, content, extra = {}) => ({ id, conversationId: conv.id, creator: '8:orgid:other', imDisplayName: 'Other Person',
  originalArrivalTime: now, version: '1', contentType: 'Text', content, isSentByCurrentUser: false, ...extra });

async function fixture(initial) {
  const messages = [];
  const sync = new Map();
  const chains = [{ conversationId: conv.id, replyChainId: 'root', messageMap: Object.fromEntries(initial.map((row) => [row.id, row])) }];
  const listeners = [];
  let poll;
  let nextId = 0;
  const request = (value) => {
    const req = { result: value };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  };
  const sandbox = {
    Date, Math, JSON, String, Number, Array, Object, Boolean, Set, Map, Promise, Error, structuredClone,
    console, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` },
    setTimeout: () => 0, clearTimeout() {}, setInterval(fn) { poll = fn; },
    location: { host: 'teams.microsoft.com' },
    IDBKeyRange: { lowerBound: (value) => value },
    indexedDB: {
      databases: async () => ['conversation-manager', 'replychain-manager', 'messaging-slice-manager'].map((kind) => ({ name: BASE.replace('conversation-manager', kind) })),
      open(name) {
        const db = {
          objectStoreNames: { contains: (store) => ['conversations', 'replychains', 'mentions-metadata-items'].includes(store) },
          close() {},
          transaction(store) {
            const tx = { oncomplete: null, onerror: null, onabort: null,
              objectStore: () => ({
                getAll: () => request(store === 'conversations' ? [conv] : []),
                openCursor: (after) => {
                  const rows = store === 'replychains' ? chains : [];
                  let at = after === undefined ? 0 : Number(after) + 1;
                  const req = {};
                  const advance = () => queueMicrotask(() => {
                    req.result = at < rows.length ? { key: at, value: rows[at], continue() { at++; advance(); } } : null;
                    req.onsuccess?.();
                    queueMicrotask(() => { if (req.result === null || at < rows.length) tx.oncomplete?.(); });
                  });
                  advance();
                  return req;
                },
              }),
            };
            return tx;
          },
        };
        return request(db);
      },
    },
    chrome: { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } }, async sendMessage(msg) {
      if (msg.type === 'pager-get-config') return { captureTeams: true, teamsChatsMode: 'all', teamsChannelsMode: 'mentions', teamsMeetingsMode: 'off', teamsMuteSelf: true };
      if (msg.type === 'pager-lease') return { elected: true };
      if (msg.type === 'pager-sync-get') return { ok: true, value: sync.get(msg.key) };
      if (msg.type === 'pager-sync-put') { sync.set(msg.key, structuredClone(msg.value)); return { ok: true }; }
      if (msg.type === 'pager-event') { messages.push(msg.ev); return { ok: true, eventId: msg.ev.eventId }; }
      return {};
    } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const settle = async () => { for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve)); };
  await settle();
  return { messages, chains, async poll() { await poll(); await settle(); }, async reimport() { listeners.forEach((fn) => fn({ type: 'pager-control', control: 'reimport' })); await settle(); } };
}

test('initial Teams cache import archives history without paging; later three replies include self without paging self', async () => {
  const cap = await fixture([cached('old', 'initial text')]);
  const initial = cap.messages.filter((event) => event.kind === 'message');
  assert.equal(initial.length, 1);
  assert.equal(initial[0].notification, undefined);
  for (const row of [cached('one', 'same text'), cached('two', 'same text'), cached('self', 'my reply', { isSentByCurrentUser: true })]) {
    cap.chains[0].messageMap[row.id] = row;
  }
  await cap.poll();
  const fresh = cap.messages.filter((event) => event.kind === 'message' && event.message.messageId !== 'old');
  assert.deepEqual(fresh.map((event) => event.message.messageId), ['one', 'two', 'self']);
  assert.deepEqual(fresh.map((event) => !!event.notification), [true, true, false]);
  assert.equal(fresh[2].message.isSelf, true);
  await cap.poll();
  assert.equal(cap.messages.filter((event) => event.kind === 'message').length, 4);
});

test('explicit deletion clears content; unsupported system content is never archived as text', async () => {
  const cap = await fixture([cached('old', 'initial text')]);
  cap.chains[0].messageMap.old = cached('old', '', { version: '2', deletionInfo: { showMessageAsDeleted: true, deleteFailed: false } });
  cap.chains[0].messageMap.system = cached('system', '<recording>secret</recording>', { messageType: 'Recording', contentType: 'Unsupported' });
  await cap.poll();
  const messages = cap.messages.filter((event) => event.kind === 'message');
  assert.equal(messages.find((event) => event.message.messageId === 'old' && event.message.bodyStatus === 'deleted')?.message.body, null);
  assert.equal(messages.find((event) => event.message.messageId === 'system')?.message.bodyStatus, 'unsupported');
  assert.equal(messages.find((event) => event.message.messageId === 'system')?.message.body, null);
});
