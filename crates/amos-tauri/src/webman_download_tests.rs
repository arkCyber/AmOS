//! Tests for [`crate::webman_download`].
//!
//! The download pipeline's whole point is that **bytes really move**, so these
//! tests do not stub the network: each one binds a real `TcpListener` on
//! loopback, speaks minimal HTTP/1.1 to it, and asserts on the file that lands
//! on disk. A test that mocked the socket would reproduce the exact defect this
//! module was written to fix (a download panel that reported progress while
//! moving nothing).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use amos_media::{MediaError, MediaItem};

use super::*;

// ─── a real loopback HTTP server ──────────────────────────────────────────

/// Spawn a server that answers exactly `count` requests. The handler receives
/// the request index and the raw request head, and returns the raw response
/// bytes. The join handle yields every request head it saw, so a test can assert
/// on the headers the client actually sent (the cookie replay test needs this).
fn spawn_server<F>(count: usize, handler: F) -> (String, thread::JoinHandle<Vec<String>>)
where
    F: Fn(usize, &str) -> Vec<u8> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let handle = thread::spawn(move || {
        let mut seen = Vec::new();
        for i in 0..count {
            let (mut sock, _) = listener.accept().expect("accept");
            sock.set_read_timeout(Some(Duration::from_secs(5))).ok();
            let head = read_head(&mut sock);
            let resp = handler(i, &head);
            // A cancelled transfer closes the socket early; writing then fails
            // with a broken pipe, which is expected and not a test failure.
            let _ = sock.write_all(&resp);
            let _ = sock.flush();
            seen.push(head);
        }
        seen
    });
    (format!("http://{addr}"), handle)
}

/// Read up to the end of the request head (`\r\n\r\n`).
fn read_head(sock: &mut std::net::TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match sock.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// A 200 response with an exact `Content-Length` and optional extra headers.
fn http_ok(body: &[u8], extra: &[(&str, &str)]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    )
    .into_bytes();
    for (k, v) in extra {
        out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
    }
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(body);
    out
}

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn no_cancel() -> AtomicBool {
    AtomicBool::new(false)
}

// ─── the transfer itself ──────────────────────────────────────────────────

#[test]
fn downloads_real_bytes_to_disk() {
    let body = b"real bytes, not a ledger entry".to_vec();
    let expected = body.clone();
    let (base, server) = spawn_server(1, move |_, _| http_ok(&body, &[]));

    let dir = tmp();
    let dest = dir.path().join("payload.bin");
    let agent = ureq::builder().build();
    let mut totals = Vec::new();
    let end = download_to_file(
        &agent,
        &format!("{base}/payload.bin"),
        &dest,
        &no_cancel(),
        &mut |_, total| {
            totals.push(total);
        },
    )
    .expect("download");

    assert_eq!(end, JobEnd::Completed(expected.len() as u64));
    assert_eq!(std::fs::read(&dest).expect("read back"), expected);
    assert_eq!(
        totals.last().copied().flatten(),
        Some(expected.len() as u64),
        "content length must be reported"
    );
    server.join().expect("server");
}

#[test]
fn cancel_mid_stream_stops_and_reports_canceled() {
    // A body large enough to span several CHUNK_BYTES reads.
    let body = vec![0xABu8; CHUNK_BYTES * 4];
    let total_len = body.len() as u64;
    let (base, server) = spawn_server(1, move |_, _| http_ok(&body, &[]));

    let dir = tmp();
    let dest = dir.path().join("big.bin");
    let agent = ureq::builder().build();
    let cancel = AtomicBool::new(false);
    let mut wrote = 0u64;
    let end = download_to_file(
        &agent,
        &format!("{base}/big.bin"),
        &dest,
        &cancel,
        &mut |received, _| {
            wrote = received;
            // Cancel once the first chunk has landed.
            cancel.store(true, Ordering::Relaxed);
        },
    )
    .expect("download");

    assert_eq!(end, JobEnd::Canceled);
    assert!(
        wrote > 0 && wrote < total_len,
        "stopped mid-stream: {wrote}"
    );
    server.join().expect("server");
}

