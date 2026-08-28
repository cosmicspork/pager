//! Authenticated HTTP client to the relay. Every request signs the exact body
//! bytes it sends, so the relay verifies the same bytes (see `pager_proto::auth`).

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Result};
use pager_proto::auth::{self, HEADER_PUBKEY, HEADER_SIGNATURE, HEADER_TIMESTAMP};
use pager_proto::{Delivery, DeviceStatus, NotifyReq, NotifyResp, SubscribeReq, Subscription};
use reqwest::{Client, Method, StatusCode};
use svastha_core::keys::Identity;

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Issue a signed request. `path` is signed and appended to `relay`; `body` is
/// the exact bytes signed and sent.
async fn signed(
    http: &Client,
    id: &Identity,
    relay: &str,
    method: Method,
    path: &str,
    body: Vec<u8>,
) -> Result<reqwest::Response> {
    let h = auth::sign(id, method.as_str(), path, &body, now_secs());
    let resp = http
        .request(method, format!("{}{}", relay.trim_end_matches('/'), path))
        .header(HEADER_PUBKEY, h.pubkey)
        .header(HEADER_SIGNATURE, h.signature)
        .header(HEADER_TIMESTAMP, h.timestamp.to_string())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await?;
    Ok(resp)
}

pub async fn subscribe(
    http: &Client,
    id: &Identity,
    relay: &str,
    device_id: &str,
    sub: Subscription,
    ed25519: Option<String>,
) -> Result<()> {
    let body = serde_json::to_vec(&SubscribeReq {
        id: device_id.to_string(),
        subscription: sub,
        ed25519,
    })?;
    let resp = signed(http, id, relay, Method::POST, "/api/subscribe", body).await?;
    if !resp.status().is_success() {
        bail!(
            "subscribe failed: {} {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        );
    }
    Ok(())
}

pub async fn notify(
    http: &Client,
    id: &Identity,
    relay: &str,
    deliveries: Vec<Delivery>,
) -> Result<NotifyResp> {
    let body = serde_json::to_vec(&NotifyReq { deliveries })?;
    let resp = signed(http, id, relay, Method::POST, "/api/notify", body).await?;
    if !resp.status().is_success() {
        bail!(
            "notify failed: {} {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        );
    }
    Ok(resp.json().await?)
}

/// Per-device delivery state as the relay sees it. `Ok(None)` when the relay
/// predates the endpoint, so a bridge upgraded ahead of its relay degrades to
/// the local view instead of erroring.
pub async fn devices(
    http: &Client,
    id: &Identity,
    relay: &str,
) -> Result<Option<Vec<DeviceStatus>>> {
    let resp = signed(http, id, relay, Method::GET, "/api/devices", Vec::new()).await?;
    match resp.status() {
        StatusCode::OK => Ok(Some(resp.json().await?)),
        StatusCode::NOT_FOUND => Ok(None),
        s => bail!(
            "device status fetch failed: {} {}",
            s,
            resp.text().await.unwrap_or_default()
        ),
    }
}

/// Fetch-and-delete a pending pairing blob. `Ok(None)` when nothing is waiting.
pub async fn fetch_pairing(
    http: &Client,
    id: &Identity,
    relay: &str,
    token: &str,
) -> Result<Option<Vec<u8>>> {
    let path = format!("/api/pair/{token}");
    let resp = signed(http, id, relay, Method::GET, &path, Vec::new()).await?;
    match resp.status() {
        StatusCode::OK => Ok(Some(resp.bytes().await?.to_vec())),
        StatusCode::NOT_FOUND => Ok(None),
        s => bail!(
            "pairing fetch failed: {} {}",
            s,
            resp.text().await.unwrap_or_default()
        ),
    }
}

pub async fn delete_device(
    http: &Client,
    id: &Identity,
    relay: &str,
    device_id: &str,
) -> Result<()> {
    let path = format!("/api/device/{device_id}");
    let resp = signed(http, id, relay, Method::DELETE, &path, Vec::new()).await?;
    if !resp.status().is_success() && resp.status() != StatusCode::NOT_FOUND {
        bail!("delete failed: {}", resp.status());
    }
    Ok(())
}
