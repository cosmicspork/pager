# Pager — build handoff

Context dump for an agent continuing this build on the host that has the Rust
toolchain, the `svastha` clone, and the SOPS age key for the homelab. This Mac
where the spike work happened lacks Tailscale and the homelab SOPS key, so the
remaining infra steps move to that host. No prior conversation context is
assumed here.

## What pager is

A browser-resident capture surface over Teams and Outlook **web**, forwarding
message events to your own devices. Built because Microsoft Graph is closed off
by tenant admins (no Azure AD app registration / consent), so the only path is
intercepting the running web apps in the browser you're already signed into.

Two consumers, in priority order:
1. **Notifications to phone** (iOS becoming primary). Can't run the Teams/Outlook
   apps on personal devices due to policy; this delivers the pings instead.
2. **An agent surface** over Teams/mail (read now, act later) — the longer-term
   prize. Phase 2-style "pull" queries (list inbox, read a thread) are a separate
   future workstream (see "Phase 2 agent surface" below), not part of the
   real-time capture built so far.

## Architecture (locked)

```
Chrome extension → local bridge (Rust) → homelab relay (Rust) → PWA (iOS/Android)
  capture events    seal+sign+rules        ciphertext only,        unseal in SW,
  (done)            (svastha-core)          VAPID Web Push          showNotification
                    QR device pairing       (zero-knowledge)
```

Zero-knowledge: the bridge seals each event to the paired devices' keys before it
leaves the Mac; the relay only ever sees ciphertext; the PWA's service worker
decrypts. Devices enroll by scanning a QR (key material travels in the QR, never
through the relay).

### Decisions made
- **Delivery = custom PWA + relay** (zero-knowledge), not ntfy. ntfy was
  considered (and ntfy + Tailscale would win if Android were the only target),
  but iOS-primary + the desire for E2E and one coherent system chose the PWA.
- **Language = Rust for both bridge and relay** (user chose this explicitly;
  rustup now installed on the Mac, see "Environment"). Both share `svastha-core`.
- **Crypto via `svastha-core`** (published: crates.io `svastha-core` /
  npm `@svastha/core`). Reuse `envelope` + `keys` + `relay`. Notification payload
  type + Web Push fan-out live in pager, NOT in svastha-core.

### Open decisions (confirm before/when relevant)
- **Do NOT extend svastha-core with push fan-out** (recommendation, not yet
  ratified). Push fan-out is transport, not trust contract. Only optional
  svastha change worth considering later: split generic `envelope`/`keys`/`relay`
  out of `svastha-core` (which also holds the medical `event` module) into a
  `svastha-contract` crate, so external consumers don't drag in `event`. Do this
  only if the dependency feels wrong in practice.
- **Production capture runtime**: extension in daily Chrome (chosen for now) vs a
  bridge-controlled persistent browser. Extension wins (you're always signed in,
  dodges Conditional Access).

## Status

### Done and validated
- **Capture extension** (`extension/`, Chrome MV3): MAIN-world content script
  patches `Notification` (all hosts) + `fetch` (Outlook hosts only, where the
  `/owa/notificationchannel` reader lives); isolated relay script + service worker
  forward to a local endpoint. Validated live through the full stack.
- **Relay + PWA plaintext push** (`relay/`, `pwa/`): builds clean (Rust 1.96,
  `web-push` 0.11), runs on `:4500`, all endpoints smoke-tested, and a desktop
  Chrome push round-trip succeeded (`{"sent":1,"failed":0}` + banner shown).
  **This is the phase-1 push proof, plaintext — no app-level crypto yet** (the
  transport encryption to the push service is handled by `web-push`).

### Not done
- iOS push proof (needs HTTPS origin reachable by the phone — blocked on this
  Mac: no Tailscale, no homelab key).
- Zero-knowledge sealing, QR pairing, the Rust bridge, homelab deploy.

## Key technical findings (from the spike)

