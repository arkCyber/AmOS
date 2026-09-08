//! `amos-pdf-parser` — the AmOS **offline RAG data-extraction core**.
//!
//! The AI assistant's local 7B model cannot read a binary PDF; it needs text or
//! structured data. This crate is the first half of the pipeline that makes a
//! PDF "readable by the model": it squeezes the text (and, best-effort, the
//! tables) out of a PDF and sizes the result into RAG chunks that fit a local
//! model's context window.
//!
//! ```text
//!   .pdf bytes
//!      │  lopdf (structure + content-stream decode)
//!      ▼
//!  ┌──────────────┐   ┌───────────────────────┐
//!  │ extract_text │──▶│  page text (+ tables) │──▶ chunk_document
//!  │ (font-aware) │   │  (reading order)      │       (RAG units)
//!  └──────────────┘   └───────────────────────┘
//! ```
//!
//! Modules:
//! * [`extract`] — `PdfParser` facade + `lopdf`-backed page text extraction.
//! * [`model`] — serialisable [`ParsedPdf`] / [`ParsedPage`] / [`Table`].
//! * [`layout`] — cheap positional pass over content operators (table discovery).
//! * [`table`] — heuristic detector of geometrically-aligned tables.
//! * [`chunk`] — RAG chunking with page anchors + overlap.
//! * [`util`] — script-aware approximate token estimator.
//!
//! Honest boundaries (see `docs/offline-rag-pdf.md`): per-page text and detected
//! table *cells* are decoded font-aware via `lopdf` (encodings + `ToUnicode`
//! cmaps → real incl. CJK Unicode), falling back to ASCII for bytes with no
//! resolvable font/encoding; `cm` transforms and exact glyph widths are not
//! modelled so column estimation assumes per-cell-origin producers; scanned /
//! image-only PDFs contain no text and need OCR (out of scope here).

// Aerospace-grade hardening: this library is intentionally pure, allocation-safe
// and panic-free in production. `unsafe` is forbidden outright.
#![forbid(unsafe_code)]
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod chunk;
pub mod cli;
pub mod error;
pub mod extract;
pub mod layout;
pub mod model;
pub mod table;
pub mod util;

pub use chunk::{chunk_document, Chunk, ChunkConfig};
pub use error::{PdfError, Result};
pub use extract::{extract_bytes, extract_document, extract_path, Options, PdfParser};
pub use layout::{ascii_text, rows_from_ops, rows_from_ops_decoded, Cell, Row};
pub use model::{ParsedPage, ParsedPdf, Table};
pub use util::estimate_tokens;
