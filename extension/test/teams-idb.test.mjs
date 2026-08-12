import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../teams-idb.js', import.meta.url), 'utf8');

const OID = '7777a9f2-c6d7-4d56-8e9b-19be6a2afb8d';
const ME = `8:orgid:${OID}`;
const THEM = '8:orgid:8f3e7eac-bd03-4de9-b1ab-58607b844564';
const DB_NAME = `Teams:conversation-manager:react-web-client:1ad003c4-8913-4c2e-b120-62aef88b6ccd:${OID}:en-us`;

function conversation({ id, type, from = THEM, content = 'hello', at = Date.now(), mentions = '[]', chatTitle = null, threadProperties = undefined }) {
  return {
    id,
    type,
    chatTitle,
    threadProperties,
    lastMessageTimeUtc: at,
    members: [],
    lastMessage: {
      content,
      fromUserId: from,
      imdisplayname: from === ME ? 'Josh Bowen' : 'Eric Wingert',
      originalarrivaltime: new Date(at).toISOString(),
      messagetype: 'RichText/Html',
      properties: { mentions, importance: '' },
    },
  };
}

// Runs the content script against a fake IndexedDB whose contents we control,
// and hands back a way to advance the poll.
async function runCapture(settings = {}, opts = {}) {
  const events = [];
  const diags = [];
  const health = [];
  const fail = { reads: false };
  // Simulates a fresh profile: the app has not created its databases yet when
  // the script lands. reveal() is the app catching up.
  const stores = { hidden: !!opts.storesHidden };
  // Keyed by store name; the three stores the script reads live in different
  // databases but their names are distinct, so one map is enough.
  const rows = { conversations: [], 'mentions-metadata-items': [], replychains: [] };
  let intervalFn = null;

  const request = (result) => {
    const req = { result };
    queueMicrotask(() => req.onsuccess && req.onsuccess());
    return req;
  };

  const sandbox = {
    JSON, Date, Math, Array, String, Number, Object, Boolean, Set, Map, Promise, Error,
    console: { log() {}, error() {} },
    queueMicrotask,
    setTimeout: () => 0, // only used for open/read timeouts; never firing is correct here
    clearTimeout: () => {},
    setInterval: (fn) => { intervalFn = fn; return 0; },
    location: { host: 'teams.microsoft.com' },
    indexedDB: {
      databases: async () => stores.hidden ? [] : [
        { name: DB_NAME },
        { name: DB_NAME.replace('conversation-manager', 'messaging-slice-manager') },
        { name: DB_NAME.replace('conversation-manager', 'replychain-manager') },
      ],
      open: () => request({
        transaction: (store) => ({
          objectStore: () => ({
            getAll: () => {
              if (fail.reads) {
                const req = {};
                queueMicrotask(() => req.onerror && req.onerror());
                return req;
              }
              return request(rows[store] || []);
            },
          }),
        }),
        close() {},
      }),
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (msg) => {
          if (msg.type === 'pager-health') { health.push(msg.health); return; }
          // The install/health ping rides the same channel; it is not a page.
          if (msg.type === 'pager-event') {
            if (msg.ev.source === '__diag') diags.push(msg.ev);
            else events.push(msg.ev);
            return;
          }
          if (msg.type === 'pager-get-config') {
            return {
              captureTeams: true,
              teamsChatsMode: 'all',
              teamsChannelsMode: 'mentions',
              teamsMeetingsMode: 'off',
              teamsMuteSelf: true,
              ...settings,
            };
          }
        },
      },
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  await settle();

  return {
    events,
    diags,
    health,
    fail,
    reveal() { stores.hidden = false; },
    // First pass only learns where each conversation stands, so a caller has to
    // set a baseline before the change it wants to observe.
    async poll(conversations, extra = {}) {
      rows.conversations = conversations;
      if (extra.mentions) rows['mentions-metadata-items'] = extra.mentions;
      if (extra.chains) rows.replychains = extra.chains;
      await intervalFn();
      await settle();
    },
  };
}

test('pages a group chat message from someone else', async () => {
  const cap = await runCapture();
  const before = conversation({ id: '19:g@thread.v2', type: 'Chat', at: Date.now() - 60000, chatTitle: { shortTitle: 'The Group' } });
  await cap.poll([before]);
  await cap.poll([conversation({ id: '19:g@thread.v2', type: 'Chat', content: 'ping', chatTitle: { shortTitle: 'The Group' } })]);

  assert.equal(cap.events.length, 1);
  assert.equal(cap.events[0].category, 'chat');
  assert.equal(cap.events[0].body, 'ping');
  // chatTitle is an object, not the string it looks like from the outside.
  assert.equal(cap.events[0].title, 'Eric Wingert · The Group');
});

test('drops your own messages, meetings, and stale sync churn', async () => {
  const cases = [
    ['own message', conversation({ id: '19:g@thread.v2', type: 'Chat', from: ME })],
    ['meeting chat', conversation({ id: '19:m@thread.v2', type: 'Meeting' })],
    ['self stream', conversation({ id: '48:notes', type: 'StreamOfNotes', from: ME })],
    // Teams re-advances a pile of conversations on startup and reconnect.
    ['old message', conversation({ id: '19:g2@thread.v2', type: 'Chat', at: Date.now(), content: 'old' })],
  ];

  for (const [label, after] of cases) {
    const cap = await runCapture();
    const before = { ...after, lastMessageTimeUtc: after.lastMessageTimeUtc - 60000 };
    if (label === 'old message') {
      after.lastMessage.originalarrivaltime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    }
    await cap.poll([before]);
    await cap.poll([after]);
    assert.equal(cap.events.length, 0, label);
  }
});

test('matches a channel mention whether Teams sends a string or an array', async () => {
  // Both shapes have been observed on the same conversation minutes apart,
  // depending on whether the record came from initial sync or live delivery.
  const shapes = [
    ['json string', JSON.stringify([{ mri: ME, displayName: 'Josh Bowen' }])],
    ['parsed array', [{ mri: ME, displayName: 'Josh Bowen' }]],
    ['unexpected key', [{ itemId: ME }]],
  ];

  for (const [label, mentions] of shapes) {
    const cap = await runCapture();
    const before = conversation({ id: '19:c@thread.tacv2', type: 'Topic', at: Date.now() - 60000 });
    await cap.poll([before]);
    await cap.poll([conversation({ id: '19:c@thread.tacv2', type: 'Topic', mentions })]);
    assert.equal(cap.events.length, 1, label);
    assert.equal(cap.events[0].category, 'channel', label);
    assert.equal(cap.events[0].isMention, true, label);
  }
});

test('names the channel a mention came from', async () => {
  const cap = await runCapture();
  const props = { threadProperties: { topic: 'MS365 - Support' } };
  const before = conversation({ id: '19:c@thread.tacv2', type: 'Topic', at: Date.now() - 60000, ...props });
  await cap.poll([before]);
  await cap.poll([conversation({ id: '19:c@thread.tacv2', type: 'Topic', mentions: [{ mri: ME }], ...props })]);

  // Channels leave chatTitle null, so without threadProperties this would page
  // as a bare sender name.
  assert.equal(cap.events[0].title, 'Eric Wingert · MS365 - Support');
  assert.equal(cap.events[0].chatTitle, 'MS365 - Support');
});

test('catches a mention that is no longer the newest message', async () => {
  // The hole this closes: conversations keeps one lastMessage, so a mention
  // followed by other replies vanishes from that view entirely.
  const CHANNEL = '19:c@thread.tacv2';
  const props = { threadProperties: { topic: 'MS365 - Support' } };
  const cap = await runCapture();

  const baseline = conversation({ id: CHANNEL, type: 'Topic', at: Date.now() - 120000, ...props });
  await cap.poll([baseline], { mentions: [], chains: [] });

  // Someone mentions you, then two other people reply on top of it.
  const buried = conversation({
    id: CHANNEL, type: 'Topic', content: 'later chatter', at: Date.now(), ...props,
  });
  const mention = {
    id: '900001', messageId: '900001', sourceThreadId: CHANNEL,
    sourceMessageId: '900001', sourceReplyChainId: '800000',
    timestamp: Date.now(), isRead: false, conversationType: 'Channel',
  };
  const chains = [{
    conversationId: CHANNEL,
    replyChainId: '800000',
    messageMap: {
      'x_1': { id: '900001', imdisplayname: 'Nick Barry', content: '<p><span itemtype="http://schema.skype.com/Mention">Josh</span> can you look?</p>' },
      'x_2': { id: '900002', imdisplayname: 'Someone Else', content: '<p>later chatter</p>' },
    },
  }];

  await cap.poll([buried], { mentions: [mention], chains });

  const mentions = cap.events.filter((e) => e.isMention);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].title, 'Nick Barry · MS365 - Support');
  // Reply-chain content is raw HTML, unlike the pre-sanitized conversation copy.
  assert.equal(mentions[0].body, 'Josh can you look?');
  assert.equal(mentions[0].messageId, '900001');
});

