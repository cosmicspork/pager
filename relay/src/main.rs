//! Pager relay — a zero-knowledge store-and-forward + Web Push fan-out server.
//!
//! It holds the VAPID keypair (to authenticate itself to the push service) and a
//! list of device push subscriptions, and it forwards opaque sealed payloads. It
//! never holds a key that can read a notification or forge a pairing. Mutating
//! endpoints are authenticated as the one configured bridge (Ed25519, via
//! `pager_proto::auth`); pairing-blob upload is the only public write and is
//! size-capped and short-lived.
//!
//! Endpoints:
//! - `GET  /api/config`        — public: VAPID public key, subject, contract version.
//! - `POST /api/pair/:token`   — public: device uploads an opaque enrollment blob.
//! - `GET  /api/pair/:token`   — bridge: fetch-and-delete that blob.
//! - `POST /api/subscribe`     — bridge: register a device id → push subscription.
//! - `POST /api/notify`        — bridge: fan out sealed payloads to devices.
//! - `POST /api/ack/:id`       — device: report that a push reached its worker.
//! - `GET  /api/devices`       — bridge: per-device delivery state.
//! - `DELETE /api/device/:id`  — bridge: drop a device subscription.
//! - fallback                  — serve the PWA (with index.html for SPA routes).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    body::Bytes,
    extract::{OriginalUri, Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Html,
    routing::{delete, get, post},
    Json, Router,
};
use pager_proto::auth::{
    self, DEFAULT_WINDOW_SECS, HEADER_PUBKEY, HEADER_SIGNATURE, HEADER_TIMESTAMP,
};
use pager_proto::{
    AckReq, Delivery, DeviceStatus, NotifyReq, NotifyResp, SubscribeReq, Subscription,
    SubscriptionKeys,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tower_http::{cors::CorsLayer, services::ServeDir, set_header::SetResponseHeaderLayer};
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

#[derive(Clone, Deserialize)]
struct Vapid {
    subject: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    #[serde(rename = "privateKey")]
    private_key: String,
}

struct Pairing {
    blob: Vec<u8>,
    expires: Instant,
}

/// What the relay stores per device. The subscription fields sit at the top
/// level so a file written before delivery tracking existed — a bare
/// `{endpoint, keys}` map — still deserializes, with the rest defaulting to
/// `None`. All timestamps are unix seconds.
#[derive(Clone, Serialize, Deserialize)]
struct DeviceRecord {
    endpoint: String,
    keys: SubscriptionKeys,
    /// Device's Ed25519 public key (hex), used to verify its acks. `None` for
    /// devices enrolled before acks, which therefore can never ack.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ed25519: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_push: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_ack: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_shown: Option<u64>,
}

impl DeviceRecord {
    fn new(sub: Subscription, ed25519: Option<String>) -> Self {
        DeviceRecord {
            endpoint: sub.endpoint,
            keys: sub.keys,
            ed25519,
            last_push: None,
            last_ack: None,
            last_shown: None,
        }
    }

    fn subscription(&self) -> Subscription {
        Subscription {
            endpoint: self.endpoint.clone(),
            keys: self.keys.clone(),
        }
    }
}

struct AppState {
    vapid: Vapid,
    /// device id (X25519 hex) → subscription plus delivery state.
    subs: Mutex<HashMap<String, DeviceRecord>>,
    /// Last time the subscription map was written, so liveness timestamps don't
    /// drive a disk write per push.
    last_persist: Mutex<Instant>,
    /// pairing token → uploaded enrollment blob (opaque, TTL-bounded).
    pairings: Mutex<HashMap<String, Pairing>>,
    /// Authorized bridge Ed25519 public key (hex). `None` disables every
    /// bridge-authenticated endpoint (relay refuses with 503 until configured).
    bridge_pubkeys: Vec<String>,
    pair_ttl: Duration,
    max_blob: usize,
    /// Optional JSON file the subscription map is persisted to so a relay restart
    /// keeps devices subscribed (set in production via a PVC).
    subs_file: Option<PathBuf>,
    /// Content hash of the PWA bundle. The page reports the build it is running
    /// so a stale client can name itself instead of silently misbehaving.
    build: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let vapid_path = std::env::var("PAGER_VAPID_FILE").unwrap_or_else(|_| "vapid.json".into());
    let vapid: Vapid = serde_json::from_slice(&std::fs::read(&vapid_path)?)?;
    let pwa_dir = std::env::var("PAGER_PWA_DIR").unwrap_or_else(|_| "pwa".into());
    let addr = std::env::var("PAGER_RELAY_ADDR").unwrap_or_else(|_| "127.0.0.1:4500".into());
    // One key or several, comma-separated: each bridge holds its own device
    // keys and seals its own payloads, so authorizing a second sender does not
    // widen what any of them can read.
    let bridge_pubkeys: Vec<String> = std::env::var("PAGER_BRIDGE_PUBKEY")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let pair_ttl = Duration::from_secs(
        std::env::var("PAGER_PAIR_TTL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(600),
    );

    if bridge_pubkeys.is_empty() {
        tracing::warn!("PAGER_BRIDGE_PUBKEY unset — bridge endpoints return 503 until configured");
    } else {
        tracing::info!("{} authorized bridge key(s)", bridge_pubkeys.len());
    }

    let subs_file = std::env::var("PAGER_SUBS_FILE")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let subs = subs_file
        .as_ref()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<HashMap<String, DeviceRecord>>(&b).ok())
        .unwrap_or_default();
    tracing::info!("loaded {} persisted subscription(s)", subs.len());

    let (build_id, index_html) = pwa_build(&pwa_dir)?;
    tracing::info!("serving PWA build {build_id} from {pwa_dir}");
    let state = Arc::new(AppState {
        vapid,
        subs: Mutex::new(subs),
        last_persist: Mutex::new(Instant::now()),
        pairings: Mutex::new(HashMap::new()),
        bridge_pubkeys,
        pair_ttl,
        max_blob: 16 * 1024,
        subs_file,
        build: build_id.clone(),
    });

    let app = Router::new()
        .route("/", get(move || async move { Html(index_html) }))
        .route("/index.html", get(move || async move { Html(index_html) }))
        .route("/api/config", get(config))
        .route("/api/pair/:token", post(pair_upload).get(pair_fetch))
        .route("/api/subscribe", post(subscribe))
        .route("/api/notify", post(notify))
        .route("/api/ack/:id", post(ack))
        .route("/api/devices", get(devices))
        .route("/api/device/:id", delete(device_delete))
        .with_state(state)
        // Unknown paths fall back to the PWA shell so SPA routes like /pair work.
        .fallback_service(
            ServeDir::new(&pwa_dir)
                .append_index_html_on_directories(false)
                .fallback(get(move || async move { Html(index_html) })),
        )
        // The PWA ships unhashed filenames, so without this a browser is free to
        // keep serving an old app.js from its heuristic cache indefinitely — which
        // is exactly how a phone kept enrolling with pre-ack code after a deploy.
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ))
        .layer(CorsLayer::permissive());

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("pager relay listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Persist the subscription map to disk if a file is configured (best-effort).
fn persist_subs(s: &AppState) {
    let Some(path) = s.subs_file.as_ref() else {
        return;
    };
    let snapshot = s.subs.lock().clone();
    match serde_json::to_vec(&snapshot) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(path, bytes) {
                tracing::warn!("persisting subscriptions failed: {e}");
            }
        }
        Err(e) => tracing::warn!("serializing subscriptions failed: {e}"),
    }
}