- **Teams capture**: chat notifications fire through the page-context
  `new Notification(title, {body})` (title is "Team — Sender" for channels;
  body is the message). Interceptable. NOT suppressed when backgrounded. Teams
  suppresses notifications for *your own* messages, so self-tests are no-ops;
  test with a real other sender.
- **Outlook capture**: page `Notification` does NOT fire (OWA uses its
  `sw_webpush.js` service worker). New mail flows over
  `outlook.cloud.microsoft/owa/notificationchannel` as **SignalR over SSE**: one
  long-lived streaming GET; body is `\x1e`-separated, `data:`-prefixed SignalR
  frames `{"type":1,"target":"syncMessage","arguments":[[{...,"Conversation":{...}}]]}`.
  The `Conversation` object carries everything inline: `ConversationTopic`
  (subject), `UniqueSenders` (sender), `GlobalUnreadCount`, `Importance`,
  `HasAttachments`, `ConversationId`, `ItemIds`. No `service.svc` fetch needed.
  `syncMessage` also fires for non-new-mail syncs (read flaps, folder syncs) — the
  extension drops empties (no sender+subject) and de-dupes by conversation +
  delivery time; this filter still needs tuning against real traffic.
- **CSP**: Teams' CSP blocks inline `<script>` injection (this broke the Teams
  app shell during the spike). The MV3 `world: "MAIN"` content script avoids
  injection entirely. The page CSP also blocks a localhost fetch from the page,
  so the service worker does the forward (extension fetch is exempt).
- **web-push 0.11 API** (works): `SubscriptionInfo::new`,
  `VapidSignatureBuilder::from_base64(&private_key_b64url, &info)` +
  `.add_claim("sub", subject)`, `WebPushMessageBuilder` with
  `ContentEncoding::Aes128Gcm`, `IsahcWebPushClient`.
- **iOS Web Push constraints**: PWA must be **added to Home Screen** (16.4+);
  the SW **must call showNotification on every push** or iOS revokes the
  subscription (the SW has a generic fallback for this); malformed payloads can
  kill the subscription. So all filtering must happen upstream (bridge), before
  the push.

## File inventory (`~/src/pager/`)

- `extension/` — MV3 capture extension (manifest, `main-capture.js`, `relay.js`,
  `background.js`, README). Working. Posts to `http://localhost:4500/capture`.
- `relay/` — Rust (Axum) relay. `Cargo.toml`, `src/main.rs`. Endpoints:
  `GET /api/config`, `POST /api/subscribe`, `POST /api/test`, fallback `ServeDir`
  for the PWA. In-memory subscription store (move to `bun:sqlite`-equivalent /
  SQLite or a Rust store for persistence).
- `pwa/` — static PWA: `index.html`, `app.js`, `sw.js`, `manifest.webmanifest`,
  `icon.svg`. Served by the relay.
- `Cargo.toml` — workspace (`members = ["relay"]`; add `bridge` later).
- `vapid.json` — **gitignored secret**. Contains VAPID keypair + subject.
  Regenerate with `bunx --bun web-push generate-vapid-keys --json` if absent on
  the new host (re-subscribing devices afterward). For homelab, the private key
  becomes a SOPS-encrypted k8s secret.
- `spike/` — throwaway Tampermonkey discovery scripts (superseded by `extension/`).
- `README.md` — project overview + how to run the push proof.

## Remaining build plan

### 1b. iOS push proof (do first)
Needs an HTTPS origin the phone can reach. On the keyed host, fastest is a
**Tailscale Funnel** to the local relay (`tailscale funnel 4500`, enable Funnel +
HTTPS certs in the tailnet admin first) → open the `…ts.net` URL in iOS Safari →
Add to Home Screen → open PWA → Enable notifications → Send test → confirm iOS
banner. (Homelab deploy is the alternative but heavier; can be deferred until
after E2E so the real thing deploys once.)

