# Pager capture extension

Chrome MV3 extension. Captures Teams/Outlook communications from signed-in tabs,
queues them durably in extension-origin IndexedDB, and sends authenticated batches
to the local Rust collector. The collector commits before attempting eligible
phone notifications through the existing bridge. A missing collector or token
**stops paging as well as archival delivery**; there is no direct-bridge fallback.
Other clients can still send directly to the bridge.

## Capture scope

- **Teams:** reads available conversations and replychains from the Teams web
  app's IndexedDB every few seconds. Imports cached retained message text,
  including your own replies, without paging initial history. New messages
  may page according to chat/channel/meeting mode and the paging schedule.
  Mention metadata alone is saved as conversation context, not invented text.
  A Teams cache is not a complete export. Deleted or unsupported message bodies
  are marked as such; disappearance from cache is not treated as deletion.
- **Outlook:** observes the signed-in tab's normal authentication/routing headers
  in memory, then uses read-only `FindItem`/`GetItem` requests against the
  personal Inbox and Sent Items and `GetConversationItems` for observed threads.
  It archives plain-text bodies when available and preserves sent provenance.
  An observed SignalR conversation is metadata, not a fabricated message body.
  No Graph token, attachment bytes, authentication headers or raw service
  response is sent to the extension worker or collector. This does not scan
  every folder or shared mailbox. Close the tab or lose authentication and
  active retrieval cannot continue; collection status reflects the gap.

Source scans skip bodies older than 365 days; the collector independently
prunes retained records on a rolling 365-day window. `bodyStatus` distinguishes
full, missing, truncated, unsupported and explicitly deleted content. Imported
history never generates retroactive pages. When a source shape changes, its
status becomes degraded rather than silently claiming a complete archive.

## Connection and privacy

1. Install/start `pager-collector` as described in the root README and initialize
   its private archive/token directory. Keep the collector bound to loopback.
2. At `chrome://extensions`, enable Developer mode → **Load unpacked** → select
   this `extension/` directory. Reload already-open Teams/Outlook tabs once
   after installation so their capture scripts are injected.
3. Open extension **Settings**. Enter the contents of the local `ingest-token`
   file in the **Collector token** password input. The collector URL defaults
   to `http://localhost:4501/capture`; downstream bridge URL defaults to
   `http://localhost:4500/capture`. Both accept only credential-free loopback
   HTTP `/capture` addresses. Do not paste the token into chats or logs.

The token, collector URL and installation identity use `chrome.storage.local`;
non-secret preferences use `chrome.storage.sync`. Pending bodies stay in the
extension-origin `pager-capture` IndexedDB only until collector acknowledgement.
Outbox delivery retries across service-worker restarts; HTTP validation/auth
errors stop automatic draining until settings change or restart, with a redacted
status shown in the popup. A full queue refuses new captures rather than
silently deleting them. Neither the source page nor MAIN-world scripts receive
the collector token. The archive is plaintext SQLite with private filesystem
permissions, **not encryption at rest**. Grant MCP access only to agents you
trust with private communications.

The popup shows collector connectivity, pending count, separate Teams and Outlook
source health, and capture toggles. If you restore an older archive backup with
the same archive ID, choose **Re-import from sources** in options. It resets
revision ledgers and re-reads still-available source data without paging history;
there is no promise that a source still retains previously imported messages.
A new archive ID automatically triggers that re-import.

## Diagnostics

Each Outlook request (except successful per-message `GetItem` calls), folder
sweep and failed poll, and each notable Teams cache scan, is recorded as a
redacted entry: action, folder, paging values, HTTP status, Exchange response
code and message, returned/total counts, whether OWA's service worker handled
the request, timing, and for Teams the store counts and failing stage. Entries
never include headers, tokens, subjects, bodies or addresses. The options page
lists the last 500 with **Copy diagnostics**, and they are forwarded best effort
to the collector's `/diagnostics` endpoint (separate from the capture outbox),
where agents read them with the `get_source_diagnostics` MCP tool. Status
reasons also name the failing step, for example
`source_response_error: FindItem/sentitems ErrorInternalServerError`.

**Console debug probe** (options, off by default) adds `__pagerDebug` to open
Outlook tabs. `await __pagerDebug.probe('FindItem', body)` sends one read-only
request (`FindItem`, `GetItem`, `GetConversationItems`, `FindFolder`,
`GetFolder`, `FindConversation`) with the tab's existing sign-in and returns the
response code, counts and per-item ids and dates, never headers or content.
`await __pagerDebug.diagnostics()` returns the log. Any script running in the
Outlook page can call these while enabled, so turn it off when done.

## Paging and activity

The popup has independent **Phone notifications** and **Keep Teams active**
selectors. Paging: `Scheduled`, `Always notify` (default), `Always silent`.
Teams activity: `Scheduled`, `Always on`, `Always off` (default). The latter two
choices in each selector are persistent manual overrides; changing capture
toggles is separate. The options page has add/remove daily HH:MM local-time
windows for paging silence and Teams activity. Windows include the start and
exclude the end, can overlap or cross midnight, and repeat every day. A
scheduled feature with no windows has no active interval. Malformed stored
schedules fail closed and show an error; invalid values are not silently reset.
Windows follow the computer's current time zone, including DST transitions.

Teams paging defaults: chats `all`, channels `mentions`, meetings `off`, and
self messages do not page. Those settings affect **only notifications**, not
which available messages are archived. A candidate older than ten minutes or
far in the future never pages. Before sending a queued event, the worker checks
the **current** paging mode: crossing into silence strips the pending page but
still archives the record. Silence never stops Teams/Outlook collection. When
the bridge is unavailable, an archive receipt still succeeds, but an eligible
page is attempted at most once; it will not replay when the bridge recovers.
The bridge's own `PAGER_QUIET` still applies to every sender.

Activity uses a best-effort synthetic mouse/Shift pulse (`keep-active.js`) and,
when enabled, a Teams-only visibility/focus mask (`keep-active-mask.js`). Browser
synthetic events remain untrusted. A tab must stay open; neither script can
force Microsoft presence to remain Active. The mask starts inert, takes effect
only while activity is enabled, and restores original descriptors/listeners
when turned off. Chrome's minute heartbeat updates already-open tabs at schedule
boundaries; it is not an exact-to-the-second presence switch. Toggling a mode
that needs presence scripts also injects them into already-open Teams tabs
without requiring reload. Disabling/re-enabling capture scripts themselves
requires a tab reload when they were absent at its original load.

## Development

```bash
node --test extension/test/*.test.mjs
```

`background.js` owns runtime content-script registrations, durable enqueue,
collector delivery and the alarm. `teams-idb.js` reads Teams IndexedDB in the
isolated world; `outlook-read.js` and `main-capture.js` observe/read Outlook in
the MAIN world; `relay.js` transports MAIN-world messages into the worker without
passing local credentials into the page. `settings.js` owns shared defaults,
validation, schedules and migration from the legacy keep-active checkbox.