/// Persist at most once per [`PERSIST_EVERY`]. Liveness timestamps update on
/// every push and every ack; losing the last few seconds of them to a restart
/// costs nothing, and a disk write per push would not be free.
const PERSIST_EVERY: Duration = Duration::from_secs(30);

fn persist_subs_throttled(s: &AppState) {
    if s.subs_file.is_none() {
        return;
    }
    {
        let mut last = s.last_persist.lock();
        if last.elapsed() < PERSIST_EVERY {
            return;
        }
        *last = Instant::now();
    }
    persist_subs(s);
}

/// Verify a bridge-authenticated request over its exact body bytes. Returns a
/// ready-to-send error response on any failure.
fn check_auth(
    s: &AppState,
    method: &str,
    uri: &OriginalUri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(), (StatusCode, String)> {
    if s.bridge_pubkeys.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "relay not configured with a bridge key".into(),
        ));
    }
    let h = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let (Some(pubkey), Some(sig), Some(ts)) =
        (h(HEADER_PUBKEY), h(HEADER_SIGNATURE), h(HEADER_TIMESTAMP))
    else {
        return Err((StatusCode::UNAUTHORIZED, "missing auth headers".into()));
    };
    let Ok(ts) = ts.parse::<u64>() else {
        return Err((StatusCode::UNAUTHORIZED, "bad timestamp".into()));
    };
    let path = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| uri.path());
    auth::verify(
        s.bridge_pubkeys.iter().map(String::as_str),
        method,
        path,
        body,
        pubkey,
        sig,
        ts,
        now_secs(),
        DEFAULT_WINDOW_SECS,
    )
    .map_err(|e| (StatusCode::UNAUTHORIZED, e.to_string()))
}

