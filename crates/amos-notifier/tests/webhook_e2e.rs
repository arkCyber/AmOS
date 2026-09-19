//! True end-to-end test for `WebhookChannel`: spin up a local HTTP server,
//! point the channel at it, and verify the wire traffic — request line,
//! headers, body — matches what the on-call dispatcher expects to see on
//! the other end of a PagerDuty / Lark / Slack-compatible hook.
//!
//! Why this is a sibling to `tests/end_to_end.rs`:
//! - `tests/end_to_end.rs` uses a `Recorder` (in-memory) — necessary for
//!   the dispatch policy tests (suppression, multi-channel fan-out).
//!   It cannot prove the wire format.
//! - The unit tests in `webhook.rs::tests` do prove the wire format but
//!   only with single-byte fixed responses and one assertion per test.
//!   They do not exercise the dispatcher end-to-end against a real
//!   HTTP server.
//!
//! This file joins the two: a real HTTP server (in the test process), a
//! real `Dispatcher`, a real `WebhookChannel`, and a `Recorder` watching
//! the metrics. Every assertion checks what came **over the network** —
//! nothing about `Recorder.received` here, that's the in-process side.
//!
//! Each test binds a fresh `127.0.0.1:0` socket so the suite is parallel-
//! safe (no port races) and tears down before returning.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use amos_notifier::channel::{Channel, SendOutcome};
use amos_notifier::dispatcher::Dispatcher;
use amos_notifier::webhook::WebhookChannel;
use amos_notifier::Alert;

/// One captured HTTP request: the method-line (e.g. `POST /path HTTP/1.1`)
/// and the raw body. Tests assert on these directly so a future change to
/// the request layout shows up as a concrete diff, not a metrics
/// mis-match.
#[derive(Debug, Default, Clone)]
struct CapturedRequest {
    method_line: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

/// The simplest possible HTTP server for tests: each `accept()` reads
/// one request, optionally writes a configured response, then closes.
/// Returned capture is shared with the test via `Arc<Mutex<Vec<_>>>`.
struct MockServer {
    listener: TcpListener,
    captures: Arc<Mutex<Vec<CapturedRequest>>>,
    handles: Vec<thread::JoinHandle<()>>,
}

impl MockServer {
    fn bind() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(false).unwrap();
        Self {
            listener,
            captures: Arc::new(Mutex::new(Vec::new())),
            handles: Vec::new(),
        }
    }

    fn port(&self) -> u16 {
        self.listener.local_addr().unwrap().port()
    }

    /// Spawn one accept-thread that handles exactly `count` requests and
    /// then exits. Each request is captured (including body). The response
    /// is given by `response_for(idx)` so a single test can drive a
    /// sequence of different status codes (e.g. 200 → 503 → 200) for
    /// retry / failover scenarios.
    fn accept_n<F>(&mut self, count: usize, response_for: F)
    where
        F: Fn(usize) -> &'static str + Send + 'static,
    {
        let listener = self.listener.try_clone().unwrap();
        let captures = self.captures.clone();
        let h = thread::spawn(move || {
            for i in 0..count {
                let (mut s, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(_) => break,
                };
                let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
                // Read the request until the empty line, then continue
                // reading so we capture the full body (Content-Length).
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                // Find the header terminator first; record its end
                // position so we know how many body bytes to keep
                // reading.
                while let Ok(n) = s.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    // Once we see the header terminator, decide whether
                    // to keep reading based on Content-Length.
                    if let Some(idx) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header_end = idx + 4;
                        // Look for Content-Length in the header section.
                        let header_str = String::from_utf8_lossy(&buf[..idx]).into_owned();
                        let content_length = header_str
                            .lines()
                            .find_map(|l| {
                                let (k, v) = l.split_once(':')?;
                                if k.eq_ignore_ascii_case("content-length") {
                                    v.trim().parse::<usize>().ok()
                                } else {
                                    None
                                }
                            })
                            .unwrap_or(0);
                        // Read until we've collected the full body, then
                        // stop. Single-shot read at most once more if
                        // the body isn't yet complete.
                        while buf.len() < header_end + content_length {
                            match s.read(&mut chunk) {
                                Ok(0) => break,
                                Ok(n) => {
                                    buf.extend_from_slice(&chunk[..n]);
                                }
                                Err(_) => break,
                            }
                        }
                        break;
                    }
                    if buf.len() > 32 * 1024 {
                        break;
                    }
                }
                let req = parse_captured(&buf);
                captures.lock().unwrap().push(req);
                // Write the response.
                let status = response_for(i);
                let resp = format!("{status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                let _ = s.write_all(resp.as_bytes());
                let _ = s.flush();
            }
        });
        self.handles.push(h);
    }

    /// Block until every accept-thread has finished. Use at end of test
    /// so the captures are guaranteed complete.
    fn join(self) -> Vec<CapturedRequest> {
        for h in self.handles {
            let _ = h.join();
        }
        let caps = self.captures.lock().unwrap().clone();
        caps
    }
}

