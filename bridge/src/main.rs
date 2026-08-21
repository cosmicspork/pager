//! Pager bridge — the only component that holds long-term keys.
//!
//! It receives capture events from the browser extension on loopback, applies
//! rules (drop diagnostics/empties, optional quiet hours), seals each surviving
//! event to every paired device's X25519 key, signs the request, and POSTs the
//! ciphertext to the relay for Web Push fan-out. It also drives QR device pairing
//! and registers device subscriptions with the relay on the device's behalf.
//!
//! Subcommands: `run` (default), `pair`, `test`, `devices`, `unpair`, `id`,
//! `ping`, `doctor`.

mod client;
mod doctor;
mod health;
mod store;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    /// Walk the whole capture → bridge → relay → device chain and report what's
    /// broken. Exits non-zero on a failure.
    Doctor {
        /// Also send a real test push at the end.
        #[arg(long)]
        test: bool,
    },
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
        Cmd::Devices => cmd_devices(&http, &identity, &cfg, &dir).await?,
        Cmd::Pair { label } => cmd_pair(&http, &identity, &cfg, &dir, &label).await?,
        Cmd::Test { message } => cmd_test(&http, &identity, &cfg, &dir, &message).await?,
        Cmd::Unpair { id } => cmd_unpair(&http, &identity, &cfg, &dir, &id).await?,
        Cmd::Ping => cmd_ping(&http, &identity, &cfg).await?,
        Cmd::Doctor { test } => {
            if !cmd_doctor(&http, &identity, &cfg, &dir, test).await? {
                std::process::exit(1);
            }
        }
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

/// A coarse "how long ago", accurate enough to spot a device that went quiet.
fn ago(now: u64, t: Option<u64>) -> String {
    let Some(t) = t else { return "never".into() };
    let d = now.saturating_sub(t);
    match d {
        0..=89 => "just now".into(),
        90..=3599 => format!("{}m ago", d / 60),
        3600..=86399 => format!("{}h ago", d / 3600),
        _ => format!("{}d ago", d / 86400),
    }
}