/// Hash the PWA bundle and stamp the result into the shell's `app.js` URL.
///
/// The bundle ships unhashed filenames, so a browser holding an old `app.js`
/// has no reason to ask for a new one. Versioning the URL forces the miss, and
/// the same id is served from `/api/config` so the page can tell whether the
/// code it is running is the code the relay has.
fn pwa_build(dir: &str) -> anyhow::Result<(String, &'static str)> {
    let root = std::path::Path::new(dir);
    let mut hasher = Sha256::new();
    for name in ["index.html", "app.js", "sw.js", "wasm/pager_wasm.js"] {
        hasher.update(std::fs::read(root.join(name)).unwrap_or_default());
    }
    let build = hex::encode(&hasher.finalize()[..6]);

    let index = std::fs::read_to_string(root.join("index.html"))?;
    let stamped = index.replace("/app.js\"", &format!("/app.js?v={build}\""));
    if stamped == index {
        tracing::warn!("index.html has no /app.js reference to version — clients may cache it");
    }
    Ok((build, Box::leak(stamped.into_boxed_str())))
}

async fn config(State(s): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "vapidPublicKey": s.vapid.public_key,
        "subject": s.vapid.subject,
        "contractVersion": pager_proto::PAGER_CONTRACT_VERSION,
        "build": s.build.clone(),
    }))
}

/// Public: a pairing device uploads its opaque enrollment blob under `token`.
async fn pair_upload(
    State(s): State<Arc<AppState>>,
    Path(token): Path<String>,
    body: Bytes,
) -> (StatusCode, &'static str) {
    if token.len() > 128 || body.len() > s.max_blob {
        return (StatusCode::PAYLOAD_TOO_LARGE, "blob or token too large");
    }
    let mut p = s.pairings.lock();
    p.retain(|_, v| v.expires > Instant::now());
    p.insert(
        token,
        Pairing {
            blob: body.to_vec(),
            expires: Instant::now() + s.pair_ttl,
        },
    );
    (StatusCode::CREATED, "stored")
}

