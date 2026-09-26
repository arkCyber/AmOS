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
   **What counts as production is decided by removing `#[cfg(test)]` regions, not by
   cutting the file at the first one** (REQ-A231): a test seam placed above real code
   used to hide everything after it — the scan then reported a live emitter
   (`layout-changed`) as "no Rust code emits it", and — worse — would have stayed
   *green* about a genuinely unconsumed emitter in that region.
2. **consumed ⇒ emitted** — a screen subscribing to an event no Rust code emits can
   never fire.
3. **payload fields** — for events whose payload is a plain Rust **struct** and
   whose wire shape a TypeScript type mirrors, every field the TS type declares must
   exist in the struct's serialized field set (the `tauri-reply-scan` comparison,
   one direction over).
4. **the payload table is a census** (REQ-A521) — *every* emitted event must be
   classified in it (or allow-listed with a reason), and each row declares **how** it
   is accounted for: `object` (compared field by field), `unit` (`()` — nothing to
   compare), `scalar` (a bare string — no field contract), or `opaque` **with a reason**
   (a tuple, a tagged enum TS reads imperatively, a `json!` built by the Android glue).
   Before this check the table held 7 rows for 20 emitted events and nothing said so.

### The reviewed payload table

The event→shape link cannot be inferred statically (nothing in the source says
"this subscribe handler parses that struct"), so it is an explicit, reviewed table
inside the script — a **recorded decision**, not a guess:

| Event | Rust payload | TS wire view | Kind |
| --- | --- | --- | --- |
| `telephony-event` | `telephony::TelephonyCallPayload` | `TelephonyCall` (`lib/backend.ts`) | object |
| `lmk-surface` | `android_lmk::LmkSurfacePayload` | `LmkSurfacePayload` (`lib/lmk.ts`) | object |
| `sensor-data` | `sensor_host::SensorHostEvent` | `SensorDataEvent` (`lib/sensorEvents.ts`) | object |
| `telemetry-spy-hit` | `telemetry_spy::SpyHitPayload` | `SpyHitPayload` (`lib/telemetrySpy.ts`) | object |
| `clipboard-changed` | `clipboard::ClipboardNotice` | `ClipboardNotice` (`lib/clipboard.ts`) | object |
| `layout-changed` | `wm::LayoutSnapshot` | `LayoutSnapshot` (`lib/wm.ts`) | object |
| `store-updated` | `store::StoreUpdated` | inline `{ key, value }` (`svelte/store.ts`) | object |
| `ai-card-received` | `ai_bridge::CardPayload` | `AiCard` (`lib/stream.ts`) | object |
| `ai-token-received` | `e.token: String` | `tokenOf` (`lib/stream.ts`) | scalar |
| `menu-event` | `id: String` | the menu id string | scalar |
| `ai-chat-complete` | `()` | ignored by `AiApp` | unit |
| `ai-session-complete` | `(String, String)` | `sessionMetaOf` — `[sessionId, fullText]` by index | opaque |
| `interpret-output` | `interpret::InterpretEventPayload` | `kind` branches in `InterpApp` / `lib/interp.ts` | opaque |
| `assistant-voice-event` | `assistant_voice::VoiceEvent` | `kind` branches in `AiApp` | opaque |
| `sms-received` | `sms::SmsIncomingOut` | *(none — the reader re-reads the inbox)* | opaque |
| `ble-value-changed` | `json!({ event, uuid, value })` (glue) | `bleOnValueChanged` (`lib/ble.ts`, unreachable module) | opaque |
| `nfc-tag-discovered` | glue-assembled JSON | `lib/nfc.ts` reader (unreachable module) | opaque |

The remaining three emitted events (`biometric-result`, `dock-badge-changed`,
`hardware-button`) are **allow-listed** with reasons in
`scripts/tauri-event-allowlist.json`; the census accepts a row **or** an allow-list
entry, never silence.

## Honest boundary

