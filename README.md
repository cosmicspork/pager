# Pager

A browser-resident communications archive and pager for Teams and Outlook web,
built because Microsoft Graph is closed off by tenant policy. The Chrome
extension captures from signed-in tabs and writes to a private local Rust/SQLite
collector before eligible notifications reach the existing local bridge.
Agents can query the retained archive through read-only stdio MCP; phone delivery
remains end-to-end encrypted through the bridge and hosted relay.

## Architecture

```
Chrome extension → local collector (Rust + SQLite/FTS5) → local bridge (Rust) → relay → PWA
  Teams cache       archive + one-year retention      seal + sign          ciphertext  unseal
  Outlook read API  read-only stdio MCP for agents     QR pairing          Web Push    + display
```

The relay only ever sees ciphertext: the bridge seals each event to the paired
devices' X25519 keys before it leaves the machine, and the PWA's service worker
decrypts (the same `svastha-core` envelope, compiled to WASM). Devices enroll by
sealing their key to the bridge's public key, learned out of band via a QR — the
relay never holds a key that can read a message or forge an enrollment.

## Components

- `proto/` — shared wire contract: sealed-blob framing, relay-auth headers, and
  the device/notify JSON shapes used by the relay, bridge, and WASM.
- `extension/` — Chrome MV3 capture extension. Persists captures to a durable
  IndexedDB outbox and delivers them to the local collector; independent
  local-time paging-silence and Teams-activity schedules live in popup/options.
- `collector/` — local Rust ingestion server, SQLite/FTS5 archive and read-only
  stdio MCP tool server. Archive writes commit before eligible paging; it does
  not store bridge keys or participate in device encryption.
- `bridge/` — Rust local bridge: holds the keys, seals + signs + runs the rules,
  drives QR pairing, forwards ciphertext to the relay. Other bridge clients
  retain their existing direct path.
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
- **Collector** runs locally at `127.0.0.1:4501` (`contrib/pager-collector.service`
  is an optional user-systemd unit). It requires a local ingestion token and
  persists the archive under `~/.local/share/pager/communications` by default.
  It is not deployed to the relay or exposed on the network.
- **Bridge** runs on your machine as a `systemd --user` service
  (`contrib/pager-bridge.service`), listening on `127.0.0.1:4500` for the
  collector and other local senders, and forwarding to `PAGER_RELAY_URL`. It
  holds the paired-device list in memory, so `pair` and `unpair` post to its
  loopback `/reload` to keep it in step; if that post can't be delivered they
  say so, and restarting the service has the same effect.
  More than one bridge may be authorized: `PAGER_BRIDGE_PUBKEY` takes a
  comma-separated list. Each bridge holds its own identity and device pairings
  and seals its own payloads, so authorizing a second sender widens who may
  *send* without widening who can read — the relay still sees only ciphertext.
  That is what lets something always-on (a bridge in the cluster, image
  `ghcr.io/cosmicspork/pager-bridge`, `PAGER_CONFIG_DIR` on a volume) page the
  phone while every laptop is asleep. Pair the phone to each bridge you want to
  hear from; `pager-bridge id` prints the key to add.

  The bridge capture endpoint remains unauthenticated by design; restrict it
  to loopback or a pod network with only intended senders. The collector
  capture endpoint is separately bearer-token protected and loopback-only.
  Neither endpoint should be exposed beyond its intended local boundary.

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
quiet hours). Collector env: `PAGER_COLLECTOR_DIR`
(`~/.local/share/pager/communications`).

## Setup runbook

**1. Install the collector and start it locally.**

```bash
cargo install --path collector --locked
pager-collector init        # creates archive.sqlite3 and ingest-token; does not print the token
pager-collector serve       # loopback 127.0.0.1:4501; leave running or enable the optional user unit
```

The data directory is private (0700); the SQLite database and ingestion token
are 0600. WAL files stay there. SQLite is plaintext, **not encrypted at rest**:
limit access and include it only in private backups. The collector prunes
messages older than a rolling 365 days at startup and hourly. `pager-collector
prune` runs the same maintenance manually. OS snapshots and older backups are
outside logical retention.

