//! Spawns the real relay binary and drives the full bridge↔relay↔device flow
//! over HTTP: auth rejection, the pairing crypto handshake, subscribe, notify
//! routing, and the device's own signed delivery acknowledgement. Proves the
//! request-signing path (which the relay verifies byte-for-byte over
//! method+path+body) actually agrees end to end, for both signing identities.

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use pager_proto::auth::{self, HEADER_PUBKEY, HEADER_SIGNATURE, HEADER_TIMESTAMP};
use pager_proto::{Delivery, Enrollment, Subscription, SubscriptionKeys, NOTIFY_AAD};
use reqwest::Client;
use svastha_core::keys::Identity;

fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

struct Relay(Child);
impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A bridge-signed request: attaches the three auth headers over the exact body.
fn signed(http: &Client, id: &Identity, method: reqwest::Method, url: &str, path: &str, body: Vec<u8>) -> reqwest::RequestBuilder {
    let h = auth::sign(id, method.as_str(), path, &body, now());
    http.request(method, url)
        .header(HEADER_PUBKEY, h.pubkey)
        .header(HEADER_SIGNATURE, h.signature)
        .header(HEADER_TIMESTAMP, h.timestamp.to_string())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
}

#[tokio::test]
async fn full_bridge_relay_device_flow() {
    // Ensure the relay binary exists (cargo test only builds this crate by default).
    let built = Command::new(env!("CARGO")).args(["build", "-p", "pager-relay"]).status().unwrap();
    assert!(built.success(), "building pager-relay failed");

    let bin = workspace().join("target/debug/pager-relay");
    let port = free_port();
    let base = format!("http://127.0.0.1:{port}");

    // A throwaway VAPID keypair so the relay boots without the gitignored
    // production vapid.json (absent in CI). It's a real P-256 key, so the notify
    // step below genuinely exercises signing before the fake push endpoint fails
    // delivery. Written to a unique temp path (port is unique per run).
    let vapid_path = std::env::temp_dir().join(format!("pager-test-vapid-{port}.json"));
    std::fs::write(
        &vapid_path,
        r#"{"subject":"mailto:test@example.com","publicKey":"BGPPypnk4Gd5alKxX0deys8V6Rzdsx0u27MAjRT9TJ1EG9ny_uxzK2oaOEvZu1Qu2KBW1pT7_cGKxM6VovSROuU","privateKey":"iGx-jxXvcfUF0nV_btcqGpqeH7-XxIZkwTSHAuht4e0"}"#,
    )
    .unwrap();

    // Bridge identity: the relay is configured to trust exactly its ed25519 key.
    let (_m, bridge) = Identity::generate().unwrap();
    let bridge_pubkey = hex::encode(bridge.verifying_key().to_bytes());
    let bridge_x25519 = hex::encode(bridge.x25519_public().as_bytes());

    let child = Command::new(&bin)
        .env("PAGER_RELAY_ADDR", format!("127.0.0.1:{port}"))
        .env("PAGER_VAPID_FILE", &vapid_path)
        .env("PAGER_PWA_DIR", workspace().join("pwa"))
        .env("PAGER_BRIDGE_PUBKEY", &bridge_pubkey)
        .env("PAGER_PAIR_TTL_SECS", "60")
        .spawn()
        .expect("spawn relay");
    let _relay = Relay(child);

    let http = Client::new();

    // Wait for readiness.
    let mut ready = false;
    for _ in 0..50 {
        if http.get(format!("{base}/api/config")).send().await.map(|r| r.status().is_success()).unwrap_or(false) {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(ready, "relay did not become ready");

    // 1) Authed endpoint rejects an unsigned request.
    let r = http.post(format!("{base}/api/notify")).body("{}").send().await.unwrap();
    assert_eq!(r.status(), reqwest::StatusCode::UNAUTHORIZED);

    // 2) Device side of pairing: seal an enrollment to the bridge, post under a token.
    let (_dm, device) = Identity::generate().unwrap();
    let device_id = hex::encode(device.x25519_public().as_bytes());
    let token = "0011223344556677";
    let device_ed25519 = hex::encode(device.verifying_key().to_bytes());
    let enrollment = Enrollment {
        device_x25519: device_id.clone(),
        device_ed25519: device_ed25519.clone(),
        label: "iPhone".into(),
        subscription: Subscription {
            endpoint: "https://example.com/push/fake".into(),
            keys: SubscriptionKeys { p256dh: "p".into(), auth: "a".into() },
        },
    };
    let blob = pager_proto::seal_to(&bridge_x25519, &serde_json::to_vec(&enrollment).unwrap(), token.as_bytes()).unwrap();
    let up = http
        .post(format!("{base}/api/pair/{token}"))
        .body(serde_json::to_vec(&blob).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(up.status(), reqwest::StatusCode::CREATED);

    // 3) Bridge fetches and opens the enrollment blob (auth + crypto over the wire).
    let path = format!("/api/pair/{token}");
    let fetched = signed(&http, &bridge, reqwest::Method::GET, &format!("{base}{path}"), &path, Vec::new())
        .send().await.unwrap();
    assert_eq!(fetched.status(), reqwest::StatusCode::OK);
    let got_blob: pager_proto::SealedBlob = serde_json::from_slice(&fetched.bytes().await.unwrap()).unwrap();
    let opened: Enrollment =
        serde_json::from_slice(&pager_proto::open_blob(&bridge, &got_blob, token.as_bytes()).unwrap()).unwrap();
    assert_eq!(opened.device_x25519, device_id);

    // 4) Second fetch is gone (consumed).
    let again = signed(&http, &bridge, reqwest::Method::GET, &format!("{base}{path}"), &path, Vec::new())
        .send().await.unwrap();
    assert_eq!(again.status(), reqwest::StatusCode::NOT_FOUND);

    // 5) Bridge registers the device subscription (authed).
    let sub_body = serde_json::to_vec(&serde_json::json!({
        "id": device_id,
        "subscription": opened.subscription,
        "ed25519": opened.device_ed25519,
    }))
    .unwrap();
    let sub = signed(&http, &bridge, reqwest::Method::POST, &format!("{base}/api/subscribe"), "/api/subscribe", sub_body)
        .send().await.unwrap();
    assert_eq!(sub.status(), reqwest::StatusCode::CREATED);

    // 6) Bridge sends a sealed notify. The fake push endpoint fails to deliver, but
    //    a 200 with failed=1 proves auth + id→subscription routing worked.
    let notif = serde_json::json!({ "title": "t", "body": "b", "source": "test", "ts": 1u64 });
    let sealed = pager_proto::seal_to(&device_id, &serde_json::to_vec(&notif).unwrap(), NOTIFY_AAD).unwrap();
    let delivery = Delivery { id: device_id.clone(), payload: B64.encode(serde_json::to_vec(&sealed).unwrap()) };
    let notify_body = serde_json::to_vec(&serde_json::json!({ "deliveries": [delivery] })).unwrap();
    let resp = signed(&http, &bridge, reqwest::Method::POST, &format!("{base}/api/notify"), "/api/notify", notify_body)
        .send().await.unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: pager_proto::NotifyResp = resp.json().await.unwrap();
    assert_eq!(body.sent, 0, "fake endpoint cannot really deliver");
    assert_eq!(body.failed, 1, "but the relay routed to the registered subscription");
    assert!(body.delivered.is_empty(), "nothing was accepted by the push service");

    // 7) The device acknowledges a delivery, signing with its *own* key.
    let ack_path = format!("/api/ack/{device_id}");
    let ack_body = serde_json::to_vec(&pager_proto::AckReq { shown: true }).unwrap();
    let ack = signed(&http, &device, reqwest::Method::POST, &format!("{base}{ack_path}"), &ack_path, ack_body)
        .send().await.unwrap();
    assert_eq!(ack.status(), reqwest::StatusCode::NO_CONTENT);

    // 8) The bridge key cannot ack for a device — acks are verified against the
    //    key registered at enrollment, not the relay's trusted bridge key.
    let ack_body = serde_json::to_vec(&pager_proto::AckReq { shown: true }).unwrap();
    let forged = signed(&http, &bridge, reqwest::Method::POST, &format!("{base}{ack_path}"), &ack_path, ack_body)
        .send().await.unwrap();
    assert_eq!(forged.status(), reqwest::StatusCode::UNAUTHORIZED);

    // 9) The bridge reads back delivery state, including the ack just recorded.
    let st = signed(&http, &bridge, reqwest::Method::GET, &format!("{base}/api/devices"), "/api/devices", Vec::new())
        .send().await.unwrap();
    assert_eq!(st.status(), reqwest::StatusCode::OK);
    let statuses: Vec<pager_proto::DeviceStatus> = st.json().await.unwrap();
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].id, device_id);
    assert!(statuses[0].can_ack, "the device registered a signing key at enrollment");
    assert!(statuses[0].last_ack.is_some(), "the ack was recorded");
    assert!(statuses[0].last_shown.is_some(), "and it reported the alert displayed");
    assert!(statuses[0].last_push.is_none(), "the fake endpoint never accepted a push");

    // 10) Delivery state is bridge-only.
    let unauthed = http.get(format!("{base}/api/devices")).send().await.unwrap();
    assert_eq!(unauthed.status(), reqwest::StatusCode::UNAUTHORIZED);
}
