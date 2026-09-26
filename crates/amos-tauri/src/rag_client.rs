//! Tauri <-> daemon offline local vector retrieval (`Rag` service) bridge.
//!
//! The Svelte Notes/Ai "ask my files" surface calls these commands; each opens a
//! `RagClient` over the OS daemon's Unix Domain Socket (same socket as
//! `AiAgent`/`Sensor`/`PrivacyService`/`NetGuardService`), runs the RPC, and
//! returns a serializable mirror (prost types don't impl `Serialize`). The
//! **daemon is the single authority**: it owns the embedder (mock on host,
//! Ollama on device), the vector index, and the durable state. If the daemon is
//! absent the commands fail with a descriptive error — the UI shows "notes search
//! offline", never a fabricated hit.
//!
//! Mirrors the `netguard` / `privacy_client` bridge shape. Wire contract:
//! `proto/ai_agent.proto` `service Rag`; `rag_query` `top_k` is `0 => default`,
//! the daemon caps it.

use amos_proto::ai_agent::rag_client::RagClient;
use amos_proto::ai_agent::{
    RagHit, RagIndexRequest, RagQueryReply, RagQueryRequest, RagRemoveRequest, RagStatusReply,
    RagStatusRequest,
};
use serde::Serialize;

use crate::error::{AmosError, ErrorCode};

/// Wire vocabulary for the RAG / notes-index module. The UI i18n layer branches
/// on these; renaming a variant is a wire break.
pub mod codes {
    use crate::error::ErrorCode;
    /// Caller passed a RAG id / text / query string that is over its byte cap.
    pub const PAYLOAD_TOO_LONG: &str = ErrorCode::RagPayloadTooLong.as_str();
    /// Any RAG RPC failed (notes-index unreachable / rejected).
    pub const RPC_FAILED: &str = ErrorCode::RagRpcFailed.as_str();
    /// A retrieval was driven by a window the user is not looking at.
    pub const FOREGROUND_REQUIRED: &str = ErrorCode::RagForegroundRequired.as_str();
}

/// The foreground rule for a note **retrieval** — the family
/// [`crate::clipboard::require_foreground`] already guards for `clipboard_read`,
/// `device_mic_start`, the in-call recording toggle, the SMS reads, the mail reads
/// (`mail::require_mail_foreground`) and the recording ledger
/// (`recording::require_recordings_foreground`).
///
/// An indexed passage *is* the user's note text, so `rag_query` is a read that hands note content
/// back to its caller. Without this, any window's WebView (including a page AmOS loads) could ask
/// the index a question and receive the matching notes; the frontend's capability ledger is a
/// `$state` in the very JS context doing the asking, so it can never be the guard. The caller's
/// label is injected by Tauri (not an argument), so a caller cannot claim to be another window.
///
/// Gates **retrieval only**. `rag_index` hands the daemon text the caller already holds (a write,
/// and "a background window may always write" is the `clipboard` precedent), `rag_remove` drops an
/// entry, and `rag_status` answers the index's *size / dimension / embedder label* — no user
/// content — the same boundary `sms_trash_list` and `mail_mailboxes` draw.
pub fn require_rag_foreground(wm: &crate::wm::WmState, caller: &str) -> Result<(), AmosError> {
    crate::clipboard::require_foreground(wm, caller).map_err(|e| {
        // The rule is `clipboard::require_foreground`'s alone, and its words (the caller's label
        // and the focused one) ride along as the cause so an operator can read which window *did*
        // have the read.
        AmosError::with_cause(
            ErrorCode::RagForegroundRequired,
            format!(
                "rag query refused: {e} (only the window the user is looking at may retrieve from \
                 the note index; F-AI-019)"
            ),
            e,
        )
    })
}

async fn build_channel() -> Result<crate::daemon::DaemonChannel, String> {
    crate::daemon::channel().await
}

/// Maximum bytes in a `rag_index` passage.
///
/// Real indexed chunks are RAG-sized paragraphs / note bodies (~1–8 KiB). A
/// 4 MiB ceiling is two orders of magnitude above that and prevents a
/// malicious UI from handing the daemon a 100 MiB blob to embed + persist.
pub const MAX_RAG_TEXT_BYTES: usize = 4 << 20;

