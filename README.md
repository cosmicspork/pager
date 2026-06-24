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
  (Teams Notif. API,  (svastha-core),         VAPID Web Push fan-out      service worker,
   OWA SignalR)       QR device pairing       (zero-knowledge)            showNotification
```

The relay only ever sees ciphertext: the bridge seals each event to the paired
devices' keys before it leaves the Mac, and the PWA's service worker decrypts.
Devices enroll by scanning a QR code (the key material travels in the QR, never
through the relay).

## Components

- `extension/` — Chrome MV3 capture extension. **Working.** See its README.
- `relay/` — Rust (Axum) relay. Holds subscriptions, fans out Web Push.
- `pwa/` — the device app (static; served by the relay).
- `bridge/` — Rust local bridge (sealing, rules, pairing). _Not built yet._
- `spike/` — throwaway Tampermonkey discovery scripts that found the capture
  points. Superseded by `extension/`.

## Build phases

1. **Prove iOS Web Push** with this plaintext relay + PWA. ← current
2. Layer in zero-knowledge sealing (`svastha-core` / `@svastha/core`).
3. QR device pairing.
4. Rust bridge: wire the extension's events through sealing into the relay.

## Run the push proof (phase 1)

Needs `cargo` (`brew install rustup && rustup-init`). VAPID keys are in the
gitignored `vapid.json` (regenerate: `bunx --bun web-push generate-vapid-keys --json`).

```bash
cd ~/src/pager
cargo run -p pager-relay        # serves http://127.0.0.1:4500, reads vapid.json + pwa/
```

Open <http://localhost:4500> in desktop Chrome → **Enable notifications** →
**Send test push**. A desktop notification should appear. `localhost` is a
secure context, so this validates the relay + PWA + Web Push path without a
deploy.

For the **iOS** test the PWA must be on an HTTPS origin your phone can reach —
that's the next milestone (deploy the relay to the homelab at `pager.0x69.xyz`,
install the PWA to the home screen, then push).

Config via env: `PAGER_RELAY_ADDR` (default `127.0.0.1:4500`), `PAGER_VAPID_FILE`
(`vapid.json`), `PAGER_PWA_DIR` (`pwa`).
