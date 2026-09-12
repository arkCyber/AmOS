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
    catalog_to_fdroid_index_v1, AppCategory, AppManifest, AppStatus, AppStore, MockStoreProvider,
    PackageFormat, PackageRef, StoreProvider, Version,
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
    info  <ID>                Show one entry in detail (version, package URL,
                              digest, size, author, lifecycle state)
    installed                 List the apps currently installed
    updatable                 List installed apps that have a newer release
    status <ID>               Show one app's lifecycle state
    install <ID>              Download → verify → install the catalog's release
    upgrade <ID>              Upgrade an installed app to the catalog's newest release
    uninstall <ID>            Uninstall an app
    export <FILE>             Write the current catalog as an F-Droid index-v1
                              JSON document (package rows only for APK entries;
                              web bundles stay visible but package-less — the
                              F-Droid client reports them incompatible)
    demo                      Print an offline sample session (catalog -> install -> status)
    help                      Show this help

OPTIONS:
    -h, --help                Show this help
    -V, --version             Print version and exit
    --store <PATH>            Persist the *installed* registry to this JSON file (can
                              appear anywhere before/after the subcommand). Without it the
                              installed set is ephemeral (reset each run). Also honors
                              $AMOS_APPSTORE_REGISTRY. The catalog is always the in-code demo.
    --catalog <URL>           Use a real remote catalog instead of the offline demo:
                              GET <URL> as a MockCatalog JSON doc and download each
                              package's bytes from its manifest URL. Requires building
                              with --features live (default build ignores it).
    --repo <URL>              Use an F-Droid repository (index-v1 format) as the catalog:
                              GET <URL>/index-v1.json, map its apps into the engine, and
                              download APK bytes from <URL>/<apkName>. Requires building
                              with --features live. Note: F-Droid entries are APKs, so
                              `install` is honestly refused (that needs a device
                              PackageInstaller bridge); use `download` to fetch +
                              sha256-verify an APK to disk. The index PGP signature is
                              not verified yet — pin it with --pin.
    --pin <SHA256>            With --repo: require the downloaded index's sha256 to match
                              this hex digest (integrity pin until PGP verification lands).
    --repo-address <URL>      With export: the repo.address the exported index
                              advertises (default https://store.amos.local/repo).
    download <ID>             Download the app's package bytes, verify the published sha256
                              (when present), and write them to --out <PATH>. Never installs.
";

/// One CLI operation, fully parsed and ready to execute against a store.
#[derive(Clone, Debug)]
pub enum Op {
    /// Print `USAGE`.
    Help,
    /// Print the binary's version (how a deployed artifact is identified).
    Version,
    /// Print an offline demo session over one ephemeral store.
    Demo,
    /// List the whole catalog.
    Catalog,
    /// Search the catalog by text.
    Search { query: String },
    /// Show one catalog entry.
    Find { id: String },
    /// Show one catalog entry in full detail.
    Info { id: String },
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
    /// Download a catalog package's bytes to `--out <PATH>` (sha256-verified
    /// when the catalog publishes a digest) without installing it — the honest
    /// operation for an APK source like F-Droid on a non-device host.
    Download { id: String, out: PathBuf },
    /// Write the current catalog out **as** an F-Droid `index-v1.json`
    /// document (the "our store speaks the F-Droid format" direction).
    Export {
        out: PathBuf,
        repo_address: Option<String>,
    },
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

/// The `--repo <URL>` value (an F-Droid repository base), if given.
fn repo_url(args: &[String]) -> Option<String> {
    scan_flag(args, "--repo").cloned()
}

/// The `--pin <SHA256>` value (index integrity pin for `--repo`), if given.
#[cfg(feature = "live")]
fn index_pin(args: &[String]) -> Option<String> {
    scan_flag(args, "--pin").cloned()
}

/// The `--out <PATH>` destination for `download`, if given.
fn download_out(args: &[String]) -> Option<PathBuf> {
    scan_flag(args, "--out").map(PathBuf::from)
}

/// The `--repo-address <URL>` value for `export`, if given.
fn export_repo_address(args: &[String]) -> Option<String> {
    scan_flag(args, "--repo-address").cloned()
}

/// Options that take a value. Kept in one place so the parser below and the
/// raw-arg readers ([`scan_flag`]) cannot disagree about which flags exist.
const VALUE_FLAGS: &[&str] = &[
    "--store",
    "--catalog",
    "--repo",
    "--repo-address",
    "--out",
    "--pin",
];

/// The value that follows `--flag` anywhere in the raw args, if present.
/// [`parse_args`] has already rejected a flag with no (or an empty) value.
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
            if VALUE_FLAGS.contains(&a.as_str()) {
                // A flag with no value must be an error, never a silent drop:
                // swallowing a dangling `--pin` would fetch the index
                // **unpinned** (the opposite of what was asked), and a dangling
                // `--store` would quietly forfeit persistence.
                match it.next() {
                    Some(v) if !v.trim().is_empty() => {}
                    Some(_) => return Err(anyhow!("{a} needs a non-empty value")),
                    None => return Err(anyhow!("{a} needs a value")),
                }
            } else {
                out.push(a.clone());
            }
        }
        out
    };
    let mut rest = filtered.iter();
    // `-V/--version` is a global flag: it must work without a subcommand (that is
    // exactly how a deployed artifact is identified).
    if filtered.iter().any(|a| a == "-V" || a == "--version") {
        return Ok(Op::Version);
    }
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
        "info" => Ok(Op::Info {
            id: parse_id(&mut rest, "info")?,
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
        "download" => {
            let id = parse_id(&mut rest, "download")?;
            let out = download_out(args).ok_or_else(|| {
                anyhow!("download needs --out <PATH> (where the verified package is written)")
            })?;
            Ok(Op::Download { id, out })
        }
        "export" => {
            let toks: Vec<&String> = rest.collect();
            let [file] = toks.as_slice() else {
                return Err(anyhow!(
                    "export needs exactly one <FILE> destination (e.g. index-v1.json)"
                ));
            };
            Ok(Op::Export {
                out: PathBuf::from((*file).clone()),
                repo_address: export_repo_address(args),
            })
        }
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
        Op::Version => Ok(vec![format!(
            "amos-appstore-cli {}",
            env!("CARGO_PKG_VERSION")
        )]),
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
        Op::Info { id } => match store.find(&id).await? {
            Some(m) => {
                let mut out = vec![app_line(&m)];
                out.push(format!("  version:  {}", m.version));
                out.push(format!("  format:   {:?}", m.package.format));
                out.push(format!("  package:  {}", m.package.url));
                out.push(format!(
                    "  sha256:   {}",
                    m.package
                        .sha256
                        .as_ref()
                        .map(|c| c.value.clone())
                        .unwrap_or_else(|| "(none published)".to_string())
                ));
                out.push(format!(
                    "  size:     {}",
                    m.package
                        .size_bytes
                        .map(|b| format!("{b} bytes"))
                        .unwrap_or_else(|| "unknown".to_string())
                ));
                out.push(format!("  author:   {}", m.author));
                if !m.homepage.is_empty() {
                    out.push(format!("  homepage: {}", m.homepage));
                }
                for line in m.description.lines() {
                    out.push(format!("  {line}"));
                }
                let st = store.status(&id).await?;
                out.push(format!("  status:   {}", status_text(&st)));
                Ok(out)
            }
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
        Op::Download { id, out } => {
            let (mf, bytes) = store.download(&id).await?;
            write_atomic(&out, &bytes)?;
            let note = if mf.package.sha256.is_some() {
                "sha256 verified"
            } else {
                "no digest published (UNVERIFIED)"
            };
            Ok(vec![format!(
                "downloaded {} v{} -> {} ({} bytes, {})",
                mf.id,
                mf.version,
                out.display(),
                bytes.len(),
                note
            )])
        }
        Op::Export { out, repo_address } => {
            let apps = store.catalog().await?;
            let address = repo_address.unwrap_or_else(|| "https://store.amos.local/repo".into());
            let index = catalog_to_fdroid_index_v1(&apps, &address);
            let json = serde_json::to_vec_pretty(&index)
                .map_err(|e| anyhow!("serialize F-Droid index: {e}"))?;
            write_atomic(&out, &json)?;
            Ok(vec![format!(
                "exported {} app(s) ({} package(s)) as F-Droid index-v1 -> {} ({} bytes)",
                index.apps.len(),
                index.packages.len(),
                out.display(),
                json.len()
            )])
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

/// Write `bytes` to `path` **atomically** — a thin adapter over the store's
/// shared [`amos_appstore::write_atomic`], so the downloaded APK / exported
/// index here and the engine's own registry snapshot can never drift apart on
/// this rule. A killed `download` / `export` therefore leaves either the
/// previous file or nothing — never a half-written artifact a later step (a
/// PackageInstaller hand-off, an F-Droid client) might trust.
fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    amos_appstore::write_atomic(path, bytes).map_err(|e| anyhow!("{e}"))
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

/// Run against an F-Droid repository (`--repo <URL>`, index-v1 format). Only
/// meaningful when built with `--features live`, like `run_with_catalog`.
#[cfg(feature = "live")]
async fn run_with_repo(
    repo: String,
    pin: Option<String>,
    path: Option<PathBuf>,
    op: Op,
) -> Result<Vec<String>> {
    #[cfg(feature = "live")]
    {
        let provider = amos_appstore::FdroidRepoProvider::fetch(
            &repo,
            amos_appstore::FdroidRepoProvider::DEFAULT_INDEX_TIMEOUT_SECS,
            pin.as_deref(),
        )
        .await
        .map_err(|e| anyhow!("load F-Droid repo {repo}: {e}"))?;
        run_op(provider, path, op).await
    }
    #[cfg(not(feature = "live"))]
    {
        let _ = (repo, pin, path, op);
        Err(anyhow!(
            "--repo needs a live build: compile with `cargo run -p amos-appstore-cli --features live`"
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
        Op::Version => Ok(vec![format!(
            "amos-appstore-cli {}",
            env!("CARGO_PKG_VERSION")
        )]),
        op => {
            let path = store_path(args);
            #[cfg(feature = "live")]
            if let Some(repo) = repo_url(args) {
                return run_with_repo(repo, index_pin(args), path, op).await;
            }
            #[cfg(not(feature = "live"))]
            if repo_url(args).is_some() {
                return Err(anyhow!(
                    "--repo needs a live build: compile with `cargo run -p amos-appstore-cli --features live`"
                ));
            }
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
    use amos_appstore::FdroidRepoProvider;

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn parse_known_subcommands() {
        assert!(matches!(parse_args(&s(&[])).unwrap(), Op::Help));
        assert!(matches!(parse_args(&s(&["help"])).unwrap(), Op::Help));
        // `-V/--version` is global: it needs no subcommand (a released artifact must
        // be able to say what it is), and wins even next to one.
        assert!(matches!(
            parse_args(&s(&["--version"])).unwrap(),
            Op::Version
        ));
        assert!(matches!(parse_args(&s(&["-V"])).unwrap(), Op::Version));
        assert!(matches!(
            parse_args(&s(&["catalog", "--version"])).unwrap(),
            Op::Version
        ));
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
    fn a_value_flag_without_a_value_is_rejected_not_silently_dropped() {
        // The dangerous shape: a dangling `--pin` used to be *dropped*, so the
        // index was fetched with no pin at all — the opposite of the request.
        let err = parse_args(&s(&["--repo", "https://r", "--pin"])).unwrap_err();
        assert!(err.to_string().contains("--pin"), "{err}");
        // A dangling `--store` silently forfeited persistence the same way.
        let err = parse_args(&s(&["--store"])).unwrap_err();
        assert!(err.to_string().contains("--store"), "{err}");
        // An explicitly empty value is a mistake too, not "no pin".
        assert!(
            parse_args(&s(&["--pin", ""])).is_err(),
            "empty value must be rejected"
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
    async fn version_prints_the_package_version() {
        // The printed line is what a deployed artifact is identified by — pin it
        // (scripts/release-artifacts.sh checks it on every staged binary too).
        let lines = run(&s(&["--version"])).await.unwrap();
        assert_eq!(
            lines,
            vec![format!("amos-appstore-cli {}", env!("CARGO_PKG_VERSION"))]
        );
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

    #[test]
    fn parse_download_takes_id_and_out() {
        match parse_args(&s(&["download", "org.x", "--out", "/tmp/a.apk"])).unwrap() {
            Op::Download { id, out } => {
                assert_eq!(id, "org.x");
                assert_eq!(out.to_string_lossy(), "/tmp/a.apk");
            }
            other => panic!("{other:?}"),
        }
        // --out is required (a download without a destination is a mistake).
        assert!(parse_args(&s(&["download", "org.x"])).is_err());
        // --repo/--out/--pin are options, never subcommands.
        assert!(matches!(
            parse_args(&s(&["--repo", "https://x/repo", "catalog"])).unwrap(),
            Op::Catalog
        ));
    }

    #[test]
    fn parse_info_and_export() {
        match parse_args(&s(&["info", "org.x"])).unwrap() {
            Op::Info { id } => assert_eq!(id, "org.x"),
            other => panic!("{other:?}"),
        }
        match parse_args(&s(&[
            "export",
            "/tmp/idx.json",
            "--repo-address",
            "https://mirror.example/repo",
        ]))
        .unwrap()
        {
            Op::Export { out, repo_address } => {
                assert_eq!(out.to_string_lossy(), "/tmp/idx.json");
                assert_eq!(repo_address.as_deref(), Some("https://mirror.example/repo"));
            }
            other => panic!("{other:?}"),
        }
        // The flag may trail the subcommand — parse_args must skip it either way.
        assert!(matches!(
            parse_args(&s(&["export", "/tmp/idx.json"])).unwrap(),
            Op::Export {
                repo_address: None,
                ..
            }
        ));
        assert!(parse_args(&s(&["export"])).is_err(), "file required");
        assert!(
            parse_args(&s(&["export", "a", "b"])).is_err(),
            "one file only"
        );
        assert!(parse_args(&s(&["info"])).is_err());
        assert!(parse_args(&s(&["info", "a", "b"])).is_err());
    }

    #[tokio::test]
    async fn dispatch_info_shows_detail_and_export_writes_a_real_fdroid_index() {
        let store = AppStore::new(demo_provider());
        let seed = store.catalog().await.unwrap();
        let id = seed[0].id.clone();

        // info: the one-line catalog row plus the detail block.
        let lines = dispatch(&store, Op::Info { id: id.clone() }).await.unwrap();
        assert!(lines.len() > 3, "detail block present: {lines:?}");
        assert!(lines.iter().any(|l| l.contains("version:")));
        assert!(lines.iter().any(|l| l.contains("package:")));
        assert!(lines.iter().any(|l| l.contains("status:")));
        assert!(dispatch(
            &store,
            Op::Info {
                id: "no.such.app".into()
            }
        )
        .await
        .unwrap()[0]
            .contains("not found"));

        // export: the written document is a genuine F-Droid index-v1 that our
        // own provider parses back, app-for-app.
        let dir = std::env::temp_dir().join(format!("amos-cli-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("index-v1.json");
        let lines = dispatch(
            &store,
            Op::Export {
                out: out.clone(),
                repo_address: Some("https://mirror.example/repo".into()),
            },
        )
        .await
        .unwrap();
        assert!(
            lines[0].contains(&format!("{} app(s)", seed.len())),
            "{lines:?}"
        );

        let parsed = FdroidRepoProvider::from_index_bytes(
            &std::fs::read(&out).unwrap(),
            "https://elsewhere/",
        )
        .unwrap();
        assert_eq!(parsed.base_url(), "https://mirror.example/repo");
        let back = parsed.catalog().await.unwrap();
        // Only APK packages map back; the demo catalog is all tar.gz web
        // bundles, so every row is honestly visible but none is installable.
        assert_eq!(
            back.len(),
            0,
            "web-bundle apps carry no package row: {back:?}"
        );
        let doc: amos_appstore::FdroidIndexV1 =
            serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
        assert_eq!(doc.apps.len(), seed.len());
        assert_eq!(doc.repo.address, "https://mirror.example/repo");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "live")]
    #[tokio::test]
    async fn run_downloads_an_apk_from_an_fdroid_repo() {
        use amos_appstore::Checksum;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");

        let h2 = Checksum::sha256_hex(b"apk one v2");
        let index_json = format!(
            r#"{{"repo": {{"address": "{base}"}},
                "apps": [{{"packageName": "org.example.one", "name": "One", "summary": "s",
                          "categories": ["Games"], "suggestedVersionCode": 2}}],
                "packages": [
                  {{"packageName": "org.example.one", "versionName": "2.0", "versionCode": 2,
                    "apkName": "org.example.one_2.apk", "hash": "{h2}", "hashType": "sha256", "size": 10}}
                ]}}"#
        );

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
                let body: Vec<u8> = if path.contains("/index-v1.json") {
                    index_json.clone().into_bytes()
                } else {
                    b"apk one v2".to_vec()
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

        let out_path = std::env::temp_dir().join(format!(
            "amos-cli-fdroid-{}-{}.apk",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let out_s = out_path.to_string_lossy().to_string();

        let out = run(&s(&[
            "--repo",
            &base,
            "download",
            "org.example.one",
            "--out",
            &out_s,
        ]))
        .await
        .unwrap();
        assert!(
            out[0].contains("downloaded org.example.one v2.0.0")
                && out[0].contains("sha256 verified"),
            "{out:?}"
        );
        let bytes = std::fs::read(&out_path).unwrap();
        assert_eq!(bytes, b"apk one v2", "verified bytes land on disk");

        server.await.unwrap();
        let _ = std::fs::remove_file(&out_path);
    }

    #[test]
    fn write_atomic_replaces_content_and_leaves_no_temp_files() {
        let dir = std::env::temp_dir().join(format!("amos-cli-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("index-v1.json");

        write_atomic(&target, b"first").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");

        // A second write replaces the content (rename over the old file).
        write_atomic(&target, b"second").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second");

        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp."))
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic write must clean up its temp file, found {leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