#[test]
fn a_non_2xx_status_is_a_named_failure() {
    let (base, server) = spawn_server(1, |_, _| {
        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
    });
    let dir = tmp();
    let dest = dir.path().join("missing.bin");
    let agent = ureq::builder().build();
    let err = download_to_file(
        &agent,
        &format!("{base}/missing.bin"),
        &dest,
        &no_cancel(),
        &mut |_, _| {},
    )
    .expect_err("404 must fail");
    assert_eq!(err.code, ErrorCode::WebmanDownloadFailed);
    assert!(
        err.message.contains("404"),
        "message names the status: {}",
        err.message
    );
    server.join().expect("server");
}

// ─── the cookie jar ───────────────────────────────────────────────────────

#[test]
fn a_set_cookie_is_replayed_on_the_next_request() {
    let (base, server) = spawn_server(2, |i, _| {
        if i == 0 {
            http_ok(b"first", &[("Set-Cookie", "sid=abc123; Path=/")])
        } else {
            http_ok(b"second", &[])
        }
    });

    let dir = tmp();
    let agent = ureq::builder().build();
    let cancel = no_cancel();
    download_to_file(
        &agent,
        &format!("{base}/a"),
        &dir.path().join("a"),
        &cancel,
        &mut |_, _| {},
    )
    .expect("first");
    download_to_file(
        &agent,
        &format!("{base}/b"),
        &dir.path().join("b"),
        &cancel,
        &mut |_, _| {},
    )
    .expect("second");

    let seen = server.join().expect("server");
    assert!(
        !seen[0].to_ascii_lowercase().contains("cookie:"),
        "first request must not carry a cookie it has never been given"
    );
    assert!(
        seen[1].contains("sid=abc123"),
        "second request must replay the cookie; saw:\n{}",
        seen[1]
    );
}

#[test]
fn persistent_cookies_survive_a_manager_restart() {
    let profile = tmp();
    let downloads = tmp();
    // `Max-Age` makes this a *persistent* cookie — the kind a browser writes to
    // disk. (A session cookie is deliberately not persisted; see the next test.)
    let (base, server) = spawn_server(1, |_, _| {
        http_ok(b"x", &[("Set-Cookie", "keep=me; Path=/; Max-Age=3600")])
    });

    let manager =
        WebmanDownloads::with_dirs(downloads.path().to_path_buf(), profile.path().to_path_buf());
    let agent = manager.agent();
    download_to_file(
        &agent,
        &format!("{base}/x"),
        &downloads.path().join("x"),
        &no_cancel(),
        &mut |_, _| {},
    )
    .expect("download");
    manager.absorb_cookies(&agent);
    assert_eq!(
        manager
            .list_cookies()
            .iter()
            .filter(|c| c.name == "keep")
            .count(),
        1
    );

    // A fresh manager over the same profile must see the persisted cookie —
    // this is the file on disk, not shared memory.
    let reopened =
        WebmanDownloads::with_dirs(downloads.path().to_path_buf(), profile.path().to_path_buf());
    assert!(
        reopened.list_cookies().iter().any(|c| c.name == "keep"),
        "a persistent cookie must survive a restart via cookies.json"
    );

    assert_eq!(reopened.clear_cookies(), 1);
    assert!(reopened.list_cookies().is_empty());
    server.join().expect("server");
}

#[test]
fn session_cookies_live_in_memory_but_are_not_written_to_disk() {
    let profile = tmp();
    let downloads = tmp();
    let (base, server) = spawn_server(1, |_, _| http_ok(b"x", &[("Set-Cookie", "sess=1; Path=/")]));

    let manager =
        WebmanDownloads::with_dirs(downloads.path().to_path_buf(), profile.path().to_path_buf());
    let agent = manager.agent();
    download_to_file(
        &agent,
        &format!("{base}/x"),
        &downloads.path().join("x"),
        &no_cancel(),
        &mut |_, _| {},
    )
    .expect("download");
    manager.absorb_cookies(&agent);
    assert!(
        manager.list_cookies().iter().any(|c| c.name == "sess"),
        "the session cookie is live for this session"
    );

    let reopened =
        WebmanDownloads::with_dirs(downloads.path().to_path_buf(), profile.path().to_path_buf());
    assert!(
        !reopened.list_cookies().iter().any(|c| c.name == "sess"),
        "a session cookie must not be resurrected after a restart (browser semantics)"
    );
    server.join().expect("server");
}

