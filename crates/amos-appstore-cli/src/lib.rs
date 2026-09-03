//! `amos-appstore-cli` — Amos app-store **CLI**.
//!
//! A thin headless front-end over [`amos_appstore::AppStore`], driving the
//! deterministic offline [`MockStoreProvider`]. It is the "CLI half" of the
//! store strategy — the *same* engine this binary uses is what the Tauri
//! System-UI bridge exposes to the WebView.
//!
//! ```text
//! $ amos-appstore-cli demo                        # offline sample session
//! $ amos-appstore-cli catalog
//! $ amos-appstore-cli search focus
//! $ amos-appstore-cli install org.amos.pomodoro
//! $ amos-appstore-cli installed
//! $ amos-appstore-cli status org.amos.pomodoro
//! $ amos-appstore-cli uninstall org.amos.pomodoro
//! ```
//!
//! Subcommand parsing lives in [`parse_args`] and execution in [`dispatch`]
//! (generic over any [`StoreProvider`], so a future real HTTP backend can drop
//! in without changing the CLI code). The core is exposed for unit tests that
//! run entirely in memory.
//!
//! *Note:* the default backend is the in-memory mock. Each invocation starts
//! with a fresh demo **catalog**; the *installed* set persists across runs only
//! when you pass `--store <PATH>` (or set `AMOS_APPSTORE_REGISTRY`).

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::path::PathBuf;

use amos_appstore::{
    AppCategory, AppManifest, AppStatus, AppStore, MockStoreProvider, PackageFormat, PackageRef,
    StoreProvider, Version,
};
use anyhow::{anyhow, Result};

/// CLI usage text.
pub const USAGE: &str = "\
amos-appstore-cli — Amos app-store CLI (offline MockStoreProvider by default)

USAGE:
    amos-appstore-cli [--store <PATH>] <SUBCOMMAND>

SUBCOMMANDS:
    catalog                   List every app the catalog publishes (sorted by id)
    search <QUERY>            Search the catalog (id/name/summary/author/category)
    find  <ID>                Show one catalog entry
    installed                 List the apps currently installed
    updatable                 List installed apps that have a newer release
    status <ID>               Show one app's lifecycle state
    install <ID>              Download → verify → install the catalog's release
    upgrade <ID>              Upgrade an installed app to the catalog's newest release
    uninstall <ID>            Uninstall an app
    demo                      Print an offline sample session (catalog -> install -> status)
    help                      Show this help

OPTIONS:
    -h, --help                Show this help
    --store <PATH>            Persist the *installed* registry to this JSON file (can
                              appear anywhere before/after the subcommand). Without it the
                              installed set is ephemeral (reset each run). Also honors
                              $AMOS_APPSTORE_REGISTRY. The catalog is always the in-code demo.
    --catalog <URL>           Use a real remote catalog instead of the offline demo:
                              GET <URL> as a MockCatalog JSON doc and download each
                              package's bytes from its manifest URL. Requires building
                              with --features live (default build ignores it).
";

/// One CLI operation, fully parsed and ready to execute against a store.
#[derive(Clone, Debug)]
pub enum Op {
    /// Print `USAGE`.
    Help,
    /// Print an offline demo session over one ephemeral store.
    Demo,
    /// List the whole catalog.
    Catalog,
    /// Search the catalog by text.
    Search { query: String },
    /// Show one catalog entry.
    Find { id: String },
    /// List installed apps.
    Installed,
    /// List installed apps with a newer release available.
    Updatable,
    /// Show one app's lifecycle state.
    Status { id: String },
    /// Install the catalog's release of an app.
    Install { id: String },
    /// Upgrade an installed app.
    Upgrade { id: String },
    /// Uninstall an app.
    Uninstall { id: String },
}

/// The persistent-registry path from `--store <PATH>` (appearing anywhere in
/// the raw args) or `$AMOS_APPSTORE_REGISTRY`. Returns `None` for ephemeral.
fn store_path(args: &[String]) -> Option<PathBuf> {
    scan_flag(args, "--store").map(PathBuf::from).or_else(|| {
        std::env::var("AMOS_APPSTORE_REGISTRY")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    })
}

