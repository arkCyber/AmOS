# Offline local vector-retrieval core (`amos-vector-db`)

> Commercial-stage framing: what AmOS calls its "Notes = Obsidian-clone, but with
> a local-RAG engine" is really **two halves**: turn documents into retrieval
> units (the *extract* half — `amos-pdf-parser`: PDF text/tables → chunks; a
> Markdown note body is just another chunk source), then **store embeddings and
> answer "which chunks are nearest to a query?"** so the daemon can assemble a
> retrieval-augmented context for the local 7B model. This crate is that second
> (index/retrieve) half. It is deliberately *pure* and *exact* — no native, no
> network, no approximate-ANN shortcuts until a device benchmark proves the flat
> scan is the bottleneck.

Design doc for `crates/amos-vector-db`. Pure-Rust on `serde`/`serde_json`, so it
compiles for the host **and** `aarch64-linux-android` with no NDK linker (a
`check` needs only the rustup target), and it has no device/HAL/model dependency
— it is host-testable with deterministic fixtures.

## Where it sits

```text
 PDF ──amos-pdf-parser──▶ chunks        ┌─────────────────────────────┐
 note/md body ──────────▶ chunks        │       amos-ai (daemon)      │
        │                               │  embedder: Ollama /api/…    │
        ▼                               │  (owned HERE — not in core) │
   chunk text ──embed──▶ Vector{id,data}│                             │
                            │ add/upsert│  ┌────────────────────────┐ │
                            ▼           │  │ amos-vector-db (core)  │ │
                        FlatIndex       │  │  dim-checked, finite,  │ │
                            ▲ search    │  │  deterministic top-k,  │ │
   query text ──embed──▶ query vector   │  │  versioned snapshot    │ │
                            │           │  └────────────────────────┘ │
                            └──────────▶ top-k ids → assemble context └▶ local 7B
```

The **core never talks to a server and never embeds text**. It consumes
already-made vectors. Embedding is the one outward seam (`Embedder`); the real
adapter for AmOS is an **Ollama `/api/embeddings` model served locally**, which
belongs in `amos-ai` (it already owns the HTTP client and the
`AMOS_OLLAMA_HOST` / local-server lifecycle for its chat path).

## Public surface

| API | Role |
| --- | --- |
| `Vector::new(id, data)` | validated embedding (non-empty id, non-empty, all-finite) |
| `FlatIndex::new(dim)` | index with a fixed embedding dimension |
| `add` / `upsert` / `remove(id)` | insert / replace-by-id (note edit) / delete |
| `search(query, Metric, k)` | exact top-k, cosine or dot |
| `snapshot_bytes` / `load_bytes` / `save_to` / `load_from` | versioned, validated persistence |
| `Embedder` / `MockEmbedder(dim)` | seam; deterministic offline embedder |
| binary `examples/bench_arm` | honest host/dev benchmark (`[COUNT] [DIM]`) |

## What is guaranteed (and tested)

* **Dimension-checked and finite-only.** `FlatIndex` has one dimension; a vector
  of the wrong length is `DimMismatch`; a `NaN`/`inf` (query or stored) is
  rejected — a poisoned value can never silently corrupt retrieval or ordering.
* **Exact & deterministic top-k.** Retrieval is a flat scan over all stored rows
  scored by the metric. Equal-scoring hits are ordered by **ascending id**, so
  two searches — or two index *build orders* — return identical results (locked
  by a test that adds the same ids in reversed order).
* **Idempotent note editing.** `upsert` with an existing id replaces that row in
  place (never a stale duplicate); `remove` drops it from future retrieval. The
  end-to-end test re-indexes an edited note and asserts the old vector is gone.
* **Dimension change is a hard error, not silent.** Switching to an embedding
  model whose vectors have a different length fails the `upsert` — the daemon
  must surface "re-index required", never quietly mix dimensions.
* **Honest snapshot.** `version: 1`; loading rejects a wrong version, a zero
  dimension, or any row that is empty-id / wrong-length / non-finite. A missing
  snapshot file is a plain I/O error (a caller *chooses* to start fresh).
