# Tauri event audit — "an event nobody receives, or a payload nobody can read"

## Why this exists

The boundary now has a gate per wire direction, and each one found real defects:

| Gate | Direction | Found |
| --- | --- | --- |
| `unwired-scan.mjs` | is an export *called*? | `ClipboardAnnounce` unmounted, the RAG run never invoked |
| `tauri-command-scan.mjs` | is a command *asked for*? | the shared-store write-through was dead |
| `tauri-args-scan.mjs` | can the call **succeed**? | `rag_query`'s `top_k`, `interpret_start`'s `source_lang` |
| `tauri-reply-scan.mjs` | is the **reply** what the shell thinks? | the SMS trash panel, dead on device |
| **`tauri-event-scan.mjs`** | does the **event** reach anyone, and can it be read? | one documented deviation (below), **no new defect** |

Events are where this codebase has silently lost features twice (the dead
store write-through, the multi-window layout subscription), so the direction is
worth holding even when it is clean.

## What it checks

1. **emitted ⇒ consumed** — every event name the host emits (a quoted literal or a
   `*_EVENT` constant, resolved **workspace-wide** so a constant defined in
   `backend.ts` and used in `MessagesApp.svelte` still resolves) must appear in a
   production `subscribe(...)`/`listen(...)`, or be allow-listed with a reason.
2. **consumed ⇒ emitted** — a screen subscribing to an event no Rust code emits can
   never fire.
3. **payload fields** — for events whose payload is a plain Rust **struct** and
   whose wire shape a TypeScript type mirrors, every field the TS type declares must
   exist in the struct's serialized field set (the `tauri-reply-scan` comparison,
   one direction over).

### The reviewed payload table

The event→shape link cannot be inferred statically (nothing in the source says
"this subscribe handler parses that struct"), so it is an explicit, reviewed table
inside the script — a **recorded decision**, not a guess:

| Event | Rust payload | TS wire view |
| --- | --- | --- |
| `telephony-event` | `telephony::TelephonyCallPayload` | `TelephonyCall` (`lib/backend.ts`) |
| `lmk-surface` | `android_lmk::LmkSurfacePayload` | `LmkSurfacePayload` (`lib/lmk.ts`) |
| `sensor-data` | `sensor_host::SensorHostEvent` | `SensorDataEvent` (`lib/sensorEvents.ts`) |
| `telemetry-spy-hit` | `telemetry_spy::SpyHitPayload` | `SpyHitPayload` (`lib/telemetrySpy.ts`) |
| `clipboard-changed` | `clipboard::ClipboardNotice` | `ClipboardNotice` (`lib/clipboard.ts`) |
| `layout-changed` | `wm::LayoutSnapshot` | `LayoutSnapshot` (`lib/wm.ts`) |
| `store-updated` | `store::StoreUpdated` | inline `{ key, value }` (`svelte/store.ts`) |

## Honest boundary

* **Out of scope, deliberately:** events whose payload is a **serde-tagged enum**
  (`interpret-output` → `InterpretEventPayload`, `assistant-voice-event` →
  `VoiceEventPayload`) or a **tuple** (`ai-session-complete` → `[sid, full]`,
  `ai-card-received` → `CardPayload`'s `kind`/`title`/… are checked by their own
  unit tests). A tagged enum's `fields` in the parser are *variant names*, not wire
  fields, so comparing them would be noise, not signal.
* A name that cannot be resolved statically (a computed constant) is **reported as
  skipped**, never counted as fine. Today: **5** such names, all inside the bridge's
  own generic `subscribe` plumbing.
* `window.addEventListener("hardware-button")` is a DOM channel, not a Tauri event;
  the scan records it separately so it cannot be mistaken for an event subscriber.

## Findings (Round 48)

No new defect. The direction is clean: **15 emitted names, 14 subscribed, 7 payload
shapes checked, 0 field findings**. One recorded deviation:

| Finding | Verdict |
| --- | --- |
| `hardware-button` — emitted by `buttons::HardwareButtons::press`, subscribed by no screen | **allow-listed with a reason**: the shell consumes a press through the pull command `take_pending_hardware_button` (polled by `svelte/osInputBridge.startOsHardwarePoll`) and through the DOM `CustomEvent` that `buttons::dispatch_dom` evaluates into every webview (`startOsInputBridge`). The Tauri `emit` stays as the plugin path for a host that delivers `plugin:event|listen`; adding a third handler would double-fire navigation, and deleting it is a device-behaviour change that cannot be verified in this environment. |

## Running it

```sh
node scripts/tauri-event-scan.mjs                 # gate (exit 1 on any finding)
node scripts/tauri-event-scan.mjs --json          # machine-readable
node scripts/tauri-event-scan.mjs --selftest      # pin the extractors (10 assertions)
```

It runs in `make lint` (hence CI), self-test first. Negative controls verified:
renaming `SpyHitPayload::ts_ms` ⇒ FAIL naming the field and the real field list;
a `subscribe("no-such-event")` ⇒ FAIL as "no Rust code emits it"; both restored ⇒ OK.

Both `tauri-reply-scan.mjs` and `tauri-event-scan.mjs` now guard their
selftest/scan dispatch behind "am I the entry point?", so the event gate may import
the reply gate's extractors instead of duplicating them.
