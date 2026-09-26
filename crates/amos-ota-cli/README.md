# amos-ota-cli — drive the update decision layer from a terminal

Parses and compares versions, hashes an image, and folds a manifest + policy + device facts
into a decision — then, for `install`, runs the whole pipeline against a **local** image in
dry-run. It is the reference consumer of **[`crates/amos-ota`](../amos-ota/README.md)**'s public
API. Part of **[Amos](../../README.md)**.

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

```text
amos-ota-cli version <A> [B]                 parse a version, or compare A and B
amos-ota-cli digest <file>                   print the SHA-256 a manifest must carry
amos-ota-cli check   --manifest <file> [opts]        the decision, printed
amos-ota-cli install --manifest <file> --image <file> [opts]   + the pipeline, dry-run
```

- **Exit codes carry the kind of answer**, so a script can branch without parsing prose:
  `0` eligible/up-to-date/ok, `10` deferred (a transient condition), `11` refused (a durable
  one), `2` usage error, `1` a real error.
- `--json` emits one JSON object, so the same decision is machine-readable.
- `install` fetches from a **local file** (a `MockUpdateProvider`), hashes it, checks the
  signature, and drives the install machine to `Staged`. It stages nothing on the host,
  reboots nothing, and says so.
- **The signature check has two modes, and the transcript names which one ran.**
  `--trust-key <id>` is *policy-only*: it matches the key id against a list and verifies no
  mathematics (`amos_ota::TrustingVerifier`, documented as **not a security boundary**).
  `--trust-key-hex <id>=<32-byte-hex>` is the **real** path — RFC 8032 Ed25519 against the
  public key you supply (`amos_ota::Ed25519Verifier`). The two are mutually exclusive on
  purpose: a forged signature on a trusted key id passes the first and fails the second, so
  picking one keeps the printed verdict attributable to the check that actually ran. A
  present-but-untrusted signature **fails** the install unless `--allow-untrusted` is given.

It is **not** an updater service: it makes the decision visible and exercisable without a
device; the real fetch/deploy half lives behind the library's seams.

## Layout

| file | what |
|---|---|
| `src/main.rs` | the binary: argv → `run` → exit code |
| `src/lib.rs` | `run`, the commands, option parsing, `render_human`/`render_json`, exit-code constants |

The tests live in `src/lib.rs` (in-process, calling `run` with an in-memory writer, so the
whole surface — output and exit code — is asserted without spawning a process).

## Build & test

```bash
cargo test -p amos-ota-cli
cargo clippy -p amos-ota-cli --all-targets -- -D warnings
cargo fmt -p amos-ota-cli -- --check
cargo run -p amos-ota-cli -- version 1.0.0-rc.1 1.0.0
```

## Examples

```bash
# The CLI as a library, offline: a deferred decision (exit 10) then a dry-run install.
cargo run -p amos-ota-cli --example embed_decide
```

| example | shows |
|---|---|
| `embed_decide` | `run` called in-process with a temp manifest: an unknown-battery deferral (exit 10) and an eligible install that reaches `Staged` (exit 0) |

## Honest boundaries

- **`install` is a dry run.** It uses a local image as the "download" and never writes a
  system slot, arms a bootloader or reboots — it reports the state it reached and stops.
- **`digest` is the only thing it does to real bytes** on disk; everything else is the
  library's pure policy fold.
- **No CDN client here.** Fetching a manifest over the network is a `check`-time concern the
  caller supplies; the CLI reads manifest JSON from a path.
- **The decision is only as current as the facts you pass** (`--current`, `--wifi`, …). The
  CLI does not probe the device.

## Related

- [`crates/amos-ota`](../amos-ota/README.md) — the decision layer this drives.
- [`docs/FEATURE_GAP_AUDIT_2026_SEP20.md`](../../docs/FEATURE_GAP_AUDIT_2026_SEP20.md) — the audit
  that recorded the missing update path.