// ─── the persisted jar's read side (REQ-A1962 / F-WM-030) ─────────────────

/// Any `cookies.corrupt-*` sibling under `dir` (the jar we moved aside).
fn kept_jars(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .expect("read profile dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("cookies.corrupt-"))
        })
        .collect()
}

/// A jar that is **present but unreadable** must be moved aside before the manager
/// starts empty, because [`WebmanDownloads::save_cookies`] rewrites that exact path
/// on the next capture — an in-place "start empty" would let one save destroy the
/// user's only copy of their cookies.
///
/// Red before the fix: `with_dirs` logged and started empty while leaving the
/// damaged bytes at `cookies.json`, so the next save overwrote them silently.
#[test]
fn an_unreadable_cookie_jar_is_preserved_not_silently_overwritten() {
    let profile = tmp();
    let downloads = tmp();
    let jar = profile.path().join(COOKIES_FILE);
    let damaged: &[u8] = b"{ this is not a cookie jar";
    std::fs::write(&jar, damaged).expect("write damaged jar");

    let manager =
        WebmanDownloads::with_dirs(downloads.path().to_path_buf(), profile.path().to_path_buf());
    assert!(
        manager.list_cookies().is_empty(),
        "an unreadable jar starts empty"
    );

    let kept = kept_jars(profile.path());
    assert_eq!(
        kept.len(),
        1,
        "the unreadable jar must be moved aside, not left to be overwritten"
    );
    assert_eq!(
        std::fs::read(&kept[0]).expect("read kept jar"),
        damaged,
        "the preserved jar keeps the original bytes"
    );

    // A later capture rewrites the configured path; the preserved copy must survive.
    manager.save_cookies();
    assert_eq!(
        std::fs::read(&kept[0]).expect("kept jar still there"),
        damaged,
        "the preserved jar must survive the next successful save"
    );
    assert!(
        jar.exists(),
        "the fresh jar lands back at the configured path"
    );
}

/// The other direction of the same rule: a jar that parses loads **in place** and
/// nothing is moved aside (preservation must not fire on a healthy file).
#[test]
fn a_readable_cookie_jar_is_loaded_without_being_moved_aside() {
    let profile = tmp();
    let downloads = tmp();
    let (base, server) = spawn_server(1, |_, _| {
        http_ok(b"x", &[("Set-Cookie", "keep=me; Path=/; Max-Age=3600")])
    });
    let manager =
        WebmanDownloads::with_dirs(downloads.path().to_path_buf(), profile.path().to_path_buf());
    let agent = manager.agent();
    download_to_file(
        &agent,
        &format!("{base}/x"),
        &downloads.path().join("x"),
        &no_cancel(),
        &mut |_, _| {},
    )
    .expect("download");
    manager.absorb_cookies(&agent);
    server.join().expect("server");

    let reopened =
        WebmanDownloads::with_dirs(downloads.path().to_path_buf(), profile.path().to_path_buf());
    assert!(
        reopened.list_cookies().iter().any(|c| c.name == "keep"),
        "a readable jar is loaded in place"
    );
    assert!(
        kept_jars(profile.path()).is_empty(),
        "a readable jar must not be moved aside"
    );
}

/// A **missing** jar is the ordinary first-run case: start empty, move nothing.
#[test]
fn a_missing_cookie_jar_starts_empty_and_moves_nothing() {
    let profile = tmp();
    let downloads = tmp();
    let manager =
        WebmanDownloads::with_dirs(downloads.path().to_path_buf(), profile.path().to_path_buf());
    assert!(manager.list_cookies().is_empty());
    assert!(!profile.path().join(COOKIES_FILE).exists());
    assert!(
        kept_jars(profile.path()).is_empty(),
        "a first run leaves no corrupt-* sibling"
    );
}

// ─── pure helpers ─────────────────────────────────────────────────────────

