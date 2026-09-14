# amos-devocare — device care (手机管家) domain core

The engine behind "device care": scan for junk, analyse it, produce a plan a human
acknowledges, execute it — with an uninstall guard that refuses to remove anything the
system needs, a read-only permission review, and a folded report where an unassessed area
stays **unassessed**. Pure, deterministic, no I/O. Part of **[Amos](../../README.md)**.
Design record: [`docs/devcare.md`](../../docs/devcare.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- **scan → analyse → plan → execute**, with the plan carrying *why* each item is reclaimable
  (`reclaim_rank`, `is_reclaimable`, `RECLAIMABLE_STATES`) — never "trust me, it's junk".
- **`UninstallGuard` + `CRITICAL_PACKAGES`** refuse system and pinned-critical removals; the
  refusal is a typed error, not a warning a caller can ignore.
- **Review-only items need acknowledgement**: a plan that would delete something requiring
  review does not execute until the caller says so (`spec.rs`).
- **URI dedup** across scan roots: the same file found twice is one item.
- **A root-confined `hostfs` backend** (bounded depth, no symlink following) and a
  `CleanProvider` seam, so the engine is exercised offline with a mock and on a device with
  real paths. **User media is never matched.**
- **`health.rs`** folds the findings into one report; an area that was not assessed is
  reported as `unassessed`, never as clean.

It is **not** an antivirus: there is no signature database, no network lookup and no
behaviour monitoring. It is a well-bounded cleaner with honest accounting.

## Layout

| file | what |
|---|---|
| `src/junk.rs` | junk classes, scoring, the scan rules |
| `src/spec.rs` | scan/plan/execute types, review gating |
| `src/boost.rs` | `reclaim_plan`, `reclaim_rank`, `is_reclaimable`, `RECLAIMABLE_STATES` |
| `src/guard.rs` | `UninstallGuard`, `CRITICAL_PACKAGES` |
| `src/permissions.rs` | read-only sensitive-permission review |
| `src/health.rs` | the folded care report |
| `src/provider.rs` | `CleanProvider` seam + mock |
| `src/hostfs.rs` | root-confined filesystem backend (bounded depth, no symlink follow) |
| `src/audit.rs` | what was decided, for the record |
| `src/error.rs` | `DevCareError`, `Result`, `SCAN_ITEM_CAP` |

## Build & test

```bash
cargo test -p amos-devocare
cargo clippy -p amos-devocare --all-targets -- -D warnings
cargo fmt -p amos-devocare -- --check
```

## Examples

```bash
# Scan → plan → (review gate) → execute, with the guard refusing a system package.
cargo run -p amos-devocare --example care_cycle
```

| example | shows |
|---|---|
| `care_cycle` | a mock provider's scan, the plan it produces and its per-item reasons, a review-only item blocking execution until acknowledged, the uninstall guard refusing a critical package, and the folded report with an `unassessed` area |

## Honest boundaries

- **`SCAN_ITEM_CAP` bounds the scan**: a directory with more entries than the cap reports a
  truncated result, and the report says so.
- **No filesystem may be touched by the engine itself**: every read/delete goes through the
  `CleanProvider` seam, so the domain rules are pure and the hostfs backend is the only
  place that can be wrong about paths.
- **"Review-only" is a hard gate**, not a UI hint.
- **Nothing here is a security boundary**: reading permissions is a review, and the guard is
  a safety policy for *this* engine — a root shell is outside its scope.

## Related

- [`docs/devcare.md`](../../docs/devcare.md) — the scan classes, the guard policy and the
  report shape.
- [`crates/amos-media`](../amos-media/README.md) — the media collections device-care
  deliberately never matches.
