// Teams capture. Reads the message store the Teams web app keeps in IndexedDB,
// rather than waiting for Teams to raise a browser notification.
//
// The Notification API this replaces only fires when Teams believes you are not
// looking at the tab, so it went silent whenever keep-active's mask was on --
// the mask exists to convince Teams of exactly the opposite. Reading the store
// does not depend on Teams deciding to notify, so capture and keep-active stop
// being mutually exclusive.
//
// Teams runs its messaging stack in a Web Worker and never hands the page the
// message text, so there is nothing here to hook in the MAIN world. IndexedDB
// is per-origin though, and this runs in the ISOLATED world on that origin --
// so it reads the worker's store directly and talks to the service worker over
// chrome.runtime, with no page patching at all.

(() => {
  'use strict';

  const TICK_MS = 5000;

  // Teams advances lastMessageTimeUtc on a lot of conversations while it syncs
  // at startup, and a reconnect re-syncs. Without a recency floor every one of
  // those looks new and the phone gets a burst of week-old messages. Same guard
  // the bridge already applies to Outlook (is_new_mail).
  const MAX_AGE_MS = 10 * 60 * 1000;
  const CLOCK_SKEW_MS = 2 * 60 * 1000;

  const DB_CONVERSATIONS = 'conversation-manager';
  const DB_SLICE = 'messaging-slice-manager';
  const DB_REPLYCHAIN = 'replychain-manager';
  const STORE_CONVS = 'conversations';
  const STORE_MENTIONS = 'mentions-metadata-items';
  const STORE_CHAINS = 'replychains';

  // Teams is free to rename its stores in any release, and the failure mode is
  // silence — capture that reads nothing looks exactly like a quiet afternoon.
  // These track enough to tell the two apart and say so out loud.
  const MAX_FAILURES = 5;
  const HEALTH_INTERVAL_MS = 60000;

  let convDbName = null;
  let sliceDbName = null;
  let chainDbName = null;
  let me = null;
  let primed = false;
  let mentionsPrimed = false;
  let failures = 0;
  let degraded = false;
  let shapeWarned = false;
  let announced = false;
  let lastHealthAt = 0;
  let lastHealthOk = null;
  let lastReadMs = 0;
  let lastConvCount = 0;
  const lastSeen = new Map();
  const seenMentions = new Set();
  const emitted = new Set();

  // Emitted keys and seen mention ids accumulate for the life of the tab, so
  // each gets trimmed oldest-first. Both are Sets appended in first-seen order,
  // so oldest genuinely is least relevant — unlike lastSeen, which is re-set on
  // every tick and is pruned by store membership in tick() instead: a size trim
  // there would rotate live watermarks out and silently drop their messages.
  function bound(store, max, keep) {
    if (store.size <= max) return;
    for (const k of [...store.keys()]) { store.delete(k); if (store.size <= keep) break; }
  }
  let settings = { captureTeams: true, teamsChatsMode: 'all', teamsChannelsMode: 'mentions', teamsMeetingsMode: 'off', teamsMuteSelf: true };

  const send = (ev) => {
    try { chrome.runtime.sendMessage({ type: 'pager-event', ev }); } catch (e) {}
  };

  const diag = (title, body) =>
    send({ source: '__diag', host: location.host, ts: Date.now(), title, body });

  const open = (name) => new Promise((res, rej) => {
    const r = indexedDB.open(name);
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; rej(new Error('open timeout')); }, 5000);
    r.onsuccess = () => {
      clearTimeout(t);
      const db = r.result;
      // A connection that arrives after the timeout has no owner to close it,
      // and an unclosed connection with no versionchange handler blocks the
      // Teams app's own schema upgrades. Close it either way it goes stale:
      // late arrival now, or an upgrade request while a read is in flight.
      if (timedOut) { try { db.close(); } catch (e) {} return; }
      db.onversionchange = () => { try { db.close(); } catch (e) {} };
      res(db);
    };
    r.onerror = () => { clearTimeout(t); rej(r.error || new Error('open failed')); };
  });

  const readAll = (db, store) => new Promise((res, rej) => {
    try {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('read failed'));
      setTimeout(() => rej(new Error('read timeout')), 8000);
    } catch (e) { rej(e); }
  });

  // `type` is authoritative; the id shape only separates 1:1 from group within
  // Chat. The 48: ids are the self/system streams (notes, drafts, mentions
  // feed) and are never worth paging.
  // 1:1 and group chats share a mode, so both are 'chat'. If they ever need
  // splitting, the id tells them apart: 1:1 ends @unq.gbl.spaces, group
  // @thread.v2.
  function classify(c) {
    if (String(c.id || '').startsWith('48:')) return 'self';
    switch (c.type) {
      case 'Chat': return 'chat';
      case 'Topic':
      case 'Space': return 'channel';
      case 'Meeting': return 'meeting';
      default: return 'other';
    }
  }

  function modeFor(category) {
    switch (category) {
      case 'chat': return settings.teamsChatsMode;
      case 'channel': return settings.teamsChannelsMode;
      case 'meeting': return settings.teamsMeetingsMode;
      default: return 'off';
    }
  }

  // chatTitle is an object ({shortTitle, longTitle, avatarUsersInfo}), not the
  // string it looks like from the outside — and channels do not use it at all,
  // carrying their name under threadProperties instead. Without that fallback a
  // channel mention pages as a bare sender name with no hint of where it came
  // from, which is most of what makes it worth waking up for.
  function titleOf(c) {
    const t = c.chatTitle;
    if (typeof t === 'string' && t) return t;
    if (t && (t.shortTitle || t.longTitle)) return t.shortTitle || t.longTitle;
    const tp = c.threadProperties;
    return (tp && (tp.topic || tp.topicThreadTopic)) || null;
  }

  // Teams writes properties.mentions as *either* a JSON string or an already
  // parsed array, and switches between the two mid-conversation depending on
  // whether the record came from the initial sync or a live delivery. Both
  // shapes have been observed on the same chat minutes apart.
  function mentionsMe(lastMessage) {
    const raw = lastMessage && lastMessage.properties && lastMessage.properties.mentions;
    if (!raw || !me) return false;

    let list = raw;
    if (typeof raw === 'string') {
      if (raw === '[]') return false;
      try { list = JSON.parse(raw); } catch (e) { return raw.includes(me); }
    }
    if (!Array.isArray(list) || !list.length) return false;
    if (list.some((m) => m && (m.mri === me || m.itemid === me || m.id === me))) return true;

    // The key naming has never been seen against a real mention, only empty
    // lists. Until it has, match anywhere in the entry rather than silently
    // dropping a mention because the field was called something else.
    try { return JSON.stringify(list).includes(me); } catch (e) { return false; }
  }

  async function discover() {
    const dbs = await indexedDB.databases();
    const find = (frag) => (dbs.find((d) => d.name && d.name.includes(frag)) || {}).name || null;
    convDbName = find(DB_CONVERSATIONS);
    sliceDbName = find(DB_SLICE);
    chainDbName = find(DB_REPLYCHAIN);
    if (!convDbName) return false;
    // Every database name embeds the signed-in user's object id, so identity
    // comes for free -- no separate lookup, no token parsing.
    const m = convDbName.match(/:([0-9a-f-]{36}):[a-z-]+$/i);
    me = m ? '8:orgid:' + m[1] : null;
    return true;
  }

  async function readConversations() {
    const db = await open(convDbName);
    try { return await readAll(db, STORE_CONVS); } finally { db.close(); }
  }

  // Conversation records arrive pre-sanitized, but the same message pulled out
  // of a reply chain is raw HTML — a mention in particular is a wrapper span
  // around the mentioned name — so anything bound for a notification body goes
  // through here.
  function plain(content) {
    const s = String(content || '');
    if (!/[<&]/.test(s)) return s;
    try {
      const doc = new DOMParser().parseFromString(s, 'text/html');
      return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  function messageIdOf(m, fallback) {
    return String((m && m.id) || (m && m.originalarrivaltime) || fallback || '');
  }

  function toEvent(c, message, opts) {
    const lm = message || c.lastMessage || {};
    const category = classify(c);
    const sender = lm.imdisplayname || lm.fromDisplayNameInToken || 'Teams';
    const chat = titleOf(c);
    return {
      source: 'teams',
      host: location.host,
      ts: Date.now(),
      title: chat && chat !== sender ? sender + ' · ' + chat : sender,
      body: plain(lm.content),
      category,
      conversationId: c.id,
      messageId: messageIdOf(lm, c.lastMessageTimeUtc),
      sender,
      chatTitle: chat,
      isMention: (opts && opts.isMention) || mentionsMe(lm),
      importance: (lm.properties && lm.properties.importance) || '',
    };
  }

  function emit(ev) {
    const key = ev.conversationId + '|' + ev.messageId;
    if (emitted.has(key)) return;
    emitted.add(key);
    bound(emitted, 500, 400);
    send(ev);
  }

  function noteFailure(where, err) {
    failures++;
    if (failures < MAX_FAILURES || degraded) return;
    degraded = true;
    diag('teams capture is failing', where + ': ' + String((err && err.message) || err));
  }

  function noteSuccess() {
    if (degraded) diag('teams capture recovered', 'reads are succeeding again');
    degraded = false;
    failures = 0;
  }

  // Surfaced in the popup so "is this thing on?" has an answer that does not
  // involve waiting for someone to message you. Called from the failure path
  // too — otherwise a broken store never reports and the popup's 'failing'
  // state is unreachable. A flip in either direction goes out immediately; the
  // throttle only paces repeats of the same state.
  async function reportHealth(conversations) {
    const now = Date.now();
    const ok = !degraded;
    if (ok === lastHealthOk && now - lastHealthAt < HEALTH_INTERVAL_MS) return;
    lastHealthAt = now;
    lastHealthOk = ok;
    try {
      // Awaited so the sender holds the port open too; the worker keeps its own
      // side alive by returning true and answering once the write lands.
      await chrome.runtime.sendMessage({
        type: 'pager-health',
        health: { ok, conversations, readMs: lastReadMs, at: now },
      });
    } catch (e) {}
  }

  function isRecent(iso, epoch) {
    const t = Number.isFinite(epoch) ? epoch : Date.parse(iso || '');
    if (!Number.isFinite(t)) return true; // no timestamp to judge by; don't drop it
    const age = Date.now() - t;
    return age <= MAX_AGE_MS && age >= -CLOCK_SKEW_MS;
  }

  // Teams keeps its own index of messages that mention you, which is the only
  // way to catch one that is no longer a conversation's newest message: the
  // conversation store holds a single lastMessage, so a mention followed
  // closely by other replies would otherwise be missed entirely.
  async function pollMentions(convs) {
    if (!sliceDbName) return;

    let items = [];
    try {
      const db = await open(sliceDbName);
      try { items = await readAll(db, STORE_MENTIONS); } finally { db.close(); }
    } catch (e) {
      // Not fatal: the conversation pass still catches a mention that is the
      // newest message, so this degrades rather than blinds capture.
      return;
    }

    const fresh = items.filter((m) => m && m.id && !seenMentions.has(String(m.id)));
    for (const m of fresh) seenMentions.add(String(m.id));
    bound(seenMentions, 2000, 1500);

    // The slice is populated on load, so the first pass is only a baseline.
    if (!mentionsPrimed) { mentionsPrimed = true; return; }

    // The replychains store holds message bodies for every synced thread, so
    // it is by far the most expensive read here. Load it at most once per
    // pass, and only if a mention actually needs resolving.
    let chains = null;
    const loadChains = async () => {
      if (chains) return chains;
      chains = [];
      if (!chainDbName) return chains;
      try {
        const db = await open(chainDbName);
        try { chains = await readAll(db, STORE_CHAINS); } finally { db.close(); }
      } catch (e) {}
      return chains;
    };

    for (const m of fresh) {
      if (!isRecent(null, m.timestamp)) continue;
      const conv = convs.find((c) => c.id === m.sourceThreadId);
      if (!conv) continue;
      if (modeFor(classify(conv)) === 'off') continue;

      const message = await resolveMessage(conv, m, loadChains);
      // Same guard the conversation path applies in shouldEmit(): a mention
      // inside your own message is not worth a page.
      if (settings.teamsMuteSelf && me && message && message.fromUserId === me) continue;
      // Better a page naming the conversation than none at all: knowing you
      // were mentioned is most of the value, and the app is one tap away. The
      // placeholder carries the mention's own message id so two unresolved
      // mentions in one conversation cannot collapse into a single page.
      emit(toEvent(conv, message || { id: m.sourceMessageId || m.id, imdisplayname: null, content: '(mentioned you)' }, { isMention: true }));
    }
  }

  async function resolveMessage(conv, mention, loadChains) {
    const lm = conv.lastMessage;
    if (lm && String(lm.id) === String(mention.sourceMessageId)) return lm;
    const chains = await loadChains();
    const chain = chains.find(
      (c) => c.conversationId === mention.sourceThreadId &&
        String(c.replyChainId) === String(mention.sourceReplyChainId),
    );
    if (!chain || !chain.messageMap) return null;
    for (const v of Object.values(chain.messageMap)) {
      if (v && String(v.id) === String(mention.sourceMessageId)) return v;
    }
    return null;
  }

  function shouldEmit(c) {
    const lm = c.lastMessage;
    if (!lm) return false;
    if (settings.teamsMuteSelf && me && lm.fromUserId === me) return false;
    if (!(lm.content || '').trim()) return false;

    const category = classify(c);
    const mode = modeFor(category);
    if (mode === 'off') return false;
    if (mode === 'mentions' && !mentionsMe(lm)) return false;

    return isRecent(lm.originalarrivaltime || lm.composetime);
  }

  async function tick() {
    if (!settings.captureTeams) return;

    // Teams creates its databases lazily, so on a fresh profile (or after a
    // site-data clear) they may not exist yet when this script lands. A single
    // shot at discovery would leave capture dead for the tab's lifetime; keep
    // looking instead — databases() is one cheap call per tick, and the slice
    // and replychain stores can also show up later than conversations.
    if (!convDbName || !sliceDbName || !chainDbName) {
      try { await discover(); } catch (e) {}
      if (!convDbName) return;
    }
    if (!announced) {
      announced = true;
      diag('pager teams capture installed', 'host=' + location.host + ' me=' + (me ? 'ok' : 'unknown'));
    }

    // Every tick reads the whole store. The obvious optimisation -- gate on the
    // cheap `conversations-internal-data` watermark and only read on change --
    // does not work: that watermark tracks sync *sessions*, not message writes.
    // Measured, its sync token still read 17:34 while a message that landed at
    // 18:34 sat in `conversations`, so gating on it drops live messages.
    //
    // The full read costs ~15 ms of structured-clone deserialisation for a few
    // hundred conversations, so at this interval it is a fraction of a percent
    // of one core. Correctness is worth more than the saving.
    let rows;
    const started = Date.now();
    try {
      rows = await readConversations();
    } catch (e) {
      noteFailure('conversations', e);
      reportHealth(lastConvCount);
      return;
    }
    lastReadMs = Date.now() - started;
    lastConvCount = rows.length;
    noteSuccess();

    const fresh = [];
    let dated = 0;
    for (const c of rows) {
      const t = c.lastMessageTimeUtc;
      if (typeof t !== 'number') continue;
      dated++;
      const prev = lastSeen.get(c.id);
      lastSeen.set(c.id, t);
      if (prev !== undefined && t > prev) fresh.push(c);
    }

    // Reading the store fine but finding nothing shaped like a conversation is
    // the signature of a schema change, and is otherwise indistinguishable from
    // nobody talking to you.
    if (rows.length && !dated && !shapeWarned) {
      shapeWarned = true;
      diag('teams capture found no usable conversations', rows.length + ' records, none with lastMessageTimeUtc');
    }
    // Forget only conversations gone from the store. Every live conversation
    // was just re-set above, so insertion order says nothing about relevance —
    // an oldest-first trim would rotate live watermarks out, and each victim
    // re-baselines on its next message, silently dropping it.
    if (lastSeen.size > dated) {
      const current = new Set();
      for (const c of rows) current.add(c.id);
      for (const k of lastSeen.keys()) if (!current.has(k)) lastSeen.delete(k);
    }
    reportHealth(rows.length);

    // The first pass only learns where every conversation stands. Emitting it
    // would page the whole chat list on tab open.
    if (!primed) {
      primed = true;
    } else {
      for (const c of fresh) if (shouldEmit(c)) emit(toEvent(c));
    }

    // Runs after the conversation pass so that a mention which *is* the newest
    // message has already been emitted and deduplicated by message id.
    await pollMentions(rows);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'pager-control') return;
    // Chrome throttles this tab's timers to about once a minute once it is in
    // the background, which is exactly when paging matters. The worker's alarm
    // is not throttled the same way, so it pokes us.
    if (msg.control === 'poll') tick();
    else if (msg.control === 'config' && msg.config) Object.assign(settings, msg.config);
  });

  (async () => {
    try {
      const cfg = await chrome.runtime.sendMessage({ type: 'pager-get-config' });
      if (cfg) Object.assign(settings, cfg);
    } catch (e) {}

    let ok = false;
    try { ok = await discover(); } catch (e) {}
    if (!ok) {
      // Teams renaming its store would otherwise mean capture just goes quiet,
      // which is indistinguishable from a slow day. Say so — but keep polling:
      // on a fresh profile the app creates its databases *after* this script
      // lands, and tick() retries discovery until they appear.
      diag('teams capture cannot find its store', 'conversation-manager missing on ' + location.host + '; still looking');
    }

    await tick();
    setInterval(tick, TICK_MS);
  })();
})();
