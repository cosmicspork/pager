use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureBatch {
    pub version: u32,
    pub installation_id: String,
    pub bridge_url: String,
    pub events: Vec<CaptureEvent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEvent {
    pub event_id: Uuid,
    pub source: Source,
    pub account_id: String,
    pub observed_at: i64,
    pub kind: EventKind,
    #[serde(default)]
    pub message: Option<MessageRecord>,
    #[serde(default)]
    pub conversation: Option<ConversationRecord>,
    #[serde(default)]
    pub status: Option<SourceStatus>,
    #[serde(default)]
    pub notification: Option<NotificationCandidate>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Teams,
    Outlook,
}
impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Teams => "teams",
            Self::Outlook => "outlook",
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Message,
    Conversation,
    Status,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BodyStatus {
    Full,
    Missing,
    Truncated,
    Unsupported,
    Deleted,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Chat,
    Channel,
    Meeting,
    Mail,
    Other,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    Ok,
    WaitingForAuth,
    Syncing,
    Degraded,
    Disabled,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Coverage {
    TeamsCache,
    OutlookInboxSentAndObservedThreads,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub message_id: String,
    pub conversation_id: String,
    pub title: String,
    pub body_status: BodyStatus,
    pub category: Category,
    #[serde(default)]
    pub source_time: Option<i64>,
    #[serde(default)]
    pub modified_at: Option<i64>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub sender: Option<Identity>,
    #[serde(default)]
    pub recipients: Vec<Recipient>,
    #[serde(default)]
    pub recipients_truncated: bool,
    #[serde(default)]
    pub is_self: Option<bool>,
    #[serde(default)]
    pub is_mention: Option<bool>,
    #[serde(default)]
    pub has_attachments: Option<bool>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub reply_to_message_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipient {
    pub role: RecipientRole,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecipientRole {
    To,
    Cc,
    Bcc,
    Member,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRecord {
    pub conversation_id: String,
    pub title: String,
    #[serde(default)]
    pub source_time: Option<i64>,
    #[serde(default)]
    pub unread: Option<bool>,
    #[serde(default)]
    pub has_attachments: Option<bool>,
    #[serde(default)]
    pub url: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub state: SourceState,
    #[serde(default)]
    pub reason: Option<String>,
    pub coverage: Coverage,
    pub initial_sync_complete: bool,
    #[serde(default)]
    pub oldest_source_time: Option<i64>,
    pub pending: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationCandidate {
    pub key: String,
    pub source_time: i64,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub last_delivery: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
}

pub fn validate_batch(batch: &CaptureBatch) -> Result<()> {
    if batch.version != 1 {
        bail!("unsupported capture version")
    }
    if batch.installation_id.is_empty() || batch.installation_id.chars().count() > 256 {
        bail!("invalid installationId")
    }
    if batch.events.is_empty() || batch.events.len() > 50 {
        bail!("events must contain 1 to 50 items")
    }
    let bridge =
        reqwest::Url::parse(&batch.bridge_url).map_err(|_| anyhow::anyhow!("invalid bridgeUrl"))?;
    if bridge.scheme() != "http"
        || !matches!(bridge.host_str(), Some("localhost" | "127.0.0.1"))
        || !bridge.username().is_empty()
        || bridge.password().is_some()
        || bridge.path() != "/capture"
        || bridge.query().is_some()
        || bridge.fragment().is_some()
    {
        bail!("invalid bridgeUrl")
    }
    for event in &batch.events {
        if event.account_id.is_empty() || event.account_id.chars().count() > 512 {
            bail!("invalid accountId")
        }
        let payloads = [
            event.message.is_some(),
            event.conversation.is_some(),
            event.status.is_some(),
        ];
        let valid = match event.kind {
            EventKind::Message => payloads == [true, false, false],
            EventKind::Conversation => payloads == [false, true, false],
            EventKind::Status => payloads == [false, false, true],
        };
        if !valid {
            bail!("kind must match exactly one payload")
        }
        if let Some(m) = &event.message {
            validate_message(m)?;
        }
        if let Some(c) = &event.conversation {
            validate_conversation(c)?;
        }
        if let Some(s) = &event.status {
            if s.reason.as_ref().is_some_and(|v| v.chars().count() > 128) {
                bail!("status reason exceeds 128 characters")
            }
            if s.pending > i64::MAX as u64 {
                bail!("status pending exceeds supported range")
            }
            if matches!(event.source, Source::Teams) != matches!(s.coverage, Coverage::TeamsCache) {
                bail!("source status coverage does not match source")
            }
        }
        if let Some(n) = &event.notification {
            if n.key.is_empty() || n.key.chars().count() > 2048 || n.title.chars().count() > 2000 {
                bail!("invalid notification bounds")
            }
            for v in [&n.conversation_id, &n.last_delivery, &n.url, &n.tag]
                .into_iter()
                .flatten()
            {
                if v.chars().count() > 2048 {
                    bail!("notification metadata exceeds 2048 characters")
                }
            }
        }
    }
    Ok(())
}
fn validate_message(m: &MessageRecord) -> Result<()> {
    if m.message_id.is_empty() || m.conversation_id.is_empty() {
        bail!("message identifiers are required")
    }
    bounded(&m.message_id, 2048, "messageId")?;
    bounded(&m.conversation_id, 2048, "conversationId")?;
    bounded(&m.title, 2000, "title")?;
    bounded_opt(&m.version, 2048, "version")?;
    bounded_opt(&m.url, 2048, "url")?;
    bounded_opt(&m.reply_to_message_id, 2048, "replyToMessageId")?;
    validate_identity(m.sender.as_ref())?;
    for p in &m.recipients {
        validate_identity_parts(&p.id, &p.name, &p.email)?;
    }
    match m.body_status {
        BodyStatus::Full | BodyStatus::Truncated if m.body.is_none() => {
            bail!("body is required for full/truncated status")
        }
        BodyStatus::Missing | BodyStatus::Unsupported | BodyStatus::Deleted if m.body.is_some() => {
            bail!("body must be null for missing/unsupported/deleted status")
        }
        _ => {}
    }
    Ok(())
}
fn validate_conversation(c: &ConversationRecord) -> Result<()> {
    if c.conversation_id.is_empty() {
        bail!("conversationId is required")
    }
    bounded(&c.conversation_id, 2048, "conversationId")?;
    bounded(&c.title, 2000, "title")?;
    bounded_opt(&c.url, 2048, "url")
}
fn validate_identity(i: Option<&Identity>) -> Result<()> {
    if let Some(i) = i {
        validate_identity_parts(&i.id, &i.name, &i.email)?;
    }
    Ok(())
}
fn validate_identity_parts(
    id: &Option<String>,
    name: &Option<String>,
    email: &Option<String>,
) -> Result<()> {
    for v in [id, name, email].into_iter().flatten() {
        bounded(v, 512, "identity")?;
    }
    Ok(())
}
fn bounded(v: &str, max: usize, field: &str) -> Result<()> {
    if v.chars().count() > max {
        bail!("{field} exceeds {max} characters")
    }
    Ok(())
}
fn bounded_opt(v: &Option<String>, max: usize, field: &str) -> Result<()> {
    if let Some(v) = v {
        bounded(v, max, field)?;
    }
    Ok(())
}