#[test]
fn validate_url_accepts_http_and_https_only() {
    assert!(validate_url("http://example.com/a").is_ok());
    assert!(validate_url("https://example.com/a?b=1").is_ok());
    assert_eq!(
        validate_url("").unwrap_err().code,
        ErrorCode::WebmanUrlInvalid
    );
    assert_eq!(
        validate_url("file:///etc/passwd").unwrap_err().code,
        ErrorCode::WebmanUrlInvalid
    );
    assert_eq!(
        validate_url("javascript:alert(1)").unwrap_err().code,
        ErrorCode::WebmanUrlInvalid
    );
    assert_eq!(
        validate_url("http://").unwrap_err().code,
        ErrorCode::WebmanUrlInvalid
    );
    let long = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
    assert_eq!(
        validate_url(&long).unwrap_err().code,
        ErrorCode::WebmanUrlInvalid
    );
}

#[test]
fn filename_from_url_takes_the_decoded_last_segment() {
    assert_eq!(
        filename_from_url("https://example.com/a/b%20c.pdf?x=1#frag"),
        "b c.pdf"
    );
    assert_eq!(filename_from_url("https://example.com/dir/"), "download");
    assert_eq!(filename_from_url("https://example.com"), "download");
    assert_eq!(
        filename_from_url("https://example.com/report.tar.gz"),
        "report.tar.gz"
    );
}

#[test]
fn sanitize_filename_refuses_traversal_and_separators() {
    assert_eq!(sanitize_filename("a/b\\c.txt"), "a_b_c.txt");
    assert_eq!(sanitize_filename(".."), "download");
    assert_eq!(sanitize_filename("   "), "download");
    assert_eq!(sanitize_filename("ok\u{0}name.txt"), "okname.txt");
    let long = "x".repeat(MAX_FILENAME_BYTES * 2);
    assert_eq!(sanitize_filename(&long).len(), MAX_FILENAME_BYTES);
}

#[test]
fn reserve_path_never_clobbers_an_existing_file() {
    let dir = tmp();
    let profile = tmp();
    let manager =
        WebmanDownloads::with_dirs(dir.path().to_path_buf(), profile.path().to_path_buf());
    std::fs::write(dir.path().join("report.pdf"), b"one").expect("seed");
    let (_id, chosen, _flag) = manager.begin(None, "report.pdf");
    assert_eq!(
        chosen.file_name().and_then(|s| s.to_str()),
        Some("report (1).pdf")
    );
}

// ─── destination reservation (concurrency) ────────────────────────────────

/// The name check and the name claim must be one step: two starts that run
/// concurrently used to both see `report.pdf` absent, both answer `report.pdf`,
/// and both write `report.pdf.part` — one file, two `Completed` events.
#[test]
fn reserving_a_name_twice_never_answers_the_same_path() {
    let dir = tmp();
    let manager = WebmanDownloads::with_dirs(dir.path().to_path_buf(), tmp().path().to_path_buf());

    let (_id, first, _flag) = manager.begin(None, "report.pdf");
    let (_id, second, _flag) = manager.begin(None, "report.pdf");

    assert_eq!(
        first.file_name().and_then(|s| s.to_str()),
        Some("report.pdf")
    );
    assert_eq!(
        second.file_name().and_then(|s| s.to_str()),
        Some("report (1).pdf"),
        "an in-flight destination is not offered twice"
    );
    assert_ne!(first, second);
}

#[test]
fn concurrent_reservers_each_get_their_own_path() {
    let dir = tmp();
    let manager = std::sync::Arc::new(WebmanDownloads::with_dirs(
        dir.path().to_path_buf(),
        tmp().path().to_path_buf(),
    ));

    let threads: Vec<_> = (0..8)
        .map(|_| {
            let manager = std::sync::Arc::clone(&manager);
            thread::spawn(move || manager.begin(None, "same.bin").1)
        })
        .collect();
    let mut paths: Vec<PathBuf> = threads
        .into_iter()
        .map(|t| t.join().expect("reserve thread"))
        .collect();

    paths.sort();
    paths.dedup();
    assert_eq!(
        paths.len(),
        8,
        "eight concurrent reservations of one name must be eight distinct paths"
    );
}

