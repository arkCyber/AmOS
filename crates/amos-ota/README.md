# amos-ota — the system-update (OTA) decision layer

Answers three questions about a system image deterministically and honestly — *is there an
update for me?*, *may I install it right now?*, *did the bytes arrive intact?* — over a
manifest, a policy and a set of device facts. Part of **[Amos](../../README.md)**. Design
record: [`docs/FEATURE_GAP_AUDIT_2026_SEP20.md`](../../docs/FEATURE_GAP_AUDIT_2026_SEP20.md) §3
(OTA row: previously a zero-hit `grep -rn 'updater'`).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- **SemVer-correct precedence** ([`version::Version`]): build metadata is ignored for both
  ordering *and* equality, numeric prerelease identifiers sort below alphanumeric ones, and a
  release outranks its own prereleases — the rules a rollout actually depends on.
- **Channels + staged rollout** ([`spec::Channel`], [`spec::Cohort`]): a device follows one
  channel, and a cohort is a deterministic FNV-1a bucket over the device id, so widening a
  wave adds devices without reshuffling the ones already in it.
- **A fixed-order policy fold** ([`policy::evaluate`]): reflash → up-to-date → prerelease →
  signature → cohort → window → Wi-Fi → battery → eligible. "I do not know"
  (an unreadable battery level on battery power) is a **deferral**, never an accidental "yes".
- **Integrity before authenticity** ([`verify`]): the payload is hashed against the published
  SHA-256 first; a signature is only checked once the digest matched.
- **A single-invariant install machine** ([`install::InstallMachine`]): `Staged` is reachable
  **only** from a verified payload — there is no shortcut around the hash.

It is **not** a flasher: writing the image to the A/B slot, arming the bootloader and rebooting
belongs to the runtime (Android's `PackageInstaller`, a Tauri updater on desktop). This crate
decides and tracks.

## Layout

| file | what |
|---|---|
| `src/version.rs` | `Version`: strict SemVer parse + precedence |
| `src/spec.rs` | `Channel`, `Cohort`, `Manifest`, `UpdatePackage`, `Signature`, `MAX_PACKAGE_BYTES` |
| `src/policy.rs` | `DeviceFacts`, `UpdatePolicy`, `Decision`, `evaluate` |
| `src/verify.rs` | `sha256_hex`, `check_integrity`, `verify_signature`, `SignatureVerifier`, `Ed25519Verifier` (real, RFC 8032), `TrustingVerifier` (policy-only) |
| `src/install.rs` | `InstallMachine`, `InstallState`, `FailReason` |
| `src/provider.rs` | the `UpdateProvider` seam + `MockUpdateProvider` |
| `src/error.rs` | `OtaError` / `Result` |
| `tests/ota_e2e.rs` | the public-API contract: manifest JSON → eligible → stages; and the ways it must refuse to lie |

## Build & test

```bash
cargo test -p amos-ota
cargo clippy -p amos-ota --all-targets -- -D warnings
cargo fmt -p amos-ota -- --check
```

## Examples

```bash
# A manifest, two device fact-sets, and the pipeline driven to Staged — fully offline.
cargo run -p amos-ota --example plan_update
```

| example | shows |
|---|---|
| `plan_update` | the same device under a 0%/100% rollout and above/below the battery floor, then the eligible one fetched, hashed, signature-checked and staged |

## Honest boundaries

- **The network is a seam.** Only [`provider::MockUpdateProvider`] ships; a real deployment
  implements `UpdateProvider` over the CDN client.
- **Two verifiers, and only one of them is a security boundary.** `TrustingVerifier` is
  policy, not cryptography: it checks *whether a key id is trusted* and *whether the
  signature is shaped like one* — it does **not** verify Ed25519/ECDSA mathematics and is
  documented as not a security boundary. The **real** verifier is [`verify::Ed25519Verifier`]
  — RFC 8032 over a caller-supplied table of trusted public keys, pinned against the RFC's own
  vectors and reachable from the `--trust-key-hex` path in the CLI and
  `AMOS_OTA_TRUST_KEY_HEX` in the host bridge; ECDSA is not offered, and a deployment needing
  it implements the same [`verify::SignatureVerifier`] seam.
- **No clock, no I/O, no runtime.** Everything is pure `std` + `sha2` + `ed25519-dalek`, so
  the whole policy is offline-testable; the caller observes the device facts and supplies the
  time window.
- **The deploy half is the runtime's**, as above — this crate never writes a slot.

## Related

- [`crates/amos-ota-cli`](../amos-ota-cli/README.md) — drive the decision layer from a terminal.
- [`docs/FEATURE_GAP_AUDIT_2026_SEP20.md`](../../docs/FEATURE_GAP_AUDIT_2026_SEP20.md) — the audit
  that recorded the missing update path.
