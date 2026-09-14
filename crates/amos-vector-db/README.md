# amos-vector-db — offline local vector retrieval

A deterministic, pure-Rust flat (ANN-free) index for local retrieval: dimension-checked,
finite-only vectors, deterministic tie-breaking, and an `Embedder` seam so the same index
serves tests, the host and the device. Part of **[Amos](../../README.md)**. Design record:
[`docs/vector-db-rag.md`](../../docs/vector-db-rag.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `FlatIndex`: exact top-k search — no approximation, so a wrong answer would be a bug, not
  a tuning trade-off. Results are stable (`ScoredHit`) because ties break deterministically.
- **Validation is upfront**: a vector whose dimension differs from the index's, or that
  contains a non-finite component (`NaN`/`inf`), is refused at insert time — the failure mode
  this prevents is a similarity score that silently becomes `NaN` and ranks everything.
- `Metric` (cosine / dot / euclidean as configured) is explicit; the index never guesses
  which one a caller meant.
- `Embedder` / `MockEmbedder`: retrieval is testable without a model, and the real path
  (local embeddings) is a seam.
- Search cost is linear by design; the crate's value is *correct* local retrieval in a
  bounded memory footprint, not scale.

It is **not** a vector database server: no persistence format, no replication, no ANN
structure (that is a deliberate, documented trade-off — see the design record).

## Layout

| file | what |
|---|---|
| `src/index.rs` | `FlatIndex`: insert/search, validation, deterministic ordering |
| `src/model.rs` | `Vector`, `ScoredHit` |
| `src/metric.rs` | `Metric` |
| `src/embed.rs` | `Embedder` seam + `MockEmbedder` |
| `src/error.rs` | `VectorDbError`, `Result` |

## Build & test

```bash
cargo test -p amos-vector-db
cargo check -p amos-vector-db --target aarch64-linux-android   # the ARM board target
cargo run -p amos-vector-db --example bench_arm -- 2000 64     # honest local benchmark
cargo clippy -p amos-vector-db --all-targets -- -D warnings
```

## Examples

```bash
cargo run -p amos-vector-db --example bench_arm -- [COUNT] [DIM]
```

| example | shows |
|---|---|
| `bench_arm` | a deterministic in-memory corpus (fixed seed) timed end to end: ingest and top-5 search per-op timings — the honest answer to "how fast is exact local retrieval on the ARM chip", measured, never claimed up front |

## Honest boundaries

- **Linear scan**: for tens of thousands of chunks this is the right trade (predictable,
  exact); for millions it is the wrong tool, and the crate says so.
- **No persistence**: an index lives in memory; the caller owns any on-disk format.
- **No quantisation**: vectors are kept at full precision, so memory is a real cost.
- **The benchmark is a benchmark**: numbers depend on the machine, which is why the example
  prints them instead of the README promising them.

## Related

- [`docs/vector-db-rag.md`](../../docs/vector-db-rag.md) — the retrieval pipeline and the
  device bring-up notes.
- [`crates/amos-pdf-parser`](../amos-pdf-parser/README.md) — where chunks come from.
