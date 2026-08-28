# Pager

A browser-resident capture surface over Teams and Outlook web that forwards
message events to your own devices, built because Microsoft Graph is closed off
by tenant policy. Capture happens in the browser you're already signed into;
delivery is end-to-end encrypted through a relay you host, to a PWA on your
phone.

## Architecture

```
Chrome extension  →  local bridge (Rust)  →  homelab relay (Rust)  →  PWA (iOS/Android)
  capture events     seal + sign + rules     ciphertext only,           unseal in the
  (Teams IndexedDB,  (svastha-core),         VAPID Web Push fan-out      service worker,
   OWA SignalR)       QR device pairing       (zero-knowledge)            showNotification
```

The relay only ever sees ciphertext: the bridge seals each event to the paired
devices' X25519 keys before it leaves the machine, and the PWA's service worker
decrypts (the same `svastha-core` envelope, compiled to WASM). Devices enroll by
sealing their key to the bridge's public key, learned out of band via a QR — the
relay never holds a key that can read a message or forge an enrollment.

## Components

- `proto/` — shared wire contract: sealed-blob framing, relay-auth headers, and
  the device/notify JSON shapes used by the relay, bridge, and WASM.
- `extension/` — Chrome MV3 capture extension. Posts events to the bridge and
  can optionally simulate Teams activity. Toggles are in its popup/options page.
  Teams capture reads the app's own IndexedDB store (Teams keeps its messaging
  stack in a Web Worker and never hands the page the text, and the old
  `Notification` hook went silent whenever keep-active was on).
- `bridge/` — Rust local bridge: holds the keys, seals + signs + runs the rules,
  drives QR pairing, forwards ciphertext to the relay.
- `relay/` — Rust (Axum) relay: subscriptions + Web Push fan-out, ciphertext only.
- `wasm/` — device-side WASM (`pager-wasm`): identity, enrollment sealing, decrypt.
- `pwa/` — the device app (static; served by the relay; WASM built into `pwa/wasm`).
- `spike/` — throwaway Tampermonkey discovery scripts. Superseded by `extension/`.

## Endpoints (relay)

Mutating endpoints are authenticated as the one configured bridge (Ed25519 over
`svastha-core`'s canonical request bytes). Two exceptions: the pairing-blob
upload is a genuinely public write, size-capped and TTL-bounded; and a device's
delivery acknowledgement is signed by that *device's* key, verified against the
one it registered at enrollment.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/config` | public | VAPID public key, subject, contract version, PWA build id |
| POST | `/api/pair/:token` | public | device uploads an opaque enrollment blob |
| GET | `/api/pair/:token` | bridge | fetch-and-delete that blob |
| POST | `/api/subscribe` | bridge | register a device id → push subscription |
| POST | `/api/notify` | bridge | fan out sealed payloads |
| POST | `/api/ack/:id` | device | device reports a push reached its worker |
| GET | `/api/devices` | bridge | per-device delivery state |
| DELETE | `/api/device/:id` | bridge | drop a device subscription |

## Deployment

- **Relay** runs in the homelab at `https://pager.0x69.xyz` (manifests in
  `cosmicspork/homelab` under `kubernetes/apps/{base,production}/pager`). Image:
  `ghcr.io/cosmicspork/pager`, built by the `Dockerfile` here (multi-stage:
  builds the WASM and the relay, serves `pwa/`). The VAPID private key is a
  SOPS-encrypted secret; the authorized bridge key is the `PAGER_BRIDGE_PUBKEY`
  env. Subscriptions persist to a PVC (`PAGER_SUBS_FILE`) so a restart keeps
  devices registered. It hashes the PWA bundle at startup and serves the shell
  with that id stamped onto the `app.js` URL, so a deploy invalidates the
  browser's copy; every PWA response is `Cache-Control: no-cache`. The page
  reports the build it is actually running, and says so when it no longer
  matches the relay — an installed PWA that keeps serving old code otherwise
  looks completely healthy.
- **Bridge** runs on your machine as a `systemd --user` service
  (`contrib/pager-bridge.service`), listening on `127.0.0.1:4500` for the
  extension and forwarding to `PAGER_RELAY_URL`. It holds the paired-device
  list in memory, so `pair` and `unpair` post to its loopback `/reload` to keep
  it in step; if that post can't be delivered they say so, and restarting the
  service has the same effect.

  More than one bridge may be authorized: `PAGER_BRIDGE_PUBKEY` takes a
  comma-separated list. Each bridge holds its own identity and device pairings
  and seals its own payloads, so authorizing a second sender widens who may
  *send* without widening who can read — the relay still sees only ciphertext.
  That is what lets something always-on (a bridge in the cluster, image
  `ghcr.io/cosmicspork/pager-bridge`, `PAGER_CONFIG_DIR` on a volume) page the
  phone while every laptop is asleep. Pair the phone to each bridge you want to
  hear from; `pager-bridge id` prints the key to add.

  The capture endpoint is unauthenticated by design — it is reached over
  loopback, or over a pod network with only its intended senders routed to it.
  Never expose it beyond that.

### Releases & deploys

CI (`.github/workflows/ci.yml`) runs clippy + tests on every PR. Releases are
cut by release-please (`release.yml`): merging the release PR tags the version,
then builds and pushes `ghcr.io/cosmicspork/pager:<version>` (and `:latest`).
The homelab repo's Renovate watches that GHCR tag and opens the deploy bump;
merging it lets Flux roll out. So the path is: merge to `main` → merge the
release PR → merge the Renovate bump in `homelab`.

Relay env: `PAGER_RELAY_ADDR` (`127.0.0.1:4500`), `PAGER_VAPID_FILE`
(`vapid.json`), `PAGER_PWA_DIR` (`pwa`), `PAGER_BRIDGE_PUBKEY` (required for
bridge endpoints; one key or several, comma-separated), `PAGER_SUBS_FILE`
(optional persistence), `PAGER_PAIR_TTL_SECS`.

