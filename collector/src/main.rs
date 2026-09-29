use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use anyhow::{bail, Context, Result};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use clap::{Parser, Subcommand};
use pager_collector::{
    diagnostics::{self, DiagnosticBatch, DiagnosticsLog},
    ingest::{bridge_url, forward_pages, now_ms},
    model::CaptureBatch,
    store::{ensure_token, Archive},
};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

const MAX_BATCH: usize = 4 * 1024 * 1024;
const MAX_DIAGNOSTICS: usize = 512 * 1024;

#[derive(Parser)]
#[command(name = "pager-collector")]
struct Cli {
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Init,
    Serve {
        #[arg(long, default_value = "127.0.0.1:4501")]
        listen: SocketAddr,
    },
    Mcp,
    Prune,
}

struct App {
    archive: Arc<Archive>,
    diagnostics: Arc<DiagnosticsLog>,
    token: String,
}

type HttpError = (StatusCode, Json<Value>);

fn error(status: StatusCode, code: &str, detail: Option<&str>) -> HttpError {
    (
        status,
        Json(match detail {
            Some(detail) => json!({"error":code,"detail":detail}),
            None => json!({"error":code}),
        }),
    )
}

async fn health(State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!({"ok":true,"archiveId":app.archive.archive_id(),"schemaVersion":1}))
}

fn authorize(app: &App, headers: &HeaderMap) -> Result<(), HttpError> {
    let provided = headers
        .get(AUTHORIZATION)
        .and_then(|header| header.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    if provided.len() != app.token.len()
        || !bool::from(provided.as_bytes().ct_eq(app.token.as_bytes()))
    {
        return Err(error(StatusCode::UNAUTHORIZED, "unauthorized", None));
    }
    Ok(())
}

async fn report_diagnostics(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, HttpError> {
    authorize(&app, &headers)?;
    if body.len() > MAX_DIAGNOSTICS {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "diagnostics_too_large",
            None,
        ));
    }
    let batch: DiagnosticBatch = serde_json::from_slice(&body).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "invalid_diagnostics",
            Some("diagnostics JSON shape"),
        )
    })?;
    diagnostics::validate(&batch).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "invalid_diagnostics",
            Some("entries"),
        )
    })?;
    let log = app.diagnostics.clone();
    let now = now_ms();
    let stored = tokio::task::spawn_blocking(move || log.append(&batch, now))
        .await
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "diagnostics_unavailable",
                None,
            )
        })?
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "diagnostics_unavailable",
                None,
            )
        })?;
    Ok(Json(json!({ "stored": stored })))
}

async fn capture(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, HttpError> {
    authorize(&app, &headers)?;
    if body.len() > MAX_BATCH {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "capture_too_large",
            None,
        ));
    }
    let batch: CaptureBatch = serde_json::from_slice(&body).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "invalid_capture",
            Some("capture JSON shape"),
        )
    })?;
    if batch.version != 1 {
        return Err(error(
            StatusCode::CONFLICT,
            "unsupported_capture_version",
            None,
        ));
    }
    bridge_url(&batch.bridge_url).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "invalid_capture",
            Some("bridgeUrl"),
        )
    })?;
    pager_collector::model::validate_batch(&batch)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_capture", Some("events")))?;
    let batch = Arc::new(batch);
    let archive = app.archive.clone();
    let archived_batch = batch.clone();
    let now = now_ms();
    let ids = tokio::task::spawn_blocking(move || archive.ingest(&archived_batch, now))
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "archive_unavailable", None))?
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "archive_unavailable", None))?;
    let archive = app.archive.clone();
    let pages = forward_pages(&archive, &batch, now)
        .await
        .unwrap_or_default();
    Ok(Json(
        json!({"archiveId": app.archive.archive_id(), "acceptedEventIds":ids,"pageResults":pages}),
    ))
}

fn data_dir(option: Option<PathBuf>) -> PathBuf {
    option
        .or_else(|| std::env::var_os("PAGER_COLLECTOR_DIR").map(PathBuf::from))
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                .join(".local/share/pager/communications")
        })
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();
    let args = Cli::parse();
    let dir = data_dir(args.data_dir);
    match args.command {
        Command::Init => {
            let archive = Archive::init(&dir)?;
            ensure_token(&dir)?;
            println!(
                "archive ready: {} (id {})",
                archive.db_path().display(),
                archive.archive_id()
            );
            println!(
                "ingestion token file: {}",
                dir.join("ingest-token").display()
            );
        }
        Command::Mcp => {
            pager_collector::mcp::run_mcp(
                dir.join("archive.sqlite3"),
                dir.join(diagnostics::FILE_NAME),
            )
            .await?
        }
        Command::Prune => {
            let archive = Archive::init(&dir)?;
            let counts = archive.prune(now_ms())?;
            println!("pruned: {counts:?}");
        }
        Command::Serve { listen } => {
            if !matches!(listen.ip(), IpAddr::V4(ip) if ip.is_loopback())
                && !matches!(listen.ip(), IpAddr::V6(ip) if ip.is_loopback())
            {
                bail!("collector refuses non-loopback listening address");
            }
            let archive = Arc::new(Archive::init(&dir)?);
            archive.prune(now_ms())?;
            let token = ensure_token(&dir)?;
            let app = Arc::new(App {
                archive: archive.clone(),
                diagnostics: Arc::new(DiagnosticsLog::open(&dir)?),
                token,
            });
            let router = Router::new()
                .route("/health", get(health))
                .route("/capture", post(capture))
                .route("/diagnostics", post(report_diagnostics))
                .layer(DefaultBodyLimit::max(MAX_BATCH))
                .with_state(app);
            let socket = tokio::net::TcpListener::bind(listen)
                .await
                .context("binding collector loopback listener")?;
            let maintenance = archive.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(3600));
                loop {
                    interval.tick().await;
                    let archive = maintenance.clone();
                    match tokio::task::spawn_blocking(move || archive.prune(now_ms())).await {
                        Ok(Ok(_)) => {}
                        Ok(Err(err)) => tracing::warn!("retention failed: {err}"),
                        Err(err) => tracing::warn!("retention task stopped: {err}"),
                    }
                }
            });
            eprintln!("collector listening on {}", socket.local_addr()?);
            axum::serve(socket, router).await?;
        }
    }
    Ok(())
}