/// The `--catalog <URL>` value (anywhere in the raw args), if given.
fn catalog_url(args: &[String]) -> Option<String> {
    scan_flag(args, "--catalog").cloned()
}

/// The value that follows `--flag` anywhere in the raw args, if present.
fn scan_flag<'a>(args: &'a [String], flag: &str) -> Option<&'a String> {
    args.windows(2)
        .find(|w| w[0] == flag)
        .and_then(|w| w.get(1))
}

/// Parse a subcommand that takes exactly one positional `<ID>` (no options).
fn parse_id<'a>(it: &mut impl Iterator<Item = &'a String>, cmd: &str) -> Result<String> {
    let toks: Vec<&String> = it.collect();
    match toks.as_slice() {
        [id] => Ok((*id).clone()),
        [] => Err(anyhow!("{cmd} needs an app <ID> (e.g. org.amos.pomodoro)")),
        _ => Err(anyhow!("{cmd}: unexpected extra arguments")),
    }
}

/// Parse CLI arguments (first token is the subcommand). A `--store <PATH>`
/// pair is dropped here (it does not affect dispatch) so the flag can appear
/// anywhere; [`store_path`] reads it back off the raw args.
pub fn parse_args(args: &[String]) -> Result<Op> {
    let filtered: Vec<String> = {
        let mut out = Vec::new();
        let mut it = args.iter();
        while let Some(a) = it.next() {
            if matches!(a.as_str(), "--store" | "--catalog") {
                let _ = it.next();
            } else {
                out.push(a.clone());
            }
        }
        out
    };
    let mut rest = filtered.iter();
    let Some(cmd) = rest.next() else {
        return Ok(Op::Help);
    };
    match cmd.as_str() {
        "help" | "-h" | "--help" => Ok(Op::Help),
        "demo" => Ok(Op::Demo),
        "catalog" => Ok(Op::Catalog),
        "installed" => Ok(Op::Installed),
        "updatable" => Ok(Op::Updatable),
        "search" => {
            let query = rest
                .cloned()
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_string();
            if query.is_empty() {
                return Err(anyhow!("search needs a <QUERY> (try: search focus)"));
            }
            Ok(Op::Search { query })
        }
        "find" => Ok(Op::Find {
            id: parse_id(&mut rest, "find")?,
        }),
        "status" => Ok(Op::Status {
            id: parse_id(&mut rest, "status")?,
        }),
        "install" => Ok(Op::Install {
            id: parse_id(&mut rest, "install")?,
        }),
        "upgrade" => Ok(Op::Upgrade {
            id: parse_id(&mut rest, "upgrade")?,
        }),
        "uninstall" => Ok(Op::Uninstall {
            id: parse_id(&mut rest, "uninstall")?,
        }),
        other => Err(anyhow!(
            "unknown subcommand {other:?} (try: amos-appstore-cli help)"
        )),
    }
}

// ---------------------------------------------------------------------------
// Demo catalog + rendering
// ---------------------------------------------------------------------------

/// A fresh `MockStoreProvider` seeded with the offline demo catalog (deterministic).
/// Each CLI run rebuilds this catalog; only the *installed* set can persist.
pub fn demo_provider() -> MockStoreProvider {
    let p = MockStoreProvider::new();
    seed(
        &p,
        "org.amos.pomodoro",
        "Pomodoro",
        "A focus timer.",
        AppCategory::Tools,
        Version::new(1, 2, 0),
        b"pomodoro pkg",
    );
    seed(
        &p,
        "org.amos.morse",
        "Morse",
        "Send & decode Morse.",
        AppCategory::Communication,
        Version::new(2, 0, 0),
        b"morse pkg",
    );
    seed(
        &p,
        "org.amos.maze",
        "Maze",
        "A tiny endless maze.",
        AppCategory::Games,
        Version::new(0, 9, 0),
        b"maze pkg",
    );
    p
}

