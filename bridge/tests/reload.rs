//! Pairing writes `devices.json`, but a running capture server holds the device
//! list in memory. These drive the real binary over its loopback API to prove a
//! device added after startup actually becomes reachable without a restart.

use std::net::TcpListener;
use std::process::{Child, Command};
use std::time::Duration;

use reqwest::Client;

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

struct Bridge(Child);
impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A device id the bridge can actually seal to: any valid X25519 public key.
const DEVICE_ID: &str = "6b3587d2bd897e03cb2829fb2f9a228cd0f3f6af86a330efdc39febaa30c5627";

fn write_devices(dir: &std::path::Path, ids: &[&str]) {
    let devices: Vec<_> = ids
        .iter()
        .map(|id| serde_json::json!({ "id": id, "label": "test", "paired_at": 1 }))
        .collect();
    std::fs::write(
        dir.join("devices.json"),
        serde_json::to_vec(&serde_json::json!({ "devices": devices })).unwrap(),
    )
    .unwrap();
}

async fn wait_ready(http: &Client, port: u16, dir: &std::path::Path) {
    for _ in 0..100 {
        if http
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let err = std::fs::read_to_string(dir.join("stderr.log")).unwrap_or_default();
    panic!("bridge never came up on {port}:\n{err}");
}

#[tokio::test]
async fn reload_makes_a_device_paired_after_startup_reachable() {
    let port = free_port();
    let dir = std::env::temp_dir().join(format!("pager-reload-test-{port}"));
    std::fs::create_dir_all(&dir).unwrap();
    write_devices(&dir, &[]);

    let _bridge = Bridge(
        Command::new(env!("CARGO_BIN_EXE_pager-bridge"))
            .arg("run")
            .env("PAGER_CONFIG_DIR", &dir)
            .env("PAGER_CAPTURE_ADDR", format!("127.0.0.1:{port}"))
            .env("PAGER_RELAY_URL", "http://127.0.0.1:1") // never answers; captures fail loudly
            .stderr(std::process::Stdio::from(
                std::fs::File::create(dir.join("stderr.log")).unwrap(),
            ))
            .spawn()
            .unwrap(),
    );
    let http = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    wait_ready(&http, port, &dir).await;

    let capture = |title: &'static str| {
        let http = http.clone();
        async move {
            http.post(format!("http://127.0.0.1:{port}/capture"))
                .json(&serde_json::json!({ "source": "teams", "title": title }))
                .send()
                .await
                .unwrap()
                .status()
        }
    };

    // Startup list is empty, so a capture has nowhere to go.
    assert_eq!(capture("before").await, reqwest::StatusCode::ACCEPTED);

    // Pairing writes the file behind the running process's back.
    write_devices(&dir, &[DEVICE_ID]);
    assert_eq!(
        capture("still stale").await,
        reqwest::StatusCode::ACCEPTED,
        "the running bridge must not see a file write on its own"
    );

    let resp = http
        .post(format!("http://127.0.0.1:{port}/reload"))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    assert_eq!(
        resp.json::<serde_json::Value>().await.unwrap()["devices"],
        1
    );

    // Now the capture is sealed and offered to the relay — which is unreachable
    // here, so a 502 is proof it got past "no devices paired".
    assert_eq!(capture("after").await, reqwest::StatusCode::BAD_GATEWAY);

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn reload_also_drops_a_device_removed_by_unpair() {
    let port = free_port();
    let dir = std::env::temp_dir().join(format!("pager-reload-test-{port}"));
    std::fs::create_dir_all(&dir).unwrap();
    write_devices(&dir, &[DEVICE_ID]);

    let _bridge = Bridge(
        Command::new(env!("CARGO_BIN_EXE_pager-bridge"))
            .arg("run")
            .env("PAGER_CONFIG_DIR", &dir)
            .env("PAGER_CAPTURE_ADDR", format!("127.0.0.1:{port}"))
            .env("PAGER_RELAY_URL", "http://127.0.0.1:1")
            .stderr(std::process::Stdio::from(
                std::fs::File::create(dir.join("stderr.log")).unwrap(),
            ))
            .spawn()
            .unwrap(),
    );
    let http = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    wait_ready(&http, port, &dir).await;

    write_devices(&dir, &[]);
    let resp = http
        .post(format!("http://127.0.0.1:{port}/reload"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.json::<serde_json::Value>().await.unwrap()["devices"],
        0
    );

    let status = http
        .post(format!("http://127.0.0.1:{port}/capture"))
        .json(&serde_json::json!({ "source": "teams", "title": "orphan" }))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(
        status,
        reqwest::StatusCode::ACCEPTED,
        "unpaired device must stop receiving"
    );

    std::fs::remove_dir_all(&dir).ok();
}