test('does not page a mention twice when it is also the newest message', async () => {
  const CHAT = '19:g@thread.v2';
  const cap = await runCapture();
  const at = Date.now();
  const msg = { id: '900500', content: '<p>ping</p>', imdisplayname: 'Nick Barry', originalarrivaltime: new Date(at).toISOString(), fromUserId: THEM, properties: { mentions: [{ mri: ME }] } };

  const baseline = conversation({ id: CHAT, type: 'Chat', at: at - 120000 });
  await cap.poll([baseline], { mentions: [], chains: [] });

  const after = { ...conversation({ id: CHAT, type: 'Chat', at }), lastMessage: msg };
  await cap.poll([after], {
    mentions: [{ id: '900500', sourceThreadId: CHAT, sourceMessageId: '900500', sourceReplyChainId: '900500', timestamp: at }],
    chains: [{ conversationId: CHAT, replyChainId: '900500', messageMap: { a: msg } }],
  });

  // Both paths see it; message id is what keeps it to one page.
  assert.equal(cap.events.length, 1);
  assert.equal(cap.events[0].isMention, true);
});

test('says so when reads keep failing, instead of going quiet', async () => {
  const cap = await runCapture();
  await cap.poll([conversation({ id: '19:g@thread.v2', type: 'Chat' })]);

  cap.fail.reads = true;
  for (let i = 0; i < 6; i++) await cap.poll([]);

  const failing = cap.diags.filter((d) => /failing/.test(d.title));
  assert.equal(failing.length, 1, 'reports once, not once per tick');
  // The popup's 'failing' line depends on health being reported from the
  // failure path too, not only after a successful read.
  assert.ok(cap.health.some((h) => h.ok === false), 'failure reaches the popup');

  cap.fail.reads = false;
  await cap.poll([conversation({ id: '19:g@thread.v2', type: 'Chat', at: Date.now() - 120000 })]);
  assert.equal(cap.diags.filter((d) => /recovered/.test(d.title)).length, 1);
  assert.equal(cap.health.at(-1).ok, true, 'recovery flips health back without waiting out the throttle');
});

