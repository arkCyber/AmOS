# amos-pdf-parser — offline RAG data extraction from PDFs

Squeezes the text — and a best-effort layout/table structure — out of a PDF so a **local 7B
model** can read it, then chunks it for retrieval. Pure Rust on `lopdf`, no C and no network,
so it cross-compiles to the ARM board without an NDK linker. Part of **[Amos](../../README.md)**.
Design record: [`docs/offline-rag-pdf.md`](../../docs/offline-rag-pdf.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `extract_document` / `extract_path` / `extract_bytes`: text plus the operations behind it,
  so layout reconstruction and text export come from **one** pass over the page.
- `layout.rs` (`rows_from_ops`, `rows_from_ops_decoded`, `Cell`, `Row`): text runs are
  grouped into rows/cells by their geometry, which is what turns a PDF table into something
  a model can read.
- **Font-aware decoding**: a cell's bytes are decoded with the page's current font
  (encoding/`ToUnicode`), so CJK and `WinAnsi` text survive as real Unicode instead of
  `U+FFFD`. `ascii_text` remains the documented fallback.
- `chunk_document` + `ChunkConfig`: bounded chunks with the metadata retrieval needs.
- `cli.rs` gives the crate a command surface, so extraction can be run without writing code.

It is **not** an OCR engine: a scanned page with no text layer yields no text (and says so),
rather than an invented transcription.

## Layout

| file | what |
|---|---|
| `src/extract.rs` | `PdfParser`, `extract_path`, `extract_bytes`, `extract_document`, `Options` |
| `src/layout.rs` | `rows_from_ops_decoded`, `Cell`, `Row`, `ascii_text` |
| `src/table.rs` | table reconstruction from geometry |
| `src/chunk.rs` | `chunk_document`, `Chunk`, `ChunkConfig` |
| `src/model.rs` | the document/text model + metrics |
| `src/cli.rs` | the command-line surface |
| `src/error.rs` | `PdfError`, `Result` |

## Build & test

```bash
cargo test -p amos-pdf-parser
cargo check -p amos-pdf-parser --target aarch64-linux-android   # no NDK linker needed
cargo clippy -p amos-pdf-parser --all-targets -- -D warnings
```

## Examples

```bash
cargo run -p amos-pdf-parser --example make_sample_pdf   # writes a small fixture PDF
```

| example | shows |
|---|---|
| `make_sample_pdf` | generating a deterministic sample PDF (text + a table with a non-ASCII cell) so extraction can be demonstrated and tested without shipping a binary fixture |

## Honest boundaries

- **No OCR**: pages without a text layer are empty, and the extraction reports what it
  found rather than guessing.
- **Encrypted/corrupt PDFs are refusals** (typed errors), never partial nonsense.
- **Layout is heuristic**: rows and tables come from geometry, and the design record lists
  the shapes that mislead it.
- **Font decoding covers what the PDF declares** (`ToUnicode`/encoding); a font with neither
  falls back to ASCII.

## Related

- [`docs/offline-rag-pdf.md`](../../docs/offline-rag-pdf.md) — the pipeline, the decoding
  rules and the Android cross-compile notes.
- [`crates/amos-vector-db`](../amos-vector-db/README.md) — where the chunks go.