fn date(t: u64) -> String {
    DateTime::from_timestamp(t as i64, 0)
        .map(|d| d.with_timezone(&Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| t.to_string())
}

/// Walk the chain in order and print a verdict per link. Each step is
/// independent: a dead relay still reports on the capture server and the local
/// device list, because knowing which links are fine is half the diagnosis.
async fn cmd_doctor(http: &Client, id: &Identity, cfg: &Config, dir: &Path, send_test: bool) -> Result<bool> {
    use doctor::{Check, Level};

    println!("relay {}\n", cfg.relay);
    let mut checks = vec![doctor::check_capture(http, &cfg.capture_addr).await];

    let config_url = format!("{}/api/config", cfg.relay.trim_end_matches('/'));
    let relay_config = http.get(&config_url).send().await.ok();
    match relay_config {
        Some(r) if r.status().is_success() => {
            let v: Value = r.json().await.unwrap_or(Value::Null);
            checks.push(Check::ok("relay reachable", cfg.relay.clone()));
            checks.push(doctor::check_contract(v.get("contractVersion").and_then(|x| x.as_u64())));
        }
        Some(r) => checks.push(Check::fail("relay reachable", format!("{} answered {}", cfg.relay, r.status()))),
        None => checks.push(Check::fail("relay reachable", format!("{} is unreachable", cfg.relay))),
    }

    // A signed GET that 404s proves auth passed; 401/503 means it did not.
    let authed = client::fetch_pairing(http, id, &cfg.relay, &random_token()).await.is_ok();
    checks.push(if authed {
        Check::ok("relay trusts this bridge", format!("ed25519 {}", &hex::encode(id.verifying_key().to_bytes())[..16]))
    } else {
        Check::fail("relay trusts this bridge", "authentication rejected — check PAGER_BRIDGE_PUBKEY on the relay")
    });

    checks.push(doctor::check_quiet(cfg.quiet, Local::now().hour()));

    let devices = store::load_devices(dir)?;
    let status = if authed { client::devices(http, id, &cfg.relay).await.ok().flatten() } else { None };
    checks.extend(doctor::check_devices(&devices, status.as_deref(), client::now_secs()));

    if send_test && !devices.devices.is_empty() {
        let notif = Notif {
            title: "Pager test".into(),
            body: "doctor".into(),
            source: "test".into(),
            ts: now_ms(),
        };
        checks.push(match build_deliveries(&devices.devices, &notif) {
            Err(e) => Check::fail("test push", e.to_string()),
            Ok(d) => match client::notify(http, id, &cfg.relay, d).await {
                Err(e) => Check::fail("test push", e.to_string()),
                Ok(r) if r.failed > 0 => Check::new("test push", Level::Warn, format!("sent={} failed={}", r.sent, r.failed)),
                Ok(r) => Check::ok("test push", format!("accepted for {} device(s) — watch for it on the phone", r.sent)),
            },
        });
    }

    Ok(doctor::report(&checks))
}

async fn cmd_devices(http: &Client, id: &Identity, cfg: &Config, dir: &Path) -> Result<()> {
    let d = store::load_devices(dir)?;
    if d.devices.is_empty() {
        println!("no paired devices");
        return Ok(());
    }
    // Delivery state lives on the relay; without it fall back to the local view.
    let status = match client::devices(http, id, &cfg.relay).await {
        Ok(Some(v)) => Some(v),
        Ok(None) => {
            println!("(relay has no /api/devices — upgrade it for delivery state)\n");
            None
        }
        Err(e) => {
            println!("(relay unreachable: {e})\n");
            None
        }
    };
    let now = client::now_secs();
    for dev in &d.devices {
        println!("{}  {}  paired {}", &dev.id[..dev.id.len().min(16)], dev.label, date(dev.paired_at));
        match status.as_ref().and_then(|v| v.iter().find(|s| s.id == dev.id)) {
            Some(st) => {
                let fault = health::assess(st, now);
                println!(
                    "  push {} · ack {} · shown {}{}",
                    ago(now, st.last_push),
                    if st.can_ack { ago(now, st.last_ack) } else { "n/a".into() },
                    if st.can_ack { ago(now, st.last_shown) } else { "n/a".into() },
                    match fault {
                        Some(f) => format!("  ⚠ {}", f.detail()),
                        None if !st.can_ack => "  (paired before acknowledgements; silence proves nothing)".into(),
                        None => String::new(),
                    }
                );
            }
            None if status.is_some() => println!("  ⚠ not subscribed on the relay — re-pair"),
            None => println!("  push {} (local view)", ago(now, dev.last_delivered)),
        }
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
    signal_reload(http, &cfg.capture_addr).await;
    Ok(())
}

/// Nudge a running capture server to re-read `devices.json`. A refused
/// connection means no bridge is running, which needs no nudge — it will read
/// the file when it starts. Anything else is reported, because the alternative
/// is pushes that the relay accepts and no device can open.
async fn signal_reload(http: &Client, capture_addr: &str) {
    let url = format!("http://{capture_addr}/reload");
    match http.post(&url).timeout(Duration::from_secs(2)).send().await {
        Ok(r) if r.status().is_success() => println!("✓ running bridge picked up the change"),
        Ok(r) => println!("! running bridge refused the reload ({}) — restart it", r.status()),
        Err(e) if e.is_connect() => {}
        Err(e) => println!("! could not reach the running bridge ({e}) — restart it"),
    }
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

            let device_key = Some(enr.device_ed25519.clone()).filter(|k| !k.is_empty());
            if device_key.is_none() {
                println!("note: this device can't acknowledge deliveries — update the PWA to get delivery health");
            }
            client::subscribe(http, id, &cfg.relay, &enr.device_x25519, enr.subscription, device_key).await?;
            let mut devices = store::load_devices(dir)?;
            devices.devices.retain(|d| d.id != enr.device_x25519);
            devices.devices.push(Device {
                id: enr.device_x25519.clone(),
                label: if enr.label.is_empty() { label.to_string() } else { enr.label },
                paired_at: now_ms() / 1000,
                last_delivered: None,
            });
            store::save_devices(dir, &devices)?;
            println!("\n✓ paired device {} ({} total)", &enr.device_x25519[..16], devices.devices.len());
            signal_reload(http, &cfg.capture_addr).await;
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
    /// When delivery health was last checked against the relay, and when each
    /// device was last complained about, so neither runs once per push.
    checked_at: Mutex<Option<Instant>>,
    warned_at: Mutex<HashMap<String, u64>>,
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
        let recent = (-120..=600).contains(&age); // last ~10 min, allowing small clock skew
        let mut seen = self.seen.lock();
        let advanced = seen.get(conv).is_none_or(|&p| ts > p);
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
    let ctx = Arc::new(Ctx {
        id,
        relay: cfg.relay,
        devices,
        dir,
        http,
        quiet: cfg.quiet,
        seen: Mutex::new(HashMap::new()),
        checked_at: Mutex::new(None),
        warned_at: Mutex::new(HashMap::new()),
    });

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/capture", post(capture))
        .route("/reload", post(reload_devices))
        .with_state(ctx);

    let addr: SocketAddr = cfg.capture_addr.parse().context("PAGER_CAPTURE_ADDR")?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("capture server on http://{addr} (POST /capture, POST /reload)");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Re-read `devices.json` into the in-memory list. `pair` and `unpair` write
/// the file, but a running capture server would otherwise keep sealing to the
/// list it loaded at startup — silently, since the relay still accepts pushes
/// for a device that was unpaired locally.
async fn reload_devices(State(ctx): State<Arc<Ctx>>) -> Result<Json<Value>, StatusCode> {
    let devices = store::load_devices(&ctx.dir).map_err(|e| {
        tracing::error!("reload failed: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let n = devices.devices.len();
    *ctx.devices.write() = devices;
    tracing::info!("reloaded devices from disk: {n} paired");
    Ok(Json(serde_json::json!({ "devices": n })))
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
            {
                let mut d = ctx.devices.write();
                let now = client::now_secs();
                for dev in d.devices.iter_mut().filter(|x| resp.delivered.contains(&x.id)) {
                    dev.last_delivered = Some(now);
                }
                if !resp.gone.is_empty() {
                    d.devices.retain(|x| !resp.gone.contains(&x.id));
                    tracing::info!("pruned {} dead device(s)", resp.gone.len());
                }
                store::save_devices(&ctx.dir, &d).ok();
            }
            // Accepted by the push service is not the same as read by a human;
            // periodically ask the relay whether the devices are still paging.
            tokio::spawn(check_health(ctx.clone()));
            StatusCode::OK
        }
        Err(e) => {
            tracing::error!("relay notify failed: {e}");
            StatusCode::BAD_GATEWAY
        }
    }
}

/// Ask the relay which devices have gone quiet and say so out loud — in the log
/// and on the desktop. Throttled to [`health::CHECK_EVERY`], and to one warning
/// per device per [`health::RENOTIFY_SECS`]; silently gives up if the relay is
/// older than the endpoint or unreachable.
async fn check_health(ctx: Arc<Ctx>) {
    {
        let mut checked = ctx.checked_at.lock();
        if checked.is_some_and(|t| t.elapsed() < health::CHECK_EVERY) {
            return;
        }
        *checked = Some(Instant::now());
    }
    let Ok(Some(status)) = client::devices(&ctx.http, &ctx.id, &ctx.relay).await else {
        return;
    };
    let now = client::now_secs();
    for st in &status {
        let Some(fault) = health::assess(st, now) else {
            ctx.warned_at.lock().remove(&st.id);
            continue;
        };
        {
            let mut warned = ctx.warned_at.lock();
            if warned.get(&st.id).is_some_and(|&t| now.saturating_sub(t) < health::RENOTIFY_SECS) {
                continue;
            }
            warned.insert(st.id.clone(), now);
        }
        let label = ctx
            .devices
            .read()
            .devices
            .iter()
            .find(|d| d.id == st.id)
            .map_or_else(|| st.id[..st.id.len().min(8)].to_string(), |d| d.label.clone());
        let headline = fault.headline(&label);
        tracing::warn!("{headline}: {}", fault.detail());
        health::notify_locally(&headline, fault.detail());
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

pub(crate) fn in_quiet(h: u32, start: u32, end: u32) -> bool {
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
