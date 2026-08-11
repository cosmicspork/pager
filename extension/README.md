# Pager capture extension

Chrome MV3 extension that captures message events from Teams and Outlook web and
forwards them to the local Pager bridge, and (optionally) keeps the Teams web app
from reporting you idle. Replaces the Tampermonkey spikes in `../spike/`.

## What it captures

- **Teams** — messages, by reading the conversation store the Teams web app
  keeps in IndexedDB (`source: "teams"`, with `title`, `body`, `category`,
  `conversationId`, `messageId`, `isMention`).
- **Outlook** — new-mail events, by reading the `/owa/notificationchannel`
  SignalR-over-SSE stream and parsing `syncMessage` frames (`source: "outlook"`,
  with `sender`, `subject`, `unread`, `conversationId`, …).

Teams capture used to wrap the page's `Notification` constructor. That only ever
fired when Teams decided you were *not* looking at the tab — so turning on
keep-active, whose mask exists to convince Teams of the opposite, silently
killed Teams paging entirely. Reading the store does not depend on Teams
choosing to notify, so the two features are no longer mutually exclusive.

Teams runs its messaging stack in a Web Worker and never hands the page the
message text, so there is nothing to hook in the MAIN world. IndexedDB is
per-origin, so an ISOLATED-world content script on that origin reads the
worker's store directly.

### What gets paged

Per conversation kind, using Teams' own `type` field — `Chat` covers 1:1 and
group, `Topic`/`Space` are channels, `Meeting` is a meeting's chat. Each is
`off` / `mentions` / `all`:

| Kind | Default | |
|---|---|---|
| Chats | `all` | 1:1 and group |
| Channels | `mentions` | only messages that @-mention you |
| Meetings | `off` | busy and rarely worth a buzz; opt in if you want it |

Your own messages are dropped (`teamsMuteSelf`), and anything older than ten
minutes is ignored — Teams re-syncs a lot of conversations on startup and on
reconnect, and without that floor every one of them looks new.

Mentions come from two places, because neither alone is enough. The
conversation store keeps only a single `lastMessage` per conversation, so a
mention that other people reply on top of disappears from that view before the
next poll sees it. Teams also keeps its own index of messages that mention you
(`messaging-slice-manager` → `mentions-metadata-items`), which is read each
tick; anything new there is resolved to its body through
`replychain-manager` → `replychains` → `messageMap`. Both paths dedupe on the
message id, so a mention that *is* the newest message is still one page.

If the body cannot be resolved, the mention is still sent with the conversation
named and a placeholder body — knowing you were mentioned is most of the value,
and the app is one tap away.

## Keep Teams active

Off by default. The extension sends two kinds of browser signals:

- `keep-active.js` — dispatches a synthetic `mousemove` and a Shift
  `keydown`/`keyup` on an interval (default 240s, under the ~5 minute idle
  threshold). Shift is chosen because it cannot alter a focused composer.
  Browser-created events remain `isTrusted === false`; `dispatchEvent()` cannot
  make them user input. Verify that Teams accepts these pulses in your tenant.
- `keep-active-mask.js` — reports the tab visible, the window focused, and the
  OS not idle (`document.hidden`, `visibilityState`, `hasFocus()`,
  lifecycle callbacks for `visibilitychange`, `focus`, `blur`, `freeze`, and
  `resume`, plus `IdleDetector`). Only needed if you background the tab, but
  that is the usual case. This is the most invasive thing the extension does —
  it changes what the page observes rather than only reading — so it is a
  separate toggle, preserves listeners for live toggle-off, and is only ever
  registered for Teams hosts.

Because Chrome throttles page timers in background tabs — exactly where this
matters — a `chrome.alarms` heartbeat in the service worker also pokes open Teams
tabs once a minute. The page timer and the poke share one throttle, so whichever
arrives first pulses and the other is a no-op.

The tab has to stay open. This is best-effort activity simulation, not a
guarantee that Teams will hold your presence.

## Settings

Toolbar popup for the three toggles worth flipping mid-session (Teams capture,
Outlook capture, keep-active) plus a bridge/last-event status readout. Full
settings on the options page (right-click the icon → Options, or **Settings** in
the popup):

