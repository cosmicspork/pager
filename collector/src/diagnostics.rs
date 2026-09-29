//! Redacted operational diagnostics from capture sources. Kept in their own
//! database so the communications archive schema and retention stay untouched.

use std::{
    fs,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::model::Source;

pub const FILE_NAME: &str = "diagnostics.sqlite3";
const MAX_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_ROWS: i64 = 5000;
pub const MAX_ENTRIES: usize = 200;
const MAX_DETAIL_KEYS: usize = 24;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS diagnostics(id INTEGER PRIMARY KEY AUTOINCREMENT,installation_id TEXT NOT NULL,source TEXT NOT NULL,account_id TEXT,at INTEGER NOT NULL,op TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('ok','error','info')),code TEXT,message TEXT,duration_ms INTEGER,detail_json TEXT NOT NULL,received_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS diagnostics_at ON diagnostics(at);";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBatch {
    pub version: u32,
    pub installation_id: String,
    pub entries: Vec<DiagnosticEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEntry {
    pub source: Source,
    #[serde(default)]
    pub account_id: Option<String>,
    pub at: i64,
    pub op: String,
    pub outcome: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub detail: Map<String, Value>,
}

pub fn validate(batch: &DiagnosticBatch) -> Result<()> {
    if batch.version != 1 {
        bail!("unsupported diagnostics version")
    }
    if batch.installation_id.is_empty() || batch.installation_id.chars().count() > 256 {
        bail!("invalid installationId")
    }
    if batch.entries.is_empty() || batch.entries.len() > MAX_ENTRIES {
        bail!("entries must contain 1 to {MAX_ENTRIES} items")
    }
    for e in &batch.entries {
        let within =
            |v: &Option<String>, max: usize| v.as_ref().is_none_or(|s| s.chars().count() <= max);
        if e.op.is_empty() || e.op.chars().count() > 64 {
            bail!("invalid op")
        }
        if !matches!(e.outcome.as_str(), "ok" | "error" | "info") {
            bail!("invalid outcome")
        }
        if !within(&e.account_id, 512) || !within(&e.code, 128) || !within(&e.message, 500) {
            bail!("diagnostic field exceeds bounds")
        }
        if e.detail.len() > MAX_DETAIL_KEYS {
            bail!("detail has too many keys")
        }
        for (key, value) in &e.detail {
            let key_ok = key.chars().count() <= 40
                && key.starts_with(|c: char| c.is_ascii_alphabetic())
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            let value_ok = match value {
                Value::Null | Value::Bool(_) | Value::Number(_) => true,
                Value::String(s) => s.chars().count() <= 200,
                _ => false,
            };
            if !key_ok || !value_ok {
                bail!("detail must be a flat map of bounded scalars")
            }
        }
    }
    Ok(())
}

pub struct DiagnosticsLog {
    conn: Mutex<Connection>,
}

impl DiagnosticsLog {
    pub fn open(dir: &Path) -> Result<Self> {
        let path = dir.join(FILE_NAME);
        // SQLite creates the WAL sidecars with the main file's mode, so the
        // file must be private before the first connection opens it.
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&path)
            .with_context(|| format!("creating {}", path.display()))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        let conn =
            Connection::open(&path).with_context(|| format!("opening {}", path.display()))?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn append(&self, batch: &DiagnosticBatch, now_ms: i64) -> Result<usize> {
        validate(batch)?;
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("diagnostics mutex poisoned"))?;
        let tx = conn.transaction()?;
        for e in &batch.entries {
            tx.execute(
                "INSERT INTO diagnostics(installation_id,source,account_id,at,op,outcome,code,message,duration_ms,detail_json,received_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![batch.installation_id, e.source.to_string(), e.account_id, e.at, e.op, e.outcome, e.code, e.message, e.duration_ms, Value::Object(e.detail.clone()).to_string(), now_ms],
            )?;
        }
        tx.execute(
            "DELETE FROM diagnostics WHERE at < ?1",
            [now_ms - MAX_AGE_MS],
        )?;
        tx.execute(
            "DELETE FROM diagnostics WHERE id <= (SELECT id FROM diagnostics ORDER BY id DESC LIMIT 1 OFFSET ?1)",
            [MAX_ROWS],
        )?;
        tx.commit()?;
        Ok(batch.entries.len())
    }
}

#[derive(Debug, Default)]
pub struct Query {
    pub source: Option<String>,
    pub outcome: Option<String>,
    pub op: Option<String>,
    pub since: Option<i64>,
    pub limit: u32,
}

/// Newest first. A missing file means nothing has been reported yet, not an error.
pub fn read(path: &PathBuf, q: &Query) -> Result<Vec<Value>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("cannot open diagnostics {} read-only", path.display()))?;
    conn.pragma_update(None, "query_only", true)?;
    let mut stmt = conn.prepare("SELECT source,account_id,at,op,outcome,code,message,duration_ms,detail_json FROM diagnostics WHERE (?1 IS NULL OR source=?1) AND (?2 IS NULL OR outcome=?2) AND (?3 IS NULL OR op=?3) AND (?4 IS NULL OR at>=?4) ORDER BY at DESC,id DESC LIMIT ?5")?;
    let rows = stmt
        .query_map(
            params![q.source, q.outcome, q.op, q.since, q.limit as i64],
            |r| {
                let detail: String = r.get(8)?;
                Ok(json!({
                    "source": r.get::<_, String>(0)?,
                    "account_id": r.get::<_, Option<String>>(1)?,
                    "at": r.get::<_, i64>(2)?,
                    "op": r.get::<_, String>(3)?,
                    "outcome": r.get::<_, String>(4)?,
                    "code": r.get::<_, Option<String>>(5)?,
                    "message": r.get::<_, Option<String>>(6)?,
                    "duration_ms": r.get::<_, Option<i64>>(7)?,
                    "detail": serde_json::from_str::<Value>(&detail).unwrap_or(Value::Null),
                }))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