**2. Bridge (already installed as a service on the keyed host).**

```bash
pager-bridge id      # prints PAGER_BRIDGE_PUBKEY (already set on the relay)
pager-bridge ping    # confirms the relay is reachable and trusts this bridge
```

**3. Install the capture extension** in your daily Chrome:
`chrome://extensions` → enable Developer mode → **Load unpacked** → select
`extension/`. Stay signed into Teams/Outlook web. In extension options, enter
the token from the private `ingest-token` file into **Collector token**; it is
held in `chrome.storage.local`, not sync storage. The default collector URL is
`http://localhost:4501/capture` and the downstream bridge stays at
`http://localhost:4500/capture`. Reload already-open tabs once to install
capture scripts.

The popup controls capture toggles, paging mode and Teams activity mode.
Choose **Scheduled** only after configuring daily local-time windows in options;
**Always notify / Always silent** and **Always on / Always off** are persistent
manual overrides. Invalid saved schedules fail closed and show an error. A
silent window stops only phone notifications, never collection. See
`extension/README.md`.

**4. Install the PWA on your phone.** In Safari (iOS) open
`https://pager.0x69.xyz`, then Share → **Add to Home Screen**. Open the installed
app once so its service worker registers.

**5. Pair the phone.**

```bash
pager-bridge pair --label iPhone
```

Scan the printed QR with your phone's camera. It opens `…/pair#…` in Safari;
tap **Copy code**, open the installed Pager app, tap **Paste & pair**, and allow
notifications. (On Android you can pair straight from the opened link.) The
bridge prints `✓ paired …` once the device enrolls.

**6. Confirm delivery.**

```bash
pager-bridge test --message "hello from the bridge"
```

A notification should appear on the phone. After that, real Teams/Outlook events
captured by the extension flow through automatically. (Teams suppresses
notifications for your *own* messages — test with a message from someone else.)

## Querying the local archive

Run `pager-collector mcp` as a local **stdio** MCP subprocess with access to
the same archive directory (or set `PAGER_COLLECTOR_DIR`). It exposes four
read-only tools: `search_messages`, `get_thread`, `get_message` and
`get_collection_status`. The MCP process opens the live SQLite WAL read-only;
it cannot create/migrate/prune a missing database. Install it only for agents
you trust with private communications; MCP read-only tools do not restrict a
full filesystem-capable, unsandboxed agent. Do not expose the archive, token or
MCP process through a hosted service.

Search/collection status report source coverage, import progress and stale
heartbeats. Teams includes available cached messages, **not** complete Teams
history. Outlook retrieves retained personal Inbox and Sent Items through
authenticated read actions in the open browser tab, plus thread context
observed there; it does not import other folders/shared mailboxes or attachments.
Bodies may be missing, truncated or deleted at the source. MCP responses bound
search snippets, paginate results/bodies and mark captured text as untrusted
data, not agent instructions. For a restored older SQLite backup with the
same archive ID, use extension options → **Re-import from sources** to re-scan
what is still available; restoration does not recover messages already gone
from Teams cache or Outlook's retention window.

Archive receipt does not mean phone delivery: the collector durably records an
eligible page claim, then attempts the existing bridge once. A failed bridge
attempt remains a local failure; it is not replayed, so the notification side
is at-most-once while the archived message remains searchable. The existing
bridge `PAGER_QUIET` setting still applies to all senders, including collector
pages; extension overrides do not bypass that bridge-wide veto.

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
cargo test -p pager-collector
cargo test --workspace --exclude pager-wasm --exclude pager-collector
node --test extension/test/*.test.mjs pwa/test/*.test.mjs
cargo check -p pager-wasm --target wasm32-unknown-unknown
wasm-pack build wasm --target no-modules \
  --out-dir pwa/wasm --out-name pager_wasm
cargo run -p pager-relay
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