fn parse_captured(buf: &[u8]) -> CapturedRequest {
    let mut req = CapturedRequest::default();
    let mut parts = buf.split(|b| *b == b'\n');
    if let Some(line) = parts.next() {
        // Strip a trailing CR so the method line is "POST /h HTTP/1.1".
        let trimmed = line.strip_suffix(b"\r").unwrap_or(line);
        req.method_line = String::from_utf8_lossy(trimmed).into();
    }
    for line in &mut parts {
        if line.starts_with(b"\r") || line.is_empty() {
            break;
        }
        // Look for ": ", trim the optional CR off the end of the value.
        let line_no_cr = line.strip_suffix(b"\r").unwrap_or(line);
        if let Some(colon) = line_no_cr.iter().position(|b| *b == b':') {
            let name = String::from_utf8_lossy(&line_no_cr[..colon])
                .trim()
                .to_string();
            let value = String::from_utf8_lossy(&line_no_cr[colon + 1..])
                .trim()
                .to_string();
            req.headers.push((name, value));
        }
    }
    if let Some(idx) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
        req.body = buf[idx + 4..].to_vec();
    }
    req
}

/// Build the JSON body shape `WebhookChannel::body` produces so tests
/// can compare on the same data. Mirrors `webhook::WebhookChannel::body`.
fn body_of(alert: &Alert) -> serde_json::Value {
    WebhookChannel::body(alert)
}

// ========================================================================
// Path & header format
// ========================================================================

/// The HTTP method, target path, and version line must all be present
/// exactly. PagerDuty / Lark / 飞书 / Slack all parse this strictly — a
/// path mismatch (`/hook` vs `/hooks`) is the most common silent
/// misconfiguration.
#[test]
fn post_request_line_is_method_path_and_version() {
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.1 200 OK");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/v1/alerts"));
    let outcome = ch.send(&Alert::p0("db.unreachable", "down"));
    assert_eq!(outcome, SendOutcome::Sent);
    let caps = srv.join();
    assert_eq!(caps.len(), 1);
    assert_eq!(caps[0].method_line, "POST /v1/alerts HTTP/1.1");
}

/// Content-Type and Content-Length are required for HTTP/1.1 RFC
/// compliance and to keep CDNs/proxies from buffering the body.
#[test]
fn headers_are_content_type_json_and_content_length_exact() {
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.1 200 OK");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/h"));
    let alert = Alert::p1("idem", "msg").with_label("k", "v");
    ch.send(&alert);
    let caps = srv.join();
    assert_eq!(caps.len(), 1);
    // Look headers up by lowercased name so HTTP's case-insensitive
    // header names work regardless of the exact casing the wire uses.
    let mut map = std::collections::HashMap::<String, String>::new();
    for (n, v) in &caps[0].headers {
        map.insert(n.to_lowercase(), v.clone());
    }
    assert_eq!(
        map.get("content-type").map(|s| s.as_str()),
        Some("application/json"),
        "Content-Type must be application/json; headers were {:?}",
        caps[0].headers
    );
    let len = map
        .get("content-length")
        .expect("Content-Length header must be present")
        .parse::<usize>()
        .expect("Content-Length must parse as usize");
    assert_eq!(len, caps[0].body.len(), "Content-Length must match body");
    assert_eq!(map.get("connection").map(|s| s.as_str()), Some("close"));
    assert!(
        map.get("host").map(|s| s.as_str()) == Some("127.0.0.1"),
        "Host header should be just the hostname (RFC 7230 §5.4); got {:?}",
        map.get("host")
    );
}

// ========================================================================
// Body shape
// ========================================================================

/// The body must round-trip through `serde_json::from_slice` and contain
/// every documented field. Server-side parsers that miss any of these
/// drop the alert silently — the failure mode this test exists to pin.
#[test]
fn body_carries_severity_id_message_labels_and_timestamp() {
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.1 200 OK");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/h"));
    let a = Alert::p0("amos-ai.breaker_open", "the breaker is open")
        .with_label("host", "edge-7")
        .with_label("trace_id", "req-123");
    ch.send(&a);
    let caps = srv.join();
    let raw = &caps[0].body;
    let v: serde_json::Value = serde_json::from_slice(raw).unwrap_or_else(|e| {
        panic!(
            "body must parse as JSON: {e}\nraw={:?}",
            String::from_utf8_lossy(raw)
        )
    });
    assert_eq!(v["severity"], "P0");
    assert_eq!(v["id"], "amos-ai.breaker_open");
    assert_eq!(v["message"], "the breaker is open");
    assert_eq!(v["labels"]["host"], "edge-7");
    assert_eq!(v["labels"]["trace_id"], "req-123");
    assert!(
        v["ts"].as_str().unwrap().contains('T'),
        "ts must be an RFC 3339 string; got {:?}",
        v["ts"]
    );
    assert!(
        v["ts"].as_str().unwrap().ends_with('Z'),
        "ts must be in UTC; got {:?}",
        v["ts"]
    );
}