/// Register one demo app (stamps the real digest of `bytes`; logs, never panics).
fn seed(
    p: &MockStoreProvider,
    id: &str,
    name: &str,
    summary: &str,
    category: AppCategory,
    version: Version,
    bytes: &[u8],
) {
    let mf = AppManifest {
        id: id.into(),
        name: name.into(),
        summary: summary.into(),
        description: String::new(),
        author: "Amos Labs".into(),
        version,
        category,
        homepage: String::new(),
        icon_url: String::new(),
        package: PackageRef {
            format: PackageFormat::TarGz,
            url: format!("https://cdn.amos.local/{id}.tgz"),
            sha256: None, // `add` stamps the real digest
            size_bytes: None,
        },
        publisher: None,
    };
    if let Err(e) = p.add(mf, bytes.to_vec()) {
        eprintln!("appstore-cli: demo seed for {id} rejected: {e}");
    }
}

/// One-line rendering of a catalog entry.
fn app_line(m: &AppManifest) -> String {
    format!(
        "{:<22} v{:<10} [{:<13}] {:<12} — {}",
        m.id, m.version, m.category, m.name, m.summary
    )
}

/// Status text for one app (what `status <ID>` prints).
fn status_text(s: &AppStatus) -> String {
    match s {
        AppStatus::Available => "available (not installed)".to_string(),
        AppStatus::Installed { version } => format!("installed (v{version})"),
        AppStatus::Updatable { installed, latest } => {
            format!("update available: v{installed} -> v{latest}")
        }
    }
}