/// A leaked reservation would push every later download of that name to `(1)`
/// forever, so the worker must always hand the name back.
#[test]
fn a_released_name_is_offered_again() {
    let dir = tmp();
    let manager = WebmanDownloads::with_dirs(dir.path().to_path_buf(), tmp().path().to_path_buf());

    let (_id, held, _flag) = manager.begin(None, "note.txt");
    manager.release_path(&held);
    let (_id, again, _flag) = manager.begin(None, "note.txt");
    assert_eq!(
        again, held,
        "after the transfer ends the plain name is free again"
    );
}

/// The RAII guard is what makes the release unconditional — including on the
/// panic path a `run_job` bug would take.
#[test]
fn the_reservation_guard_releases_on_unwind() {
    let dir = tmp();
    let profile = tmp();
    let manager =
        WebmanDownloads::with_dirs(dir.path().to_path_buf(), profile.path().to_path_buf());
    let target = dir.path().join("guarded.bin");

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _reservation = PathReservation::new(&manager, target.clone());
        panic!("a worker bug");
    }));
    assert!(outcome.is_err(), "the panic must propagate");
    let (_id, again, _flag) = manager.begin(None, "guarded.bin");
    assert_eq!(
        again, target,
        "an unwound worker must not keep the name reserved"
    );
}

/// Both halves of a start are check-then-act, so one caller's id may not be
/// handed to another: the loser of the race gets a minted id rather than a
/// second handle onto the winner's cancel flag.
#[test]
fn begin_never_hands_one_id_to_two_transfers() {
    let dir = tmp();
    let manager = WebmanDownloads::with_dirs(dir.path().to_path_buf(), tmp().path().to_path_buf());

    let (first_id, first_path, first_flag) = manager.begin(Some("row-1"), "a.bin");
    let (second_id, second_path, second_flag) = manager.begin(Some("row-1"), "a.bin");

    assert_eq!(first_id, "row-1");
    assert_ne!(second_id, "row-1", "a taken correlation id is not reused");
    assert_ne!(first_path, second_path, "and neither is the destination");
    assert!(
        !std::sync::Arc::ptr_eq(&first_flag, &second_flag),
        "each transfer owns its own cancel flag"
    );
}

// ─── the command path (mock host) ─────────────────────────────────────────

fn mock_handle(dir: PathBuf, profile: PathBuf) -> tauri::AppHandle<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .manage(WebmanDownloads::with_dirs(dir, profile))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app builds");
    app.handle().clone()
}

#[test]
fn command_rejects_a_non_http_url_before_touching_the_network() {
    let handle = mock_handle(tmp().path().to_path_buf(), tmp().path().to_path_buf());
    let err = tauri::async_runtime::block_on(webman_download_start(
        handle,
        "file:///etc/passwd".to_owned(),
        None,
        None,
    ))
    .expect_err("must refuse");
    assert_eq!(err.code, ErrorCode::WebmanUrlInvalid);
}

#[test]
fn command_streams_a_real_file_onto_disk() {
    let body = b"command-path bytes".to_vec();
    let expected = body.clone();
    let (base, server) = spawn_server(1, move |_, _| http_ok(&body, &[]));

    let dir = tmp();
    let handle = mock_handle(dir.path().to_path_buf(), tmp().path().to_path_buf());
    let started = tauri::async_runtime::block_on(webman_download_start(
        handle,
        format!("{base}/note.txt"),
        Some("note.txt".to_owned()),
        None,
    ))
    .expect("start");
    assert_eq!(started.filename, "note.txt");

    // The transfer runs on a worker; wait for the file to materialize.
    let path = PathBuf::from(&started.location);
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(std::fs::read(&path).expect("file landed"), expected);
    server.join().expect("server");
}