/// Bridge: fetch-and-delete the enrollment blob for `token`.
async fn pair_fetch(
    State(s): State<Arc<AppState>>,
    Path(token): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Result<Vec<u8>, (StatusCode, String)> {
    check_auth(&s, "GET", &uri, &headers, &[])?;
    let mut p = s.pairings.lock();
    match p.remove(&token) {
        Some(pairing) if pairing.expires > Instant::now() => Ok(pairing.blob),
        _ => Err((StatusCode::NOT_FOUND, "no pending pairing for token".into())),
    }
}

/// Bridge: register a device id → push subscription.
async fn subscribe(
    State(s): State<Arc<AppState>>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    check_auth(&s, "POST", &uri, &headers, &body)?;
    let req: SubscribeReq =
        serde_json::from_slice(&body).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let can_ack = req.ed25519.is_some();
    s.subs.lock().insert(
        req.id.clone(),
        DeviceRecord::new(req.subscription, req.ed25519),
    );
    persist_subs(&s);
    tracing::info!(
        "subscription registered for device {} (acks: {can_ack})",
        short(&req.id)
    );
    Ok(StatusCode::CREATED)
}

/// Bridge: drop a device subscription.
async fn device_delete(
    State(s): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Result<StatusCode, (StatusCode, String)> {
    check_auth(&s, "DELETE", &uri, &headers, &[])?;
    s.subs.lock().remove(&id);
    persist_subs(&s);
    Ok(StatusCode::NO_CONTENT)
}

/// Bridge: fan out sealed payloads. Each delivery's `payload` is base64 of the
/// exact bytes to push. Subscriptions the push service rejects are reported in
/// `gone` so the bridge can prune them.
async fn notify(
    State(s): State<Arc<AppState>>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<NotifyResp>, (StatusCode, String)> {
    check_auth(&s, "POST", &uri, &headers, &body)?;
    let req: NotifyReq =
        serde_json::from_slice(&body).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let client = IsahcWebPushClient::new()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (mut failed, mut gone, mut delivered) = (0u32, Vec::new(), Vec::new());
    let now = now_secs();

    for Delivery { id, payload } in &req.deliveries {
        let Some(sub) = s.subs.lock().get(id).map(DeviceRecord::subscription) else {
            failed += 1;
            tracing::warn!("notify: no subscription for device {}", short(id));
            continue;
        };
        let bytes = match B64.decode(payload) {
            Ok(b) => b,
            Err(_) => {
                failed += 1;
                continue;
            }
        };
        match send_one(&client, &s.vapid, &sub, &bytes).await {
            Ok(()) => {
                if let Some(rec) = s.subs.lock().get_mut(id) {
                    rec.last_push = Some(now);
                }
                delivered.push(id.clone());
            }
            Err(e) => {
                failed += 1;
                if matches!(
                    e,
                    WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_)
                ) {
                    s.subs.lock().remove(id);
                    gone.push(id.clone());
                }
                tracing::warn!("push to {} failed: {e}", short(id));
            }
        }
    }
    if gone.is_empty() {
        persist_subs_throttled(&s);
    } else {
        persist_subs(&s);
    }
    Ok(Json(NotifyResp {
        sent: delivered.len() as u32,
        failed,
        gone,
        delivered,
    }))
}

/// Device: acknowledge that a push reached the service worker. Public route, but
/// the body and path are signed by the device's own Ed25519 key and verified
/// against the key registered at enrollment, so only that device can speak for
/// it. Records liveness only — the relay learns nothing it did not already know.
async fn ack(
    State(s): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    let Some(device_key) = s.subs.lock().get(&id).and_then(|r| r.ed25519.clone()) else {
        // Unknown device, or one enrolled before acks existed.
        return Err((
            StatusCode::NOT_FOUND,
            "no ack-capable device with that id".into(),
        ));
    };
    let h = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let (Some(pubkey), Some(sig), Some(ts)) =
        (h(HEADER_PUBKEY), h(HEADER_SIGNATURE), h(HEADER_TIMESTAMP))
    else {
        return Err((StatusCode::UNAUTHORIZED, "missing auth headers".into()));
    };
    let Ok(ts) = ts.parse::<u64>() else {
        return Err((StatusCode::UNAUTHORIZED, "bad timestamp".into()));
    };
    let path = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| uri.path());
    // A device ack is authorized by exactly one key: the device's own.
    auth::verify(
        [device_key.as_str()],
        "POST",
        path,
        &body,
        pubkey,
        sig,
        ts,
        now_secs(),
        DEFAULT_WINDOW_SECS,
    )
    .map_err(|e| (StatusCode::UNAUTHORIZED, e.to_string()))?;

    let req: AckReq =
        serde_json::from_slice(&body).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let now = now_secs();
    if let Some(rec) = s.subs.lock().get_mut(&id) {
        rec.last_ack = Some(now);
        if req.shown {
            rec.last_shown = Some(now);
        }
    }
    persist_subs_throttled(&s);
    Ok(StatusCode::NO_CONTENT)
}

/// Bridge: per-device delivery state, so `pager-bridge devices` can show which
/// devices are actually still paging and which have gone quiet.
async fn devices(
    State(s): State<Arc<AppState>>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> Result<Json<Vec<DeviceStatus>>, (StatusCode, String)> {
    check_auth(&s, "GET", &uri, &headers, &[])?;
    let mut out: Vec<DeviceStatus> = s
        .subs
        .lock()
        .iter()
        .map(|(id, r)| DeviceStatus {
            id: id.clone(),
            last_push: r.last_push,
            last_ack: r.last_ack,
            last_shown: r.last_shown,
            can_ack: r.ed25519.is_some(),
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Json(out))
}

async fn send_one(
    client: &IsahcWebPushClient,
    vapid: &Vapid,
    sub: &Subscription,
    payload: &[u8],
) -> Result<(), WebPushError> {
    let info = SubscriptionInfo::new(
        sub.endpoint.clone(),
        sub.keys.p256dh.clone(),
        sub.keys.auth.clone(),
    );
    let mut sig = VapidSignatureBuilder::from_base64(&vapid.private_key, &info)?;
    sig.add_claim("sub", vapid.subject.as_str());
    let signature = sig.build()?;

    let mut msg = WebPushMessageBuilder::new(&info);
    msg.set_payload(ContentEncoding::Aes128Gcm, payload);
    msg.set_vapid_signature(signature);
    client.send(msg.build()?).await
}

/// First 8 hex chars of a device id, for logs (never the full key).
fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}