/// Maximum bytes in a `rag_index` / `rag_remove` id.
///
/// Indexed ids are note slugs; 256 B is well above any realistic id and bounds
/// the daemon's per-id storage index.
pub const MAX_RAG_ID_BYTES: usize = 256;

/// Maximum bytes in a `rag_query` query string.
///
/// A query is a sentence the embedder turns into one vector — 4 KiB is plenty
/// (longer than any natural-language retrieval query), and tight enough that
/// the daemon's embedder cannot be wedged by a paste-sized payload.
pub const MAX_RAG_QUERY_BYTES: usize = 4 << 10;

/// Serializable mirror of one daemon `RagStatusReply`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RagStatusOut {
    pub indexed: u64,
    /// The index's vector dimension, `None` until the first ingest. Kept optional
    /// all the way to the panel: `0` is not a dimension an embedder can have, so
    /// folding "unknown" into it would draw 「0 维」 for an empty index.
    pub dimension: Option<u32>,
    /// "mock" (host/offline) | "ollama" (real local model) — honest backend label.
    pub embedder: String,
}

/// Serializable mirror of one daemon `RagHit`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RagHitOut {
    pub id: String,
    pub score: f64,
    /// Indexed text for this id (for citations / building a context prompt).
    pub passage: String,
}

/// Serializable mirror of a daemon `RagQueryReply`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RagQueryOut {
    pub hits: Vec<RagHitOut>,
    pub count: u32,
}

/// Serializable mirror of a daemon `RagIndexReply`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RagIndexOut {
    pub indexed: bool,
    pub dimension: u32,
}

/// Serializable mirror of a daemon `RagRemoveReply`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RagRemoveOut {
    pub removed: bool,
}

/// Map a daemon `RagStatusReply` onto its serializable mirror (pure; unit-tested).
fn to_status(r: &RagStatusReply) -> RagStatusOut {
    RagStatusOut {
        indexed: r.indexed,
        dimension: r.dimension,
        embedder: r.embedder.clone(),
    }
}

/// Map a daemon `RagHit` onto its serializable mirror (pure; unit-tested).
fn to_hit(r: &RagHit) -> RagHitOut {
    RagHitOut {
        id: r.id.clone(),
        score: r.score,
        passage: r.passage.clone(),
    }
}

/// Map a daemon `RagQueryReply` onto its serializable mirror (pure; unit-tested).
fn to_query(r: &RagQueryReply) -> RagQueryOut {
    RagQueryOut {
        hits: r.hits.iter().map(to_hit).collect(),
        count: r.count,
    }
}

/// Index (or re-index on edit) a passage under an id in the daemon.
#[tauri::command]
pub async fn rag_index(id: String, text: String) -> Result<RagIndexOut, AmosError> {
    // Bound at the command seam — same rationale as `ask_ai_agent`'s prompt cap.
    if id.len() > MAX_RAG_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::RagPayloadTooLong,
            format!(
                "rag id too long: {} bytes (max {MAX_RAG_ID_BYTES})",
                id.len()
            ),
        ));
    }
    if text.len() > MAX_RAG_TEXT_BYTES {
        return Err(AmosError::new(
            ErrorCode::RagPayloadTooLong,
            format!(
                "rag text too long: {} bytes (max {MAX_RAG_TEXT_BYTES})",
                text.len()
            ),
        ));
    }
    let mut client = RagClient::new(
        build_channel()
            .await
            .map_err(|e| AmosError::with_cause(ErrorCode::RagRpcFailed, codes::RPC_FAILED, e))?,
    );
    let reply = client
        .index(RagIndexRequest { id, text })
        .await
        .map_err(|e| AmosError::with_cause(ErrorCode::RagRpcFailed, codes::RPC_FAILED, e))?
        .into_inner();
    Ok(RagIndexOut {
        indexed: reply.indexed,
        dimension: reply.dimension,
    })
}

/// Drop an indexed passage from retrieval in the daemon.
#[tauri::command]
pub async fn rag_remove(id: String) -> Result<RagRemoveOut, AmosError> {
    if id.len() > MAX_RAG_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::RagPayloadTooLong,
            format!(
                "rag id too long: {} bytes (max {MAX_RAG_ID_BYTES})",
                id.len()
            ),
        ));
    }
    let mut client = RagClient::new(
        build_channel()
            .await
            .map_err(|e| AmosError::with_cause(ErrorCode::RagRpcFailed, codes::RPC_FAILED, e))?,
    );
    let reply = client
        .remove(RagRemoveRequest { id })
        .await
        .map_err(|e| AmosError::with_cause(ErrorCode::RagRpcFailed, codes::RPC_FAILED, e))?
        .into_inner();
    Ok(RagRemoveOut {
        removed: reply.removed,
    })
}