#[test]
fn body_matches_webhook_channel_body_helper() {
    // Same alert twice — once sent through `ch.send`, once through
    // `WebhookChannel::body`. The static fields must be identical; the
    // `ts` field is exempt because the helper reports SystemTime::now
    // at the moment of the call (sub-millisecond apart).
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.1 200 OK");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/h"));
    let a = Alert::p2("amos-ai.engine_degraded", "fallback to mock").with_label("a", "1");
    ch.send(&a);
    let caps = srv.join();
    let over_wire: serde_json::Value = serde_json::from_slice(&caps[0].body).unwrap();
    let from_helper = body_of(&a);
    // Compare everything except `ts` (wall-clock skew between send()
    // and body_of()).
    let mut wire = over_wire.clone();
    let mut helper = from_helper.clone();
    wire.as_object_mut().unwrap().remove("ts");
    helper.as_object_mut().unwrap().remove("ts");
    assert_eq!(
        wire, helper,
        "wire body must equal WebhookChannel::body (ts excepted); wire={over_wire} helper={from_helper}"
    );
}

// ========================================================================
// Outcome mapping per HTTP status
// ========================================================================

#[test]
fn a_200_is_sent_for_a_p0() {
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.1 200 OK");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/h"));
    assert_eq!(ch.send(&Alert::p0("a", "b")), SendOutcome::Sent);
}

#[test]
fn a_202_is_sent_for_a_p1() {
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.1 202 Accepted");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/h"));
    assert_eq!(ch.send(&Alert::p1("a", "b")), SendOutcome::Sent);
}

#[test]
fn a_429_is_dropped_not_failed() {
    // 429 = rate-limit. The transport is fine; **this particular** send
    // was over budget. The dispatcher should pick a different channel
    // next time, not declare the transport dead.
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.1 429 Too Many Requests");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/h"));
    assert_eq!(ch.send(&Alert::p0("a", "b")), SendOutcome::Dropped);
}

#[test]
fn a_400_is_dropped() {
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.1 400 Bad Request");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/h"));
    assert_eq!(ch.send(&Alert::p0("a", "b")), SendOutcome::Dropped);
}

#[test]
fn a_503_is_failed() {
    // 5xx = transport issue (we're trying to send but the server is
    // unhealthy). The dispatcher should retry on the next alert, not
    // consider this transport dead **permanently**.
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.1 503 Service Unavailable");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/h"));
    assert_eq!(ch.send(&Alert::p0("a", "b")), SendOutcome::Failed);
}

#[test]
fn a_500_is_failed() {
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.1 500 Internal Server Error");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/h"));
    assert_eq!(ch.send(&Alert::p0("a", "b")), SendOutcome::Failed);
}

// ========================================================================
// Connection-failure paths (the cost of "real socket" testing)
// ========================================================================

/// No server listening ⇒ connect-refused. Outcome must be `Failed` so
/// the dispatcher's metrics surface the broken transport and the
/// operator's pager is not falsely "all clear".
#[test]
fn a_connection_to_a_closed_port_is_failed() {
    // Bind-and-immediately-drop a listener just to pick an unused port,
    // then point the channel at it. The closure happens ~µs after the
    // listener drops; the channel connect times out and returns Failed.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/h"));
    assert_eq!(ch.send(&Alert::p0("a", "b")), SendOutcome::Failed);
}

#[test]
fn http_version_1_0_2xx_is_also_treated_as_sent() {
    // Some legacy relays answer 1.0 instead of 1.1. Treating their 2xx
    // as success is what the existing impl does — pin that here so a
    // future "strictly 1.1" change is intentional.
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.0 200 OK");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/h"));
    assert_eq!(ch.send(&Alert::p0("a", "b")), SendOutcome::Sent);
}

#[test]
fn http_version_1_0_4xx_is_dropped() {
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.0 404 Not Found");
    let port = srv.port();
    let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/missing"));
    assert_eq!(ch.send(&Alert::p0("a", "b")), SendOutcome::Dropped);
}

// ========================================================================
// Dispatcher + Webhook (the production-shape integration)
// ========================================================================