* **Out of scope, deliberately — and now recorded per event** (REQ-A521): the census
  classifies each payload it cannot compare instead of omitting it. Two shapes stay
  unverifiable: an internally **tagged enum** (`interpret-output` → `InterpretEventPayload`,
  `assistant-voice-event` → `VoiceEvent`) whose variants TS reads imperatively — a tagged
  enum's `fields` in the parser are *variant names*, not wire fields, so comparing them
  would be noise — and a **tuple** (`ai-session-complete` → `(sid, full)`, serialized as a
  JSON array: no field names at all, and `sessionMetaOf` parses it by index). `ai-card-received`
  used to be listed here as "checked by its own unit tests" — **measured 2026-09-19: no test in
  `ai_bridge.rs` mentions `CardPayload` at all** (only its definition, its use as a field, the
  constructor call and the emit). It is now a scanned `object` row instead, and a rename of any
  field on either side fails the gate.
* A name that cannot be resolved statically (a computed constant or a variable) is
  **reported as skipped**, never counted as fine. Re-measured 2026-09-21 (REQ-A843):
  **4** such names (`emit(event)` in `lib.rs`; `subscribe(channel)` at `backend.ts:49`
  and `:139`; `subscribe(serviceUuid)` in `ble.ts`). The pre-fix extractor printed **7** —
  three of them (`"backend"` twice, `internals`) were *invented* by its own regex, and one
  real site (`backend.ts:49`) was *hidden*, so the number was wrong in both directions.
* `window.addEventListener("hardware-button")` is a DOM channel, not a Tauri event;
  the scan records it separately so it cannot be mistaken for an event subscriber.
* The census's `opaque` rows are **admissions, not checks** — they say where the wire view
  lives and why it cannot be compared; `payloadCensusProblems` rejects one whose reason is
  missing or decorative, so `opaque` cannot become the quiet way to skip a verification.

## Findings (Round 49)

The direction is clean (no field mismatch found), but the **instrument** had two defects,
and one document claim was false:

| Finding | Verdict |
| --- | --- |
| **10 of 20 emitted events had no payload classification at all** — including `ai-card-received`, `ai-token-received` and `ai-session-complete`, all three read by a live screen (`AiApp`) | **fixed**: the table is a census now (17 rows + 3 allow-listed), a missing classification is a FAIL, and a row for an event nobody emits is a FAIL too (anti-rot). A stale allow-list entry is a **failure** as well (it used to print a note — the mechanism REQ-A518 removed from the command scan). |
| `docs/tauri-event-audit.md` claimed `ai-card-received`'s fields "are checked by their own unit tests" | **false**: `grep` over `ai_bridge.rs` finds `CardPayload` only in its definition, one field, the constructor and the emit — no test names it. The new `object` row makes the claim true (negative control: renaming `subtitle` → `subTitle` in Rust fails the gate with *"`AiCard` declares `subtitle` — absent from the reply's `CardPayload` (which serializes: kind, title, subTitle, fields, actions)"*). |
| The numbers in this page's "Honest boundary" (15 emitted / 14 subscribed / 7 checked, 5 unresolved) had aged | updated to today's measured values: **20 emitted / 17 subscribed / 8 checked + 9 classified / 6 unresolved**; re-measured again 2026-09-21 (REQ-A843): **24 emitted / 21 subscribed / 12 checked + 9 classified / 4 unresolved**. |


| Finding | Verdict |
| --- | --- |
| `hardware-button` — emitted by `buttons::HardwareButtons::press`, subscribed by no screen | **allow-listed with a reason**: the shell consumes a press through the pull command `take_pending_hardware_button` (polled by `svelte/osInputBridge.startOsHardwarePoll`) and through the DOM `CustomEvent` that `buttons::dispatch_dom` evaluates into every webview (`startOsInputBridge`). The Tauri `emit` stays as the plugin path for a host that delivers `plugin:event|listen`; adding a third handler would double-fire navigation, and deleting it is a device-behaviour change that cannot be verified in this environment. |

## Findings (Round 11 — REQ-A843: the instrument read a *word*, not a call)

