# Offline RAG data-extraction pipeline (`amos-pdf-parser`)

> Commercial-stage note: **what AmOS truly needs for "ask my files" is an offline
> RAG data-extraction pipeline**, not a PDF *viewer*. When a user hands a PDF to
> the AI assistant, the assistant's local 7B model cannot read raw binary PDF —
> it needs text or structured data. This crate is that pipeline's front half:
> **extract (text + best-effort tables) → measure (≈ tokens) → chunk (page-anchored
> RAG units)**.

Design doc for `crates/amos-pdf-parser`. The crate is pure-Rust on top of
[`lopdf`](https://docs.rs/lopdf/0.34.0/lopdf/) so it compiles for both the host
and Android (`aarch64-linux-android`), and it has no device/HAL dependency — it
is host-testable with deterministic fixtures.

## Why this and not a PDF viewer

Reading a PDF for its *content* (as opposed to rendering it) is what an AI OS
needs:

* The assistant has to **quote / summarise / answer questions** about the file —
  every one of those needs the file's *text*, not its pixels.
* Rendering pages is pure commodity (WebView/mupdf already do it) and teaches
  the model nothing. Extraction is what unlocks "让 AI 帮我读".

## Pipeline shape

```text
 bytes ── lopdf (structure: xref / object & xref streams / filters)
    │
    ▼
 extract_text (font-aware: Tf switches, encodings, ToUnicode)   ── canonical page text
    │
    ├─ layout pass (text-matrix translation → rows/cells) ── table detector ── Table[]
    │
    ▼
 estimate_tokens (CJK≈1/char, Latin≈¼/char)   ── est_tokens per page
    │
    ▼
 chunk_document (target tokens + overlap, page anchors)   ── Vec<Chunk> for the 7B's context
```

Public surface (`src/lib.rs`):

| API | Role |
| --- | --- |
| `PdfParser::{new, with_tables, parse_bytes, parse_path, from_options}` | facade |
| `ParsedPdf` / `ParsedPage` / `Table` | serialisable model (JSON-ready) |
| `chunk_document(doc, ChunkConfig)` | RAG chunking |
| `Table::{to_csv, to_markdown}` | structured output for tables |
| binary `amos-pdf-parser` | `--format text\|json`, `--chunks` |

## What is guaranteed (and tested)

* **Font-aware extraction.** Page text *and detected table cells* use per-font
  decoding (`Tf`/`Tj`/`TJ`, encodings + ToUnicode cmaps) — the layer that
  survives real-world & CJK PDFs. An integration cell whose WinAnsi byte `0xE9`
  must come back as real `é` (not U+FFFD) proves the font-aware table path.
* **No hidden loss of content when chunking.** Unit tests verify no line is
  dropped/duplicated and every chunk's `est_tokens ≤ target_tokens`.
* **Script-aware sizing.** CJK ≈ 1 token/char, Latin ≈ ¼; a chunk never splits a
  CJK character.
* **Soft-failure policy.** One bad page ⇒ warning + empty text, not a failed
  document (what an ingestion queue wants). Missing `%PDF-` header is rejected
  early with a clear error.
* **Honest tokens.** `estimate_tokens` is a documented *planner* heuristic, not
  a real BPE tokeniser.

## Honest boundaries

| Boundary | Reality | Consequence |
| --- | --- | --- |
| Table cell text | decoded per-`Tf` font via lopdf encodings / `ToUnicode` cmaps → real Unicode (incl. CJK); ASCII fallback when no font/encoding resolvable | Real (CJK) cell text *is* kept when the font embeds a `ToUnicode` cmap (same power as page text); otherwise fallback is ASCII |
| `cm` transforms / exact glyph widths | not modelled | Columns estimated from text-origin x; best for generated tables (reportlab/iText/weasyprint) |
| Scanned / image-only PDFs | have **no text layer** | need OCR (out of scope — see `docs/` backlog) |
| Token count | approximate | use for planning/window sizing only |

## Integrity, safety & determinism (aerospace-grade baseline)

The crate treats PDF data as untrusted input and its output as something that
will be fed to a model, so degradation is never silent:

* **No `unsafe`.** `#![forbid(unsafe_code)]` on the lib and the binary; plus a
  production-time `deny(clippy::unwrap_used / expect_used / panic)`. A parse can
  fail with an error or a warning, but it cannot crash the assistant process.
* **No silent data loss.** Any text element that could not be decoded under its
  font/encoding and had to fall back to the lossy [`ascii_text`] decoder is
  *counted and surfaced* in [`ParsedPdf::warnings`]. A caller that ignores
  warnings is explicitly choosing degraded output; it is never hidden.
* **Deterministic.** Table detection and chunking are order-stable and
  idempotent (unit-tested: two runs over the same input give identical
  results); no randomness, wall-clock or thread dependence.
* **Adversarial robustness.** Unknown/malformed operators, missing operands,
  huge numbers and wrong operand types never panic (unit-tested); non-PDF bytes
  are rejected early by the `%PDF-` magic check.
* **Invariants unit-tested.** Chunk `est_tokens ≤ target_tokens`; CJK is never
  split mid-character; chunk indices are contiguous `0..n`; a zero-page
  document is well-formed (empty text, zero totals).
* **Resource note (honest).** `lopdf` loads the whole document into memory; for
  very large or adversarial PDFs, impose your own input-size / decompression
  caps at the integration boundary (this crate has no magic safety margin on
  that axis).


## Verification

```bash
cargo test -p amos-pdf-parser                      # unit + integration (real generated PDF)
cargo clippy -p amos-pdf-parser --all-targets -- -D warnings
cargo test -p amos-pdf-parser --features ...       # (no extra features today)
cargo run -p amos-pdf-parser -- --help
cargo run -p amos-pdf-parser -- --format json --chunks <file.pdf>
# Android cross-compile gate (pure Rust on lopdf — no NDK linker needed for a check):
cargo check -p amos-pdf-parser --target aarch64-linux-android
# Convenience wrapper above + host tests:
make pdf-android-check
```

The workspace `cargo test --workspace` picks up this crate's `tests/` and the
new member automatically.