/// One-line rendering of an installed app.
fn installed_line(a: &amos_appstore::InstalledApp) -> String {
    format!(
        "{} v{}  (installed at {})",
        a.manifest.id, a.manifest.version, a.installed_at
    )
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Execute `op` against a store and return the lines to print.
///
/// Generic over the provider so a future live backend works unchanged.
pub async fn dispatch<S: StoreProvider>(store: &AppStore<S>, op: Op) -> Result<Vec<String>> {
    match op {
        Op::Help => Ok(vec![USAGE.to_string()]),
        Op::Demo => demo_lines().await,
        Op::Catalog => {
            let cat = store.catalog().await?;
            let mut out = vec![format!("Catalog: {} app(s)", cat.len())];
            if cat.is_empty() {
                out.push("  (empty)".to_string());
            } else {
                for m in &cat {
                    out.push(format!("  {}", app_line(m)));
                }
            }
            Ok(out)
        }
        Op::Search { query } => {
            let hits = store.search(&query).await?;
            let mut out = vec![format!("Search {query:?}: {} match(es)", hits.len())];
            if hits.is_empty() {
                out.push("  (no matches)".to_string());
            } else {
                for m in &hits {
                    out.push(format!("  {}", app_line(m)));
                }
            }
            Ok(out)
        }
        Op::Find { id } => match store.find(&id).await? {
            Some(m) => Ok(vec![app_line(&m)]),
            None => Ok(vec![format!("(app {id:?} not found in catalog)")]),
        },
        Op::Installed => {
            let apps = store.installed()?;
            let mut out = vec![format!("Installed: {} app(s)", apps.len())];
            if apps.is_empty() {
                out.push("  (none installed)".to_string());
            } else {
                for a in &apps {
                    out.push(format!("  {}", installed_line(a)));
                }
            }
            Ok(out)
        }
        Op::Updatable => {
            let ids = store.updatable().await?;
            let mut out = vec![format!("Updatable: {} app(s)", ids.len())];
            if ids.is_empty() {
                out.push("  (all up to date)".to_string());
            } else {
                for id in &ids {
                    out.push(format!("  {id}"));
                }
            }
            Ok(out)
        }
        Op::Status { id } => {
            let s = store.status(&id).await?;
            Ok(vec![format!("{id}: {}", status_text(&s))])
        }
        Op::Install { id } => {
            let app = store.install(&id).await?;
            Ok(vec![format!(
                "installed {} v{} (sha256 verified)",
                app.manifest.id, app.manifest.version
            )])
        }
        Op::Upgrade { id } => {
            let app = store.upgrade(&id).await?;
            Ok(vec![format!(
                "upgraded {} to v{}",
                app.manifest.id, app.manifest.version
            )])
        }
        Op::Uninstall { id } => {
            store.uninstall(&id)?;
            Ok(vec![format!("uninstalled {id}")])
        }
    }
}

/// An offline sample session (catalog -> install -> status) over one ephemeral store.
async fn demo_lines() -> Result<Vec<String>> {
    let store = AppStore::new(demo_provider());
    let cat = store.catalog().await?;
    let mut out = Vec::new();
    out.push("amos-appstore-cli demo (offline MockStoreProvider)".to_string());
    out.push(format!("  catalog: {} app(s) ready", cat.len()));
    out.push("  install org.amos.pomodoro ...".to_string());
    let app = store.install("org.amos.pomodoro").await?;
    out.push(format!(
        "    -> installed {} v{} (sha256 verified)",
        app.manifest.id, app.manifest.version
    ));
    let status = store.status("org.amos.pomodoro").await?;
    out.push(format!(
        "  status org.amos.pomodoro -> {}",
        status_text(&status)
    ));
    out.push("  (try `amos-appstore-cli install org.amos.maze` for yourself)".to_string());
    Ok(out)
}

/// Execute a fully-parsed op over a concrete provider, opening the registry at
/// `path` (if any) and persisting it afterwards. Generic so the same CLI logic
/// drives the offline demo catalog and the live HTTP backend unchanged.
async fn run_op<S: StoreProvider>(
    provider: S,
    path: Option<PathBuf>,
    op: Op,
) -> Result<Vec<String>> {
    let store = match &path {
        Some(p) => AppStore::open(provider, p)?,
        None => AppStore::new(provider),
    };
    let lines = dispatch(&store, op).await?;
    if let Some(p) = &path {
        store.save_file(p)?;
    }
    Ok(lines)
}

/// Run against a remote catalog URL. Only meaningful when built with
/// `--features live`; otherwise a clear error so a user isn't silently handed
/// the offline demo catalog.
async fn run_with_catalog(url: String, path: Option<PathBuf>, op: Op) -> Result<Vec<String>> {
    #[cfg(feature = "live")]
    {
        let provider = amos_appstore::HttpStoreProvider::new(url);
        run_op(provider, path, op).await
    }
    #[cfg(not(feature = "live"))]
    {
        let _ = (url, path, op);
        Err(anyhow!(
            "--catalog needs a live build: compile with `cargo run -p amos-appstore-cli --features live`"
        ))
    }
}

/// Parse args, build the store (offline demo catalog, or a real remote catalog
/// via `--catalog <URL>` when built `live`), dispatch, and persist the
/// installed registry when `--store` / `AMOS_APPSTORE_REGISTRY` is set — so
/// installs survive across invocations (mirrors the Tauri bridge).
pub async fn run(args: &[String]) -> Result<Vec<String>> {
    let op = parse_args(args)?;
    match op {
        Op::Demo => demo_lines().await,
        Op::Help => Ok(vec![USAGE.to_string()]),
        op => {
            let path = store_path(args);
            match catalog_url(args) {
                Some(url) => run_with_catalog(url, path, op).await,
                None => run_op(demo_provider(), path, op).await,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn parse_known_subcommands() {
        assert!(matches!(parse_args(&s(&[])).unwrap(), Op::Help));
        assert!(matches!(parse_args(&s(&["help"])).unwrap(), Op::Help));
        assert!(matches!(parse_args(&s(&["catalog"])).unwrap(), Op::Catalog));
        assert!(matches!(
            parse_args(&s(&["installed"])).unwrap(),
            Op::Installed
        ));
        assert!(matches!(
            parse_args(&s(&["updatable"])).unwrap(),
            Op::Updatable
        ));
        assert!(matches!(parse_args(&s(&["demo"])).unwrap(), Op::Demo));
        // Multi-word search is joined into one query.
        assert!(matches!(
            parse_args(&s(&["search", "a", "focus", "timer"])).unwrap(),
            Op::Search { query } if query == "a focus timer"
        ));
        // Single-id subcommands.
        assert!(matches!(
            parse_args(&s(&["install", "org.amos.pomodoro"])).unwrap(),
            Op::Install { id } if id == "org.amos.pomodoro"
        ));
        assert!(matches!(
            parse_args(&s(&["find", "org.amos.maze"])).unwrap(),
            Op::Find { id } if id == "org.amos.maze"
        ));
    }

    #[test]
    fn parse_rejects_bad_input() {
        assert!(parse_args(&s(&["nope"])).is_err());
        assert!(parse_args(&s(&["search"])).is_err(), "search needs a query");
        assert!(parse_args(&s(&["install"])).is_err(), "missing id");
        assert!(
            parse_args(&s(&["status", "a", "b"])).is_err(),
            "one id only"
        );
    }

    #[test]
    fn parse_and_store_path_ignore_store_flag_anywhere() {
        let args = s(&["--store", "/tmp/r.json", "install", "org.amos.morse"]);
        assert!(matches!(parse_args(&args).unwrap(), Op::Install { .. }));
        assert_eq!(
            store_path(&args),
            Some(PathBuf::from("/tmp/r.json")),
            "--store read back off raw args wherever it appears"
        );
        assert!(store_path(&s(&["catalog"])).is_none());
    }

    #[tokio::test]
    async fn dispatch_lifecycle_round_trip() {
        let store = AppStore::new(demo_provider());

        // Catalog header lists all 3 demo apps.
        let out = dispatch(&store, Op::Catalog).await.unwrap();
        assert_eq!(out[0], "Catalog: 3 app(s)", "{out:?}");
        assert!(out[1..].iter().any(|l| l.contains("org.amos.pomodoro")));

        // Available → install → installed → uninstall → available.
        let status = dispatch(
            &store,
            Op::Status {
                id: "org.amos.pomodoro".into(),
            },
        )
        .await
        .unwrap();
        assert!(status[0].contains("available"), "{status:?}");

        let installed = dispatch(
            &store,
            Op::Install {
                id: "org.amos.pomodoro".into(),
            },
        )
        .await
        .unwrap();
        assert!(
            installed[0].contains("installed org.amos.pomodoro v1.2.0"),
            "{installed:?}"
        );

        let now = dispatch(
            &store,
            Op::Status {
                id: "org.amos.pomodoro".into(),
            },
        )
        .await
        .unwrap();
        assert!(now[0].contains("installed"), "{now:?}");

        dispatch(
            &store,
            Op::Uninstall {
                id: "org.amos.pomodoro".into(),
            },
        )
        .await
        .unwrap();
        let again = dispatch(
            &store,
            Op::Status {
                id: "org.amos.pomodoro".into(),
            },
        )
        .await
        .unwrap();
        assert!(again[0].contains("available"), "{again:?}");
    }

    #[tokio::test]
    async fn dispatch_guards_errors_cleanly() {
        let store = AppStore::new(demo_provider());
        // Find a missing id is a friendly line, not an error.
        let out = dispatch(
            &store,
            Op::Find {
                id: "org.amos.ghost".into(),
            },
        )
        .await
        .unwrap();
        assert!(out[0].contains("not found"), "{out:?}");
        // Upgrade an app that isn't installed is a clean error.
        assert!(dispatch(
            &store,
            Op::Upgrade {
                id: "org.amos.maze".into()
            }
        )
        .await
        .is_err());
        // Install an id that isn't in the catalog is a clean error.
        assert!(dispatch(
            &store,
            Op::Install {
                id: "org.amos.ghost".into()
            }
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn run_persists_installs_across_invocations_via_store() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "amos-appstore-cli-registry-{}-{nonce}.json",
            std::process::id()
        ));
        let path_s = path.to_string_lossy().to_string();

        // First invocation installs (persists via --store).
        let out = run(&s(&["--store", &path_s, "install", "org.amos.pomodoro"]))
            .await
            .unwrap();
        assert!(out[0].contains("installed"), "{out:?}");

        // Second invocation (fresh process-equivalent) still sees the install.
        let installed = run(&s(&["installed", "--store", &path_s])).await.unwrap();
        assert!(
            installed[1..]
                .iter()
                .any(|l| l.contains("org.amos.pomodoro")),
            "registry survived across invocations: {installed:?}"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn run_demo_plays_an_offline_session() {
        let out = run(&s(&["demo"])).await.unwrap();
        let joined = out.join("\n");
        assert!(joined.contains("catalog"), "{joined}");
        assert!(
            joined.contains("installed org.amos.pomodoro v1.2.0"),
            "{joined}"
        );
        assert!(joined.contains("sha256 verified"), "{joined}");
    }
    #[test]
    fn catalog_flag_is_read_and_stripped_from_subcommand() {
        let args = s(&[
            "--catalog",
            "http://127.0.0.1/c.json",
            "install",
            "org.amos.morse",
        ]);
        assert!(matches!(parse_args(&args).unwrap(), Op::Install { .. }));
        assert_eq!(
            catalog_url(&args).as_deref(),
            Some("http://127.0.0.1/c.json")
        );
    }

    #[cfg(feature = "live")]
    #[tokio::test]
    async fn run_installs_over_a_remote_http_catalog() {
        use amos_appstore::provider::MockCatalog;
        use amos_appstore::Checksum;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // A loopback catalog + package server.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");

        let pkg: Vec<u8> = b"cli http package".to_vec();
        let hex = Checksum::sha256_hex(&pkg);
        let mf = AppManifest {
            id: "org.amos.live".into(),
            name: "Live".into(),
            summary: "over http".into(),
            description: String::new(),
            author: "Http Dev".into(),
            version: Version::new(1, 0, 0),
            category: AppCategory::Tools,
            homepage: String::new(),
            icon_url: String::new(),
            package: PackageRef {
                format: PackageFormat::TarGz,
                url: format!("{base}/pkg.tgz"),
                sha256: Some(Checksum::sha256(hex).unwrap()),
                size_bytes: None,
            },
            publisher: None,
        };
        let cat_json = serde_json::to_vec(&MockCatalog {
            name: "http-catalog".into(),
            apps: vec![mf],
        })
        .unwrap();

        // install → catalog GET + package GET (2 requests).
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut req = Vec::new();
                let mut b = [0u8; 256];
                loop {
                    let n = s.read(&mut b).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    req.extend_from_slice(&b[..n]);
                    if req.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let path = req
                    .split(|c| *c == b' ')
                    .nth(1)
                    .map(|p| String::from_utf8_lossy(p).into_owned())
                    .unwrap_or_default();
                let body = if path.contains("/catalog.json") {
                    cat_json.clone()
                } else {
                    pkg.clone()
                };
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                s.write_all(head.as_bytes()).await.unwrap();
                s.write_all(&body).await.unwrap();
                let _ = s.flush().await;
            }
        });

        let tmp = std::env::temp_dir().join(format!(
            "amos-appstore-cli-http-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let tmp_s = tmp.to_string_lossy().to_string();

        let out = run(&s(&[
            "--catalog",
            &format!("{base}/catalog.json"),
            "--store",
            &tmp_s,
            "install",
            "org.amos.live",
        ]))
        .await
        .unwrap();
        assert!(out[0].contains("installed org.amos.live v1.0.0"), "{out:?}");

        // Persisted across a fresh invocation.
        let installed = run(&s(&["installed", "--store", &tmp_s])).await.unwrap();
        assert!(
            installed[1..].iter().any(|l| l.contains("org.amos.live")),
            "{installed:?}"
        );

        server.await.unwrap();
        let _ = std::fs::remove_file(&tmp);
    }
}