The direction is clean again, but the **extractor** was wrong in both directions at once.
Its subscriber-site regex was `\b(?:subscribe|listen)\s*<?[^>(]*>?\(\s*([A-Za-z_]\w*|"[^"]+")\s*,`:
no left word boundary, no right word boundary, and an **unbounded** gap to the `(`. Measured
over the 650 frontend files: **20 false sites**, **3 real sites hidden** — and the gate was red.

| Finding | Verdict |
| --- | --- |
| A **log string** invented an event: in `lib/backend.ts:145/158` the match started inside `kind: "listen-failed"`, crossed the statement boundary and captured the next call's first argument, `"backend"` — so the gate reported `FAIL — a screen subscribes to 「backend」 but no Rust code emits it`, exit 1. It is **unsatisfiable by the allow-list**: a reason must say what the event is, and this one does not exist. | **fixed**: string/template-literal *contents* are blanked before matching (`maskLiterals`), which cannot hide a real site — masking only *removes* occurrences, so the residual error is a false red, never a false green. |
| The keyword matched as a **prefix**: `listenEvent(internals, …)` ⇒ `subscribe(internals)`; `listeners.set(type, …)` ⇒ `listen(type` (9 such sites, 8 of them in test doubles); `import { subscribeSensorData, … }` / `subscribeStoreTiles`; the type-literal signature `listen: (channel, handler) => …`; and `svelte/propsBus.ts:41`'s `subscribe: Readable<T>["subscribe"] = (run, invalidate) =>` — a **Svelte store contract**, not a Tauri subscription. | **fixed**: a left word boundary `(?<![\w$])` (restored — my first draft dropped the original `\b` and immediately re-admitted `bleUnsubscribe(serviceUuid, …)` as `subscribe(`), a right boundary `(?![A-Za-z0-9_$])`, and a gap that may hold a type argument but may **not cross a parenthesis**. |
| **The false green**: `matchAll` does not overlap, so `lib/backend.ts:48`'s statement-crossing match (from `if (typeof internals.listen === "function") {` all the way to `return internals.listen(channel,` `channel,`) **swallowed the real bridge call** `internals.listen(channel, handler)` on line 49 ⇒ the genuine subscription was invisible to the gate. Same shape swallowed two real subscriptions in `lib/__tests__/backend-bridge.test.ts:179/195`. | **fixed**: with the gap bounded, all three are found. |
| The extractor's *names* live inside the literals it must blank | the name is read back from the **unmasked** text through the `d` flag's `indices`, so `subscribe("store-updated", h)` still yields `store-updated`. |

**Negative control** (`/tmp/negctl11`, kept **outside** the repo — this gate's corpus includes
`scripts/*.mjs`, so a copy inside it would be witnessed by its own fixtures): one list of **18**
assertions run in four arms — index revision **11/18**, fixed regex with masking reverted **17/18**
(only "a call shape written inside a string literal" still fails, which the boundary cannot reject),
old regex with masking only **14/18** (the prefix class and the nested generic stay red), both
**18/18** ⇒ the two mechanisms are each load-bearing and neither replaces the other.
`--selftest` ⇒ **48** assertions, 0 failures (14 new this round).

### Honest boundary, extended (REQ-A843)

* A **signature** whose parentheses are adjacent — `ble.ts`'s `subscribe(serviceUuid: string,
  characteristicUuid: string): Promise<boolean>;` — is still reported as a site. It lands in the
  `unresolved` list (skipped), never in a failure, but no line-level regex can tell it from a call.
  Not fixed.
* The **emitter** extractor has the same latent hole (an `.emit(` shape written inside a string
  literal). Measured today: **0** instances in the corpus — the single textual hit is a frontend
  *test title*, and the emitter sweep is production-only. It was not masked, for a measured reason:
  masking must happen *before* `stripTestRegions`, and that changes the brace count `stripTestRegions`
  uses, so the stripped length differs on **40 of 1424** files and reading names by offset stops
  being valid. It needs its own seam.
* The nested-generic branch (`subscribe<Record<string, unknown>>(…)`) is **new capability** — the old
  regex could not match it at all (a second false green) — but `subscribe<` occurs **0** times in the
  repo, so that branch is exercised only by its fixture, not by the corpus.

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
