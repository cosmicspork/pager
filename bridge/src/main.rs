//! Pager bridge — the only component that holds long-term keys.
//!
//! It receives capture events from the browser extension on loopback, applies
//! rules (drop diagnostics/empties, optional quiet hours), seals each surviving
//! event to every paired device's X25519 key, signs the request, and POSTs the
//! ciphertext to the relay for Web Push fan-out. It also drives QR device pairing
//! and registers device subscriptions with the relay on the device's behalf.
//!
//! Subcommands: `run` (default), `pair`, `test`, `devices`, `unpair`, `id`.

mod client;
mod store;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use base64::Engine;
use chrono::{DateTime, Local, Timelike};
use clap::{Parser, Subcommand};
use parking_lot::{Mutex, RwLock};
use pager_proto::{Delivery, Enrollment, Notif, PairPayload, SealedBlob};
use reqwest::Client;
use serde_json::Value;
use svastha_core::keys::Identity;

use store::{Device, Devices};

#[derive(Parser)]
#[command(name = "pager-bridge", about = "Pager local bridge: capture → seal → relay")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the loopback capture server (default).
    Run,
    /// Pair a new device: print a QR/URL and wait for the device to enroll.
    Pair {
        #[arg(long, default_value = "device")]
        label: String,
    },
    /// Send a sealed test notification to all paired devices.
    Test {
        #[arg(long, default_value = "It works 🎉")]
        message: String,
    },
    /// List paired devices.
    Devices,
    /// Remove a paired device by id (X25519 hex).
    Unpair { id: String },
    /// Print this bridge's public keys (for the relay's PAGER_BRIDGE_PUBKEY).
    Id,
    /// Check the relay is reachable and accepts this bridge's authentication.
    Ping,
}

struct Config {
    relay: String,
    capture_addr: String,
    /// Local-time quiet-hours window `[start, end)` in hours; pushes are dropped inside it.
    quiet: Option<(u32, u32)>,
}

impl Config {
    fn from_env() -> Self {
        let quiet = std::env::var("PAGER_QUIET").ok().and_then(|s| parse_quiet(&s));
        Config {
            relay: std::env::var("PAGER_RELAY_URL").unwrap_or_else(|_| "https://pager.0x69.xyz".into()),
            capture_addr: std::env::var("PAGER_CAPTURE_ADDR").unwrap_or_else(|_| "127.0.0.1:4500".into()),
            quiet,
        }
    }
}