/// Retrieve the nearest indexed passages to `query` (embed + top-k in the daemon).
///
/// A passage *is* the user's note text, so only the window the user is looking at may retrieve
/// ([`require_rag_foreground`]); the refusal is its own typed code, distinct from the daemon RPC
/// failing — "this window may not read right now" and "the index is unreachable" are different
/// facts and only the code can carry the difference to a caller.
#[tauri::command]
pub async fn rag_query(
    wm: tauri::State<'_, crate::wm::WmState>,
    window: tauri::WebviewWindow,
    query: String,
    top_k: u32,
) -> Result<RagQueryOut, AmosError> {
    require_rag_foreground(wm.inner(), window.label())?;
    if query.len() > MAX_RAG_QUERY_BYTES {
        return Err(AmosError::new(
            ErrorCode::RagPayloadTooLong,
            format!(
                "rag query too long: {} bytes (max {MAX_RAG_QUERY_BYTES})",
                query.len()
            ),
        ));
    }
    let mut client = RagClient::new(
        build_channel()
            .await
            .map_err(|e| AmosError::with_cause(ErrorCode::RagRpcFailed, codes::RPC_FAILED, e))?,
    );
    let reply = client
        .query(RagQueryRequest { query, top_k })
        .await
        .map_err(|e| AmosError::with_cause(ErrorCode::RagRpcFailed, codes::RPC_FAILED, e))?
        .into_inner();
    Ok(to_query(&reply))
}

