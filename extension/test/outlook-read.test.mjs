import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const adapterCode = await readFile(new URL('../outlook-read.js', import.meta.url), 'utf8');
const wrapperCode = await readFile(new URL('../main-capture.js', import.meta.url), 'utf8');
const clockStart = Date.now();
const dateString = new Date(clockStart).toISOString();

async function fixture({ failFirst = false, failThreadFirst = false, secondMailbox = false, preAuthFrame = false, stalled = false, throttle = false, sentError = false, oldSent = false, refreshDuringSweep = false } = {}) {
  let refreshes = 0;
  const events = [];
  const diags = [];
  const requests = [];
  const ledgers = new Map();
  const listeners = [];
  let current = clockStart;
  let getFailures = 0;
  let throttled = false;
  let nextUuid = 0;
  const FakeDate = class extends Date { static now() { return current; } };
  const item = (id, changeKey = 'v1') => ({ ItemId: { Id: id, ChangeKey: changeKey }, ConversationId: { Id: 'thread-1' },
    Subject: 'Synthetic subject', DateTimeSent: dateString, DateTimeReceived: dateString,
    From: { Mailbox: { Name: 'Sender Sample', EmailAddress: 'sender@example.invalid' } }, IsFromMe: false,
    HasAttachments: false });
  const success = (payload) => Response.json({ Body: { ResponseMessages: { Items: [{ ResponseClass: 'Success', ResponseCode: 'NoError', ...payload }] } } });
  const nativeFetch = async (url, init = {}) => {
    const parsed = new URL(url, 'https://outlook.office.com');
    const action = parsed.searchParams.get('action');
    if (parsed.pathname.includes('/owa/notificationchannel')) {
      const frame = JSON.stringify({ type: 1, target: 'syncMessage', arguments: [[{ Conversation: {
        ConversationId: { Id: 'thread-1' }, ConversationTopic: 'Synthetic subject',
        UniqueSenders: ['Sender Sample'], LastDeliveryTime: dateString, GlobalUnreadCount: 1,
      } }]] }) + String.fromCharCode(30);
      const encoded = new TextEncoder().encode('data:' + frame);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoded.slice(0, 25)); controller.enqueue(encoded.slice(25)); controller.close();
      } }));
    }
    if (!init.headers?.Action) return Response.json({});
    requests.push({ action, url: parsed.href, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    if (throttle && !throttled) { throttled = true; return Response.json({}, { status: 429, headers: { 'Retry-After': '60' } }); }
    if (action === 'FindItem') {
      const folder = requests.at(-1).body.Body.ParentFolderIds[0].Id;
      const offset = requests.at(-1).body.Body.Paging.Offset;
      if (oldSent && folder === 'sentitems') {
        const old = new Date(clockStart - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
        return success({ RootFolder: { Items: [{ ...item('old-' + offset), DateTimeSent: old, DateTimeReceived: old }],
          IndexedPagingOffset: offset + 1, IncludesLastItemInRange: false } });
      }
      if (sentError && folder === 'sentitems') {
        return Response.json({ Body: { ResponseMessages: { Items: [{ ResponseClass: 'Error', ResponseCode: 'ErrorInternalServerError',
          MessageText: 'An internal server error occurred. The operation failed., Index was outside the bounds of the array.', RootFolder: null }] } } });
      }
      const rows = folder === 'inbox' ? [item('mail-1'), item('mail-2')] : [item('mail-1')];
      return success({ RootFolder: { Items: offset === 0 ? [rows[0]] : rows.slice(1), IndexedPagingOffset: stalled ? offset : offset + 1,
        IncludesLastItemInRange: folder === 'sentitems' || offset !== 0 } });
    }
    if (action === 'GetItem') {
      const id = requests.at(-1).body.Body.ItemIds[0].Id;

      if ((failFirst && id === 'mail-2' || failThreadFirst && id === 'thread-only') && getFailures++ === 0) return Response.json({}, { status: 500 });
      return success({ Items: [{ ...item(id), Body: { BodyType: 'Text', Value: id === 'mail-2' ? 'Retry succeeded' : 'Tangerine message body', IsTruncated: false } }] });
    }
    if (action === 'GetConversationItems') {
      return success({ Conversation: { TotalConversationNodesCount: 2, ConversationNodes: [
        { Items: [item('mail-1')] }, { Items: [item('thread-only')] },
      ] } });
    }
    throw new Error('unexpected action');
  };
  const window = { fetch: nativeFetch, addEventListener(_, fn) { listeners.push(fn); }, postMessage(data) {
    if (data.__pagerDiag) diags.push(data.entry);
    if (data.__pagerEvent) {
      events.push(data.ev);
      queueMicrotask(() => listeners.forEach((fn) => fn({ source: window, origin: 'https://outlook.office.com', data: {
        __pagerControl: true, control: 'ack', eventId: data.ev.eventId, ack: { ok: true, eventId: data.ev.eventId },
      } })));
    }
    if (data.__pagerRequest) {
      const req = data.request;
      const response = req.type === 'pager-sync-get' ? { ok: true, value: ledgers.get(req.key) } :
        (ledgers.set(req.key, req.value), { ok: true });
      queueMicrotask(() => listeners.forEach((fn) => fn({ source: window, origin: 'https://outlook.office.com', data: {
        __pagerControl: true, control: 'response', requestId: data.requestId, response,
      } })));
    }
  } };
  const sandbox = { window, globalThis: window, Date: FakeDate, URL, Headers, Request, Response,
    TextDecoder, TextEncoder, JSON, Math, Map, Set, Promise, Number, String, Array, Object, Boolean,
    location: { host: 'outlook.office.com', origin: 'https://outlook.office.com', pathname: '/mail/' },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextUuid).padStart(12, '0')}` },
    setTimeout(fn, ms) {
      // The adapter's one-second pacing wait is where OWA's own requests land.
      if (refreshDuringSweep && ms >= 500 && ms < 5000) {
        window.fetch('https://outlook.office.com/owa/service.svc?action=GetItem', { method: 'POST',
          headers: { authorization: 'Bearer refreshed-' + refreshes++, 'x-anchormailbox': 'owner@example.invalid', 'x-tenantid': 'tenant' }, body: '{}' });
      }
      if (ms < 5000) queueMicrotask(fn);
      return 0;
    },
    setInterval() {}, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(adapterCode, sandbox);
  vm.runInContext(wrapperCode, sandbox);
  if (preAuthFrame) await window.fetch('https://outlook.office.com/owa/notificationchannel');
  const auth = (anchor = 'owner@example.invalid') => window.fetch('https://outlook.office.com/owa/service.svc?action=FindItem', {
    method: 'POST', headers: { authorization: 'Bearer fixture-secret', 'x-anchormailbox': anchor, 'x-tenantid': 'tenant', 'x-owa-sessionid': 'session-secret' }, body: '{}',
  });
  await auth();
  if (secondMailbox) await auth('other@example.invalid');
  const settle = async () => { for (let n = 0; n < 100; n++) await new Promise((resolve) => setImmediate(resolve)); };
  await settle();
  const control = (message) => listeners.forEach((fn) => fn({ source: window, origin: 'https://outlook.office.com', data: { __pagerControl: true, ...message } }));
  return { events, diags, requests, ledgers, window, settle, control, advance(ms) { current += ms; }, adapter: window.__pagerOutlookRead };
}

test('enumerates Inbox and Sent with read actions, archives full bodies and sent provenance', async () => {
  const cap = await fixture();
  const actions = cap.requests.map((request) => request.action);
  assert.ok(actions.includes('FindItem') && actions.includes('GetItem'));
  assert.ok(actions.every((action) => ['FindItem', 'GetItem', 'GetConversationItems'].includes(action)));
  assert.ok(cap.requests.every((request) => request.method === 'POST' && request.headers.Action === request.action && request.url.includes('UA=0')));
  const full = cap.events.filter((event) => event.kind === 'message' && event.message.messageId === 'mail-1' && event.message.bodyStatus === 'full');
  assert.equal(full.length, 1);
  assert.equal(full[0].message.body, 'Tangerine message body');
  assert.ok(cap.events.some((event) => event.kind === 'message' && event.message.messageId === 'mail-1' && event.message.isSelf === true));
  assert.ok(cap.events.every((event) => !JSON.stringify(event).includes('fixture-secret')));
  assert.ok(cap.events.some((event) => event.kind === 'status' && event.status.initialSyncComplete));
});

test('same ChangeKey failed GetItem is retried and full body replaces missing observation', async () => {
  const cap = await fixture({ failFirst: true });
  assert.ok(cap.events.some((event) => event.message?.messageId === 'mail-2' && event.message.bodyStatus === 'missing'));
  cap.advance(3 * 60 * 1000 + 15 * 60 * 1000);
  await cap.adapter.poll();
  await cap.settle();
  assert.ok(cap.events.some((event) => event.message?.messageId === 'mail-2' && event.message.body === 'Retry succeeded'));
});

test('different anchors in one tab fail closed rather than mixing accounts', async () => {
  const cap = await fixture({ secondMailbox: true });
  assert.ok(cap.events.some((event) => event.kind === 'status' && event.status.reason === 'multiple_mailboxes'));
  assert.ok(cap.events.every((event) => event.accountId === 'tenant:owner@example.invalid'));
});

test('split SignalR frame before authentication binds to the observed mailbox and loads thread context', async () => {
  const cap = await fixture({ preAuthFrame: true });
  assert.ok(cap.events.some((event) => event.kind === 'conversation' && event.accountId === 'tenant:owner@example.invalid'));
  assert.ok(cap.requests.some((request) => request.action === 'GetConversationItems'));
  assert.ok(cap.events.some((event) => event.message?.messageId === 'thread-only' && event.message.bodyStatus === 'full'));
});

test('thread-only body failure is retained for reconciliation at unchanged ChangeKey', async () => {
  const cap = await fixture({ preAuthFrame: true, failThreadFirst: true });
  assert.ok(cap.events.some((event) => event.message?.messageId === 'thread-only' && event.message.bodyStatus === 'missing'));
  cap.advance(18 * 60 * 1000);
  await cap.adapter.poll();
  await cap.settle();
  assert.ok(cap.events.some((event) => event.message?.messageId === 'thread-only' && event.message.bodyStatus === 'full'));
});

test('stalled pagination and throttling never report complete coverage', async () => {
  for (const config of [{ stalled: true }, { throttle: true }]) {
    const cap = await fixture(config);
    const statuses = cap.events.filter((event) => event.kind === 'status');
    assert.ok(statuses.some((event) => event.status.state === 'degraded'));
    assert.equal(statuses.at(-1).status.initialSyncComplete, false);
  }
});

test('source response errors name the action, folder and Exchange code without leaking content', async () => {
  const cap = await fixture({ sentError: true });
  const statuses = cap.events.filter((event) => event.kind === 'status');
  assert.equal(statuses.at(-1).status.reason, 'source_response_error: FindItem/sentitems ErrorInternalServerError');
  const failure = cap.diags.find((entry) => entry.op === 'FindItem' && entry.outcome === 'error');
  assert.equal(failure.code, 'ErrorInternalServerError');
  assert.match(failure.message, /Index was outside the bounds/);
  assert.deepEqual([failure.detail.folder, failure.detail.shape, failure.detail.offset, failure.detail.max, failure.detail.http],
    ['sentitems', 'IdOnly', 0, 50, 200]);
  assert.ok(cap.diags.some((entry) => entry.op === 'sweep' && entry.detail.folder === 'inbox' && entry.detail.listed === 2));
  assert.ok(cap.diags.some((entry) => entry.op === 'poll' && entry.outcome === 'error'));
  assert.ok(!cap.diags.some((entry) => entry.op === 'GetItem' && entry.outcome === 'ok'), 'successful GetItem is not logged');
  const serialized = JSON.stringify(cap.diags);
  for (const secret of ['fixture-secret', 'session-secret', 'Synthetic subject', 'Tangerine', 'sender@example.invalid']) {
    assert.ok(!serialized.includes(secret), secret + ' must not appear in diagnostics');
  }
});

test('debug probe exists only while enabled and returns summaries of read actions', async () => {
  const cap = await fixture();
  assert.equal(cap.window.__pagerDebug, undefined);
  await assert.rejects(cap.adapter.probe('FindItem', {}), /disabled/);
  cap.control({ control: 'config', config: { debugProbe: true } });
  const body = { ParentFolderIds: [{ Id: 'inbox' }], ItemShape: { BaseShape: 'IdOnly' }, Paging: { Offset: 0, MaxEntriesReturned: 5 } };
  const result = await cap.window.__pagerDebug.probe('FindItem', body);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'NoError');
  assert.equal(result.folder, 'inbox');
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['hasBody', 'id', 'itemClass', 'received', 'sent']);
  assert.ok(!JSON.stringify(result).includes('Synthetic subject') && !JSON.stringify(result).includes('fixture-secret'));
  await assert.rejects(cap.window.__pagerDebug.probe('SendItem', {}), /invalid_action/);
  cap.control({ control: 'config', config: { debugProbe: false } });
  assert.equal(cap.window.__pagerDebug, undefined);
  await assert.rejects(cap.adapter.probe('FindItem', body), /disabled/);
});

test('listing asks Exchange for ids and the fields retrieve reads, not AllProperties', async () => {
  const cap = await fixture();
  const find = cap.requests.find((request) => request.action === 'FindItem').body.Body;
  assert.equal(find.ItemShape.BaseShape, 'IdOnly');
  const fields = find.ItemShape.AdditionalProperties.map((property) => property.FieldURI);
  for (const field of ['DateTimeSent', 'DateTimeReceived', 'IsDraft', 'ConversationId', 'Subject']) assert.ok(fields.includes(field), field);
  assert.ok(!fields.includes('LastModifiedTime'), 'OWA rejects LastModifiedTime with HTTP 400');
  assert.equal(find.FocusedViewFilter, undefined);
});

test('a failed sweep backs off instead of re-listing on every OWA request', async () => {
  const cap = await fixture({ sentError: true });
  const sentLists = () => cap.requests.filter((request) => request.action === 'FindItem' &&
    request.body.Body.ParentFolderIds[0].Id === 'sentitems').length;
  assert.equal(sentLists(), 1);
  for (let n = 0; n < 5; n++) {
    await cap.window.fetch('https://outlook.office.com/owa/service.svc?action=GetItem', { method: 'POST',
      headers: { authorization: 'Bearer fixture-secret', 'x-anchormailbox': 'owner@example.invalid', 'x-tenantid': 'tenant' }, body: '{}' });
    await cap.adapter.poll();
    await cap.settle();
  }
  assert.equal(sentLists(), 1, 'no retry inside the backoff window');
  assert.equal(cap.events.filter((event) => event.kind === 'status').at(-1).status.state, 'degraded', 'backoff never reports ok');
  cap.advance(61 * 1000);
  await cap.adapter.poll();
  await cap.settle();
  assert.equal(sentLists(), 2);
  cap.advance(61 * 1000);
  await cap.adapter.poll();
  await cap.settle();
  assert.equal(sentLists(), 2, 'second failure doubles the wait');
  const failure = cap.diags.filter((entry) => entry.op === 'poll').at(-1);
  assert.equal(failure.detail.failures, 2);
  assert.equal(failure.detail.retryInSec, 120);
});

test('sweep stops paging once a whole page is past retention', async () => {
  const cap = await fixture({ oldSent: true });
  const sentLists = cap.requests.filter((request) => request.action === 'FindItem' &&
    request.body.Body.ParentFolderIds[0].Id === 'sentitems');
  assert.equal(sentLists.length, 1);
  assert.ok(cap.events.some((event) => event.kind === 'status' && event.status.initialSyncComplete));
  assert.ok(!cap.requests.some((request) => request.action === 'GetItem' && request.body.Body.ItemIds[0].Id.startsWith('old-')));
});

test('OWA requests during a sweep refresh auth without restarting it', async () => {
  const cap = await fixture({ refreshDuringSweep: true });
  const lists = cap.requests.filter((request) => request.action === 'FindItem');
  assert.deepEqual(lists.map((request) => request.body.Body.ParentFolderIds[0].Id), ['inbox', 'inbox', 'sentitems']);
  assert.ok(!cap.diags.some((entry) => entry.code === 'waiting_for_auth'));
  assert.ok(cap.events.some((event) => event.kind === 'status' && event.status.initialSyncComplete));
  assert.match(cap.requests.at(-1).headers.authorization, /^Bearer refreshed-/, 'uses the newest template');
});
