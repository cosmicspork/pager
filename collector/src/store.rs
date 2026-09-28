use crate::model::{
    validate_batch, BodyStatus, CaptureBatch, Category, Identity, MessageRecord, Recipient, Source,
};
use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

const RETENTION_MS: i64 = 365 * 24 * 60 * 60 * 1000;
const RECEIPT_MS: i64 = 24 * 60 * 60 * 1000;
const PAGE_MS: i64 = RETENTION_MS;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub enum ArchiveError {
    Schema(String),
    Data(String),
    Database(rusqlite::Error),
}
impl std::fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Schema(s) => write!(f, "schema error: {s}"),
            Self::Data(s) => write!(f, "invalid capture: {s}"),
            Self::Database(e) => write!(f, "database error: {e}"),
        }
    }
}
impl std::error::Error for ArchiveError {}

pub struct Archive {
    db_path: PathBuf,
    archive_id: String,
    writer: Mutex<Connection>,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct PruneCounts {
    pub messages: u64,
    pub conversations: u64,
    pub receipts: u64,
    pub page_attempts: u64,
}

impl Archive {
    pub fn init(dir: &Path) -> Result<Self> {
        private_dir(dir)?;
        let db_path = dir.join("archive.sqlite3");
        let mut conn =
            Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
        configure_writer(&conn)?;
        check_sqlite(&conn)?;
        migrate(&mut conn)?;
        secure_file(&db_path)?;
        let archive_id: String = conn.query_row(
            "SELECT value FROM metadata WHERE key='archive_id'",
            [],
            |r| r.get(0),
        )?;
        Ok(Self {
            db_path,
            archive_id,
            writer: Mutex::new(conn),
        })
    }
    pub fn open_existing(dir: &Path) -> Result<Self> {
        let db_path = dir.join("archive.sqlite3");
        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_context(|| {
            format!(
                "opening existing archive {}; initialize it with pager-collector init",
                db_path.display()
            )
        })?;
        configure_writer(&conn)?;
        check_sqlite(&conn)?;
        check_schema(&conn)?;
        let archive_id = conn
            .query_row(
                "SELECT value FROM metadata WHERE key='archive_id'",
                [],
                |r| r.get::<_, String>(0),
            )
            .context("archive schema is missing its archive identity")?;
        Ok(Self {
            db_path,
            archive_id,
            writer: Mutex::new(conn),
        })
    }
    pub fn archive_id(&self) -> &str {
        &self.archive_id
    }
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }
    pub fn ingest(&self, batch: &CaptureBatch, now_ms: i64) -> Result<Vec<String>> {
        validate_batch(batch).map_err(|e| ArchiveError::Data(format!("{e:#}")))?;
        let mut db = self
            .writer
            .lock()
            .map_err(|_| anyhow!("archive writer mutex poisoned"))?;
        let tx = db.transaction().map_err(ArchiveError::Database)?;
        tx.execute(
            "DELETE FROM capture_receipts WHERE received_at < ?1",
            [now_ms - RECEIPT_MS],
        )?;
        let mut accepted = Vec::with_capacity(batch.events.len());
        for event in &batch.events {
            let id = event.event_id.to_string();
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO capture_receipts(event_id,received_at) VALUES(?1,?2)",
                params![id, now_ms],
            )?;
            accepted.push(id.clone());
            if inserted == 0 {
                continue;
            }
            if let Some(status) = &event.status {
                tx.execute("INSERT INTO source_status(installation_id,source,account_id,state,reason,coverage,initial_sync_complete,oldest_source_time,pending,last_heartbeat) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(installation_id,source,account_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,coverage=excluded.coverage,initial_sync_complete=excluded.initial_sync_complete,oldest_source_time=excluded.oldest_source_time,pending=excluded.pending,last_heartbeat=excluded.last_heartbeat", params![batch.installation_id,event.source.to_string(),event.account_id,state_string(status.state),status.reason,coverage_string(status.coverage),status.initial_sync_complete,status.oldest_source_time,i64::try_from(status.pending)?,event.observed_at])?;
            }
            if let Some(conversation) = &event.conversation {
                upsert_conversation(
                    &tx,
                    ConversationInput {
                        source: &event.source.to_string(),
                        account: &event.account_id,
                        source_id: &conversation.conversation_id,
                        title: &conversation.title,
                        source_time: conversation.source_time,
                        unread: conversation.unread,
                        attachments: conversation.has_attachments,
                        url: safe_url(&event.source, conversation.url.as_deref()),
                        now: event.observed_at,
                    },
                )?;
            }
            if let Some(message) = &event.message {
                upsert_conversation(
                    &tx,
                    ConversationInput {
                        source: &event.source.to_string(),
                        account: &event.account_id,
                        source_id: &message.conversation_id,
                        title: &message.title,
                        source_time: message.source_time,
                        unread: None,
                        attachments: message.has_attachments,
                        url: safe_url(&event.source, message.url.as_deref()),
                        now: event.observed_at,
                    },
                )?;
                upsert_message(
                    &tx,
                    &event.source,
                    &event.account_id,
                    message,
                    event.observed_at,
                )?;
            }
        }
        tx.commit().map_err(ArchiveError::Database)?;
        Ok(accepted)
    }
    pub fn prune(&self, now_ms: i64) -> Result<PruneCounts> {
        let mut db = self
            .writer
            .lock()
            .map_err(|_| anyhow!("archive writer mutex poisoned"))?;
        let tx = db.transaction()?;
        let cutoff = now_ms - RETENTION_MS;
        let messages =
            tx.execute("DELETE FROM messages WHERE retention_time < ?1", [cutoff])? as u64;
        let conversations = tx.execute("DELETE FROM conversations WHERE retention_time < ?1 AND NOT EXISTS(SELECT 1 FROM messages WHERE messages.conversation_id=conversations.id)", [cutoff])? as u64;
        let receipts = tx.execute(
            "DELETE FROM capture_receipts WHERE received_at < ?1",
            [now_ms - RECEIPT_MS],
        )? as u64;
        let page_attempts = tx.execute(
            "DELETE FROM page_attempts WHERE attempted_at < ?1",
            [now_ms - PAGE_MS],
        )? as u64;
        tx.commit()?;
        db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        Ok(PruneCounts {
            messages,
            conversations,
            receipts,
            page_attempts,
        })
    }
    pub fn claim_page(
        &self,
        source: &str,
        account_id: &str,
        key: &str,
        now_ms: i64,
    ) -> Result<bool> {
        let db = self
            .writer
            .lock()
            .map_err(|_| anyhow!("archive writer mutex poisoned"))?;
        let tx = db.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM page_attempts WHERE attempted_at < ?1",
            [now_ms - PAGE_MS],
        )?;
        let changed = tx.execute("INSERT OR IGNORE INTO page_attempts(source,account_id,page_key,attempted_at,outcome) VALUES(?1,?2,?3,?4,'attempted')", params![source,account_id,key,now_ms])?;
        tx.commit()?;
        Ok(changed == 1)
    }
    pub fn finish_page(
        &self,
        source: &str,
        account_id: &str,
        key: &str,
        outcome: &str,
    ) -> Result<()> {
        if !matches!(outcome, "attempted" | "accepted" | "suppressed" | "failed") {
            bail!("invalid page outcome")
        }
        let db = self
            .writer
            .lock()
            .map_err(|_| anyhow!("archive writer mutex poisoned"))?;
        let changed = db.execute(
            "UPDATE page_attempts SET outcome=?4 WHERE source=?1 AND account_id=?2 AND page_key=?3",
            params![source, account_id, key, outcome],
        )?;
        if changed != 1 {
            bail!("page claim does not exist")
        }
        Ok(())
    }
}

