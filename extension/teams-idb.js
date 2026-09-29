(() => {
  'use strict';
  if (globalThis.__pagerTeamsCaptureInstalled) return;
  globalThis.__pagerTeamsCaptureInstalled = true;

  const TICK_MS = 5000;
  const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
  const MAX_AGE_MS = 10 * 60 * 1000;
  const CLOCK_SKEW_MS = 2 * 60 * 1000;
  const pending = new Map();
  const ledgers = new Map();
  const primed = new Set();
  const lastReported = new Map();
  let running = false;
  let configuration = { captureTeams: true, teamsChatsMode: 'all', teamsChannelsMode: 'mentions', teamsMeetingsMode: 'off', teamsMuteSelf: true };

  const send = async (event) => {
    const key = event.source + ':' + event.accountId + ':' + (event.message?.messageId || event.conversation?.conversationId || event.kind);
    let existing = pending.get(key);
    if (!existing) {
      existing = { ...event, eventId: crypto.randomUUID() };
      pending.set(key, existing);
    }
    try {
      const ack = await chrome.runtime.sendMessage({ type: 'pager-event', ev: existing });
      if (!ack?.ok || ack.eventId !== existing.eventId) return false;
      pending.delete(key);
      return true;
    } catch { return false; }
  };

  const worker = (request) => chrome.runtime.sendMessage({ source: 'teams', ...request });
  const diag = (entry) => chrome.runtime.sendMessage({ type: 'pager-diag', source: 'teams', entry: { at: Date.now(), ...entry } }).catch(() => {});
  const HEARTBEAT_MS = 10 * 60 * 1000;
  const syncKey = (account) => `revision:teams:${account}:messages`;
  async function revisions(account) {
    if (!ledgers.has(account)) {
      const response = await worker({ type: 'pager-sync-get', accountId: account, key: syncKey(account) });
      ledgers.set(account, response?.ok && response.value && typeof response.value === 'object' ? response.value : {});
    }
    return ledgers.get(account);
  }

  const open = (name) => new Promise((resolve, reject) => {
    let finished = false;
    const req = indexedDB.open(name);
    const timeout = setTimeout(() => { finished = true; reject(new Error('open_timeout')); }, 5000);
    req.onsuccess = () => {
      clearTimeout(timeout);
      const db = req.result;
      db.onversionchange = () => db.close();
      if (finished) db.close(); else resolve(db);
    };
    req.onerror = () => { clearTimeout(timeout); reject(new Error('open_failed')); };
  });

  const readAll = (db, store) => new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) { resolve([]); return; }
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    const timeout = setTimeout(() => reject(new Error('read_timeout')), 8000);
    req.onsuccess = () => { clearTimeout(timeout); resolve(req.result); };
    req.onerror = () => { clearTimeout(timeout); reject(new Error('read_failed')); };
  });

  // Each transaction retains at most 100 reply chains; the next batch starts
  // strictly after the last key and yields to the Teams app between reads.
  async function readChains(db, store, consume) {
    if (!db.objectStoreNames.contains(store)) return;
    let after;
    while (true) {
      const batch = await new Promise((resolve, reject) => {
        const rows = [];
        const tx = db.transaction(store, 'readonly');
        const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
        const cursor = tx.objectStore(store).openCursor(range);
        const timeout = setTimeout(() => { try { tx.abort(); } catch {} reject(new Error('read_timeout')); }, 8000);
        cursor.onsuccess = () => {
          const found = cursor.result;
          if (found && rows.length < 100) {
            rows.push({ key: found.key, value: found.value });
            found.continue();
          }
        };
        tx.oncomplete = () => { clearTimeout(timeout); resolve(rows); };
        tx.onerror = () => { clearTimeout(timeout); reject(new Error('read_failed')); };
        tx.onabort = () => { clearTimeout(timeout); reject(new Error('read_timeout')); };
      });
      if (!batch.length) break;
      for (const row of batch) await consume(row.value);
      after = batch.at(-1).key;
      if (batch.length < 100) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  function accountOf(name) {
    const ids = name?.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig) || [];
    return ids.length >= 2 ? ids.slice(0, 2).map((id) => id.toLowerCase()).join(':') : null;
  }
  function discover(dbs) {
    const accounts = new Map();
    for (const { name } of dbs) {
      const manager = name?.match(/:(conversation-manager|replychain-manager|messaging-slice-manager):/);
      if (!manager) continue;
      const account = accountOf(name);
      if (!account) continue;
      const entry = accounts.get(account) || { account, userId: '8:orgid:' + account.split(':')[1] };
      entry[manager[1]] = name;
      accounts.set(account, entry);
    }
    return [...accounts.values()].filter((entry) => entry['conversation-manager']);
  }

  function categoryOf(conv) {
    if (String(conv.id || '').startsWith('48:')) return 'other';
    if (conv.type === 'Chat') return 'chat';
    if (conv.type === 'Topic' || conv.type === 'Space') return 'channel';
    if (conv.type === 'Meeting') return 'meeting';
    return 'other';
  }
  function titleOf(conv) {
    const title = conv.chatTitle;
    if (typeof title === 'string') return title;
    return title?.shortTitle || title?.longTitle || conv.threadProperties?.topic || conv.threadProperties?.topicThreadTopic || '';
  }
  function plain(value) {
    const text = String(value || '');
    if (!/[<&]/.test(text)) return text;
    try { return new DOMParser().parseFromString(text, 'text/html').body.textContent.replace(/\s+/g, ' ').trim(); }
    catch { return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  }
  function mentionsMe(message, me) {
    let mentions = message?.properties?.mentions;
    if (!mentions || !me) return false;
    if (typeof mentions === 'string') {
      try { mentions = JSON.parse(mentions); } catch { return mentions.includes(me); }
    }
    return Array.isArray(mentions) && mentions.some((entry) => entry?.mri === me || entry?.itemid === me || entry?.id === me);
  }
  function stamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : null;
  }
  function memberList(conv) {
    return Array.isArray(conv.members) ? conv.members.filter((member) => member?.id).slice(0, 500).map((member) => ({ role: 'member', id: String(member.id) })) : [];
  }
  function normalizeChain(message, chain, conv, me) {
    const deletion = message.deletionInfo;
    const deleted = deletion?.showMessageAsDeleted === true && deletion?.deleteFailed !== true;
    const format = String(message.contentType || message.messageType || '');
    const supported = /^(text|richtext\/html)$/i.test(format);
    const body = deleted || !supported ? null : format.toLowerCase() === 'text' ? String(message.content ?? '') : plain(message.content);
    return {
      messageId: String(message.id), conversationId: String(message.conversationId || chain.conversationId),
      title: titleOf(conv), category: categoryOf(conv), bodyStatus: deleted ? 'deleted' : supported ? 'full' : 'unsupported', body,
      sourceTime: stamp(message.originalArrivalTime), modifiedAt: stamp(message.lastModifiedTime),
      version: message.version == null ? null : String(message.version),
      sender: { id: message.creator || null, name: message.imDisplayName || message.fromDisplayNameInToken || null },
      recipients: memberList(conv), recipientsTruncated: (conv.members?.length || 0) > 500,
      isSelf: typeof message.isSentByCurrentUser === 'boolean' ? message.isSentByCurrentUser : null,
      isMention: mentionsMe(message, me), hasAttachments: null, url: conv.url || null,
      replyToMessageId: message.parentMessageId || null,
    };
  }
  function normalizeLast(message, conv, me) {
    const body = plain(message.content);
    return {
      messageId: String(message.id || message.originalarrivaltime || conv.lastMessageTimeUtc),
      conversationId: String(conv.id), title: titleOf(conv), category: categoryOf(conv),
      bodyStatus: body ? 'full' : 'missing', body: body || null,
      sourceTime: stamp(message.originalarrivaltime || message.composetime), modifiedAt: null,
      version: null, sender: { id: message.fromUserId || null, name: message.imdisplayname || message.fromDisplayNameInToken || null },
      recipients: memberList(conv), recipientsTruncated: (conv.members?.length || 0) > 500,
      isSelf: message.fromUserId === me, isMention: mentionsMe(message, me),
      hasAttachments: null, url: conv.url || null, replyToMessageId: null,
    };
  }
  function eligible(message, newMessage) {
    if (!newMessage || message.bodyStatus !== 'full' || !message.body?.trim() || message.isSelf && configuration.teamsMuteSelf) return false;
    const mode = { chat: configuration.teamsChatsMode, channel: configuration.teamsChannelsMode, meeting: configuration.teamsMeetingsMode }[message.category] || 'off';
    if (mode === 'off' || (mode === 'mentions' && !message.isMention)) return false;
    const age = Date.now() - message.sourceTime;
    return Number.isFinite(age) && age <= MAX_AGE_MS && age >= -CLOCK_SKEW_MS;
  }
  function fingerprint(message) {
    const data = [message.version, message.modifiedAt, message.bodyStatus, message.body,
      message.isSelf, message.isMention, message.title, message.sender?.name];
    let hash = 2166136261;
    for (const ch of JSON.stringify(data)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return String(hash >>> 0);
  }

  async function scanAccount(entry, progress) {
    const started = Date.now();
    progress.stage = 'lease';
    const elected = await worker({ type: 'pager-lease', accountId: entry.account, source: 'teams' });
    if (!elected?.elected) return;
    const counts = { conversations: 0, chains: 0, observed: 0, captured: 0, sendFailures: 0, mentions: 0,
      replychainDb: !!entry['replychain-manager'], sliceDb: !!entry['messaging-slice-manager'] };
    const ledger = await revisions(entry.account);
    const initial = !primed.has(entry.account);
    progress.stage = 'conversations';
    const conversationsDb = await open(entry['conversation-manager']);
    let conversations;
    try { conversations = await readAll(conversationsDb, 'conversations'); }
    finally { conversationsDb.close(); }
    counts.conversations = conversations.length;
    const byId = new Map(conversations.filter((conv) => conv?.id).map((conv) => [String(conv.id), conv]));
    const seen = new Set();
    let oldest = null;
    let changed = false;
    let failed = false;
    const observe = async (message) => {
      if (!message.messageId || !message.conversationId) return;
      const key = message.messageId;
      if (seen.has(key)) return;
      seen.add(key);
      if (message.sourceTime != null && message.sourceTime < Date.now() - RETENTION_MS) return;
      if (message.sourceTime != null) oldest = oldest === null ? message.sourceTime : Math.min(oldest, message.sourceTime);
      counts.observed++;
      const fp = fingerprint(message);
      if (ledger[key] === fp) return;
      const notification = eligible(message, !initial && ledger[key] === undefined) ? {
        key: key, sourceTime: message.sourceTime, title: [message.sender?.name, message.title].filter(Boolean).join(' · ') || 'Teams',
        body: message.body, conversationId: message.conversationId, url: message.url,
      } : undefined;
      const event = { source: 'teams', accountId: entry.account, observedAt: Date.now(), kind: 'message', message, notification };
      if (await send(event)) { ledger[key] = fp; changed = true; counts.captured++; }
      else { failed = true; counts.sendFailures++; }
    };
    if (entry['replychain-manager']) {
      progress.stage = 'replychains';
      const db = await open(entry['replychain-manager']);
      try {
        for (const store of ['replychains', 'replychains-2']) {
          await readChains(db, store, async (chain) => {
            if (!chain?.messageMap) return;
            counts.chains++;
            const conv = byId.get(String(chain.conversationId));
            if (!conv) return;
            for (const value of Object.values(chain.messageMap)) {
              if (value?.id) await observe(normalizeChain(value, chain, conv, entry.userId));
            }
          });
        }
      } finally { db.close(); }
    }
    for (const conv of conversations) {
      if (!conv?.id) continue;
      if (conv.lastMessage) await observe(normalizeLast(conv.lastMessage, conv, entry.userId));
      if (conv.lastMessageTimeUtc && !conv.lastMessage) {
        await send({ source: 'teams', accountId: entry.account, observedAt: Date.now(), kind: 'conversation',
          conversation: { conversationId: String(conv.id), title: titleOf(conv), sourceTime: stamp(conv.lastMessageTimeUtc), url: conv.url || null } });
      }
    }
    if (entry['messaging-slice-manager']) {
      progress.stage = 'mentions';
      const db = await open(entry['messaging-slice-manager']);
      try {
        const mentions = await readAll(db, 'mentions-metadata-items');
        counts.mentions = mentions.length;
        for (const mention of mentions) {
          if (!mention?.sourceMessageId || seen.has(String(mention.sourceMessageId))) continue;
          const conv = byId.get(String(mention.sourceThreadId));
          if (!conv) continue;
          await observe({ messageId: String(mention.sourceMessageId), conversationId: String(conv.id), title: titleOf(conv),
            category: categoryOf(conv), bodyStatus: 'missing', body: null, sourceTime: stamp(mention.timestamp),
            isMention: true, recipients: [], sender: null });
        }
      } finally { db.close(); }
    }
    if (changed) await worker({ type: 'pager-sync-put', accountId: entry.account, key: syncKey(entry.account), value: ledger });
    if (!failed) primed.add(entry.account);
    await send({ source: 'teams', accountId: entry.account, observedAt: Date.now(), kind: 'status',
      status: { state: failed ? 'degraded' : initial ? 'syncing' : 'ok', reason: failed ? 'outbox_unavailable' : null,
        coverage: 'teams_cache', initialSyncComplete: !initial && !failed, oldestSourceTime: oldest, pending: pending.size } });
    await chrome.runtime.sendMessage({ type: 'pager-health', health: { ok: !failed, conversations: conversations.length, at: Date.now() } });
    const now = Date.now();
    if (initial || failed || counts.captured || now - (lastReported.get(entry.account) || 0) >= HEARTBEAT_MS) {
      lastReported.set(entry.account, now);
      diag({ accountId: entry.account, op: 'scan', outcome: failed ? 'error' : 'ok', code: failed ? 'outbox_unavailable' : null,
        durationMs: now - started, detail: { ...counts, initial } });
    }
  }
  async function tick() {
    if (running || !configuration.captureTeams) return;
    running = true;
    try {
      const databases = await indexedDB.databases();
      const accounts = discover(databases);
      if (!accounts.length && Date.now() - (lastReported.get('') || 0) >= HEARTBEAT_MS) {
        lastReported.set('', Date.now());
        diag({ op: 'discover', outcome: 'error', code: 'no_teams_accounts',
          detail: { databases: databases.length, teamsDatabases: databases.filter(({ name }) => /^Teams:/.test(name || '')).length } });
      }
      for (const account of accounts) {
        const progress = { stage: 'start' };
        try { await scanAccount(account, progress); }
        catch (error) {
          diag({ accountId: account.account, op: 'scan', outcome: 'error', code: String(error?.message || 'scan_failed').slice(0, 128),
            detail: { stage: progress.stage } });
          await send({ source: 'teams', accountId: account.account, observedAt: Date.now(), kind: 'status',
            status: { state: 'degraded', reason: `cache_read_failed: ${progress.stage} ${String(error?.message || '')}`.trim().slice(0, 128),
              coverage: 'teams_cache', initialSyncComplete: false, pending: pending.size } });
        }
      }
    } finally { running = false; }
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'pager-control') return;
    if (message.control === 'config' && message.config) Object.assign(configuration, message.config);
    if (message.control === 'reimport') { ledgers.clear(); primed.clear(); tick(); }
    if (message.control === 'poll') tick();
  });
  chrome.runtime.sendMessage({ type: 'pager-get-config' }).then((config) => {
    if (config) Object.assign(configuration, config);
    tick();
  }).catch(() => tick());
  setInterval(tick, TICK_MS);
})();