#[test]
fn two_downloads_of_one_name_land_in_two_files() {
    let body = b"same name, two files".to_vec();
    let expected = body.clone();
    let (base, server) = spawn_server(2, move |_, _| http_ok(&body, &[]));

    let dir = tmp();
    let handle = mock_handle(dir.path().to_path_buf(), tmp().path().to_path_buf());
    let first = tauri::async_runtime::block_on(webman_download_start(
        handle.clone(),
        format!("{base}/x.bin"),
        Some("x.bin".to_owned()),
        None,
    ))
    .expect("first start");
    let second = tauri::async_runtime::block_on(webman_download_start(
        handle,
        format!("{base}/x.bin"),
        Some("x.bin".to_owned()),
        None,
    ))
    .expect("second start");

    assert_ne!(
        first.location, second.location,
        "two live downloads must not share one destination"
    );

    for started in [&first, &second] {
        let path = PathBuf::from(&started.location);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            std::fs::read(&path).expect("file landed"),
            expected,
            "{} must hold a complete body",
            started.location
        );
    }
    assert!(
        !dir.path().join("x.bin.part").exists() && !dir.path().join("x (1).bin.part").exists(),
        "a finished transfer leaves no .part behind"
    );
    server.join().expect("server");
}

#[test]
fn cookie_commands_read_and_clear_through_the_host() {
    let profile = tmp();
    let downloads = tmp();
    let (base, server) = spawn_server(1, |_, _| http_ok(b"x", &[("Set-Cookie", "tmp=1; Path=/")]));

    let handle = mock_handle(downloads.path().to_path_buf(), profile.path().to_path_buf());
    let state = handle.state::<WebmanDownloads>();
    let agent = state.agent();
    download_to_file(
        &agent,
        &format!("{base}/x"),
        &downloads.path().join("x"),
        &no_cancel(),
        &mut |_, _| {},
    )
    .expect("download");
    state.absorb_cookies(&agent);

    let listed = webman_cookies_list(handle.clone());
    assert!(listed.iter().any(|c| c.name == "tmp"));
    assert_eq!(webman_cookies_clear(handle.clone()), 1);
    assert!(webman_cookies_list(handle).is_empty());
    server.join().expect("server");
}

#[test]
fn cancel_of_an_unknown_id_is_false_not_a_panic() {
    let handle = mock_handle(tmp().path().to_path_buf(), tmp().path().to_path_buf());
    assert!(!webman_download_cancel(handle, "no-such-id".to_owned()));
}

#[test]
fn a_caller_supplied_id_is_used_verbatim_and_a_blank_one_is_minted() {
    let body = b"id test".to_vec();
    let expected = body.clone();
    let (base, server) = spawn_server(2, move |_, _| http_ok(&body, &[]));

    let dir = tmp();
    let handle = mock_handle(dir.path().to_path_buf(), tmp().path().to_path_buf());
    let started = tauri::async_runtime::block_on(webman_download_start(
        handle.clone(),
        format!("{base}/x.txt"),
        None,
        Some("row-42".to_owned()),
    ))
    .expect("start");
    assert_eq!(
        started.id, "row-42",
        "the UI's row id must be the correlation id"
    );

    let path = PathBuf::from(&started.location);
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(std::fs::read(&path).expect("file landed"), expected);

    // A blank id is not trusted; the host mints one so the UI can still match.
    let minted = tauri::async_runtime::block_on(webman_download_start(
        handle,
        format!("{base}/y.txt"),
        None,
        Some(String::new()),
    ))
    .expect("blank id is replaced, not rejected");
    assert!(!minted.id.is_empty());
    server.join().expect("server");
}

// ─── the destination seam: DirSink vs MediaStoreSink ──────────────────────

/// A provider that behaves like Android's MediaStore on a name collision: it
/// **adopts the bytes via `save_from_path`** (never `save`) and answers with a
/// display name of its own. It records the source path it was handed, so a test
/// can prove the payload crossed the seam as a path rather than as base64.
struct RenamingProvider {
    seen_src: Mutex<Vec<PathBuf>>,
}

impl RenamingProvider {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            seen_src: Mutex::new(Vec::new()),
        })
    }

    fn sources(&self) -> Vec<PathBuf> {
        self.seen_src.lock().expect("lock").clone()
    }
}