* **No crashes.** `#![forbid(unsafe_code)]`, production-time
  `deny(clippy::unwrap_used / expect_used / panic)`; cosine of a zero vector is
  `0.0`, never `NaN`.
* **Soft, honest retrieval.** Searching an empty index returns an empty result —
  never a fabricated hit.

## Honest boundaries

| Boundary | Reality | Consequence |
| --- | --- | --- |
| Exact in-memory scan | no disk index, no ANN | fine for thousands of chunks; add approximate search *only after* `bench_arm` on-device shows a need |
| Snapshot stores vectors + ids | **not** the raw chunk text | persistence is for retrieval; re-rendering context needs the passage store owned by the daemon/Notes layer |
| Embedding quality & dimension | a real-model property | `MockEmbedder` is **not semantic** (host wiring only); dimension/latency/quality come from the real Ollama model on device |
| "ARM embedding latency" figure | unverified until measured | `examples/bench_arm` only measures the **index**, on this host — the product number is a real-device measurement, never a claim here |
| Ollama on-device serving | a separate system service | Android deployment of Ollama is a bring-up seam (`deploy/android/*.rc`), not something this crate does |

## Verification

```bash
cargo test -p amos-vector-db                 # 35 unit + 6 end-to-end
cargo clippy -p amos-vector-db --all-targets -- -D warnings
cargo fmt -p amos-vector-db -- --check
cargo run -p amos-vector-db --example bench_arm -- 20000 384   # host index bench
# Android cross-compile gate (pure Rust on serde — no NDK linker for a check):
cargo check -p amos-vector-db --target aarch64-linux-android
# Convenience wrapper above + host tests + clippy + fmt + a small bench:
make vector-db-check
```

The workspace `cargo test --workspace` picks up this crate's `tests/` and the new
member automatically.

## Status & next steps

Landed (2026-09-09):
* `amos-vector-db` — pure retrieval core (`FlatIndex`/`metric`/`model`/`embed` +
  snapshot); 41 tests, host + aarch64 cross-compile.
* `amos-ai/src/rag.rs` — `OllamaEmbedder` (`/api/embeddings`, bearer-capable,
  transport-tested) + `RagStore` (embedder + `FlatIndex`).
* `amos-ai/src/rag_service.rs` + proto `service Rag` — a gRPC `Rag` service
  mounted on the daemon's shared UDS: `Index` / `Remove` / `Query` / `Status`.
  Embedder is mock (offline) by default, `AMOS_RAG_EMBEDDER=ollama` for a real
  local model. "Retrieve-then-answer" is composed by the caller from `Rag.Query`
  (returns nearest ids **+ their passage text** for citations) then
  `AiAgent.StreamChat` with that context dropped into the prompt. Durable state:
  `AMOS_RAG_STATE` persists the vector snapshot + passages atomically and a
  restart re-hydrates them. UDS e2e: `rag_rpc_e2e.rs` + `rag_persist_e2e.rs`.
  `amos-ai` lib tests: **202**.
* Svelte-side client + Tauri bridge + orchestration — `frontend-ts/src/lib/rag.ts`
  (type-guarded parsing + `backend.invoke` seam, offline ⇒ `null`) and
  `amos-tauri/src/rag_client.rs` (`rag_status` / `rag_query` / `rag_index` /
  `rag_remove`, each opening a `RagClient` over the daemon UDS), plus
  `frontend-ts/src/lib/notesRag.ts` (UI-agnostic: stable `note:<id>` naming,
  bulk upsert / removal decisions, cited-context + prompt assembly, and a
  busy/error state machine a Notes/Ai component can mount). Headless tests:
  23 (`rag.test.ts` 11 + `notesRag.test.ts` 12) + 3 bridge mapping tests;
  `tsc` / clippy / fmt clean.

Still open (live wiring — only verifiable in a running app / on device):
* Wire **`AiApp` / `NotesApp`** to `lib/rag.ts` + `notesRag.ts` so "index this
  note / ask my files" is reachable from the UI; that is also where the real ARM
  numbers get measured on-device.




## Recorded on-device measurement (2026-09-09)

`examples/bench_arm` cross-compiled to `aarch64-linux-android` (release) and run
on the bring-up device — **S5 · SDK34 · arm64-v8a · MediaTek MT6768**:

| corpus | ingest | top-5 exact search |
| --- | --- | --- |
| 2 000 × 64 | ≈ 6.95 µs/insert | ≈ 0.82 ms/query |
| 20 000 × 384 | ≈ 85 µs/insert | **≈ 45.5 ms/query** |

These are the **index/retrieval** figures (exact flat scan, single-threaded
release, no SIMD). They are the real measured basis for the "flat-exact first,
add ANN only if the device benchmark says so" decision. The separate
**embedding-latency** figure (Ollama `/api/embeddings`) still requires an Ollama
install + model on-device and is deliberately NOT claimed here.

## On-device daemon bring-up (2026-09-09)

Cross-compile recipe (the `.cargo/config.toml` sets the linker, but a C build-dep
still needs `CC`/`AR` + the NDK `bin` on PATH or cc-rs cannot find the Android
clang):

```bash
NDK=/opt/homebrew/share/android-commandlinetools/ndk/23.1.7779620/toolchains/llvm/prebuilt/darwin-x86_64/bin
export CC_aarch64_linux_android=$NDK/aarch64-linux-android31-clang
export AR_aarch64_linux_android=$NDK/llvm-ar
export PATH="$NDK:$PATH"
cargo build -p amos-ai --target aarch64-linux-android --release --bins --examples
adb push target/aarch64-linux-android/release/amos-ai /data/local/tmp/amos-ai-rag
adb push target/aarch64-linux-android/release/examples/rag_once /data/local/tmp/rag_once
```

Running the daemon as **adb `shell` (no root)** on this FreemeOS/MTK ROM hits a
SELinux block when the daemon binds a **Unix socket** in `/data/local/tmp`
(`Permission denied`, shell domain). The daemon's **TCP loopback mode**
(`AMOS_TCP_ADDR=127.0.0.1:19090`) avoids the socket-file bind and works from the
`shell` context:

```bash
adb shell 'cd /data/local/tmp && nohup env AMOS_TCP_ADDR=127.0.0.1:19090 AMOS_RAG_EMBEDDER=mock AMOS_BACKEND=mock ./amos-ai-rag >amos-rag.log 2>&1 </dev/null &'
adb shell /data/local/tmp/rag_once http://127.0.0.1:19090
```

`rag_once` accepts either a UDS path or an `http://host:port` (h2c). Observed
on-device round-trip (mock embedder, no model): `indexed note:a dim=384` →
self-matching `query` returns the passage `score≈1.0` → `remove` → `indexed=0`.
A real device deployment (AOSP `init.rc` service as system/root) can still use
the Unix socket; the TCP mode is the adb-shell bring-up path.

The above is wrapped in a repeatable one-shot driver: `scripts/android-rag-bringup.sh`
(`--check-prereqs` / `--dry-run` / `--apply`, mirrors `android-voice-bringup.sh`)
or `make android-rag-bringup ARGS='--apply'`. It pushes the three binaries, runs
the ARM `bench_arm`, then in one blocking adb call starts the daemon (TCP, mock
embedder), runs the `rag_once` index/query/remove round-trip, and stops the daemon.

### Embedding-latency feasibility (2026-09-09, on the S5)

Still the one deliberately-unmeasured metric. On-device probe found: **no root**,
**no `curl`/`wget`** (only `nc`), `MemTotal ≈ 7.8 GB` (not 12), `/sdcard` has
~221 GB free. So the honest read is: installing a real Ollama + embedding model
on this constrained device is high-effort / mid-success — the Ollama Android
binary + a model GGUF must be fetched **on the host** and `adb push`ed (Ollama's
blob store layout makes hand-placing a model fragile), and `ollama serve` must
survive in the `shell` SELinux context. Recommended path when pursued: host-side
download of a small embedding GGUF (e.g. `nomic-embed-text` / an `all-MiniLM`
GGUF), push into an Ollama data dir under `/data/local/tmp`, start `ollama serve`
(TCP 11434) as a daemon, then call `/api/embeddings` from the host/device to
measure dim + ms — reusing `rag_once`'s TCP pattern. This remains the documented
open item until executed.