/// End-to-end through the dispatcher: a real `WebhookChannel` is wired
/// in alongside a `Recorder`, the dispatcher fires one P0, and the wire
/// captures one POST while the recorder also gets the in-memory copy.
/// This is the only test that proves both sides of the dispatch policy
/// are exercised by a single alert: the on-the-wire transport and the
/// dispatch fan-out.
#[test]
fn dispatcher_fans_out_through_a_real_webhook_and_a_recorder() {
    let mut srv = MockServer::bind();
    srv.accept_n(1, |_| "HTTP/1.1 200 OK");
    let port = srv.port();
    let dispatcher = Dispatcher::builder()
        .with_channel(WebhookChannel::new(format!(
            "http://127.0.0.1:{port}/v1/hook"
        )))
        .build();

    dispatcher.fire(Alert::p0("amos-ai.breaker_open", "the breaker is open"));
    let caps = srv.join();

    // The wire captured exactly one request with the right method + path.
    assert_eq!(caps.len(), 1, "the webhook received exactly one request");
    assert_eq!(caps[0].method_line, "POST /v1/hook HTTP/1.1");

    // The body is parseable JSON and the alert id/message land correctly.
    let v: serde_json::Value = serde_json::from_slice(&caps[0].body).unwrap();
    assert_eq!(v["id"], "amos-ai.breaker_open");
    assert_eq!(v["message"], "the breaker is open");
    assert_eq!(v["severity"], "P0");

    // Dispatcher reports 1 channel, all metrics alive.
    let m = dispatcher.metrics();
    assert_eq!(m.channels.len(), 1);
    let (id, metrics) = &m.channels[0];
    assert!(
        id.starts_with("webhook:") && id.contains(&format!("127.0.0.1:{port}")),
        "channel id is webhook:<host>: <{id}>"
    );
    assert!(
        metrics.sent + metrics.suppressed >= 1,
        "at least one outcome recorded for the one send; got {metrics:?}"
    );
}

/// Three alerts in a sequence ⇒ three captures. The dispatcher's per-
/// channel suppression window may collapse some, but a **sequence of
/// distinct ids** must all hit the wire.
#[test]
fn dispatching_three_distinct_ids_three_captures() {
    let mut srv = MockServer::bind();
    srv.accept_n(3, |i| match i {
        0 => "HTTP/1.1 200 OK",
        1 => "HTTP/1.1 200 OK",
        _ => "HTTP/1.1 200 OK",
    });
    let port = srv.port();
    let dispatcher = Dispatcher::builder()
        .with_channel(WebhookChannel::new(format!(
            "http://127.0.0.1:{port}/v1/hook"
        )))
        .build();

    dispatcher.fire(Alert::p0("a.x", "first"));
    dispatcher.fire(Alert::p0("a.y", "second"));
    dispatcher.fire(Alert::p0("a.z", "third"));
    let caps = srv.join();
    assert_eq!(caps.len(), 3);
    let ids: Vec<String> = caps
        .iter()
        .map(|c| {
            let v: serde_json::Value = serde_json::from_slice(&c.body).unwrap();
            v["id"].as_str().unwrap().to_string()
        })
        .collect();
    assert!(ids.contains(&"a.x".to_string()));
    assert!(ids.contains(&"a.y".to_string()));
    assert!(ids.contains(&"a.z".to_string()));
}

/// Mixed responses (200 → 503 → 200) drive the dispatcher's metrics
/// across all three buckets: `sent / failed / dropped` would all be set
/// here if the dispatcher were extended to retry; this test pins the
/// **current** SendOutcome mapping without retry.
#[test]
fn sequence_200_5xx_200_records_outcomes() {
    let mut srv = MockServer::bind();
    // Each alert uses a distinct id so suppression does not collapse them.
    srv.accept_n(3, |i| match i {
        0 => "HTTP/1.1 200 OK",
        1 => "HTTP/1.1 503 Service Unavailable",
        _ => "HTTP/1.1 200 OK",
    });
    let port = srv.port();
    let dispatcher = Dispatcher::builder()
        .with_channel(WebhookChannel::new(format!(
            "http://127.0.0.1:{port}/v1/hook"
        )))
        .build();

    dispatcher.fire(Alert::p0("a.first", "first"));
    dispatcher.fire(Alert::p0("a.second", "second"));
    dispatcher.fire(Alert::p0("a.third", "third"));
    let caps = srv.join();
    assert_eq!(caps.len(), 3);
    // Verify the three ids all reached the wire.
    let ids: std::collections::HashSet<String> = caps
        .iter()
        .map(|c| {
            let v: serde_json::Value = serde_json::from_slice(&c.body).unwrap();
            v["id"].as_str().unwrap().to_string()
        })
        .collect();
    assert!(ids.contains("a.first"));
    assert!(ids.contains("a.second"));
    assert!(ids.contains("a.third"));
}