impl MediaProvider for RenamingProvider {
    fn name(&self) -> &'static str {
        "renaming"
    }

    fn available_collections(&self) -> Vec<StandardDir> {
        vec![StandardDir::Download]
    }

    fn list(&self, _dir: StandardDir) -> std::result::Result<Vec<MediaItem>, MediaError> {
        Ok(Vec::new())
    }

    fn save(
        &self,
        _dir: StandardDir,
        _kind: MediaKind,
        _name: &str,
        _data: &[u8],
    ) -> std::result::Result<MediaItem, MediaError> {
        // The whole point of the sink is that a multi-gigabyte download never
        // becomes one in-memory buffer; materialising here would be that defect.
        panic!("MediaStoreSink must stream through save_from_path, never call save");
    }

    fn save_from_path(
        &self,
        dir: StandardDir,
        kind: MediaKind,
        name: &str,
        src: &Path,
    ) -> std::result::Result<MediaItem, MediaError> {
        self.seen_src.lock().expect("lock").push(src.to_path_buf());
        let adopted = format!("{name} (1)");
        let uri = "content://media/external/downloads/7".to_string();
        MediaItem::new(uri.clone(), kind, dir, adopted, uri, 1_700_000_000_000)
            .map_err(MediaError::Provider)
    }

    fn load(&self, _item: &MediaItem) -> std::result::Result<Vec<u8>, MediaError> {
        Err(MediaError::Provider("not used by these tests".to_string()))
    }
}

fn mock_handle_with_sink(
    dir: PathBuf,
    profile: PathBuf,
    sink: Arc<dyn DownloadSink>,
) -> tauri::AppHandle<tauri::test::MockRuntime> {
    let handle = mock_handle(dir, profile);
    handle.state::<WebmanDownloads>().configure(sink);
    handle
}

#[test]
fn download_dir_for_takes_the_platform_facts_it_is_given() {
    let temp = PathBuf::from("/tmp");

    // Android: no browsable Downloads dir exists, so the answer is app-private
    // staging the MediaStore sink hands over — never the dirs/home fallbacks,
    // which are `None` on a real device anyway.
    assert_eq!(
        download_dir_for(
            true,
            None,
            Some(PathBuf::from("/home/u/Downloads")),
            Some(PathBuf::from("/home/u")),
            temp.clone()
        ),
        PathBuf::from("/tmp/amos-downloads"),
        "Android must not fall through to a host-style Downloads directory"
    );

    // Desktop: the platform's real Downloads dir wins over the home join.
    assert_eq!(
        download_dir_for(
            false,
            None,
            Some(PathBuf::from("/home/u/Downloads")),
            Some(PathBuf::from("/home/u")),
            temp.clone()
        ),
        PathBuf::from("/home/u/Downloads")
    );

    // No `dirs` answer, but a home: the conventional join.
    assert_eq!(
        download_dir_for(
            false,
            None,
            None,
            Some(PathBuf::from("/home/u")),
            temp.clone()
        ),
        PathBuf::from("/home/u/Downloads")
    );

    // Nothing at all: the temp fallback, on either platform.
    assert_eq!(
        download_dir_for(false, None, None, None, temp.clone()),
        PathBuf::from("/tmp/amos-downloads")
    );

    // The explicit override beats every other fact — including Android — so a
    // host/test can pin a location deterministically.
    assert_eq!(
        download_dir_for(true, Some("/pinned".to_string()), None, None, temp.clone()),
        PathBuf::from("/pinned")
    );
    assert_eq!(
        download_dir_for(false, Some("   ".to_string()), None, None, temp.clone()),
        PathBuf::from("/tmp/amos-downloads"),
        "a blank override is not a location"
    );
}

#[test]
fn a_media_store_sink_stages_per_transfer_so_two_same_names_do_not_collide() {
    let sink = MediaStoreSink::new(RenamingProvider::new(), PathBuf::from("/staging"));
    assert_eq!(
        sink.staging_dir(Path::new("/ignored")),
        PathBuf::from("/staging")
    );
    assert_eq!(sink.staging_name("id-1", "report.pdf"), "id-1-report.pdf");
    assert_ne!(
        sink.staging_name("id-1", "report.pdf"),
        sink.staging_name("id-2", "report.pdf"),
        "two concurrent transfers of one name must not share one scratch file"
    );
}