pub fn ensure_token(dir: &Path) -> Result<String> {
    private_dir(dir)?;
    let path = dir.join("ingest-token");
    if path.exists() {
        secure_file(&path)?;
        let value = fs::read_to_string(path)?.trim().to_owned();
        if value.is_empty() {
            bail!("ingestion token file is empty; replace it explicitly before serving")
        }
        return Ok(value);
    }
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| anyhow!("random token generation failed: {e}"))?;
    let token = hex::encode(bytes);
    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            bail!("ingestion token appeared during creation; retry initialization")
        }
        Err(e) => return Err(e.into()),
    };
    file.write_all(token.as_bytes())?;
    file.sync_all()?;
    secure_file(&path)?;
    Ok(token)
}

fn private_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
fn secure_file(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}
fn configure_writer(conn: &Connection) -> Result<()> {
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;")?;
    Ok(())
}
fn check_sqlite(conn: &Connection) -> Result<()> {
    let version: String = conn.query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
    let numbers: Vec<u32> = version.split('.').map(|s| s.parse().unwrap_or(0)).collect();
    if numbers.as_slice() < &[3, 51, 3] {
        return Err(ArchiveError::Schema(format!(
            "bundled SQLite {version} is older than required 3.51.3"
        ))
        .into());
    }
    conn.query_row(
        "SELECT 1 FROM pragma_module_list WHERE name='fts5'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map_err(|_| ArchiveError::Schema(format!("SQLite {version} does not provide FTS5")))?;
    Ok(())
}
fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == 0 {
        let tx = conn.transaction()?;
        tx.execute_batch(SCHEMA)?;
        tx.execute(
            "INSERT INTO metadata(key,value) VALUES('archive_id',?1)",
            [Uuid::new_v4().to_string()],
        )?;
        tx.pragma_update(None, "user_version", 1)?;
        tx.commit()?;
    } else if version != 1 {
        return Err(
            ArchiveError::Schema(format!("unsupported archive schema version {version}")).into(),
        );
    }
    check_schema(conn)?;
    conn.execute(
        "INSERT INTO message_fts(message_fts,rank) VALUES('secure-delete',1)",
        [],
    )
    .context("FTS5 secure-delete support is required")?;
    Ok(())
}
fn check_schema(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version != 1 {
        return Err(ArchiveError::Schema(format!(
            "incompatible archive schema version {version}; expected 1"
        ))
        .into());
    }
    let tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('metadata','conversations','messages','source_status','capture_receipts','page_attempts','message_fts')", [], |r| r.get(0))?;
    if tables != 7 {
        return Err(ArchiveError::Schema("archive is missing required tables".into()).into());
    }
    Ok(())
}
/// Validate an existing archive without acquiring a writer or mutating its WAL/schema.
pub fn check_existing_readonly(path: &Path) -> Result<String> {
    let conn=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY|OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .with_context(||format!("opening archive read-only at {}; ensure archive.sqlite3 and its WAL sidecars are readable",path.display()))?;
    conn.execute_batch("PRAGMA query_only=ON;")?;
    check_sqlite(&conn)?;
    check_schema(&conn)?;
    conn.query_row(
        "SELECT value FROM metadata WHERE key='archive_id'",
        [],
        |r| r.get(0),
    )
    .context("archive schema is missing its archive identity")
}
fn state_string(s: crate::model::SourceState) -> &'static str {
    match s {
        crate::model::SourceState::Ok => "ok",
        crate::model::SourceState::WaitingForAuth => "waiting_for_auth",
        crate::model::SourceState::Syncing => "syncing",
        crate::model::SourceState::Degraded => "degraded",
        crate::model::SourceState::Disabled => "disabled",
    }
}
fn coverage_string(c: crate::model::Coverage) -> &'static str {
    match c {
        crate::model::Coverage::TeamsCache => "teams_cache",
        crate::model::Coverage::OutlookInboxSentAndObservedThreads => {
            "outlook_inbox_sent_and_observed_threads"
        }
    }
}
fn safe_url<'a>(source: &Source, raw: Option<&'a str>) -> Option<&'a str> {
    let raw = raw?;
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?;
    let allowed = match source {
        Source::Teams => {
            host == "teams.microsoft.com"
                || host.ends_with(".teams.microsoft.com")
                || host == "teams.cloud.microsoft"
        }
        Source::Outlook => matches!(
            host,
            "outlook.office.com" | "outlook.office365.com" | "outlook.cloud.microsoft"
        ),
    };
    allowed.then_some(raw)
}

