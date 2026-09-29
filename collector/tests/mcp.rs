use std::{fs, path::PathBuf};

use pager_collector::{model::CaptureBatch, store::Archive};
use rmcp::{
    model::CallToolRequestParams,
    transport::{ConfigureCommandExt, TokioChildProcess},
    ServiceExt,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use uuid::Uuid;

fn result_value(value: &rmcp::model::CallToolResult) -> Value {
    value
        .structured_content
        .clone()
        .expect("tool returns structured content")
}

#[tokio::test]
async fn readers_see_commits_without_restart_and_cannot_write() {
    let dir: PathBuf = std::env::temp_dir().join(format!("pager-mcp-test-{}", Uuid::new_v4()));
    let archive = Archive::init(&dir).unwrap();
    let binary = env!("CARGO_BIN_EXE_pager-collector");
    let launch = || {
        TokioChildProcess::new(tokio::process::Command::new(binary).configure(|c| {
            c.arg("--data-dir").arg(&dir).arg("mcp");
        }))
        .unwrap()
    };
    let first = ().serve(launch()).await.unwrap();
    let second = ().serve(launch()).await.unwrap();
    let tools = first.list_all_tools().await.unwrap();
    let mut names: Vec<_> = tools.iter().map(|t| t.name.as_ref()).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "get_collection_status",
            "get_message",
            "get_source_diagnostics",
            "get_thread",
            "search_messages"
        ]
    );

    let before = second
        .call_tool(
            CallToolRequestParams::new("get_collection_status")
                .with_arguments(json!({}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    assert_eq!(result_value(&before)["state"], "not_started");
    let now = chrono::Utc::now().timestamp_millis();
    let batch: CaptureBatch = serde_json::from_value(json!({"version":1,"installationId":"fixture","bridgeUrl":"http://localhost:4500/capture","events":[
      {"eventId":Uuid::new_v4(),"source":"teams","accountId":"tenant:alice","observedAt":now,"kind":"message","message":{
        "messageId":"test-1","conversationId":"room","title":"Fixture room","category":"chat","bodyStatus":"full",
        "body":"Tangerine telescope appears twice","sourceTime":now,"sender":{"name":"Example Person"},"recipients":[],"isSelf":true
      }}] })).unwrap();
    archive.ingest(&batch, now).unwrap();
    let search = second
        .call_tool(
            CallToolRequestParams::new("search_messages").with_arguments(
                json!({"query":"telescope","source":"teams","account_id":"tenant:alice"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    let data = result_value(&search);
    assert_eq!(data["messages"].as_array().unwrap().len(), 1);
    let id = data["messages"][0]["message_id"].as_i64().unwrap();
    let thread = data["messages"][0]["thread_id"].as_i64().unwrap();
    assert_eq!(data["messages"][0]["source"], "teams");
    assert_eq!(data["messages"][0]["account_id"], "tenant:alice");
    let get = first
        .call_tool(
            CallToolRequestParams::new("get_message").with_arguments(
                json!({"message_id":id,"body_limit":9})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    let message = result_value(&get);
    assert_eq!(message["body"], "Tangerine");
    assert_eq!(message["next_body_offset"], 9);
    let thread_result = first
        .call_tool(
            CallToolRequestParams::new("get_thread")
                .with_arguments(json!({"thread_id":thread}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    assert_eq!(
        result_value(&thread_result)["messages"][0]["message_id"],
        id
    );
    let missing = first
        .call_tool(
            CallToolRequestParams::new("get_message")
                .with_arguments(json!({"message_id":id+999}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    assert_eq!(result_value(&missing)["error"], "not_found");
    let invalid = first
        .call_tool(
            CallToolRequestParams::new("search_messages")
                .with_arguments(json!({"query":"("}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    assert_eq!(result_value(&invalid)["error"], "invalid_argument");
    let reversed = first
        .call_tool(
            CallToolRequestParams::new("search_messages")
                .with_arguments(json!({"query":"telescope","since":"2026-09-29T00:00:00Z","until":"2026-09-28T00:00:00Z"}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    assert_eq!(result_value(&reversed)["error"], "invalid_argument");
    let recipient =
        json!({"role":"to","id":"🙂".repeat(512),"name":"🙂".repeat(512),"email":"🙂".repeat(512)});
    let extreme: CaptureBatch = serde_json::from_value(json!({
        "version":1,"installationId":"fixture","bridgeUrl":"http://localhost:4500/capture",
        "events":[{
            "eventId":Uuid::new_v4(),"source":"outlook","accountId":"tenant:owner",
            "observedAt":now,"kind":"message","message":{
                "messageId":"large-metadata","conversationId":"large-thread","category":"mail",
                "title":format!("Aurora {}", "🙂".repeat(1993)),"bodyStatus":"full","body":"\"".repeat(64000),
                "sourceTime":now,"recipients":vec![recipient;500]
            }
        }]
    }))
    .unwrap();
    archive.ingest(&extreme, now).unwrap();
    let large_id: i64 = Connection::open(archive.db_path())
        .unwrap()
        .query_row(
            "SELECT id FROM messages WHERE source_id='large-metadata'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let bounded = second
        .call_tool(
            CallToolRequestParams::new("get_message").with_arguments(
                json!({"message_id":large_id,"body_limit":64000,"recipient_limit":32})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    let bounded_value = result_value(&bounded);
    assert!(!bounded.is_error.unwrap_or(false));
    assert!(serde_json::to_vec(&bounded).unwrap().len() < 256 * 1024);
    assert_eq!(bounded_value["recipient_count"], 500);
    let returned_recipients = bounded_value["recipients"].as_array().unwrap().len();
    assert!((1..=32).contains(&returned_recipients));
    assert_eq!(bounded_value["next_recipient_offset"], returned_recipients);
    assert_eq!(bounded_value["body_total_characters"], 64000);
    assert!(bounded_value["next_body_offset"].as_u64().unwrap() < 64000);
    let bounded_search = first
        .call_tool(
            CallToolRequestParams::new("search_messages").with_arguments(
                json!({"query":"Aurora","source":"outlook","recipient_limit":32,"limit":1})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert!(!bounded_search.is_error.unwrap_or(false));
    assert!(serde_json::to_vec(&bounded_search).unwrap().len() < 256 * 1024);
    let search_value = result_value(&bounded_search);
    assert_eq!(search_value["messages"][0]["message_id"], large_id);
    assert_eq!(search_value["messages"][0]["recipient_count"], 500);
    assert!(
        search_value["messages"][0]["next_recipient_offset"]
            .as_u64()
            .unwrap()
            < 32
    );
    let mut invalid_metadata = extreme.clone();
    invalid_metadata.events[0]
        .message
        .as_mut()
        .unwrap()
        .title
        .push('!');
    assert!(archive.ingest(&invalid_metadata, now).is_err());
    let readonly =
        Connection::open_with_flags(archive.db_path(), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    readonly.execute_batch("PRAGMA query_only=ON;").unwrap();
    assert!(readonly.execute("DELETE FROM messages", []).is_err());
    first.cancel().await.unwrap();
    second.cancel().await.unwrap();
    drop(readonly);
    drop(archive);
    fs::remove_dir_all(dir).unwrap();
}