fn parse_quiet(s: &str) -> Option<(u32, u32)> {
    let (a, b) = s.split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

#[tokio::main]
async fn main() -> Result<()> {
    init_logging();
    let cli = Cli::parse();
    let cfg = Config::from_env();
    let dir = store::config_dir();
    let identity = Arc::new(store::load_or_create_identity(&dir).context("loading bridge identity")?);
    let http = Client::builder().timeout(Duration::from_secs(30)).build()?;

    match cli.cmd.unwrap_or(Cmd::Run) {
        Cmd::Id => cmd_id(&identity),
        Cmd::Devices => cmd_devices(&dir)?,
        Cmd::Pair { label } => cmd_pair(&http, &identity, &cfg, &dir, &label).await?,
        Cmd::Test { message } => cmd_test(&http, &identity, &cfg, &dir, &message).await?,
        Cmd::Unpair { id } => cmd_unpair(&http, &identity, &cfg, &dir, &id).await?,
        Cmd::Ping => cmd_ping(&http, &identity, &cfg).await?,
        Cmd::Run => cmd_run(http, identity, cfg, dir).await?,
    }
    Ok(())
}

fn cmd_id(id: &Identity) {
    let ed = hex::encode(id.verifying_key().to_bytes());
    println!("bridge ed25519 (relay-auth id): {ed}");
    println!("bridge x25519  (pairing addr):  {}", hex::encode(id.x25519_public().as_bytes()));
    println!("\nConfigure the relay with:\n  PAGER_BRIDGE_PUBKEY={ed}");
}

/// Confirm the relay is reachable and accepts this bridge's signed requests.
async fn cmd_ping(http: &Client, id: &Identity, cfg: &Config) -> Result<()> {
    let cfg_url = format!("{}/api/config", cfg.relay.trim_end_matches('/'));
    let v: serde_json::Value = http.get(&cfg_url).send().await.context("relay unreachable")?.json().await?;
    println!(
        "relay {} reachable (contract v{})",
        cfg.relay,
        v.get("contractVersion").and_then(|x| x.as_u64()).unwrap_or(0)
    );
    // A signed GET that 404s (no such pairing) proves auth passed; 401/503 means it did not.
    match client::fetch_pairing(http, id, &cfg.relay, &random_token()).await {
        Ok(_) => {
            println!("✓ authentication accepted by relay");
            Ok(())
        }
        Err(e) => anyhow::bail!("authenticated request rejected: {e}"),
    }
}

fn cmd_devices(dir: &Path) -> Result<()> {
    let d = store::load_devices(dir)?;
    if d.devices.is_empty() {
        println!("no paired devices");
    }
    for dev in &d.devices {
        println!("{}  {}  (paired {})", &dev.id[..dev.id.len().min(16)], dev.label, dev.paired_at);
    }
    Ok(())
}

/// Build one sealed delivery per device for a notification.
fn build_deliveries(devices: &[Device], notif: &Notif) -> Result<Vec<Delivery>> {
    let plaintext = serde_json::to_vec(notif)?;
    let mut out = Vec::with_capacity(devices.len());
    for d in devices {
        let blob = pager_proto::seal_to(&d.id, &plaintext, pager_proto::NOTIFY_AAD)?;
        out.push(Delivery { id: d.id.clone(), payload: B64.encode(serde_json::to_vec(&blob)?) });
    }
    Ok(out)
}

async fn cmd_test(http: &Client, id: &Identity, cfg: &Config, dir: &Path, message: &str) -> Result<()> {
    let devices = store::load_devices(dir)?.devices;
    if devices.is_empty() {
        anyhow::bail!("no paired devices — run `pager-bridge pair` first");
    }
    let notif = Notif { title: "Pager test".into(), body: message.into(), source: "test".into(), ts: now_ms() };
    let deliveries = build_deliveries(&devices, &notif)?;
    let resp = client::notify(http, id, &cfg.relay, deliveries).await?;
    println!("sent={} failed={} gone={:?}", resp.sent, resp.failed, resp.gone);
    Ok(())
}

async fn cmd_unpair(http: &Client, id: &Identity, cfg: &Config, dir: &Path, device_id: &str) -> Result<()> {
    let mut d = store::load_devices(dir)?;
    let before = d.devices.len();
    d.devices.retain(|x| x.id != device_id && !x.id.starts_with(device_id));
    store::save_devices(dir, &d)?;
    client::delete_device(http, id, &cfg.relay, device_id).await.ok();
    println!("removed {} device(s)", before - d.devices.len());
    Ok(())
}

async fn cmd_pair(http: &Client, id: &Identity, cfg: &Config, dir: &Path, label: &str) -> Result<()> {
    // The device needs the VAPID public key to subscribe; the relay serves it.
    let vapid_public_key = http
        .get(format!("{}/api/config", cfg.relay.trim_end_matches('/')))
        .send()
        .await
        .context("fetching /api/config from relay")?
        .json::<Value>()
        .await?
        .get("vapidPublicKey")
        .and_then(|v| v.as_str())
        .map(String::from)
        .context("relay /api/config missing vapidPublicKey")?;

    let token = random_token();
    let payload = PairPayload {
        relay: cfg.relay.trim_end_matches('/').to_string(),
        bridge_x25519: hex::encode(id.x25519_public().as_bytes()),
        vapid_public_key,
        token: token.clone(),
        contract_version: pager_proto::PAGER_CONTRACT_VERSION,
    };
    let url = format!("{}/pair#{}", payload.relay, B64URL.encode(serde_json::to_vec(&payload)?));

    println!("\nScan with your phone's camera (or open the URL on the device):\n");
    print_qr(&url);
    println!("\n{url}\n");
    println!("Waiting for the device to enroll (label: {label})…  Ctrl-C to cancel.");

    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    loop {
        if std::time::Instant::now() > deadline {
            anyhow::bail!("pairing timed out — re-run `pager-bridge pair`");
        }
        if let Some(blob_bytes) = client::fetch_pairing(http, id, &cfg.relay, &token).await? {
            let blob: SealedBlob = serde_json::from_slice(&blob_bytes).context("enrollment blob is not a SealedBlob")?;
            let plaintext = pager_proto::open_blob(id, &blob, token.as_bytes()).context("opening enrollment blob")?;
            let enr: Enrollment = serde_json::from_slice(&plaintext).context("enrollment payload")?;

            client::subscribe(http, id, &cfg.relay, &enr.device_x25519, enr.subscription).await?;
            let mut devices = store::load_devices(dir)?;
            devices.devices.retain(|d| d.id != enr.device_x25519);
            devices.devices.push(Device {
                id: enr.device_x25519.clone(),
                label: if enr.label.is_empty() { label.to_string() } else { enr.label },
                paired_at: now_ms() / 1000,
            });
            store::save_devices(dir, &devices)?;
            println!("\n✓ paired device {} ({} total)", &enr.device_x25519[..16], devices.devices.len());
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

struct Ctx {
    id: Arc<Identity>,
    relay: String,
    devices: Arc<RwLock<Devices>>,
    dir: PathBuf,
    http: Client,
    quiet: Option<(u32, u32)>,
    /// conversationId → newest LastDeliveryTime (epoch secs) seen. In-memory;
    /// resets on restart (the recency guard then prevents backfill spam).
    seen: Mutex<HashMap<String, i64>>,
}

impl Ctx {
    /// True only when an Outlook conversation sync is a newly *delivered* message:
    /// its LastDeliveryTime advanced past what we last saw for that conversation
    /// and is recent. Deletes, reads, flags, and moves re-emit the conversation
    /// without advancing LastDeliveryTime, so they're dropped.
    fn is_new_mail(&self, ev: &Value) -> bool {
        let conv = ev.get("conversationId").and_then(|v| v.as_str());
        let ld = ev.get("lastDelivery").and_then(|v| v.as_str());
        let (conv, ld) = match (conv, ld) {
            (Some(c), Some(l)) if !c.is_empty() => (c, l),
            _ => return true, // no conversation data: don't second-guess, let it through
        };
        let ts = match DateTime::parse_from_rfc3339(ld) {
            Ok(d) => d.timestamp(),
            Err(_) => return true,
        };
        let age = Local::now().timestamp() - ts;
        let recent = age <= 600 && age >= -120; // last ~10 min, allowing small clock skew
        let mut seen = self.seen.lock();
        let advanced = seen.get(conv).map_or(true, |&p| ts > p);
        let next = seen.get(conv).map_or(ts, |&p| p.max(ts));
        seen.insert(conv.to_string(), next);
        advanced && recent
    }
}

async fn cmd_run(http: Client, id: Arc<Identity>, cfg: Config, dir: PathBuf) -> Result<()> {
    let devices = Arc::new(RwLock::new(store::load_devices(&dir)?));
    tracing::info!(
        "bridge relay={} devices={} quiet={:?}",
        cfg.relay,
        devices.read().devices.len(),
        cfg.quiet
    );
    let ctx = Arc::new(Ctx { id, relay: cfg.relay, devices, dir, http, quiet: cfg.quiet, seen: Mutex::new(HashMap::new()) });

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/capture", post(capture))
        .with_state(ctx);

    let addr: SocketAddr = cfg.capture_addr.parse().context("PAGER_CAPTURE_ADDR")?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("capture server on http://{addr} (POST /capture)");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn capture(State(ctx): State<Arc<Ctx>>, Json(ev): Json<Value>) -> StatusCode {
    let Some(notif) = event_to_notif(&ev, ctx.quiet) else {
        return StatusCode::NO_CONTENT; // dropped by rules
    };
    if notif.source == "outlook" && !ctx.is_new_mail(&ev) {
        return StatusCode::NO_CONTENT; // conversation sync (delete/read/flag/move), not new mail
    }
    let devices = ctx.devices.read().devices.clone();
    if devices.is_empty() {
        tracing::warn!("captured '{}' but no devices paired", notif.title);
        return StatusCode::ACCEPTED;
    }
    let deliveries = match build_deliveries(&devices, &notif) {
        Ok(d) => d,
        Err(e) => {
            tracing::error!("seal failed: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
    };
    match client::notify(&ctx.http, &ctx.id, &ctx.relay, deliveries).await {
        Ok(resp) => {
            tracing::info!("pushed '{}' sent={} failed={}", notif.title, resp.sent, resp.failed);
            if !resp.gone.is_empty() {
                let mut d = ctx.devices.write();
                d.devices.retain(|x| !resp.gone.contains(&x.id));
                store::save_devices(&ctx.dir, &d).ok();
                tracing::info!("pruned {} dead device(s)", resp.gone.len());
            }
            StatusCode::OK
        }
        Err(e) => {
            tracing::error!("relay notify failed: {e}");
            StatusCode::BAD_GATEWAY
        }
    }
}

/// Apply the (deliberately small) rules engine, turning a raw capture event into
/// a notification, or `None` to drop it.
fn event_to_notif(ev: &Value, quiet: Option<(u32, u32)>) -> Option<Notif> {
    let s = |k: &str| ev.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let source = s("source");
    if source == "__diag" {
        return None; // extension's "capture installed" heartbeat
    }
    let title = s("title");
    let body = s("body");
    if title.is_empty() && body.is_empty() {
        return None; // sync flap with no real content
    }
    if let Some((start, end)) = quiet {
        if in_quiet(Local::now().hour(), start, end) {
            tracing::info!("quiet hours: dropped '{title}'");
            return None;
        }
    }
    let source = if source.is_empty() {
        let host = s("host");
        if host.contains("teams") { "teams" } else if host.contains("outlook") { "outlook" } else { "msg" }.to_string()
    } else {
        source
    };
    let ts = ev.get("ts").and_then(|v| v.as_u64()).unwrap_or_else(now_ms);
    Some(Notif { title, body, source, ts })
}

fn in_quiet(h: u32, start: u32, end: u32) -> bool {
    if start <= end { h >= start && h < end } else { h >= start || h < end }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn random_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("OS RNG");
    hex::encode(buf)
}

fn print_qr(data: &str) {
    match qrcode::QrCode::new(data.as_bytes()) {
        Ok(code) => {
            let s = code.render::<qrcode::render::unicode::Dense1x2>().quiet_zone(true).build();
            println!("{s}");
        }
        Err(_) => println!("(QR too large to render; use the URL below)"),
    }
}

/// Init tracing with `RUST_LOG`, defaulting to info for this crate.
fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("pager_bridge=info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_diag_and_empty() {
        assert!(event_to_notif(&serde_json::json!({"source":"__diag","title":"x"}), None).is_none());
        assert!(event_to_notif(&serde_json::json!({"source":"teams"}), None).is_none());
    }

    #[test]
    fn keeps_real_event_and_derives_source() {
        let n = event_to_notif(&serde_json::json!({"title":"Team — Alice","body":"hi","host":"teams.microsoft.com"}), None).unwrap();
        assert_eq!(n.title, "Team — Alice");
        assert_eq!(n.source, "teams");
    }

    #[test]
    fn quiet_window_wraps_midnight() {
        assert!(in_quiet(23, 22, 7));
        assert!(in_quiet(3, 22, 7));
        assert!(!in_quiet(12, 22, 7));
    }
}
