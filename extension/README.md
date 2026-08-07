# Pager capture extension

Chrome MV3 extension that captures message events from Teams and Outlook web and
forwards them to the local Pager bridge, and (optionally) keeps the Teams web app
from reporting you idle. Replaces the Tampermonkey spikes in `../spike/`.

## What it captures

- **Teams** — chat notifications, via the page-context `Notification` API
  (`source: "teams"`, with `title` and `body`).
- **Outlook** — new-mail events, by reading the `/owa/notificationchannel`
  SignalR-over-SSE stream and parsing `syncMessage` frames (`source: "outlook"`,
  with `sender`, `subject`, `unread`, `conversationId`, …).

## Keep Teams active

Off by default. Teams decides you are away from three independent signals, so
holding presence takes two scripts:

- `keep-active.js` — dispatches a synthetic `mousemove` and a Shift
  `keydown`/`keyup` on an interval (default 240s, under the ~5 minute idle
  threshold). Shift is chosen because it cannot alter a focused composer.
  `isTrusted` is set per-event rather than by patching `Event.prototype`, so
  every other event the app sees still reads truthfully.
- `keep-active-mask.js` — reports the tab visible, the window focused, and the
  OS not idle (`document.hidden`, `visibilityState`, `hasFocus()`,
  `visibilitychange`/`freeze` listeners, `IdleDetector`). Only needed if you
  background the tab, but that is the usual case. This is the most invasive
  thing the extension does — it changes what the page observes rather than only
  reading — so it is a separate toggle, restores everything on toggle-off, and
  is only ever registered for Teams hosts.

Because Chrome throttles page timers in background tabs — exactly where this
matters — a `chrome.alarms` heartbeat in the service worker also pokes open Teams
tabs once a minute. The page timer and the poke share one throttle, so whichever
arrives first pulses and the other is a no-op.

The tab has to stay open; this holds presence, it does not create it.

## Settings

Toolbar popup for the three toggles worth flipping mid-session (Teams capture,
Outlook capture, keep-active) plus a bridge/last-event status readout. Full
settings on the options page (right-click the icon → Options, or **Settings** in
the popup):

| Setting | Default | |
|---|---|---|
| Teams capture | on | inject the Teams capture script |
| Outlook capture | on | inject the Outlook capture script |
| Keep Teams active | off | synthetic input pulses |
| Pulse interval | 240s | clamped to 30–900s |
| Mask visibility & focus | on | the `keep-active-mask.js` half, when keep-active is on |
| Capture endpoint | `http://localhost:4500/capture` | must be http on loopback |
| Forward the install ping | on | the one `__diag` event per tab load |

Settings live in `chrome.storage.sync`. The bridge URL is restricted to
`localhost`/`127.0.0.1`/`[::1]` — the bridge holds the only long-term identity
key and is not meant to be reachable off the machine, so a bad paste can't start
shipping captured message text to another host.

## How it's wired

Content scripts are registered at runtime by `background.js` from the settings
above, rather than declared in the manifest. That is what makes the toggles mean
what they say: a disabled feature is never injected, instead of a script that
loads and then checks a flag. Chrome persists these registrations across
restarts and applies them at `document_start`, same as a manifest-declared
script. Already-open tabs keep whatever was injected at load; a settings change
is also broadcast to them so keep-active picks it up live, but a capture toggle
needs a reload to take effect there.

Three worlds, because the page's CSP blocks both inline injection and a direct
localhost fetch:

- `main-capture.js`, `keep-active.js`, `keep-active-mask.js` — the page's **MAIN**
  world, so they patch the objects the app actually calls and dispatch onto the
  document it actually listens to. `main-capture.js` patches `Notification` on
  all hosts and `fetch` on Outlook hosts only (the stream reader only matches
  `/owa/notificationchannel`, and leaving the wrapper off Teams keeps it out of
  Teams' own failed-fetch stack traces).
- `relay.js` — **isolated** world; the only piece that can reach `chrome.*`.
  Carries captured events out to the service worker and control messages
  (keep-alive pokes, config changes) back into the page.
- `background.js` — service worker; owns registrations, the keep-alive alarm, and
  POSTing each event to the bridge. Extension fetch is exempt from the page CSP.

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
