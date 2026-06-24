# Pager capture spike

Goal: confirm that Teams and Outlook web fire their notifications through the
**page-context** Notification API (`new Notification()` or page-side
`registration.showNotification()`), so a userscript/extension can tap them. If
nothing shows up here while real pings arrive on screen, the apps are firing
from inside their own service worker's `push` handler and we need a different
capture layer.

## Run

1. Start the sink:

   ```
   cd ~/src/pager/spike
   bun run sink.ts
   ```

2. Install `capture.user.js` in Tampermonkey (drag the file into the dashboard,
   or create a new script and paste it). Make sure Tampermonkey is enabled.

3. Open / reload `teams.microsoft.com` and `outlook.office.com`. You should see
   a `diag: pager tap installed` line in the sink immediately, confirming the
   tap loaded and reporting notification permission state.

4. Trigger a notification (have someone message you in Teams, or send yourself
   mail in OWA with the tab in the background). Watch the sink for the captured
   `title` / `body`.

`GET http://127.0.0.1:4500/` dumps the last 200 captures as JSON. Captures are
in memory only; restarting the sink clears them.

## What this proves / doesn't

- A `diag` line but **no** captures when pings clearly arrive → the apps emit
  from the service worker, not the page. Pivot capture strategy.
- Captures flowing → the userscript/extension tap is viable; the real bridge
  (Rust + svastha-core) then receives these, applies rules, seals the payload,
  and forwards to the relay.

The browser console also logs each capture as `[pager] …` for quick eyeballing
without the sink.