Bridge env: `PAGER_RELAY_URL`, `PAGER_CAPTURE_ADDR` (`127.0.0.1:4500`),
`PAGER_CONFIG_DIR` (`~/.config/pager`), `PAGER_QUIET` (e.g. `22-7`, local-time
quiet hours).

## Setup runbook

**1. Bridge (already installed as a service on the keyed host).**

```bash
pager-bridge id      # prints PAGER_BRIDGE_PUBKEY (already set on the relay)
pager-bridge ping    # confirms the relay is reachable and trusts this bridge
```

**2. Install the capture extension** in your daily Chrome:
`chrome://extensions` → enable Developer mode → **Load unpacked** → select
`extension/`. Stay signed into Teams/Outlook web. The extension posts captured
events to the bridge on `127.0.0.1:4500`.

Its toolbar popup toggles Teams capture, Outlook capture, and *keep Teams
active* (off by default — sends best-effort synthetic activity while the tab is
open), and shows whether the bridge is reachable. The options page has the
pulse interval and the capture endpoint. See `extension/README.md`.

**3. Install the PWA on your phone.** In Safari (iOS) open
`https://pager.0x69.xyz`, then Share → **Add to Home Screen**. Open the installed
app once so its service worker registers.

**4. Pair the phone.**

```bash
pager-bridge pair --label iPhone
```

Scan the printed QR with your phone's camera. It opens `…/pair#…` in Safari;
tap **Copy code**, open the installed Pager app, tap **Paste & pair**, and allow
notifications. (On Android you can pair straight from the opened link.) The
bridge prints `✓ paired …` once the device enrolls.

**5. Confirm delivery.**

```bash
pager-bridge test --message "hello from the bridge"
```

A notification should appear on the phone. After that, real Teams/Outlook events
captured by the extension flow through automatically. (Teams suppresses
notifications for your *own* messages — test with a message from someone else.)

## Delivery health

When the phone is quiet, start here:

```bash
pager-bridge doctor          # walk the whole chain; --test also sends a push
```

It checks each link in order — capture server, relay reachability, contract
version, bridge authentication, quiet hours, paired devices, and each device's
delivery state — and prints a verdict per line, exiting non-zero if anything is
outright broken. The first ✗ or ⚠ is the answer.

```
✓ capture server            listening on 127.0.0.1:4500
✓ relay reachable           https://pager.0x69.xyz
✓ relay trusts this bridge  ed25519 f3797abfe2eefceb
✓ quiet hours               not configured
✓ devices                   1 paired
✗ device                    iPhone (d50779de)  Pages are arriving but alerts are switched off on the device.
```

`sent=1 failed=0` means the *push service* accepted the message. It says nothing
about whether a human saw it: between the relay and a banner sit the device's
service worker and the OS notification permission, either of which can fail
silently for days while every push still reports success.

So devices acknowledge each push they handle, signed with their own key, and the
ack says whether the alert actually reached the screen. `pager-bridge devices`
reads that back:

```
d50779de81ec7430  iPhone  paired 2026-06-24
  push 3m ago · ack 3m ago · shown 3m ago
```

Two failures are then distinguishable, and the bridge warns about both in its log
and as a desktop notification, at most twice a day per device:

- **pushes land, no acks** — the worker isn't running. The app was deleted, its
  storage was evicted, or the subscription is a zombie the push service hasn't
  retired yet. Re-pair.
- **acks arrive, nothing shown** — notification permission is off on the device.

Devices paired before acknowledgements existed report `n/a` and are never
faulted; re-pair one to start tracking it. The PWA shows the same state on the
device itself, in the Function sheet and as a caution strip.

## Sending from something other than the extension

Anything that can reach a bridge's capture endpoint can page the phone, and
needs no key of its own — the bridge does the sealing:

```bash
curl -s -X POST http://127.0.0.1:4500/capture \
  -H 'content-type: application/json' \
  -d '{"source":"tracon","title":"Review — feat: the thing","body":"+12 −3",
       "url":"https://tracon.example/reviews/r1","tag":"tracon-review-r1"}'
```

`title` and `body` are what shows (at least one must be non-empty). `source`
labels the sender. `url`, when present, is where tapping the notification
lands; `tag` is the banner's replacement key, which defaults to `source` — mail
collapses under one banner that way, so a sender that wants each item to stand
on its own should send a distinct tag. Both are optional and a device running
an older service worker ignores them.

Responses: `200` pushed, `204` dropped by rules (quiet hours, empty), `202` no
devices paired, `502` the relay refused.

## Local development

```bash
cargo test                                   # proto + bridge unit + integration
node --test extension/test/*.test.mjs \
     pwa/test/*.test.mjs                     # extension + service-worker tests
wasm-pack build wasm --target no-modules \
  --out-dir pwa/wasm --out-name pager_wasm   # build the device WASM
cargo run -p pager-relay                     # serves http://127.0.0.1:4500 (needs vapid.json)
```

`vapid.json` (VAPID keypair, gitignored) and `pwa/wasm/` (build output) are not
committed. Regenerate VAPID keys with
`bunx --bun web-push generate-vapid-keys --json` (re-pair devices afterward).

## Crypto / trust

`pager` reuses `svastha-core` (AGPL-3.0) for the envelope (XChaCha20-Poly1305 +
X25519 ECIES), key derivation (BIP39 → X25519/Ed25519), and relay-auth signing.
The bridge holds the only long-term identity; each device holds its own. The
relay and the public pairing endpoint never see plaintext or a key that can read
it. `pager` is therefore AGPL-3.0-only as well.
