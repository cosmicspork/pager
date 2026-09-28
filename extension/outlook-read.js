(() => {
  'use strict';
  if (window.__pagerOutlookRead) return;
  const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
  const HEADERS = ['authorization', 'x-anchormailbox', 'x-tenantid', 'x-owa-sessionid', 'x-clientid',
    'x-client-version', 'owaappid', 'x-ms-appname', 'x-routingparameter-sessionkey', 'prefer'];
  const ACTIONS = new Set(['FindItem', 'GetItem', 'GetConversationItems']);
  const folders = ['inbox', 'sentitems'];
  const templates = new Map();
  const anchors = new Set();
  const pendingThreads = new Map();
  const revisions = new Map();
  const bodies = new Map();
  const failedItems = new Map();
  let failedLoaded = false;
  let emit;
  let worker;
  let active = false;
  let captureEnabled = true;
  let authAccount = null;
  let polling = false;
  let nextStart = 0;
  let pauseUntil = 0;
  let lastSweep = 0;
  let lastStatus = 0;
  let initialComplete = false;
  let reason = null;
  let oldest = null;
  let originalFetch = null;

  const epoch = (value) => {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? time : null;
  };
  const cutoff = () => Date.now() - RETENTION_MS;
  const sourceKey = (type, account, item) => `${type}:outlook:${account}:${item}`;
  function linkOf(raw) {
    try {
      const link = new URL(raw, location.origin);
      return link.protocol === 'https:' && !link.username && !link.password &&
        ['outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft'].includes(link.hostname) ? link.href : null;
    } catch { return null; }
  }
  function mailbox(value) {
    const box = value?.Mailbox || value;
    if (!box || typeof box !== 'object') return null;
    const name = typeof box.Name === 'string' ? box.Name.slice(0, 512) : null;
    const email = typeof box.EmailAddress === 'string' ? box.EmailAddress.slice(0, 512) : null;
    return name || email ? { name, email } : null;
  }
  const recipients = (item, property, role) => {
    const list = item[property];
    const values = Array.isArray(list) ? list : Array.isArray(list?.Mailbox) ? list.Mailbox : list?.Mailbox ? [list.Mailbox] : [];
    return values.map((entry) => mailbox(entry)).filter(Boolean).map((entry) => ({ ...entry, role }));
  };
  const itemTime = (item, sent) => epoch(sent ? item.DateTimeSent : item.DateTimeReceived)
    ?? epoch(sent ? item.DateTimeReceived : item.DateTimeSent) ?? epoch(item.DateTimeCreated);
  const revisionOf = (item) => item.ItemId?.ChangeKey || null;
  const itemId = (item) => item.ItemId?.Id || null;
  const threadId = (item) => item.ConversationId?.Id || null;
  function baseRecord(item, id, conversation, sent) {
    return {
      messageId: id, conversationId: conversation || id, title: String(item.Subject || '').slice(0, 2000),
      category: 'mail', bodyStatus: 'missing', body: null, sourceTime: itemTime(item, sent),
      modifiedAt: epoch(item.LastModifiedTime), version: revisionOf(item),
      sender: mailbox(item.From) || mailbox(item.Sender),
      recipients: [...recipients(item, 'ToRecipients', 'to'), ...recipients(item, 'CcRecipients', 'cc'), ...recipients(item, 'BccRecipients', 'bcc')].slice(0, 500),
      recipientsTruncated: ['ToRecipients', 'CcRecipients', 'BccRecipients'].reduce((sum, key) => sum + (item[key]?.length || 0), 0) > 500,
      isSelf: sent ? true : null, isMention: null, hasAttachments: item.HasAttachments ?? null,
      url: linkOf(item.WebClientReadFormQueryString), replyToMessageId: null,
    };
  }
  async function status(state, nextReason, force = false) {
    if (!emit || !authAccount) return;
    if (!force && Date.now() - lastStatus < 60000 && state === (reason ? 'degraded' : 'ok')) return;
    reason = nextReason;
    lastStatus = Date.now();
    await emit({ source: 'outlook', accountId: authAccount, observedAt: Date.now(), kind: 'status',
      status: { state, reason: nextReason, coverage: 'outlook_inbox_sent_and_observed_threads',
        initialSyncComplete: initialComplete, oldestSourceTime: oldest, pending: pendingThreads.size } });
  }
  async function readRequest(action, body) {
    if (!captureEnabled) throw new Error('source_disabled');
    if (!ACTIONS.has(action)) throw new Error('invalid_action');
    const template = templates.get(authAccount);
    if (!template) throw new Error('waiting_for_auth');
    const wait = Math.max(nextStart, pauseUntil) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (templates.get(authAccount) !== template) throw new Error('waiting_for_auth');
    nextStart = Date.now() + 1000;
    const version = action === 'GetConversationItems' ? 'V2017_08_18' : 'V2018_01_18';
    const response = await originalFetch.call(window, new URL(`/owa/service.svc?action=${action}&app=Mail&UA=0`, location.origin), {
      method: 'POST', credentials: 'include',
      headers: { ...template.headers, Action: action, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ __type: `${action}JsonRequest:#Exchange`,
        Header: { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: version }, Body: body }),
    });
    if (response.status === 401 || response.status === 403) {
      templates.delete(authAccount);
      await status('waiting_for_auth', 'auth_expired', true);
      throw new Error('waiting_for_auth');
    }
    if (response.status === 429 || response.status === 503) {
      const retry = response.headers.get('Retry-After');
      const seconds = Number(retry);
      const until = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000 : epoch(retry);
      pauseUntil = until && until > Date.now() ? until : Date.now() + 60000;
      await status('degraded', 'source_throttled', true);
      throw new Error('source_throttled');
    }
    if (!response.ok) throw new Error('source_http_error');
    const parsed = await response.json();
    const envelope = parsed?.Body?.ResponseMessages?.Items?.[0];
    if (!envelope || envelope.ResponseClass !== 'Success' || envelope.ResponseCode !== 'NoError') {
      throw new Error('source_response_error');
    }
    return envelope;
  }
  function findShape(folder, offset) {
    return { __type: 'FindItemRequest:#Exchange',
      ParentFolderIds: [{ __type: 'DistinguishedFolderId:#Exchange', Id: folder }],
      ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'AllProperties' },
      Traversal: 'Shallow', Paging: { __type: 'IndexedPageView:#Exchange', BasePoint: 'Beginning', Offset: offset, MaxEntriesReturned: 50 },
      FocusedViewFilter: -1, ViewFilter: 'All' };
  }
  function itemShape(id) {
    return { __type: 'GetItemRequest:#Exchange',
      ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'AllProperties', BodyType: 'Text', MaximumBodySize: 2097152 },
      ItemIds: [{ __type: 'ItemId:#Exchange', Id: id }] };
  }
  function threadShape(id, limit) {
    return { __type: 'GetConversationItemsRequest:#Exchange',
      Conversations: [{ __type: 'ConversationRequestType:#Exchange', ConversationId: { __type: 'ItemId:#Exchange', Id: id }, SyncState: '' }],
      ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'IdOnly', FilterHtmlContent: true,
        BlockExternalImagesIfSenderUntrusted: true, MaximumBodySize: 2097152 },
      ShapeName: 'ItemPart', SortOrder: 'DateOrderDescending', MaxItemsToReturn: limit,
      Action: 'ReturnRootNode', FoldersToIgnore: [], ReturnSubmittedItems: true, ReturnDeletedItems: true };
  }
  async function revision(id) {
    if (!revisions.has(id)) {
      const result = await worker({ type: 'pager-sync-get', source: 'outlook', accountId: authAccount, key: sourceKey('revision', authAccount, id) });
      revisions.set(id, result?.ok ? result.value || null : null);
    }
    return revisions.get(id);
  }
  async function bodyState(id) {
    if (!bodies.has(id)) {
      const result = await worker({ type: 'pager-sync-get', source: 'outlook', accountId: authAccount, key: sourceKey('body', authAccount, id) });
      bodies.set(id, result?.ok ? result.value || null : null);
    }
    return bodies.get(id);
  }
  async function save(type, id, value) {
    const result = await worker({ type: 'pager-sync-put', source: 'outlook', accountId: authAccount, key: sourceKey(type, authAccount, id), value });
    if (!result?.ok) throw new Error('sync_write_failed');
    (type === 'revision' ? revisions : bodies).set(id, value);
  }
  async function enqueue(record) {
    if (record.sourceTime !== null) oldest = oldest === null ? record.sourceTime : Math.min(oldest, record.sourceTime);
    const ack = await emit({ source: 'outlook', accountId: authAccount, observedAt: Date.now(), kind: 'message', message: record });
    if (!ack) throw new Error('outbox_unavailable');
  }
  async function loadFailures() {
    if (failedLoaded) return;
    const response = await worker({ type: 'pager-sync-get', source: 'outlook', accountId: authAccount,
      key: sourceKey('import', authAccount, 'failed-items') });
    if (Array.isArray(response?.value)) {
      for (const entry of response.value) if (entry.id && entry.conversationId) failedItems.set(entry.id, entry);
    }
    failedLoaded = true;
  }
  async function saveFailures() {
    const response = await worker({ type: 'pager-sync-put', source: 'outlook', accountId: authAccount,
      key: sourceKey('import', authAccount, 'failed-items'), value: [...failedItems.values()] });
    if (!response?.ok) throw new Error('sync_write_failed');
  }
  async function retrieve(meta, sent, sweepFailures = new Map()) {
    if (meta.IsDraft === true) return;
    const id = itemId(meta);
    if (!id) throw new Error('invalid_item_shape');
    const time = itemTime(meta, sent);
    if (time !== null && time < cutoff()) return;
    const changeKey = revisionOf(meta);
    const known = await revision(id);
    const state = await bodyState(id);
    if (sent && known?.changeKey === changeKey && !known.isSelf) {
      await enqueue({ ...baseRecord(meta, id, threadId(meta), true), bodyStatus: 'missing' });
      await save('revision', id, { changeKey, isSelf: true });
      return;
    }
    const retry = state?.state === 'failed' && (state.nextRetry || 0) <= Date.now() && (sweepFailures.get(id) || 0) < 3;
    if (known?.changeKey === changeKey && state?.state === 'fetched' && !retry) return;
    if (known?.changeKey === changeKey && state?.state === 'failed' && !retry) return;
    let record;
    try {
      const response = await readRequest('GetItem', itemShape(id));
      const item = response.Items?.[0];
      if (!item || itemId(item) !== id) throw new Error('invalid_item_shape');
      if (item.IsDraft === true) return;
      record = baseRecord(item, id, threadId(item) || threadId(meta), sent);
      record.body = typeof item.Body?.Value === 'string' ? item.Body.Value : null;
      record.bodyStatus = record.body === null ? 'missing' : item.Body?.IsTruncated ? 'truncated' : 'full';
      await enqueue(record);
      await save('body', id, { state: record.body === null ? 'failed' : 'fetched', attempts: 0, nextRetry: 0 });
      if (record.body === null) failedItems.set(id, { id, conversationId: record.conversationId, sent });
      else failedItems.delete(id);
      await saveFailures();
    } catch (error) {
      if (error.message === 'waiting_for_auth' || error.message === 'source_throttled') throw error;
      record = baseRecord(meta, id, threadId(meta), sent);
      await enqueue(record);
      const attempts = (state?.attempts || 0) + 1;
      sweepFailures.set(id, (sweepFailures.get(id) || 0) + 1);
      await save('body', id, { state: 'failed', attempts, nextRetry: Date.now() + Math.min(24 * 60 * 60 * 1000, 60000 * 2 ** Math.min(attempts, 10)) });
      failedItems.set(id, { id, conversationId: record.conversationId, sent });
      await saveFailures();
      await status('degraded', 'body_fetch_failed', true);
    }
    await save('revision', id, { changeKey, isSelf: sent || known?.isSelf === true });
  }
  async function retrieveThread(id) {
    let limit = 50;
    let previous = -1;
    let truncated = false;
    const seen = new Map();
    while (true) {
      const envelope = await readRequest('GetConversationItems', threadShape(id, limit));
      const conversation = envelope.Conversation;
      if (!conversation || !Array.isArray(conversation.ConversationNodes)) throw new Error('invalid_thread_shape');
      for (const node of conversation.ConversationNodes) {
        for (const item of node.Items || []) {
          const key = itemId(item);
          if (key) seen.set(key, item);
        }
      }
      const total = Number(conversation.TotalConversationNodesCount);
      const nodeCount = conversation.ConversationNodes.length;
      if (!Number.isFinite(total)) throw new Error('invalid_thread_shape');
      if (nodeCount >= total) break;
      if (nodeCount <= previous) { truncated = true; break; }
      previous = nodeCount;
      limit += 50;
    }
    for (const item of seen.values()) await retrieve(item, false);
    if (truncated) throw new Error('thread_truncated');
  }
  async function sweep(folder) {
    const key = sourceKey('import', authAccount, folder);
    let offset = 0;
    const failureCount = new Map();
    while (true) {
      const response = await readRequest('FindItem', findShape(folder, offset));
      const root = response.RootFolder;
      if (!root || !Array.isArray(root.Items) || typeof root.IncludesLastItemInRange !== 'boolean') throw new Error('invalid_find_shape');
      for (const item of root.Items) {
        if (pendingThreads.size) await drainThreads();
        await retrieve(item, folder === 'sentitems', failureCount);
      }
      const next = Number(root.IndexedPagingOffset);
      if (!root.IncludesLastItemInRange && (!Number.isSafeInteger(next) || next <= offset)) throw new Error('pagination_stalled');
      offset = next;
      const saved = await worker({ type: 'pager-sync-put', source: 'outlook', accountId: authAccount, key, value: { offset, at: Date.now() } });
      if (!saved?.ok) throw new Error('sync_write_failed');
      if (root.IncludesLastItemInRange) break;
    }
  }
  async function drainThreads() {
    for (const [id, nextRetry] of pendingThreads) {
      if (nextRetry > Date.now()) continue;
      try {
        await retrieveThread(id);
        pendingThreads.delete(id);
      } catch (error) {
        pendingThreads.set(id, Date.now() + 15 * 60 * 1000);
        throw error;
      }
    }
  }
  async function poll() {
    if (polling || !captureEnabled || !active || !templates.has(authAccount)) return;
    polling = true;
    try {
      await loadFailures();
      await drainThreads();
      if (!initialComplete || Date.now() - lastSweep >= 15 * 60 * 1000) {
        await status('syncing', reason && pendingThreads.size ? reason : null, true);
        for (const folder of folders) await sweep(folder);
        for (const failure of [...failedItems.values()]) {
          if (pendingThreads.size) await drainThreads();
          const known = await revision(failure.id);
          await retrieve({ ItemId: { Id: failure.id, ChangeKey: known?.changeKey },
            ConversationId: { Id: failure.conversationId } }, failure.sent);
        }
        initialComplete = true;
        lastSweep = Date.now();
      }
      await status(reason && pendingThreads.size ? 'degraded' : 'ok', reason && pendingThreads.size ? reason : null, true);
    } catch (error) {
      const code = ['waiting_for_auth', 'source_throttled', 'pagination_stalled', 'thread_truncated', 'invalid_thread_shape', 'invalid_find_shape', 'sync_write_failed', 'outbox_unavailable', 'source_response_error'].includes(error.message) ? error.message : 'source_read_failed';
      await status(code === 'waiting_for_auth' ? 'waiting_for_auth' : 'degraded', code, true);
    } finally { polling = false; }
  }
  function observe(input, init, fetchOriginal) {
    if (!captureEnabled) return;
    const url = new URL(typeof input === 'string' ? input : input?.url || '', location.origin);
    if (url.origin !== location.origin || !(/\/owa\/service\.svc|\/MessageService\/api\/v1\/getConversationSummary|\/ows\/v2\.0\//.test(url.pathname))) return;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const anchor = headers.get('x-anchormailbox')?.toLowerCase();
    const tenant = headers.get('x-tenantid')?.toLowerCase();
    if (!anchor || !tenant) return;
    anchors.add(anchor);
    const account = tenant + ':' + anchor;
    if (anchors.size > 1) { active = false; status('degraded', 'multiple_mailboxes', true); return; }
    if (!headers.get('authorization')) {
      authAccount = account;
      status('waiting_for_auth', 'auth_not_observed', true);
      return;
    }
    authAccount = account;
    originalFetch = fetchOriginal;
    templates.set(account, { headers: Object.fromEntries(HEADERS.filter((key) => headers.has(key)).map((key) => [key, headers.get(key)])) });
    active = true;
    poll();
  }
  function conversation(conversation) {
    if (!captureEnabled || !authAccount) return false;
    const id = conversation?.ConversationId?.Id;
    if (!id) return true;
    const sender = Array.isArray(conversation.UniqueSenders) ? conversation.UniqueSenders.join(', ') : '';
    const subject = conversation.ConversationTopic || '';
    const time = epoch(conversation.LastDeliveryTime);
    const candidate = time !== null && Date.now() - time >= -120000 && Date.now() - time <= 600000 && (sender || subject) ? {
      key: id + ':' + conversation.LastDeliveryTime, sourceTime: time,
      title: [sender, subject].filter(Boolean).join(' — '), body: subject || sender,
      conversationId: id, lastDelivery: conversation.LastDeliveryTime,
    } : undefined;
    emit({ source: 'outlook', accountId: authAccount, observedAt: Date.now(), kind: 'conversation',
      conversation: { conversationId: id, title: subject, sourceTime: time,
        unread: conversation.GlobalUnreadCount == null ? null : conversation.GlobalUnreadCount > 0,
        hasAttachments: conversation.HasAttachments ?? null }, notification: candidate });
    pendingThreads.set(id, true);
    poll();
    return true;
  }
  function reimport() {
    revisions.clear(); bodies.clear(); failedItems.clear(); failedLoaded = false; initialComplete = false; lastSweep = 0;
    poll();
  }
  function setEnabled(enabled) {
    captureEnabled = enabled;
    if (!enabled) {
      active = false;
      status('disabled', null, true);
    } else {
      active = anchors.size === 1 && templates.has(authAccount);
      poll();
    }
  }
  window.__pagerOutlookRead = Object.freeze({
    install(hooks) { emit = hooks.emit; worker = hooks.worker; },
    observe, conversation, poll, reimport, setEnabled,
    hasAccount: () => !!authAccount,
  });
  setInterval(poll, 60000);
})();
