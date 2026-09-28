use std::{fs, path::PathBuf};

use pager_collector::{model::CaptureBatch, store::Archive};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use uuid::Uuid;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("pager-archive-test-{}", Uuid::new_v4())))
    }
    fn archive(&self) -> Archive {
        Archive::init(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).ok();
    }
}

fn event(id: &str, body: Option<&str>, status: &str, modified_at: i64, at: i64) -> Value {
    json!({
        "eventId": Uuid::new_v4(), "source": "teams", "accountId": "tenant:user",
        "observedAt": at, "kind": "message",
        "message": { "messageId": id, "conversationId": "room", "title": "Planning room",
            "category": "chat", "bodyStatus": status, "body": body,
            "modifiedAt": modified_at, "sourceTime": at,
            "sender": {"name": "Alex Example"}, "recipients": [] }
    })
}
fn ingest(archive: &Archive, at: i64, events: Vec<Value>) {
    let batch: CaptureBatch = serde_json::from_value(json!({"version":1,"installationId":"fixture","bridgeUrl":"http://localhost:4500/capture","events":events})).unwrap();
    archive.ingest(&batch, at).unwrap();
}
fn count(conn: &Connection, sql: &str, needle: &str) -> i64 {
    conn.query_row(sql, [needle], |row| row.get(0)).unwrap()
}

#[test]
fn revisions_enrich_without_conflating_identical_messages_and_deletion_removes_search() {
    let fixture = Fixture::new();
    let archive = fixture.archive();
    let now = 1_800_000_000_000i64;
    ingest(&archive, now, vec![event("one", None, "missing", 1, now)]);
    ingest(
        &archive,
        now + 1,
        vec![
            event("one", Some("distinct phrase"), "full", 2, now + 1),
            event("two", Some("distinct phrase"), "full", 2, now + 1),
        ],
    );
    ingest(
        &archive,
        now + 2,
        vec![event("one", Some("obsolete body"), "full", 1, now + 2)],
    );
    let db =
        Connection::open_with_flags(archive.db_path(), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM message_fts WHERE message_fts MATCH ?1",
            "distinct"
        ),
        2
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM messages WHERE source_id=?1",
            "one"
        ),
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM message_fts WHERE message_fts MATCH ?1",
            "obsolete"
        ),
        0
    );
    ingest(
        &archive,
        now + 3,
        vec![event("one", None, "deleted", 3, now + 3)],
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM message_fts WHERE message_fts MATCH ?1",
            "distinct"
        ),
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM messages WHERE source_id=?1",
            "one"
        ),
        1
    );
}

#[test]
fn retention_does_not_renew_on_reobservation_and_prunes_fts() {
    let fixture = Fixture::new();
    let archive = fixture.archive();
    let now = 1_800_000_000_000i64;
    let year = 365 * 24 * 60 * 60 * 1000i64;
    let expired = now - year - 1;
    let retained = now - year;
    ingest(
        &archive,
        now,
        vec![
            event("old", Some("yesterdayolder"), "full", 1, expired),
            event("boundary", Some("boundaryterm"), "full", 1, retained),
        ],
    );
    ingest(
        &archive,
        now + 1,
        vec![event("old", Some("yesterdayolder"), "full", 1, now + 1)],
    );
    let counts = archive.prune(now).unwrap();
    assert_eq!(counts.messages, 1);
    let db =
        Connection::open_with_flags(archive.db_path(), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM message_fts WHERE message_fts MATCH ?1",
            "yesterdayolder"
        ),
        0
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM message_fts WHERE message_fts MATCH ?1",
            "boundaryterm"
        ),
        1
    );
    drop(db);
    drop(archive);
    let reopened = fixture.archive();
    let db =
        Connection::open_with_flags(reopened.db_path(), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM messages WHERE source_id=?1",
            "old"
        ),
        0
    );
}