#[test]
fn a_media_store_sink_hands_over_the_path_and_reports_the_adopted_name() {
    let provider = RenamingProvider::new();
    let sink = MediaStoreSink::new(provider.clone(), PathBuf::from("/staging"));
    let staged = PathBuf::from("/staging/id-1-report.pdf.part");
    let dest = PathBuf::from("/staging/id-1-report.pdf");

    let placed = sink
        .place(&dest, &staged, "report.pdf")
        .expect("the provider accepts the file");

    // The location is the provider's URI, not a filesystem path — on Android
    // there is no path a user could open.
    assert_eq!(placed.location, "content://media/external/downloads/7");
    // And the name is the one the *device* adopted. Reporting `report.pdf` here
    // would show the user a name the Downloads collection does not contain.
    assert_eq!(placed.filename, "report.pdf (1)");
    // The payload crossed as a path (so the provider could stream it), never as
    // a materialised buffer.
    assert_eq!(provider.sources(), vec![staged]);
}

/// The desktop sink must report the adopted name too.
///
/// `DirSink` used to answer `None` = "the name you asked for is the name it has",
/// but `pick_path` avoids clobbering by appending ` (1)` — so on a collision the
/// name the *file* has is not the name we proposed, and the UI (which now reads
/// `DownloadProgressEvent::filename`) would name a file that is not there. Both
/// sinks rename; both must say so.
#[test]
fn a_dir_sink_reports_the_name_the_file_actually_has_on_a_collision() {
    let dir = tmp();
    let taken = HashSet::new();
    // Something already sits at `report.pdf`, so `pick_path` steps aside.
    std::fs::write(dir.path().join("report.pdf"), b"already here").expect("seed the collision");

    let dest = pick_path(dir.path(), "report.pdf", &taken);
    assert_eq!(
        dest.file_name().and_then(|n| n.to_str()),
        Some("report (1).pdf"),
        "pick_path is the thing that renames; the sink must not claim otherwise"
    );

    let staged = dir.path().join("staged.part");
    std::fs::write(&staged, b"fresh bytes").expect("stage the transfer");
    let placed = DirSink
        .place(&dest, &staged, "report.pdf")
        .expect("rename into the free slot");

    assert_eq!(placed.location, dest.to_string_lossy());
    assert_eq!(placed.filename, "report (1).pdf");
    // And that is the name on disk — the seed is untouched, the transfer is beside it.
    assert_eq!(
        std::fs::read(&dest).expect("the transfer landed"),
        b"fresh bytes"
    );
    assert_eq!(
        std::fs::read(dir.path().join("report.pdf")).expect("the seed survives"),
        b"already here"
    );
}

#[test]
fn a_media_store_download_lands_in_the_provider_and_leaves_no_scratch_behind() {
    let body = b"android download payload".to_vec();
    let (base, server) = spawn_server(1, move |_, _| http_ok(&body, &[]));

    let staging = tmp();
    let provider = RenamingProvider::new();
    let sink = Arc::new(MediaStoreSink::new(
        provider.clone(),
        staging.path().to_path_buf(),
    ));
    let handle =
        mock_handle_with_sink(tmp().path().to_path_buf(), tmp().path().to_path_buf(), sink);

    let started = tauri::async_runtime::block_on(webman_download_start(
        handle,
        format!("{base}/report.pdf"),
        Some("report.pdf".to_owned()),
        None,
    ))
    .expect("start");

    // Before the hand-over the transfer is *staged* app-privately: the reported
    // location is inside the staging directory, not a user-visible folder.
    assert!(
        Path::new(&started.location).starts_with(staging.path()),
        "a MediaStore download must stage, not write straight into a visible path: {}",
        started.location
    );

    let deadline = Instant::now() + Duration::from_secs(10);
    while provider.sources().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    let sources = provider.sources();
    assert_eq!(sources.len(), 1, "the file is handed over exactly once");
    assert!(
        sources[0].starts_with(staging.path()),
        "the handed-over file must come from the staging dir: {}",
        sources[0].display()
    );

    // The scratch copy is gone once MediaStore owns the bytes — otherwise the
    // staging directory grows by a full copy of every download, across boots.
    let leftover: Vec<_> = std::fs::read_dir(staging.path())
        .expect("staging dir readable")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        leftover.is_empty(),
        "a completed hand-over must leave no scratch file behind, found {leftover:?}"
    );
    server.join().expect("server");
}
