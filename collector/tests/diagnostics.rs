use std::path::PathBuf;

use pager_collector::diagnostics::{self, DiagnosticBatch, DiagnosticsLog};
use pager_collector::store::Archive;
use rmcp::{
    model::CallToolRequestParams,
    transport::{ConfigureCommandExt, TokioChildProcess},
    ServiceExt,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn batch(value: Value) -> DiagnosticBatch {
    serde_json::from_value(value).unwrap()
}

fn entry(op: &str, outcome: &str, at: i64) -> Value {
    json!({"source":"outlook","accountId":"tenant:owner","at":at,"op":op,"outcome":outcome,
        "code":"ErrorInternalServerError","durationMs":42,
        "detail":{"folder":"sentitems","offset":0,"includesLast":false,"serviceWorker":null}})
}

#[test]
fn rejects_nested_or_oversized_detail() {
    let now = chrono::Utc::now().timestamp_millis();
    let mut nested = entry("FindItem", "error", now);
    nested["detail"]["headers"] = json!({"authorization":"Bearer x"});
    let long = entry("FindItem", "error", now);
    let mut long = long;
    long["detail"]["folder"] = json!("x".repeat(201));
    let mut bad_key = entry("FindItem", "error", now);
    bad_key["detail"]["not-a-key"] = json!(1);
    for e in [nested, long, bad_key] {
        let b = batch(json!({"version":1,"installationId":"fixture","entries":[e]}));
        assert!(diagnostics::validate(&b).is_err());
    }
    let ok = batch(
        json!({"version":1,"installationId":"fixture","entries":[entry("FindItem","error",now)]}),
    );
    assert!(diagnostics::validate(&ok).is_ok());
}

#[tokio::test]
async fn mcp_lists_recent_diagnostics_newest_first_with_filters() {
    let dir: PathBuf = std::env::temp_dir().join(format!("pager-diag-test-{}", Uuid::new_v4()));
    Archive::init(&dir).unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    let log = DiagnosticsLog::open(&dir).unwrap();
    log.append(
        &batch(json!({"version":1,"installationId":"fixture","entries":[
            entry("FindItem", "error", now - 2000),
            entry("GetItem", "ok", now - 1000),
            {"source":"teams","at":now - 500,"op":"scan","outcome":"ok","detail":{"conversations":3}},
            entry("FindItem", "error", now - 30 * 24 * 60 * 60 * 1000),
        ]})),
        now,
    )
    .unwrap();

    let binary = env!("CARGO_BIN_EXE_pager-collector");
    let client = ()
        .serve(
            TokioChildProcess::new(tokio::process::Command::new(binary).configure(|c| {
                c.arg("--data-dir").arg(&dir).arg("mcp");
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let call = |args: Value| {
        CallToolRequestParams::new("get_source_diagnostics")
            .with_arguments(args.as_object().unwrap().clone())
    };
    let all = client.call_tool(call(json!({}))).await.unwrap();
    let all = all.structured_content.unwrap();
    let ops: Vec<_> = all["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["op"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        ops,
        ["scan", "GetItem", "FindItem"],
        "expired entry is pruned"
    );
    assert_eq!(all["entries"][2]["detail"]["folder"], "sentitems");

    let errors = client
        .call_tool(call(json!({"source":"outlook","outcome":"error"})))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(errors["entries"].as_array().unwrap().len(), 1);
    assert_eq!(errors["entries"][0]["code"], "ErrorInternalServerError");

    let invalid = client
        .call_tool(call(json!({"outcome":"bogus"})))
        .await
        .unwrap();
    assert_eq!(invalid.is_error, Some(true));
    client.cancel().await.unwrap();
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn mcp_reports_empty_list_before_any_diagnostics() {
    let dir: PathBuf = std::env::temp_dir().join(format!("pager-diag-empty-{}", Uuid::new_v4()));
    Archive::init(&dir).unwrap();
    let binary = env!("CARGO_BIN_EXE_pager-collector");
    let client = ()
        .serve(
            TokioChildProcess::new(tokio::process::Command::new(binary).configure(|c| {
                c.arg("--data-dir").arg(&dir).arg("mcp");
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let result = client
        .call_tool(
            CallToolRequestParams::new("get_source_diagnostics")
                .with_arguments(serde_json::Map::new()),
        )
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(result["entries"], json!([]));
    assert!(
        !dir.join(diagnostics::FILE_NAME).exists(),
        "the MCP reader never creates the file"
    );
    client.cancel().await.unwrap();
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn diagnostics_database_and_wal_sidecars_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir: PathBuf = std::env::temp_dir().join(format!("pager-diag-perm-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let log = DiagnosticsLog::open(&dir).unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    log.append(
        &batch(
            json!({"version":1,"installationId":"fixture","entries":[entry("FindItem","ok",now)]}),
        ),
        now,
    )
    .unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let path = dir.join(format!("{}{suffix}", diagnostics::FILE_NAME));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{}", path.display());
    }
    std::fs::remove_dir_all(dir).ok();
}