/// Read the daemon's current index size / dimension / honest embedder label.
#[tauri::command]
pub async fn rag_status() -> Result<RagStatusOut, AmosError> {
    let mut client = RagClient::new(
        build_channel()
            .await
            .map_err(|e| AmosError::with_cause(ErrorCode::RagRpcFailed, codes::RPC_FAILED, e))?,
    );
    let reply = client
        .status(RagStatusRequest {})
        .await
        .map_err(|e| AmosError::with_cause(ErrorCode::RagRpcFailed, codes::RPC_FAILED, e))?
        .into_inner();
    Ok(to_status(&reply))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_status_verbatim() {
        let s = to_status(&RagStatusReply {
            indexed: 7,
            dimension: Some(384),
            embedder: "mock".into(),
        });
        assert_eq!(s.indexed, 7);
        assert_eq!(s.dimension, Some(384));
        assert_eq!(s.embedder, "mock");
    }

    /// An empty index carries no dimension across the bridge — the mirror must not
    /// re-introduce the `0` the daemon stopped sending (it would draw 「0 维」).
    #[test]
    fn maps_an_unindexed_status_without_a_dimension() {
        let s = to_status(&RagStatusReply {
            indexed: 0,
            dimension: None,
            embedder: "mock".into(),
        });
        assert_eq!(s.indexed, 0);
        assert_eq!(s.dimension, None);
    }

    #[test]
    fn maps_query_hits_with_passages() {
        let q = to_query(&RagQueryReply {
            hits: vec![RagHit {
                id: "note:a".into(),
                score: 0.91,
                passage: "预算正文".into(),
            }],
            count: 1,
        });
        assert_eq!(q.count, 1);
        assert_eq!(q.hits.len(), 1);
        assert_eq!(q.hits[0].id, "note:a");
        assert!((q.hits[0].score - 0.91).abs() < 1e-9);
        assert_eq!(q.hits[0].passage, "预算正文");
    }

    #[test]
    fn maps_index_and_remove_replies() {
        let idx = RagIndexOut {
            indexed: true,
            dimension: 8,
        };
        assert!(idx.indexed);
        assert_eq!(idx.dimension, 8);
        assert!(RagRemoveOut { removed: true }.removed);
    }

    // The note index holds the user's note text, so *retrieving* from it is a disclosure. These
    // are the family's other half: `rag_query` was the last AI-side private read no caller check
    // guarded (the mic family `require_mic_foreground` / F-AI-018 already does).

    /// The focused window may retrieve. `WmState::new()` seeds the launcher (`"main"`) focused —
    /// the phone/tablet shell's single window, which is where the Notes / Ai surfaces run there.
    #[test]
    fn the_focused_window_may_retrieve() {
        let wm = crate::wm::WmState::new();
        assert_eq!(crate::clipboard::foreground_label(&wm).unwrap(), "main");
        assert!(
            require_rag_foreground(&wm, "main").is_ok(),
            "the window the user is looking at must be able to retrieve from the note index"
        );
    }

    /// Any other window is refused — and the refusal is honest about *which* fact it is. The code
    /// is its own (`foreground_required`), **not** the RPC-failure one: "this window may not read
    /// right now" is a different fact from "the index is unreachable", and only the code can carry
    /// that distinction to a caller (the surface answers "come back to this window", not "search
    /// offline").
    #[test]
    fn a_background_window_is_refused_a_retrieval() {
        let wm = crate::wm::WmState::new();
        let err = require_rag_foreground(&wm, "webman").unwrap_err();
        assert_eq!(err.code(), "amos.rag.foreground_required");
        assert_eq!(err.code(), codes::FOREGROUND_REQUIRED);
        assert_ne!(
            err.code(),
            codes::RPC_FAILED,
            "a foreground refusal must not be reported as the index being unreachable"
        );
        // The cause chain keeps `require_foreground`'s own words: both labels, so an operator can
        // read which window *did* have the read.
        let text = err.to_string();
        assert!(
            text.contains("webman") && text.contains("main"),
            "the refusal must name the caller and the window that does have the read: got `{text}`"
        );
    }

    /// The statement in `body` that calls the gate, trimmed (the clipboard twin's first version
    /// asked only whether the *name* appeared — a discarded `Result` denies nothing, so a
    /// `let _ = …` left it green).
    fn gate_statement<'a>(body: &'a str, fname: &str) -> &'a str {
        let at = body.find("require_rag_foreground(").unwrap_or_else(|| {
            panic!(
                "{fname} must gate its retrieval through require_rag_foreground — a background \
                 window reading the user's notes out of the index is the F-AI-019 privacy failure"
            )
        });
        let tail = &body[at..];
        let semi = tail.find(';').unwrap_or(tail.len());
        tail[..semi].trim()
    }

    /// The body of the `#[tauri::command] pub … fn <fname>` in this file, up to its matching
    /// closing brace. Brace-counted (not "next `\n}`") so a nested block cannot cut it short.
    fn command_body<'a>(src: &'a str, fname: &str) -> &'a str {
        let needle = format!("fn {fname}(");
        let start = src
            .find(&needle)
            .unwrap_or_else(|| panic!("{fname} not found in rag_client.rs"));
        let open = src[start..]
            .find('{')
            .map(|o| start + o)
            .unwrap_or_else(|| panic!("{fname} has no body"));
        let mut depth = 0usize;
        for (i, ch) in src[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &src[open..open + i + 1];
                    }
                }
                _ => {}
            }
        }
        panic!("{fname}'s body never closed");
    }

    /// Source-level pin: the one command that hands back note passages calls the gate, and the
    /// call **is** the statement (propagated with `?`), not a value dropped on the floor. Deleting
    /// the gate from `rag_query` makes this fail.
    #[test]
    fn the_retrieval_propagates_the_foreground_gate() {
        const SRC: &str = include_str!("rag_client.rs");
        let stmt = gate_statement(command_body(SRC, "rag_query"), "rag_query");
        assert!(
            stmt.starts_with("require_rag_foreground("),
            "rag_query's gate must *be* the statement, not a value handed to something else (a \
             discarded `Result` denies nothing): got `{stmt}`"
        );
        assert!(
            stmt.ends_with(")?"),
            "rag_query must propagate the gate's refusal with `?`: got `{stmt}`"
        );
        // The contrast that makes it meaningful. `rag_index` hands the daemon text the caller
        // already holds — a *write*, and a background window may always write (the `clipboard`
        // precedent). `rag_remove` drops an entry. `rag_status` answers the index's size /
        // dimension / embedder label, never a passage — the same boundary `sms_trash_list` and
        // `mail_mailboxes` draw.
        for fname in ["rag_index", "rag_remove", "rag_status"] {
            assert!(
                !command_body(SRC, fname).contains("require_rag_foreground("),
                "{fname} must not carry the *read* gate — the rule here is about disclosure"
            );
        }
    }
}