struct ConversationInput<'a> {
    source: &'a str,
    account: &'a str,
    source_id: &'a str,
    title: &'a str,
    source_time: Option<i64>,
    unread: Option<bool>,
    attachments: Option<bool>,
    url: Option<&'a str>,
    now: i64,
}

fn upsert_conversation(tx: &Transaction<'_>, input: ConversationInput<'_>) -> Result<()> {
    let ConversationInput {
        source,
        account,
        source_id,
        title,
        source_time,
        unread,
        attachments,
        url,
        now,
    } = input;
    let old: Option<(Option<i64>,i64)> = tx.query_row("SELECT source_time,retention_time FROM conversations WHERE source=?1 AND account_id=?2 AND source_id=?3", params![source,account,source_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let retention = match (old, source_time) {
        (None, Some(t)) => t.min(now),
        (None, None) => now,
        (Some((old_t, ret)), Some(t)) if old_t.is_none_or(|v| t > v) => t.min(now).max(ret),
        (Some((_, ret)), _) => ret,
    };
    tx.execute("INSERT INTO conversations(source,account_id,source_id,title,source_time,unread,has_attachments,url,first_observed_at,last_observed_at,retention_time) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10) ON CONFLICT(source,account_id,source_id) DO UPDATE SET title=CASE WHEN excluded.title!='' THEN excluded.title ELSE conversations.title END,source_time=CASE WHEN excluded.source_time IS NOT NULL AND (conversations.source_time IS NULL OR excluded.source_time>conversations.source_time) THEN excluded.source_time ELSE conversations.source_time END,unread=COALESCE(excluded.unread,conversations.unread),has_attachments=COALESCE(excluded.has_attachments,conversations.has_attachments),url=COALESCE(excluded.url,conversations.url),last_observed_at=excluded.last_observed_at,retention_time=excluded.retention_time", params![source,account,source_id,title,source_time,unread.map(|v|v as i64),attachments.map(|v|v as i64),url,now,retention])?;
    Ok(())
}
fn upsert_message(
    tx: &Transaction<'_>,
    source: &Source,
    account: &str,
    m: &MessageRecord,
    now: i64,
) -> Result<()> {
    let source_s = source.to_string();
    let mut body = m.body.as_deref();
    let mut status = m.body_status;
    if let Some(text) = body {
        if text.len() > MAX_BODY_BYTES {
            body = Some(truncate_utf8(text, MAX_BODY_BYTES));
            status = BodyStatus::Truncated;
        }
    }
    let sender_json = m.sender.as_ref().map(serde_json::to_string).transpose()?;
    let capped_recipients = &m.recipients[..m.recipients.len().min(500)];
    let recipients_truncated = m.recipients_truncated || m.recipients.len() > 500;
    let recipients_json = if recipients_truncated {
        #[derive(Serialize)]
        struct TruncatedRecipients<'a> {
            items: &'a [Recipient],
            truncated: bool,
        }
        serde_json::to_string(&TruncatedRecipients {
            items: capped_recipients,
            truncated: true,
        })?
    } else {
        serde_json::to_string(capped_recipients)?
    };
    let people = people_text(m);
    let fp = fingerprint(m, body, status)?;
    let old: Option<OldMessage> = tx.query_row(
        "SELECT id,modified_at,source_version,body,body_status,sender_json,recipients_json,people_text,is_self,fingerprint,first_observed_at FROM messages WHERE source=?1 AND account_id=?2 AND source_id=?3",
        params![source_s,account,m.message_id],
        |r| Ok(OldMessage { id:r.get(0)?, modified_at:r.get(1)?, version:r.get(2)?, body:r.get(3)?, status:r.get(4)?, sender:r.get(5)?, recipients:r.get(6)?, people:r.get(7)?, is_self:r.get(8)?, fingerprint:r.get(9)?, first:r.get(10)? })
    ).optional()?;
    if let Some(old) = old {
        let replace = should_replace(&old, m, &fp, now);
        let deleting = replace && status == BodyStatus::Deleted;
        let merged_body = if deleting {
            None
        } else if replace && body.is_some() {
            body
        } else {
            old.body.as_deref().or(body)
        };
        let merged_status = if deleting {
            "deleted"
        } else if replace && (m.body.is_some() || status == BodyStatus::Deleted) {
            status_string(status)
        } else if old.body.is_some() {
            &old.status
        } else {
            status_string(status)
        };
        let merged_sender = if replace && sender_json.is_some() {
            sender_json
        } else {
            old.sender
        };
        let merged_recipients = if replace && !m.recipients.is_empty() {
            recipients_json
        } else {
            old.recipients
        };
        let merged_people = if replace { people } else { old.people };
        let self_value = match (old.is_self, m.is_self) {
            (Some(1), _) => Some(1),
            (_, Some(v)) => Some(v as i64),
            _ => None,
        };
        let merged_fp = if replace { fp } else { old.fingerprint };
        tx.execute(
            "UPDATE messages SET source_time=CASE WHEN ?19 THEN COALESCE(?2,source_time) ELSE source_time END,modified_at=CASE WHEN ?19 THEN COALESCE(?3,modified_at) ELSE modified_at END,source_version=CASE WHEN ?19 THEN COALESCE(?4,source_version) ELSE source_version END,category=CASE WHEN ?19 THEN ?5 ELSE category END,title=CASE WHEN ?6!='' THEN ?6 ELSE title END,body=?7,body_status=?8,sender_json=?9,recipients_json=?10,people_text=?11,is_self=?12,is_mention=COALESCE(?13,is_mention),has_attachments=COALESCE(?14,has_attachments),url=COALESCE(?15,url),reply_to_source_id=COALESCE(?16,reply_to_source_id),last_observed_at=?17,fingerprint=?18 WHERE id=?1",
            params![old.id,m.source_time,m.modified_at,m.version,category_string(m.category),m.title,merged_body,merged_status,merged_sender,merged_recipients,merged_people,self_value,m.is_mention.map(|v|v as i64),m.has_attachments.map(|v|v as i64),safe_url(source,m.url.as_deref()),m.reply_to_message_id,now,merged_fp,replace]
        )?;
    } else {
        let retention = m.source_time.unwrap_or(now).min(now);
        tx.execute(
            "INSERT INTO messages(conversation_id,source,account_id,source_id,category,source_time,modified_at,source_version,title,body,body_status,sender_json,recipients_json,people_text,is_self,is_mention,has_attachments,url,reply_to_source_id,first_observed_at,last_observed_at,retention_time,fingerprint) SELECT id,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?19,?20,?21 FROM conversations WHERE source=?1 AND account_id=?2 AND source_id=?22",
            params![source_s,account,m.message_id,category_string(m.category),m.source_time,m.modified_at,m.version,m.title,body,status_string(status),sender_json,recipients_json,people,m.is_self.map(|v|v as i64),m.is_mention.map(|v|v as i64),m.has_attachments.map(|v|v as i64),safe_url(source,m.url.as_deref()),m.reply_to_message_id,now,retention,fp,m.conversation_id]
        )?;
    }
    Ok(())
}
struct OldMessage {
    id: i64,
    modified_at: Option<i64>,
    version: Option<String>,
    body: Option<String>,
    status: String,
    sender: Option<String>,
    recipients: String,
    people: String,
    is_self: Option<i64>,
    fingerprint: String,
    first: i64,
}
fn should_replace(o: &OldMessage, m: &MessageRecord, fp: &str, now: i64) -> bool {
    if m.body_status == BodyStatus::Deleted {
        return match (m.modified_at, o.modified_at) {
            (Some(n), Some(old)) => n >= old,
            _ => now >= o.first,
        };
    }
    if let (Some(n), Some(old)) = (m.modified_at, o.modified_at) {
        if n != old {
            return n > old;
        }
    }
    if let (Some(n), Some(old)) = (&m.version, &o.version) {
        if let (Ok(a), Ok(b)) = (n.parse::<u64>(), old.parse::<u64>()) {
            return a > b;
        } else if n == old {
            return false;
        }
    }
    if m.body.is_none() && o.body.is_some() {
        return false;
    }
    fp != o.fingerprint && now >= o.first
}
fn status_string(s: BodyStatus) -> &'static str {
    match s {
        BodyStatus::Full => "full",
        BodyStatus::Missing => "missing",
        BodyStatus::Truncated => "truncated",
        BodyStatus::Unsupported => "unsupported",
        BodyStatus::Deleted => "deleted",
    }
}
fn category_string(c: Category) -> &'static str {
    match c {
        Category::Chat => "chat",
        Category::Channel => "channel",
        Category::Meeting => "meeting",
        Category::Mail => "mail",
        Category::Other => "other",
    }
}
fn truncate_utf8(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}
fn people_text(m: &MessageRecord) -> String {
    let mut s = String::new();
    if let Some(i) = &m.sender {
        for v in [&i.name, &i.email].into_iter().flatten() {
            s.push_str(v);
            s.push(' ');
        }
    }
    for p in m.recipients.iter().take(500) {
        for v in [&p.name, &p.email].into_iter().flatten() {
            s.push_str(v);
            s.push(' ');
        }
    }
    s
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fingerprint<'a> {
    body: Option<&'a str>,
    body_status: BodyStatus,
    category: Category,
    has_attachments: Option<bool>,
    is_mention: Option<bool>,
    is_self: Option<bool>,
    recipients: &'a [Recipient],
    recipients_truncated: bool,
    reply_to_message_id: Option<&'a str>,
    sender: Option<&'a Identity>,
    title: &'a str,
    url: Option<&'a str>,
}
struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn fingerprint(m: &MessageRecord, body: Option<&str>, status: BodyStatus) -> Result<String> {
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(
        &mut writer,
        &Fingerprint {
            body,
            body_status: status,
            category: m.category,
            has_attachments: m.has_attachments,
            is_mention: m.is_mention,
            is_self: m.is_self,
            recipients: &m.recipients[..m.recipients.len().min(500)],
            recipients_truncated: m.recipients_truncated || m.recipients.len() > 500,
            reply_to_message_id: m.reply_to_message_id.as_deref(),
            sender: m.sender.as_ref(),
            title: &m.title,
            url: m.url.as_deref(),
        },
    )?;
    Ok(hex::encode(writer.0.finalize()))
}

