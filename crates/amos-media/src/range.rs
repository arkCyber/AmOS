//! HTTP byte-range planning for ranged media reads (RFC 7233, **single** range).
//!
//! A media element (`<video>`/`<audio>`) drives playback with `Range` requests,
//! so a streaming backend must answer "which bytes, with which status" before it
//! touches storage. That decision is pure and lives here — no IO, no HTTP types —
//! so it is exhaustively testable and shared by every backend.
//!
//! Scope (deliberate simplifications, documented rather than hidden):
//! * Only the `bytes` unit and a **single** range are honoured; a multi-range
//!   request serves its first range (we never emit `multipart/byteranges`).
//! * A malformed/unsupported `Range` header is **ignored** (full response), as
//!   RFC 7233 permits — it is never treated as an error.
//! * A satisfiable window is clamped to the caller's body cap so one response can
//!   never allocate an unbounded body; a client re-requests the remainder.

/// The largest window this server returns for a single partial response.
pub const MAX_RANGE_BYTES: u64 = 4 * 1024 * 1024; // 4 MiB

/// The outcome of interpreting a `Range` header against a known resource size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeSpec {
    /// No header, an unsupported unit, or a malformed value → serve everything.
    Full,
    /// One satisfiable byte range, inclusive `[start, end]`.
    Satisfiable { start: u64, end: u64 },
    /// A well-formed request that cannot be satisfied (start past the end, or a
    /// zero-length suffix) → `416`.
    Unsatisfiable,
}

/// What to answer with, given the request and the resource size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponsePlan {
    /// `200 OK` with the whole body (only when it fits `max_body`).
    Full { len: u64 },
    /// `206 Partial Content` with an inclusive window.
    Partial { start: u64, end: u64, total: u64 },
    /// `416 Range Not Satisfiable`; caller sends `Content-Range: bytes */total`.
    Unsatisfiable { total: u64 },
    /// No range was requested and the whole resource is too large for one bounded
    /// body → `413 Payload Too Large` (a real player asks with `Range`).
    TooLarge { total: u64, max: u64 },
}

/// Inclusive length of `[start, end]` (`0` when `end < start`).
pub const fn window_len(start: u64, end: u64) -> u64 {
    if end < start {
        0
    } else {
        end - start + 1
    }
}

/// Clamp `[start, end]` to at most `max` bytes (never extends the range).
pub const fn clamp_window(start: u64, end: u64, max: u64) -> (u64, u64) {
    if end < start {
        return (start, start);
    }
    if max == 0 || window_len(start, end) <= max {
        return (start, end);
    }
    (start, start + max - 1)
}

/// Interpret a `Range` header for a resource of `total` bytes.
pub fn parse_range(header: Option<&str>, total: u64) -> RangeSpec {
    let Some(raw) = header else {
        return RangeSpec::Full;
    };
    let raw = raw.trim();
    let Some(list) = raw.strip_prefix("bytes=") else {
        return RangeSpec::Full; // another unit (or garbage) → ignore the header
    };
    // Single range only: take the first spec and ignore the rest.
    let first = match list.split(',').next() {
        Some(s) => s.trim(),
        None => return RangeSpec::Full,
    };
    // An empty resource cannot satisfy any byte range.
    if total == 0 {
        return RangeSpec::Unsatisfiable;
    }
    // suffix-byte-range-spec: the LAST `n` bytes.
    if let Some(n) = first.strip_prefix('-') {
        return match n.trim().parse::<u64>() {
            Ok(0) => RangeSpec::Unsatisfiable, // RFC 7233: a 0 suffix is unsatisfiable
            Ok(n) => RangeSpec::Satisfiable {
                start: total.saturating_sub(n),
                end: total - 1,
            },
            Err(_) => RangeSpec::Full,
        };
    }
    let mut it = first.splitn(2, '-');
    let start_s = it.next().unwrap_or("").trim();
    let end_s = it.next().unwrap_or("").trim();
    let Ok(start) = start_s.parse::<u64>() else {
        return RangeSpec::Full;
    };
    if start >= total {
        return RangeSpec::Unsatisfiable;
    }
    let end = if end_s.is_empty() {
        total - 1
    } else {
        match end_s.parse::<u64>() {
            Ok(e) if e < start => return RangeSpec::Full, // malformed → ignore
            Ok(e) => e.min(total - 1),
            Err(_) => return RangeSpec::Full,
        }
    };
    RangeSpec::Satisfiable { start, end }
}

