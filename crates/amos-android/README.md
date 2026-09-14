# amos-android — Android-compat layer (Waydroid container, APKs, LMK)

Drives a Waydroid/LXC Android container from Rust: launch and stop APKs, list what is
installed, extract app icons, watch activity state and hand the container's memory pressure
to the OS reclaim proxy — then expose all of it over gRPC (`AndroidManager`) so the System
UI and the daemon use one path. Part of **[Amos](../../README.md)**. Design records:
[`docs/android-compat.md`](../../docs/android-compat.md),
[`docs/android-lmk-e2e.md`](../../docs/android-lmk-e2e.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

- **Shell-driven container control** through a `CommandRunner` seam (`ShellRunner` in
  production): `AndroidController::{launch_apk, list_installed_apps, force_stop,
  install_apk}`. Pure parsers (`parse_app_list`, `extract_icon_bytes`) sit beside it, so the
  command construction and the output parsing are testable without a container.
- **A capability ledger** (`CapabilityLedger`) records which package was granted which
  resource key, so a revoked app cannot keep a grant by accident.
- **Activity observation** (`FoldingObserver`, `activity_id`) folds raw activity events into
  "which app is on top", which is what memory/energy policy needs.
- **The LMK proxy** (`lmk.rs`: `ActivityState`, `MemoryPressure`) maps container memory
  pressure onto the states `crates/amos-applife` reclaims.
- **Icons** (`png.rs::icon_png`) turn an APK's icon bytes into a PNG the UI can show.

It is **not** an emulator or a hypervisor: it orchestrates Waydroid/LXC and `adb`/`waydroid`
commands that must already exist on the device.

## Layout

| file | what |
|---|---|
| `src/controller.rs` | `AndroidController<R: CommandRunner>`, `ShellRunner`, `parse_app_list`, `extract_icon_bytes` |
| `src/capability.rs` | `CapabilityLedger` (+ `valid_resource_key`) |
| `src/activity_observer.rs` | `activity_id` / `activity_id_parts`, `FoldingObserver` |
| `src/lmk.rs` | `ActivityState`, `MemoryPressure` — the reclaim proxy |
| `src/manager.rs` | `EnhancedAndroidManager`, `AndroidManagerConfig`, `CacheStats` |
| `src/runtime.rs` | `AndroidRuntime`, `WaydroidRuntime`, `DemoRuntime`, `auto()` |
| `src/png.rs` | `icon_png` — icon bytes → PNG |
| `src/service.rs` | the tonic `AndroidManager` service |

## Build & test

```bash
cargo test -p amos-android                       # parsers, ledger, observer, LMK rules
cargo clippy -p amos-android --all-targets -- -D warnings
cargo fmt -p amos-android -- --check
```

## Examples

```bash
# Drive the controller against a fake shell: shows the exact commands it would run.
cargo run -p amos-android --example controller_offline
```

| example | shows |
|---|---|
| `controller_offline` | a `CommandRunner` that records instead of executing: the `waydroid`/`adb` command lines for launch/stop/install, the parsed app list, the capability ledger across grant→revoke, and an LMK pressure decision |

## Honest boundaries

- **No container is started by the tests or examples.** The seam means the *commands* and
  the *parsing* are proven offline; whether Waydroid itself behaves that way is a device
  verification item (`docs/android-lmk-e2e.md`).
- **`extract_icon_bytes` is best-effort**: an APK whose icon is not a plain PNG yields
  `None` rather than a fabricated image.
- **Capabilities are this crate's bookkeeping**, not a kernel sandbox: they record what AmOS
  granted; enforcing it is the container's job.
- **The LMK proxy reports; it does not kill.** Reclaim decisions belong to
  `crates/amos-applife`, execution to the host.

## Related

- [`docs/android-compat.md`](../../docs/android-compat.md) — the compat layer's contract and
  the W-series acceptance items.
- [`docs/android-lmk-e2e.md`](../../docs/android-lmk-e2e.md) · [`docs/android-storage-unify.md`](../../docs/android-storage-unify.md)
- [`proto/android_compat.proto`](../../proto/android_compat.proto) — the gRPC surface.
- [`crates/amos-applife`](../amos-applife/README.md) — the reclaim policy this feeds.
