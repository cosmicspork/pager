# Pager capture extension

Chrome MV3 extension that captures message events from Teams and Outlook web and
forwards them to the local Pager bridge. Replaces the Tampermonkey spikes in
`../spike/`.

## What it captures

- **Teams** — chat notifications, via the page-context `Notification` API
  (`source: "teams"`, with `title` and `body`).
- **Outlook** — new-mail events, by reading the `/owa/notificationchannel`
  SignalR-over-SSE stream and parsing `syncMessage` frames (`source: "outlook"`,
  with `sender`, `subject`, `unread`, `conversationId`, …).

## How it's wired

Three pieces, because the page's CSP blocks both inline injection and a direct
localhost fetch:

- `main-capture.js` — runs in the page's **MAIN** world (manifest `world`),
  patches `Notification` and `fetch`, posts events via `window.postMessage`.
- `relay.js` — **isolated** world; forwards those messages to the service worker.
- `background.js` — service worker; POSTs each event to the bridge. Extension
  fetch is exempt from the page CSP.

## Load it

1. Disable the Tampermonkey `Pager …` scripts (this replaces them).
2. Start the dev sink (until the Rust bridge exists): `cd ../spike && bun run sink.ts`.
3. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   this `extension/` folder.
4. Reload Teams and Outlook. Look for a `pager extension capture installed`
   line per tab in the sink.

The bridge URL is `http://localhost:4500/capture` (see `background.js`); it will
move to an options page when the real bridge lands.

## Not yet

- Filtering (inbox-only, new vs. read) for Outlook `syncMessage` needs tuning
  against live traffic — it currently emits every conversation sync.
- Teams real-time over the Trouter WebSocket (richer than the Notification API)
  and the Phase-2 pull API surface (`service.svc` / Teams REST replay).