/// `Content-Range` value for one satisfied window.
pub fn content_range(start: u64, end: u64, total: u64) -> String {
    format!("bytes {start}-{end}/{total}")
}

/// `Content-Range` value for an unsatisfiable request.
pub fn content_range_unsatisfied(total: u64) -> String {
    format!("bytes */{total}")
}

/// The HTTP status code a [`RangeSpec`] maps to.
pub const fn status_for(spec: RangeSpec) -> u16 {
    match spec {
        RangeSpec::Full => 200,
        RangeSpec::Satisfiable { .. } => 206,
        RangeSpec::Unsatisfiable => 416,
    }
}

/// The inclusive window to read for a satisfiable spec (clamped to `max_chunk`);
/// `None` for `Full`/`Unsatisfiable`.
pub fn window_for(spec: RangeSpec, max_chunk: u64) -> Option<(u64, u64)> {
    match spec {
        RangeSpec::Satisfiable { start, end } => Some(clamp_window(start, end, max_chunk)),
        _ => None,
    }
}

/// The full response plan for a request: status + window, decided before any IO.
pub fn plan_response(header: Option<&str>, total: u64, max_body: u64) -> ResponsePlan {
    match parse_range(header, total) {
        RangeSpec::Unsatisfiable => ResponsePlan::Unsatisfiable { total },
        RangeSpec::Full => {
            if total <= max_body {
                ResponsePlan::Full { len: total }
            } else {
                ResponsePlan::TooLarge {
                    total,
                    max: max_body,
                }
            }
        }
        RangeSpec::Satisfiable { start, end } => {
            let (start, end) = clamp_window(start, end, max_body);
            ResponsePlan::Partial { start, end, total }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_header_or_other_unit_is_full() {
        assert_eq!(parse_range(None, 100), RangeSpec::Full);
        assert_eq!(parse_range(Some(""), 100), RangeSpec::Full);
        assert_eq!(parse_range(Some("items=0-1"), 100), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes"), 100), RangeSpec::Full);
    }

    #[test]
    fn closed_range_is_inclusive() {
        assert_eq!(
            parse_range(Some("bytes=0-99"), 100),
            RangeSpec::Satisfiable { start: 0, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=10-20"), 100),
            RangeSpec::Satisfiable { start: 10, end: 20 }
        );
    }

    #[test]
    fn an_open_range_runs_to_the_end() {
        assert_eq!(
            parse_range(Some("bytes=50-"), 100),
            RangeSpec::Satisfiable { start: 50, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=0-"), 100),
            RangeSpec::Satisfiable { start: 0, end: 99 }
        );
    }

    #[test]
    fn a_suffix_range_counts_from_the_end() {
        assert_eq!(
            parse_range(Some("bytes=-10"), 100),
            RangeSpec::Satisfiable { start: 90, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=-500"), 100),
            RangeSpec::Satisfiable { start: 0, end: 99 }
        );
    }

    #[test]
    fn an_end_past_the_resource_is_clamped() {
        assert_eq!(
            parse_range(Some("bytes=90-100000"), 100),
            RangeSpec::Satisfiable { start: 90, end: 99 }
        );
    }

    #[test]
    fn out_of_range_start_is_unsatisfiable() {
        assert_eq!(
            parse_range(Some("bytes=100-"), 100),
            RangeSpec::Unsatisfiable
        );
        assert_eq!(
            parse_range(Some("bytes=200-300"), 100),
            RangeSpec::Unsatisfiable
        );
    }

    #[test]
    fn malformed_specs_are_ignored_not_fatal() {
        for bad in [
            "bytes=abc-def",
            "bytes=10-5",
            "bytes=--1",
            "bytes=1-x",
            "bytes=,",
            "bytes=1-2-3",
        ] {
            assert_eq!(parse_range(Some(bad), 100), RangeSpec::Full, "bad: {bad}");
        }
    }

    #[test]
    fn a_zero_length_resource_is_unsatisfiable_for_any_range() {
        assert_eq!(parse_range(Some("bytes=0-"), 0), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-1"), 0), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(None, 0), RangeSpec::Full); // no range → 200, empty body
    }

    #[test]
    fn a_zero_suffix_is_unsatisfiable() {
        assert_eq!(parse_range(Some("bytes=-0"), 100), RangeSpec::Unsatisfiable);
    }

    #[test]
    fn only_the_first_of_several_ranges_is_served() {
        assert_eq!(
            parse_range(Some("bytes=5-9,20-29"), 100),
            RangeSpec::Satisfiable { start: 5, end: 9 }
        );
    }

    #[test]
    fn whitespace_around_tokens_is_tolerated() {
        assert_eq!(
            parse_range(Some("  bytes= 10 - 20  "), 100),
            RangeSpec::Satisfiable { start: 10, end: 20 }
        );
    }

    #[test]
    fn window_len_and_clamp_are_total() {
        assert_eq!(window_len(0, 0), 1);
        assert_eq!(window_len(5, 4), 0); // guarded, never underflows
        assert_eq!(clamp_window(10, 19, 100), (10, 19));
        assert_eq!(clamp_window(10, 199, 100), (10, 109)); // first 100 bytes
        assert_eq!(clamp_window(10, 19, 0), (10, 19)); // 0 = unlimited
        assert_eq!(clamp_window(5, 4, 100), (5, 5)); // degenerate guard
    }

    #[test]
    fn headers_and_status_codes_match_the_spec() {
        let spec = parse_range(Some("bytes=10-20"), 100);
        assert_eq!(status_for(spec), 206);
        assert_eq!(window_for(spec, MAX_RANGE_BYTES), Some((10, 20)));
        assert_eq!(content_range(10, 20, 100), "bytes 10-20/100");
        assert_eq!(status_for(RangeSpec::Full), 200);
        assert_eq!(status_for(RangeSpec::Unsatisfiable), 416);
        assert_eq!(content_range_unsatisfied(100), "bytes */100");
        assert_eq!(window_for(RangeSpec::Full, 10), None);
    }

    #[test]
    fn a_small_unranged_resource_is_served_whole() {
        assert_eq!(
            plan_response(None, 900, 1000),
            ResponsePlan::Full { len: 900 }
        );
    }

    #[test]
    fn a_large_unranged_resource_is_refused_instead_of_unbounded() {
        assert_eq!(
            plan_response(None, 10_000, 1000),
            ResponsePlan::TooLarge {
                total: 10_000,
                max: 1000
            }
        );
    }

    #[test]
    fn a_range_is_planned_as_a_clamped_partial() {
        assert_eq!(
            plan_response(Some("bytes=0-"), 10_000, 1000),
            ResponsePlan::Partial {
                start: 0,
                end: 999,
                total: 10_000
            }
        );
        assert_eq!(
            plan_response(Some("bytes=500-600"), 10_000, 1000),
            ResponsePlan::Partial {
                start: 500,
                end: 600,
                total: 10_000
            }
        );
    }

    #[test]
    fn an_unsatisfiable_range_is_planned_as_416() {
        assert_eq!(
            plan_response(Some("bytes=99999-"), 100, 1000),
            ResponsePlan::Unsatisfiable { total: 100 }
        );
    }

    #[test]
    fn the_default_cap_bounds_one_response() {
        // 10 MiB requested from a 20 MiB file → capped at MAX_RANGE_BYTES.
        match plan_response(Some("bytes=0-"), 20 * 1024 * 1024, MAX_RANGE_BYTES) {
            ResponsePlan::Partial { start, end, total } => {
                assert_eq!(start, 0);
                assert_eq!(end, MAX_RANGE_BYTES - 1);
                assert_eq!(total, 20 * 1024 * 1024);
            }
            other => panic!("expected partial, got {other:?}"),
        }
    }
}
