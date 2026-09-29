import assert from 'node:assert/strict';
import test from 'node:test';

const session = new Map();
const posts = [];
let status = 200;
globalThis.chrome = { storage: { session: {
  async get(keys) { return Object.fromEntries([keys].flat().filter((key) => session.has(key)).map((key) => [key, structuredClone(session.get(key))])); },
  async set(values) { for (const [key, value] of Object.entries(values)) session.set(key, structuredClone(value)); },
} } };
globalThis.fetch = async (url, init) => { posts.push({ url: String(url), init, body: JSON.parse(init.body) }); return new Response('{}', { status }); };
const diagnostics = await import('../diagnostics.js');

test('sanitize keeps bounded flat scalars and drops everything else', () => {
  const entry = diagnostics.sanitize({ op: 'FindItem', outcome: 'error', code: 'X'.repeat(300), at: 5, durationMs: -1,
    detail: { folder: 'sentitems', offset: 0, ok: true, nested: { authorization: 'Bearer secret' }, list: [1], 'bad-key': 1,
      long: 'y'.repeat(500), nan: NaN } }, 'outlook');
  assert.deepEqual(entry.detail, { folder: 'sentitems', offset: 0, ok: true, long: 'y'.repeat(200) });
  assert.equal(entry.code.length, 128);
  assert.equal(entry.durationMs, null);
  assert.equal(diagnostics.sanitize({ op: 'x' }, 'elsewhere'), null);
  assert.equal(diagnostics.sanitize({ outcome: 'ok' }, 'teams'), null);
  assert.equal(diagnostics.sanitize({ op: 'scan', outcome: 'weird' }, 'teams').outcome, 'info');
});

test('ring keeps the newest 500, lists newest first and forwards each entry once', async () => {
  for (let n = 0; n < 510; n++) diagnostics.record(diagnostics.sanitize({ op: 'op' + n, outcome: 'ok', at: n }, 'teams'));
  const listed = await diagnostics.list();
  assert.equal(listed.length, 500);
  assert.equal(listed[0].op, 'op509');
  assert.equal(listed.at(-1).op, 'op10');
  assert.ok(!('seq' in listed[0]));

  const target = { collectorUrl: 'http://localhost:4501/capture', token: 'collector-token', installationId: 'install' };
  await diagnostics.flush(target);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'http://localhost:4501/diagnostics');
  assert.equal(posts[0].init.headers.Authorization, 'Bearer collector-token');
  assert.equal(posts[0].body.entries.length, 200);
  assert.equal(posts[0].body.entries[0].op, 'op10');
  await diagnostics.flush(target);
  await diagnostics.flush(target);
  assert.equal(posts.length, 3);
  assert.equal(posts[2].body.entries.at(-1).op, 'op509');
  await diagnostics.flush(target);
  assert.equal(posts.length, 3, 'nothing left to send');

  status = 503;
  diagnostics.record(diagnostics.sanitize({ op: 'later', outcome: 'error' }, 'outlook'));
  await diagnostics.flush(target);
  status = 200;
  await diagnostics.flush(target);
  assert.deepEqual(posts.slice(-2).map((post) => post.body.entries.map((entry) => entry.op)), [['later'], ['later']],
    'a transient collector failure is retried');

  await diagnostics.clear();
  assert.deepEqual(await diagnostics.list(), []);
  await diagnostics.flush({ ...target, token: '' });
  assert.equal(posts.length, 5);
});
