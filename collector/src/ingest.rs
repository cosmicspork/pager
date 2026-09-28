use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Result};
use reqwest::{redirect::Policy, Client, Url};
use serde::Serialize;

use crate::{
    model::{CaptureBatch, NotificationCandidate},
    store::Archive,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageResult {
    pub event_id: String,
    pub outcome: String,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn bridge_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw)?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/capture"
    {
        bail!("bridgeUrl must be a loopback HTTP /capture URL");
    }
    Ok(url)
}

fn eligible(candidate: &NotificationCandidate, now: i64) -> bool {
    let age = (now - candidate.source_time) / 1000;
    (-120..=600).contains(&age)
        && !candidate.title.trim().is_empty()
        && !candidate.body.trim().is_empty()
        && candidate.title != "__diag"
}

fn clamp(value: &str, n: usize) -> String {
    value.chars().take(n).collect()
}

fn source_link<'a>(source: &str, link: Option<&'a str>) -> Option<&'a str> {
    let link = link?;
    let url = Url::parse(link).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?;
    let allowed = match source {
        "outlook" => matches!(
            host,
            "outlook.office.com" | "outlook.office365.com" | "outlook.cloud.microsoft"
        ),
        "teams" => {
            host == "teams.microsoft.com"
                || host.ends_with(".teams.microsoft.com")
                || host == "teams.cloud.microsoft"
        }
        _ => false,
    };
    allowed.then_some(link)
}

pub async fn forward_pages(
    archive: &Archive,
    batch: &CaptureBatch,
    now: i64,
) -> Result<Vec<PageResult>> {
    let url = bridge_url(&batch.bridge_url)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(Policy::none())
        .build()?;
    let mut results = Vec::new();
    for event in &batch.events {
        let Some(candidate) = &event.notification else {
            continue;
        };
        if !eligible(candidate, now) {
            continue;
        }
        if !archive.claim_page(
            &event.source.to_string(),
            &event.account_id,
            &candidate.key,
            now,
        )? {
            continue;
        }
        let payload = serde_json::json!({
            "source": event.source,
            "title": clamp(&candidate.title, 200),
            "body": clamp(&candidate.body, 500),
            "ts": now,
            "url": source_link(&event.source.to_string(), candidate.url.as_deref()),
            "tag": candidate.tag,
            "conversationId": candidate.conversation_id,
            "lastDelivery": candidate.last_delivery,
        });
        let outcome = match client.post(url.clone()).json(&payload).send().await {
            Ok(response) if response.status().as_u16() == 204 => "suppressed",
            Ok(response) if response.status().is_success() => "accepted",
            _ => "failed",
        };
        archive.finish_page(
            &event.source.to_string(),
            &event.account_id,
            &candidate.key,
            outcome,
        )?;
        results.push(PageResult {
            event_id: event.event_id.to_string(),
            outcome: outcome.into(),
        });
    }
    Ok(results)
}