| Setting | Default | |
|---|---|---|
| Teams capture | on | inject the Teams capture script |
| Chats | `all` | 1:1 and group chats — `off`/`mentions`/`all` |
| Channels &amp; teams | `mentions` | channels and teams — `off`/`mentions`/`all` |
| Meeting chats | `off` | meeting chats — `off`/`mentions`/`all` |
| Mute my own messages | on | drop messages you sent |
| Outlook capture | on | inject the Outlook capture script |
| Keep Teams active | off | synthetic input pulses |
| Pulse interval | 240s | clamped to 30–900s |
| Mask visibility & focus | on | the `keep-active-mask.js` half, when keep-active is on |
| Capture endpoint | `http://localhost:4500/capture` | must be http on loopback |
| Forward the install ping | on | the one `__diag` event per tab load |

Settings live in `chrome.storage.sync`. The bridge URL is restricted to
`localhost`/`127.0.0.1` — the hosts granted in `manifest.json`. The bridge holds
the only long-term identity key and is not meant to be reachable off the
machine, so a bad paste cannot start shipping captured message text elsewhere.

## How it's wired

Content scripts are registered at runtime by `background.js` from the settings
above, rather than declared in the manifest. That is what makes the toggles mean
what they say: a disabled feature is never injected, instead of a script that
loads and then checks a flag. Chrome persists these registrations across
restarts and applies them at `document_start`, same as a manifest-declared
script. Already-open tabs keep whatever was injected at load; a settings change
is also broadcast to them so keep-active picks it up live, but a capture toggle
needs a reload to take effect there.

Which world a script needs depends on whether it has to touch page objects:

- `teams-idb.js` — **isolated** world, Teams hosts. Reads the page origin's
  IndexedDB and talks to the service worker over `chrome.runtime` directly, so
  it needs neither the MAIN world nor `relay.js`. Every few seconds it reads the
  conversation store and diffs `lastMessageTimeUtc` per conversation. The read
  costs single-digit to ~20 ms once warm.

  It is tempting to gate that read on the cheap `conversations-internal-data`
  watermark, and wrong: that watermark tracks sync *sessions*, not message
  writes. Measured, its sync token still read an hour stale while a
  just-arrived message sat in `conversations` — so gating on it drops live
  messages.
- `main-capture.js`, `keep-active.js`, `keep-active-mask.js` — the page's **MAIN**
  world, so they patch the objects the app actually calls and dispatch onto the
  document it actually listens to. `main-capture.js` is now Outlook-only; it
  patches `fetch` there to read the notification stream.
- `relay.js` — **isolated** world, carrying MAIN-world messages out to the
  service worker and control messages back in. Needed wherever a MAIN-world
  script runs.
- `background.js` — service worker; owns registrations, the alarm, and POSTing
  each event to the bridge. Extension fetch is exempt from the page CSP.

Chrome throttles a background tab's timers to about once a minute, which is
exactly when paging matters, so the worker's alarm also pokes open Teams tabs to
poll. (The throttle keys on whether the tab is really backgrounded, not on what
keep-active's mask tells the page, so masking does not help here.)

If Teams renames the store, capture would otherwise just go quiet — which looks
identical to a slow day. `teams-idb.js` guards against that: a run of failed
reads emits a `teams capture is failing` diagnostic (once, with a recovery note
when reads resume), and a store it can read but no longer parse emits
`found no usable conversations`. It also reports a heartbeat to the worker each
minute — conversation count and read time — which the popup shows as the
`teams capture` line (`ok · N convs · Nms`, or `stale`/`failing`). So "nothing
came through" can be told apart from "the store moved". That heartbeat rides its
own session-storage key and holds the worker's message channel open until the
write lands, since a lone fire-and-forget write is otherwise lost when the
worker suspends.

`settings.js` is the shared contract (defaults, host lists, clamps) imported by
the worker and both pages, so nothing re-derives them.

Host matches are named per app rather than using the old
`https://*.cloud.microsoft/*` wildcard, which covered both Teams and Outlook and
so couldn't be attributed to one toggle. `teams.cloud.microsoft` and
`outlook.cloud.microsoft` are listed explicitly instead — a narrower grant, but
check here first if a tenant serves either app from some other subdomain.

## Load it

1. Disable the Tampermonkey `Pager …` scripts (this replaces them).
2. Start the dev sink (until the Rust bridge exists): `cd ../spike && bun run sink.ts`.
3. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   this `extension/` folder.
4. Reload Teams and Outlook. Look for a `pager extension capture installed`
   line per tab in the sink, or check the popup's status readout.

## Not yet

- Filtering (inbox-only, new vs. read) for Outlook `syncMessage` needs tuning
  against live traffic — it currently emits every conversation sync.
- Teams real-time over the Trouter WebSocket (richer than the Notification API)
  and the Phase-2 pull API surface (`service.svc` / Teams REST replay).
- Keep-active is Teams-only. Nothing equivalent exists for Outlook, which has no
  presence to hold.
