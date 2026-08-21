//! The PWA ships unhashed filenames, so nothing stops a browser from serving an
//! old `app.js` out of its heuristic cache after a deploy — which is how a phone
//! kept enrolling with pre-acknowledgement code. These pin the two defences:
//! every response tells the browser to revalidate, and the shell points at a
//! content-versioned `app.js` that a stale cache cannot satisfy.

use std::net::TcpListener;
use std::process::{Child, Command};
use std::time::Duration;

use reqwest::Client;

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Relay(Child);
impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

const VAPID: &str = r#"{"subject":"mailto:test@example.com","publicKey":"BGPPypnk4Gd5alKxX0deys8V6Rzdsx0u27MAjRT9TJ1EG9ny_uxzK2oaOEvZu1Qu2KBW1pT7_cGKxM6VovSROuU","privateKey":"iGx-jxXvcfUF0nV_btcqGpqeH7-XxIZkwTSHAuht4e0"}"#;

async fn boot() -> (Relay, Client, String) {
    let port = free_port();
    let vapid = std::env::temp_dir().join(format!("pager-pwa-test-vapid-{port}.json"));
    std::fs::write(&vapid, VAPID).unwrap();
    let pwa = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("pwa");

    let relay = Relay(
        Command::new(env!("CARGO_BIN_EXE_pager-relay"))
            .env("PAGER_RELAY_ADDR", format!("127.0.0.1:{port}"))
            .env("PAGER_VAPID_FILE", &vapid)
            .env("PAGER_PWA_DIR", pwa)
            .spawn()
            .expect("spawn relay"),
    );
    let http = Client::new();
    let base = format!("http://127.0.0.1:{port}");
    for _ in 0..50 {
        if http.get(format!("{base}/api/config")).send().await.map(|r| r.status().is_success()).unwrap_or(false) {
            return (relay, http, base);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("relay did not become ready");
}

#[tokio::test]
async fn shell_points_at_a_versioned_app_js_matching_the_reported_build() {
    let (_relay, http, base) = boot().await;

    let build = http
        .get(format!("{base}/api/config"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap()["build"]
        .as_str()
        .expect("relay reports a build id")
        .to_string();
    assert!(!build.is_empty());

    let shell = http.get(&base).send().await.unwrap().text().await.unwrap();
    assert!(
        shell.contains(&format!("/app.js?v={build}")),
        "shell must request the build the relay is serving, got:\n{}",
        shell.lines().filter(|l| l.contains("app.js")).collect::<Vec<_>>().join("\n")
    );
    assert!(!shell.contains("\"/app.js\""), "unversioned app.js must not survive");
}

#[tokio::test]
async fn spa_routes_and_index_serve_the_same_stamped_shell() {
    let (_relay, http, base) = boot().await;

    let root = http.get(&base).send().await.unwrap().text().await.unwrap();
    for path in ["/index.html", "/pair"] {
        let body = http.get(format!("{base}{path}")).send().await.unwrap().text().await.unwrap();
        assert_eq!(body, root, "{path} must serve the stamped shell, not the file on disk");
    }
}

#[tokio::test]
async fn every_pwa_response_asks_the_browser_to_revalidate() {
    let (_relay, http, base) = boot().await;

    for path in ["/", "/app.js", "/sw.js", "/index.html"] {
        let r = http.get(format!("{base}{path}")).send().await.unwrap();
        assert!(r.status().is_success(), "{path} → {}", r.status());
        assert_eq!(
            r.headers().get("cache-control").and_then(|v| v.to_str().ok()),
            Some("no-cache"),
            "{path} must not be cacheable without revalidation"
        );
    }
}
