//! Webhook transport — HTTP POST with a JSON body.
//!
//! Pure-std implementation that opens a short-lived `std::net::TcpStream`,
//! writes an HTTP/1.1 request, reads the status line. No `reqwest` /
//! `ureq` — every external HTTP client the workspace uses so far is
//! re-implemented at the lower level for the same reason (auditable,
//! dependency-light, fail-closed). The body format is the Slack-compatible
//! "text" field plus our structured "labels" object, so a Slack / PagerDuty
//! / Lark / 飞书 webhook accepts it without translation.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::alert::Alert;
use crate::channel::{Channel, ChannelId, SendOutcome};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(2);

pub struct WebhookChannel {
    id: ChannelId,
    host_port: (String, u16),
    path: String,
}

impl WebhookChannel {
    /// Parse the URL once at construction time so a bad URL fails the build,
    /// not the first alert. Supported schemes: `http://host:port/path` and
    /// `https://` (the latter is **not** implemented in pure std — the
    /// constructor refuses it explicitly so the operator sees a loud
    /// startup error rather than a silent fallback).
    ///
    /// Construction is **explicit about failure**: use [`Self::try_new`]
    /// for fallible builds and `new` only when a bad URL is unrecoverable
    /// (a misconfigured daemon should panic at startup, not silently drop
    /// alerts).
    ///
    /// The crate root denies `clippy::panic` (P0-1). This is the **one**
    /// reasoned exception, and it is visible right here rather than asserted
    /// in a comment: startup misconfiguration is not a runtime failure mode,
    /// and the alternative (`new` returning a default) would leave the daemon
    /// running with a webhook that silently drops every alert.
    #[allow(clippy::panic)] // documented contract: startup misconfiguration is fatal
    pub fn new(url: impl Into<String>) -> Self {
        match Self::try_new(url) {
            Ok(c) => c,
            Err(e) => panic!("{e}"),
        }
    }

    /// Fallible constructor — returns `Err(message)` for malformed URLs.
    /// Test code and dynamic configurations (e.g. values loaded from
    /// `amos-config`) should prefer this over [`Self::new`].
    pub fn try_new(url: impl Into<String>) -> Result<Self, String> {
        let url = url.into();
        let (host_port, path) = parse_http_url(&url)
            .ok_or_else(|| "webhook url must be http://host:port/path".to_string())?;
        Ok(Self {
            id: ChannelId::new(format!("webhook:{url}")),
            host_port,
            path,
        })
    }

    /// Build the JSON body sent in the request. Exposed for tests.
    pub fn body(alert: &Alert) -> serde_json::Value {
        serde_json::json!({
            "severity": alert.severity.label(),
            "id": alert.id,
            "message": alert.message,
            "labels": alert.labels,
            "ts": now_rfc3339(),
        })
    }
}

fn parse_http_url(url: &str) -> Option<((String, u16), String)> {
    let rest = url.strip_prefix("http://")?;
    if rest.is_empty() {
        return None;
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return None;
    }
    let (host, port) = match authority.rfind(':') {
        Some(i) => (authority[..i].to_string(), authority[i + 1..].parse().ok()?),
        None => (authority.to_string(), 80u16),
    };
    if host.is_empty() {
        return None;
    }
    Some(((host, port), path.to_string()))
}

/// RFC 3339 timestamp — shared between webhook bodies and SMTP `Date:` headers.
pub(crate) fn now_rfc3339() -> String {
    // Inline RFC 3339 formatter — see crates/amos-ai/src/jsonlog.rs for the
    // same pattern. Pulling `chrono` is out of scope (workspace policy).
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let nanos = dur.subsec_nanos();
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400) as u32;
    let h = sod / 3600;
    let m = (sod % 3600) / 60;
    let s = sod % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let yy = if mth <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:09}Z",
        yy, mth, d, h, m, s, nanos
    )
}

