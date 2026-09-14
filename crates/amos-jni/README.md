# amos-jni — shared JNI plumbing for the Android providers

The two rules every Android provider in the workspace must follow, implemented **once**:
a `JNIEnv` always comes from a clean, attached thread, and a glue class is resolved through
the **app's** class loader. Part of **[Amos](../../README.md)**. Design record:
[`docs/android-glue.md`](../../docs/android-glue.md). Sibling crate:
[`crates/amos-radio`](../amos-radio/README.md).

> ⚠️ Amos is a research prototype — not qualified for safety-critical use (see the
> [root README](../../README.md)).

## What it is

AmOS's System UI APK runs Rust provider code that talks to Android through JNI, and one
failed JNI call can **kill the process** on the next call if the exception it left behind
is not cleared. That is not a theory — a device round proved it (a `find_class` failure on
a tokio worker thread aborted the app under CheckJNI on the following `NewStringUTF`).

Measured across the workspace at that time: **15 modules, 52 JNI call sites, and the
exception was cleared in exactly one place.** So the rules live here:

- [`clear_pending`] — drop any exception the JVM left pending on this thread. A pending
  exception makes the *next* JNI call abort the whole process; clearing is attempted before
  a sequence and again after a failed one, and a failure to clear is reported (never
  swallowed) because the VM is then in trouble.
- [`attached`] / [`with_env`] — every `JNIEnv` a provider uses comes from here, so an
  earlier operation on the same pooled thread cannot poison the next one.
- [`jni_call!`] — clears immediately after a failed call at each site, for the
  remaining in-operation case (a failure followed by more JNI calls on the same thread).
  [`ClearAfterFailure`] is the trait the macro expands to, accepting either an owned
  `JNIEnv` or a reference (call sites have both shapes).
- [`resolve_class`] — resolves a glue class through `Context#getClassLoader` and caches it
  as a global ref, because `JNIEnv::find_class` uses the *calling thread's* loader
  (bootstrap on a tokio worker ⇒ `ClassNotFoundException`).

It is **not** a binding generator, an `android` facade, or a place for provider logic: it
is the minimum shared plumbing the providers import instead of re-deriving.

## Layout

| file | what |
|---|---|
| `src/lib.rs` | `clear_pending`, `attached`, `with_env`, `ClearAfterFailure`, `jni_call!`, `resolve_class`, and the crate's `Result<T> = Result<T, String>` |

One file is deliberate: the crate exists to be small enough that the whole surface can be
read at once, and every rule is a short function or macro.

## Build & test

```bash
cargo check -p amos-jni
cargo test -p amos-jni
cargo clippy -p amos-jni --all-targets -- -D warnings
cargo fmt -p amos-jni -- --check
```

## Examples

There is no `examples/` directory **on purpose**, and the reason is recorded in
[`scripts/crate-readme-allowlist.json`](../../scripts/crate-readme-allowlist.json): every
entry point needs a live JVM, `JNIEnv` and the app's class loader, so a host example cannot
run one — and a fake that only printed class names would demonstrate the opposite of what
this crate is for. The crate is exercised on device through the Android providers that use
it.

## Honest boundaries

- **Nothing here is unit-testable without a JVM.** The guarantee is "clears at these
  points" plus the `android` features still compiling; the device is the only place the
  behaviour is observed.
- **The failure that motivated the crate is device-observed, not host-reproduced** — see
  `docs/android-glue.md` for the aborted run and the fix.
- **`resolve_class` caches a global ref**; a class loader that changes out from under a long
  lived process is not handled here.
- The crate is Android-only in practice: on a host it compiles, but there is no JVM to
  attach to.

## Related

- [`docs/android-glue.md`](../../docs/android-glue.md) — the device round, the two rules,
  and the audit of all 52 call sites.
- [`crates/amos-radio`](../amos-radio/README.md) — the Android `RadioProvider` that drives
  the platform through this plumbing.
- [`docs/TRACEABILITY_MATRIX.md`](../../docs/TRACEABILITY_MATRIX.md) — the requirement
  (REQ-A186) this crate exists to satisfy.