### 2. Zero-knowledge sealing
Add `svastha-core` (Rust) / `@svastha/core`. Bridge seals each event with the
envelope (per-message data key, ECIES-wrapped to each paired device's X25519
key). PWA SW decrypts via WASM before showNotification; generic fallback on
decrypt failure (satisfies the iOS must-show rule). Relay carries ciphertext as
the Web Push payload — already encrypted again in transit to the push service.

### 3. QR device pairing
Bridge mints a one-time pairing token; QR carries `{relay URL, bridge X25519
pubkey, token}`. PWA generates its keypair, seals its pubkey + push subscription
**to the bridge's pubkey**, posts the opaque blob to the relay under the token.
Bridge fetches + unseals → learns the device key authentically (relay can't MITM
because it can't forge a seal to the bridge). Reuses `svastha-core` envelope.

### 4. Rust bridge (`bridge/` crate)
Receives extension events on loopback (replaces the relay's current `:4500`
receiver role — note the extension currently POSTs to `:4500`). Holds the
Ed25519 identity for relay-auth, the paired device pubkeys, the rules engine
(filter / quiet hours / per-device routing — start trivial), seals events, signs,
POSTs to the relay. Supervise via Switchboard as a LaunchAgent (like the notebook
server). The relay then only does subscriptions + Web Push fan-out.

### Homelab deploy (cosmicspork/homelab, Flux + SOPS + cert-manager)
- Multi-stage Rust **Dockerfile** building `linux/amd64` (DO cluster is amd64;
  build host is arm64 — use `docker buildx --platform linux/amd64`). Either
  `COPY pwa/` into the image + set `PAGER_PWA_DIR`, or `rust-embed` the PWA for a
  self-contained binary (cleaner for prod).
- Push image to `ghcr.io/cosmicspork/pager`.
- App dir following the FreshRSS template: `kubernetes/apps/base/pager/`
  (namespace, deployment, service, kustomization) + `kubernetes/apps/production/
  pager/` (ingress + kustomization). Register `pager` in
  `kubernetes/apps/production/kustomization.yaml`.
- Ingress host `pager.0x69.xyz`, annotation
  `cert-manager.io/cluster-issuer: letsencrypt-prod`, TLS auto-provisioned.
  Confirm DNS for `pager.0x69.xyz` resolves to the ingress (wildcard or add a
  record — DNS is managed outside the repo).
- **VAPID private key** as a SOPS+age secret (`secret.yaml`, encrypted to the
  homelab age recipient in `.sops.yaml`), mounted into the pod; set
  `PAGER_VAPID_FILE` to its path. It's the only secret the relay holds and does
  not weaken zero-knowledge (VAPID only authenticates the relay to the push
  service).

## Security TODO before public exposure
- `POST /api/test` is currently open (anyone could trigger a push to all subs).
  Remove it or gate it behind a shared secret before the relay is publicly
  reachable. `/api/subscribe` is comparatively benign but consider the pairing
  token gate from phase 3.
- `vapid.json` and any `.env`/`*.pem` are gitignored; keep it that way. The repo
  is intended to be public — no tenant IDs, hostnames-as-secrets, or keys in
  committed files.

## Environment notes
- **This Mac**: rustup installed (keg-only; PATH wired in `~/.zshrc` and in the
  dotfiles — base `10-path.zsh` has `~/.cargo/bin`, macOS profile has the keg
  bin, Brewfile has `rustup`). Has bun/node/openssl. **Lacks** Tailscale and the
  homelab SOPS age key. A relay process may still be running on `:4500` here.
- **Finishing host**: has Rust, `svastha` cloned, SOPS age key (and presumably
  Tailscale + homelab access). `pager` is currently only on this Mac — it must
  reach the finishing host (push to `cosmicspork/pager` on GitHub, or sync the
  directory). `vapid.json` is gitignored so won't travel via git — transfer it
  out of band or regenerate.