impl Channel for WebhookChannel {
    fn id(&self) -> ChannelId {
        self.id.clone()
    }
    fn send(&self, alert: &Alert) -> SendOutcome {
        let body = match serde_json::to_vec(&Self::body(alert)) {
            Ok(b) => b,
            Err(_) => return SendOutcome::Failed,
        };
        let (host, port) = &self.host_port;
        let addr = match (host.as_str(), *port)
            .to_socket_addrs()
            .ok()
            .and_then(|mut it| it.next())
        {
            Some(a) => a,
            None => return SendOutcome::Failed,
        };
        let mut stream = match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(s) => s,
            Err(_) => return SendOutcome::Failed,
        };
        // A failed `set_*_timeout` means the next read()/write_all() may
        // block forever — exactly the failure mode the timeout was supposed
        // to prevent. Loud-on-stderr, do NOT panic, do NOT silently swallow
        // (a swallowed timeout is a wedged dispatcher the next time the
        // webhook hangs). Same discipline as the JSON sink's stat() failure:
        // one eprintln, the send still proceeds because the alternative is
        // worse (we have no alert delivery at all).
        if let Err(e) = stream.set_read_timeout(Some(READ_TIMEOUT)) {
            eprintln!(
                "amos-notifier: webhook {host}:{port} read timeout could not be set ({e}); \
                 next read() may block — sending anyway",
            );
        }
        if let Err(e) = stream.set_write_timeout(Some(READ_TIMEOUT)) {
            eprintln!(
                "amos-notifier: webhook {host}:{port} write timeout could not be set ({e}); \
                 next write_all() may block — sending anyway",
            );
        }
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
            path = self.path,
            host = host,
            len = body.len(),
        );
        if stream.write_all(req.as_bytes()).is_err() {
            return SendOutcome::Failed;
        }
        if stream.write_all(&body).is_err() {
            return SendOutcome::Failed;
        }
        let mut buf = [0u8; 256];
        let n = match stream.read(&mut buf) {
            Ok(n) => n,
            Err(_) => return SendOutcome::Failed,
        };
        let response = String::from_utf8_lossy(&buf[..n]);
        // HTTP status line: "HTTP/1.1 2xx …" ⇒ Sent; 4xx ⇒ Dropped; 5xx and
        // everything else ⇒ Failed.
        if response.starts_with("HTTP/1.1 2") || response.starts_with("HTTP/1.0 2") {
            SendOutcome::Sent
        } else if response.starts_with("HTTP/1.1 4") || response.starts_with("HTTP/1.0 4") {
            SendOutcome::Dropped
        } else {
            SendOutcome::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alert::Alert;
    use std::io::Read;
    use std::net::TcpListener;
    use std::thread;

    /// Refused: `https://` is documented but unsupported. `try_new` must
    /// give the caller an Err (the fallible path), so a runtime config
    /// load from `amos-config` does not panic the daemon.
    #[test]
    fn try_new_refuses_https_with_a_clear_error() {
        let res = WebhookChannel::try_new("https://hooks.example.com/amos");
        assert!(
            res.is_err(),
            "https:// must be refused at build time (pure std has no TLS)"
        );
    }

    #[test]
    fn try_new_refuses_malformed_urls() {
        assert!(WebhookChannel::try_new("not a url").is_err());
        assert!(WebhookChannel::try_new("ftp://hooks.example.com/x").is_err());
        // Empty authority: `http://` and `http:///path` are nonsensical and
        // must be refused at parse time, not silently accepted as
        // `(host="", port=80)` (which would later log "connection refused"
        // for every alert instead of failing the build).
        assert!(WebhookChannel::try_new("http://").is_err());
        assert!(WebhookChannel::try_new("http:///path").is_err());
    }

    #[test]
    fn body_has_severity_id_message_labels_ts() {
        let a = Alert::p0("db.unreachable", "down").with_label("host", "edge-7");
        let b = WebhookChannel::body(&a);
        assert_eq!(b["severity"], "P0");
        assert_eq!(b["id"], "db.unreachable");
        assert_eq!(b["message"], "down");
        assert_eq!(b["labels"]["host"], "edge-7");
        assert!(b["ts"].as_str().unwrap().contains('T'));
    }

    /// End-to-end: spin up a local TCP "server" that always returns 200 OK,
    /// point a `WebhookChannel` at it, fire one alert, and confirm we get
    /// `Sent`. This is the integration test the rest of the notifier
    /// stack doesn't have — the dispatcher is sync, so the test exercises
    /// the full path.
    #[test]
    fn end_to_end_webhook_round_trip() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            }
        });
        let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/hook"));
        let outcome = ch.send(&Alert::p0("x", "y"));
        assert_eq!(outcome, SendOutcome::Sent);
        let _ = server.join();
    }

    /// 500-class response ⇒ Failed.
    #[test]
    fn end_to_end_500_is_failed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ =
                    s.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
            }
        });
        let ch = WebhookChannel::new(format!("http://127.0.0.1:{port}/hook"));
        let outcome = ch.send(&Alert::p1("x", "y"));
        assert_eq!(outcome, SendOutcome::Failed);
        let _ = server.join();
    }
}
