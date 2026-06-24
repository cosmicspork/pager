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
//! - `DELETE /api/device/:id`  — bridge: drop a device subscription.
//! - fallback                  — serve the PWA (with index.html for SPA routes).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    body::Bytes,
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get, post},
    Json, Router,
};
use parking_lot::Mutex;
use pager_proto::auth::{self, DEFAULT_WINDOW_SECS, HEADER_PUBKEY, HEADER_SIGNATURE, HEADER_TIMESTAMP};
use pager_proto::{Delivery, NotifyReq, NotifyResp, SubscribeReq, Subscription};
use serde::Deserialize;
use tower_http::{cors::CorsLayer, services::ServeDir};
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

struct AppState {
    vapid: Vapid,
    /// device id (X25519 hex) → push subscription.
    subs: Mutex<HashMap<String, Subscription>>,
    /// pairing token → uploaded enrollment blob (opaque, TTL-bounded).
    pairings: Mutex<HashMap<String, Pairing>>,
    /// Authorized bridge Ed25519 public key (hex). `None` disables every
    /// bridge-authenticated endpoint (relay refuses with 503 until configured).
    bridge_pubkey: Option<String>,
    pair_ttl: Duration,
    max_blob: usize,
    /// Optional JSON file the subscription map is persisted to so a relay restart
    /// keeps devices subscribed (set in production via a PVC).
    subs_file: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let vapid_path = std::env::var("PAGER_VAPID_FILE").unwrap_or_else(|_| "vapid.json".into());
    let vapid: Vapid = serde_json::from_slice(&std::fs::read(&vapid_path)?)?;
    let pwa_dir = std::env::var("PAGER_PWA_DIR").unwrap_or_else(|_| "pwa".into());
    let addr = std::env::var("PAGER_RELAY_ADDR").unwrap_or_else(|_| "127.0.0.1:4500".into());
    let bridge_pubkey = std::env::var("PAGER_BRIDGE_PUBKEY").ok().filter(|s| !s.is_empty());
    let pair_ttl = Duration::from_secs(
        std::env::var("PAGER_PAIR_TTL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(600),
    );

    if bridge_pubkey.is_none() {
        tracing::warn!("PAGER_BRIDGE_PUBKEY unset — bridge endpoints return 503 until configured");
    }

    let subs_file = std::env::var("PAGER_SUBS_FILE").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
    let subs = subs_file
        .as_ref()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<HashMap<String, Subscription>>(&b).ok())
        .unwrap_or_default();
    tracing::info!("loaded {} persisted subscription(s)", subs.len());

    let index = std::path::Path::new(&pwa_dir).join("index.html");
    let state = Arc::new(AppState {
        vapid,
        subs: Mutex::new(subs),
        pairings: Mutex::new(HashMap::new()),
        bridge_pubkey,
        pair_ttl,
        max_blob: 16 * 1024,
        subs_file,
    });

    let app = Router::new()
        .route("/api/config", get(config))
        .route("/api/pair/:token", post(pair_upload).get(pair_fetch))
        .route("/api/subscribe", post(subscribe))
        .route("/api/notify", post(notify))
        .route("/api/device/:id", delete(device_delete))
        .with_state(state)
        // Unknown paths fall back to the PWA shell so SPA routes like /pair work.
        .fallback_service(ServeDir::new(&pwa_dir).fallback(tower_http::services::ServeFile::new(index)))
        .layer(CorsLayer::permissive());

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("pager relay listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

/// Persist the subscription map to disk if a file is configured (best-effort).
fn persist_subs(s: &AppState) {
    let Some(path) = s.subs_file.as_ref() else { return };
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

/// Verify a bridge-authenticated request over its exact body bytes. Returns a
/// ready-to-send error response on any failure.
fn check_auth(
    s: &AppState,
    method: &str,
    uri: &OriginalUri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(), (StatusCode, String)> {
    let Some(authorized) = s.bridge_pubkey.as_deref() else {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "relay not configured with a bridge key".into()));
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
    let path = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or_else(|| uri.path());
    auth::verify(authorized, method, path, body, pubkey, sig, ts, now_secs(), DEFAULT_WINDOW_SECS)
        .map_err(|e| (StatusCode::UNAUTHORIZED, e.to_string()))
}

async fn config(State(s): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "vapidPublicKey": s.vapid.public_key,
        "subject": s.vapid.subject,
        "contractVersion": pager_proto::PAGER_CONTRACT_VERSION,
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
    p.insert(token, Pairing { blob: body.to_vec(), expires: Instant::now() + s.pair_ttl });
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
    s.subs.lock().insert(req.id.clone(), req.subscription);
    persist_subs(&s);
    tracing::info!("subscription registered for device {}", short(&req.id));
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

    let client = IsahcWebPushClient::new().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (mut sent, mut failed, mut gone) = (0u32, 0u32, Vec::new());

    for Delivery { id, payload } in &req.deliveries {
        let Some(sub) = s.subs.lock().get(id).cloned() else {
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
            Ok(()) => sent += 1,
            Err(e) => {
                failed += 1;
                if matches!(e, WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_)) {
                    s.subs.lock().remove(id);
                    gone.push(id.clone());
                }
                tracing::warn!("push to {} failed: {e}", short(id));
            }
        }
    }
    if !gone.is_empty() {
        persist_subs(&s);
    }
    Ok(Json(NotifyResp { sent, failed, gone }))
}

async fn send_one(
    client: &IsahcWebPushClient,
    vapid: &Vapid,
    sub: &Subscription,
    payload: &[u8],
) -> Result<(), WebPushError> {
    let info = SubscriptionInfo::new(sub.endpoint.clone(), sub.keys.p256dh.clone(), sub.keys.auth.clone());
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