test('flags a store it can read but no longer understands', async () => {
  const cap = await runCapture();
  // Records present, but nothing shaped like a conversation — what a Teams
  // schema change looks like from here, and otherwise indistinguishable from
  // a quiet day.
  await cap.poll([{ id: 'x', type: 'Chat' }, { id: 'y', type: 'Chat' }]);
  await cap.poll([{ id: 'x', type: 'Chat' }, { id: 'y', type: 'Chat' }]);

  const warned = cap.diags.filter((d) => /no usable conversations/.test(d.title));
  assert.equal(warned.length, 1);
});

test('leaves channel chatter alone when it does not mention you', async () => {
  for (const mentions of ['[]', [], JSON.stringify([{ mri: THEM }])]) {
    const cap = await runCapture();
    const before = conversation({ id: '19:c@thread.tacv2', type: 'Topic', at: Date.now() - 60000 });
    await cap.poll([before]);
    await cap.poll([conversation({ id: '19:c@thread.tacv2', type: 'Topic', mentions })]);
    assert.equal(cap.events.length, 0, JSON.stringify(mentions));
  }
});

test('starts capturing when the store shows up after load', async () => {
  // A fresh profile creates the databases after the script lands; a single
  // shot at discovery would leave capture dead until a manual reload.
  const cap = await runCapture({}, { storesHidden: true });
  assert.ok(cap.diags.some((d) => /cannot find its store/.test(d.title)));

  cap.reveal();
  await cap.poll([conversation({ id: '19:g@thread.v2', type: 'Chat', at: Date.now() - 60000 })]);
  await cap.poll([conversation({ id: '19:g@thread.v2', type: 'Chat', content: 'ping' })]);

  assert.equal(cap.events.length, 1);
  assert.equal(cap.events[0].body, 'ping');
});

test('does not page a mention inside your own message', async () => {
  const CHAT = '19:g@thread.v2';
  const cap = await runCapture();
  const at = Date.now();
  await cap.poll([conversation({ id: CHAT, type: 'Chat', at: at - 120000 })], { mentions: [], chains: [] });

  // You mention yourself, buried under later chatter, so the mention index is
  // the only path that sees it — it has to honor teamsMuteSelf like the
  // conversation path does.
  const buried = conversation({ id: CHAT, type: 'Chat', content: 'later chatter', at });
  const mention = { id: '910001', sourceThreadId: CHAT, sourceMessageId: '910001', sourceReplyChainId: '810000', timestamp: at };
  const chains = [{
    conversationId: CHAT,
    replyChainId: '810000',
    messageMap: { a: { id: '910001', fromUserId: ME, imdisplayname: 'Josh Bowen', content: '<p>note to self</p>' } },
  }];
  await cap.poll([buried], { mentions: [mention], chains });

  assert.equal(cap.events.filter((e) => e.isMention).length, 0);
});

test('pages both unresolved mentions in the same conversation', async () => {
  const CHANNEL = '19:c@thread.tacv2';
  const props = { threadProperties: { topic: 'MS365 - Support' } };
  const cap = await runCapture();
  const at = Date.now();
  await cap.poll([conversation({ id: CHANNEL, type: 'Topic', at: at - 120000, ...props })], { mentions: [], chains: [] });

  // Two mentions arrive between polls and neither body can be resolved; the
  // placeholders must not share a message id, or the second dedupes away.
  const after = conversation({ id: CHANNEL, type: 'Topic', content: 'later chatter', at, ...props });
  const mentions = [
    { id: '920001', sourceThreadId: CHANNEL, sourceMessageId: '920001', sourceReplyChainId: '820000', timestamp: at },
    { id: '920002', sourceThreadId: CHANNEL, sourceMessageId: '920002', sourceReplyChainId: '820000', timestamp: at },
  ];
  await cap.poll([after], { mentions, chains: [] });

  const paged = cap.events.filter((e) => e.isMention);
  assert.equal(paged.length, 2);
  assert.notEqual(paged[0].messageId, paged[1].messageId);
});
