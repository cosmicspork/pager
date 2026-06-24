//! End-to-end wire-framing test: exercises the exact byte path a notification
//! takes from the bridge, through the relay's opaque forward, to the device —
//! seal → SealedBlob JSON → base64 (the `Delivery.payload`) → decode → open.
//! If any of the relay/bridge/wasm encode or decode steps drift, this breaks.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use pager_proto::{open_blob, seal_to, Notif, SealedBlob, NOTIFY_AAD};
use svastha_core::keys::Identity;

#[test]
fn full_notify_path() {
    // Device generates its identity at pairing; bridge knows only the X25519 pub.
    let (_m, device) = Identity::generate().unwrap();
    let device_id = hex::encode(device.x25519_public().as_bytes());

    // Bridge side: build a notification and seal it to the device.
    let notif = Notif {
        title: "Team — Alice".into(),
        body: "ping while you were afk".into(),
        source: "teams".into(),
        ts: 1_700_000_000_000,
    };
    let plaintext = serde_json::to_vec(&notif).unwrap();
    let blob = seal_to(&device_id, &plaintext, NOTIFY_AAD).unwrap();

    // Transport: the bridge base64s the SealedBlob JSON into Delivery.payload;
    // the relay forwards those decoded bytes verbatim as the push payload.
    let payload_b64 = B64.encode(serde_json::to_vec(&blob).unwrap());
    let push_bytes = B64.decode(&payload_b64).unwrap();

    // Device service worker: parse the SealedBlob JSON and open it.
    let received: SealedBlob = serde_json::from_slice(&push_bytes).unwrap();
    let opened = open_blob(&device, &received, NOTIFY_AAD).unwrap();
    let out: Notif = serde_json::from_slice(&opened).unwrap();

    assert_eq!(out.title, "Team — Alice");
    assert_eq!(out.body, "ping while you were afk");
    assert_eq!(out.source, "teams");
    assert_eq!(out.ts, 1_700_000_000_000);
}

#[test]
fn pairing_enrollment_path() {
    // Bridge identity; device learns only the bridge X25519 pub via the QR.
    let (_m, bridge) = Identity::generate().unwrap();
    let bridge_x = hex::encode(bridge.x25519_public().as_bytes());
    let token = "deadbeefcafe";

    // Device seals its enrollment to the bridge, bound to the pairing token.
    let enrollment = serde_json::json!({
        "device_x25519": "00".repeat(32),
        "label": "iPhone",
        "subscription": { "endpoint": "https://push/x", "keys": { "p256dh": "p", "auth": "a" } }
    });
    let blob = seal_to(&bridge_x, &serde_json::to_vec(&enrollment).unwrap(), token.as_bytes()).unwrap();

    // Relay stores the SealedBlob JSON opaquely; bridge fetches and opens it.
    let stored = serde_json::to_vec(&blob).unwrap();
    let fetched: SealedBlob = serde_json::from_slice(&stored).unwrap();
    let opened = open_blob(&bridge, &fetched, token.as_bytes()).unwrap();
    let got: serde_json::Value = serde_json::from_slice(&opened).unwrap();
    assert_eq!(got["label"], "iPhone");

    // A wrong token (aad) must fail — binds the enrollment to this pairing.
    assert!(open_blob(&bridge, &fetched, b"wrong-token").is_err());
}