const SCHEMA: &str = r#"
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE conversations(id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,account_id TEXT NOT NULL,source_id TEXT NOT NULL,title TEXT NOT NULL,source_time INTEGER,unread INTEGER,has_attachments INTEGER,url TEXT,first_observed_at INTEGER NOT NULL,last_observed_at INTEGER NOT NULL,retention_time INTEGER NOT NULL,UNIQUE(source,account_id,source_id));
CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id INTEGER NOT NULL REFERENCES conversations(id),source TEXT NOT NULL,account_id TEXT NOT NULL,source_id TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('chat','channel','meeting','mail','other')),source_time INTEGER,modified_at INTEGER,source_version TEXT,title TEXT NOT NULL,body TEXT,body_status TEXT NOT NULL,sender_json TEXT,recipients_json TEXT NOT NULL,people_text TEXT NOT NULL,is_self INTEGER,is_mention INTEGER,has_attachments INTEGER,url TEXT,reply_to_source_id TEXT,first_observed_at INTEGER NOT NULL,last_observed_at INTEGER NOT NULL,retention_time INTEGER NOT NULL,fingerprint TEXT NOT NULL,UNIQUE(source,account_id,source_id));
CREATE TABLE source_status(installation_id TEXT NOT NULL,source TEXT NOT NULL,account_id TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,coverage TEXT NOT NULL,initial_sync_complete INTEGER NOT NULL,oldest_source_time INTEGER,pending INTEGER NOT NULL,last_heartbeat INTEGER NOT NULL,PRIMARY KEY(installation_id,source,account_id));
CREATE TABLE capture_receipts(event_id TEXT PRIMARY KEY,received_at INTEGER NOT NULL);
CREATE TABLE page_attempts(source TEXT NOT NULL,account_id TEXT NOT NULL,page_key TEXT NOT NULL,attempted_at INTEGER NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('attempted','accepted','suppressed','failed')),PRIMARY KEY(source,account_id,page_key));
CREATE INDEX messages_conversation_time ON messages(conversation_id,source_time,id);
CREATE INDEX messages_retention ON messages(retention_time);
CREATE INDEX conversations_retention ON conversations(retention_time);
CREATE INDEX receipts_time ON capture_receipts(received_at);
CREATE INDEX page_attempts_time ON page_attempts(attempted_at);
CREATE VIRTUAL TABLE message_fts USING fts5(title,body,people_text,content='messages',content_rowid='id',tokenize='unicode61');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO message_fts(rowid,title,body,people_text) VALUES(new.id,new.title,CASE WHEN new.body_status IN ('missing','unsupported','deleted') THEN NULL ELSE new.body END,new.people_text); END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO message_fts(message_fts,rowid,title,body,people_text) VALUES('delete',old.id,old.title,CASE WHEN old.body_status IN ('missing','unsupported','deleted') THEN NULL ELSE old.body END,old.people_text); END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN INSERT INTO message_fts(message_fts,rowid,title,body,people_text) VALUES('delete',old.id,old.title,CASE WHEN old.body_status IN ('missing','unsupported','deleted') THEN NULL ELSE old.body END,old.people_text); INSERT INTO message_fts(rowid,title,body,people_text) VALUES(new.id,new.title,CASE WHEN new.body_status IN ('missing','unsupported','deleted') THEN NULL ELSE new.body END,new.people_text); END;
"#;
