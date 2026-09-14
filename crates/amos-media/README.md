# amos-media — media / external-storage domain core

Specifies the standard Android file collections (DCIM/Camera, Pictures, Download,
Recordings…), exposes a `MediaProvider` seam for reading and writing them, and keeps the
access grants explicit: what a caller may load is a size-checked, path-checked decision.
Part of **[Amos](../../README.md)**. Design record:
[`docs/media.md`](../../docs/media.md) · [`docs/media-player.md`](../../docs/media-player.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- `StandardDir` / `MediaKind` / `MediaItem` model the collections and one item's metadata,
  so the gallery, the player and device-care speak one vocabulary.
- `MediaManager` owns **grants** (`Grant`) and `AccessKind`: a read or write is allowed only
  for a declared collection, and the decision is a value the caller can print.
- **Bounded payloads**: `MAX_LOAD_BYTES` / `MAX_SAVE_BYTES` are enforced on both sides, so a
  malformed item cannot make a device allocate its way into a crash.
- `src/range.rs` implements byte-range handling the player needs (seek without loading a
  whole file); `src/hostfs.rs` is a real filesystem backend for host runs;
  `src/android.rs` (feature `android`) is the `MediaStore`/SAF path.
- `src/mapping.rs` is the single place a MIME type/extension becomes a `MediaKind`.

It is **not** a codec: decoding and playback belong to the player app, not this crate.

## Layout

| file | what |
|---|---|
| `src/spec.rs` | `StandardDir`, `MediaKind`, `MediaItem`, `AccessKind` |
| `src/manager.rs` | `MediaManager`, `Grant` (the access decision) |
| `src/provider.rs` | `MediaProvider` seam, `MockMediaProvider`, `MAX_LOAD_BYTES`, `MAX_SAVE_BYTES` |
| `src/hostfs.rs` | `HostFsProvider` — a real filesystem backend for host runs |
| `src/range.rs` | byte-range parsing/serving for media playback |
| `src/mapping.rs` | extension/MIME → `MediaKind` (one table, one place) |
| `src/android.rs` | *(feature `android`)* the device backend |

## Build & test

```bash
cargo test -p amos-media
cargo check -p amos-media --features android
cargo clippy -p amos-media --all-targets -- -D warnings
```

## Examples

```bash
# Grant-checked scan + bounded read + a byte range, against a real temp directory.
cargo run -p amos-media --example scan_dir
# Metadata without a big allocation (also the on-device probe).
cargo run -p amos-media --example probe_media -- <path>
```

| example | shows |
|---|---|
| `scan_dir` | a host directory scanned through `HostFsProvider`: the collections found, an item's metadata, a granted read, a refused read outside the grant, and a seek by byte range |
| `probe_media` | one file's kind/MIME/size without loading it — the probe used during device bring-up |

## Honest boundaries

- **Grants are this crate's model, not a kernel permission**: on device the real gate is
  `MediaStore`/SAF; here it makes the *intent* explicit and testable.
- **No codec, no thumbnail generation**: a caller that wants a poster frame does that itself.
- **Size caps are hard**: an oversized load/save is refused, never partially applied.
- **`hostfs` is for host runs**: it follows no symlinks into unexpected places, but it is not
  a sandbox.

## Related

- [`docs/media.md`](../../docs/media.md) — collections, grants and the Android storage
  unification.
- [`docs/media-player.md`](../../docs/media-player.md) — the player that consumes ranges.
- [`crates/amos-devocare`](../amos-devocare/README.md) — the cleaner that never touches user
  media.
