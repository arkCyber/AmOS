# Unwired exports audit — "defined + tested + documented, but no production call site"

## Why this exists

The System UI repeatedly shipped a module that was **complete, unit-tested and
documented, yet never called from the running shell**:

| Round | Symbol(s) | Had | Missing |
| --- | --- | --- | --- |
| keep-awake | `keepAwakeCore` reasons | module + tests + docs | a caller |
| wakeHome | `makeWakeHomeGate` | pure gate + tests | Shell wiring |
| RAG | `notesRag` / `notesRagRun` | index/query orchestration + tests | an "ask my notes" call |
| clipboard | `ClipboardAnnounce.svelte` | component + tests | mounted in `Shell.svelte` |
| telemetry-spy | `startTelemetrySpyWatcher` | bridge + tests | app-level subscription |

`tsc` cannot see this class of defect: `noUnusedLocals` **exempts `export`s**, and
the unit test keeps importing the symbol directly, so every gate stays green
while the feature is dead in production.

`scripts/unwired-scan.mjs` turns the manual audit into a static check.

## What it checks

Scanned corpus: `crates/amos-tauri/frontend-ts`. Production = `src/**` minus
`*.test.*` / `__tests__/`; tests = `src/__tests__`, `svelte-tests/`.

The **reverse direction** has its own gate: `scripts/tauri-command-scan.mjs`
(added in Round 40) flags a **registered Tauri command no screen ever calls** —
the class neither this scan, `tsc`, nor `rust-unwired-scan.mjs` can see. See the
Round 39/40 sections below.

The **third** member of the family is `scripts/tauri-args-scan.mjs` (Round 46): a
call site existing is not the same as the call *succeeding*, so it checks the
**payload keys** against the Rust parameters (Tauri looks an argument up by its
lowerCamelCase name). It found `rag_query`'s `top_k` — which killed every
retrieval — and `interpret_start`'s `source_lang`/`target_lang`, which `Option`
parameters accepted as `None`, silently discarding the user's language choice. See
`docs/tauri-args-audit.md`.

The **fourth** is `scripts/tauri-reply-scan.mjs` (Round 47): the **reply** is a
contract too, and Tauri serializes it with serde's own rules. It found the SMS trash
panel reading camelCase fields off snake_case rows and comparing a `bool`/`usize`
reply to a string — a feature that was dead on device while every gate stayed green.
See `docs/tauri-reply-audit.md`.

The **fifth** is `scripts/tauri-event-scan.mjs` (Round 48): the host→UI **event**
direction — every emitted event must reach a screen (or be allow-listed with a
reason), every subscription must have an emitter, and the payload struct fields must
match the TypeScript type that mirrors them. It found no new defect (the direction is
clean) and records one deliberate deviation (`hardware-button` is consumed through the
pull command + a DOM event, not through the Tauri listener). See
`docs/tauri-event-audit.md`.

The **symbol scan** (checks 2–3) covers `src/lib/**` **and `src/svelte/**/*.ts`
helper modules** — the defect class is not special to `lib/`, and helper modules
under `svelte/` are not components, so an export there can be dead while every
gate stays green (Round 29 widened the corpus for exactly that reason). Svelte
**components** (`.svelte`) are scanned by check 4 instead. **Module
reachability** (check 1) is `src/lib/**` only.

### 1. Unreachable module — hard gate (no baseline)

A `src/lib/*.ts` module that no production file imports, directly or transitively
through other reachable modules. A whole dead module is the strongest form of the
defect. Deliberate not-yet-wired modules must be allow-listed **with a reason**.

### 2. Value export with no production call site — baseline ratchet

A `function` / `const` / `class` / `enum` export (in `src/lib/**` or
`src/svelte/**/*.ts`) whose name appears **nowhere in production** (its own module
included, minus its own `export` declaration). The only remaining mentions are in
tests, or nowhere at all. Public API that is deliberately ahead of its host is
allow-listed; everything else is tracked in `scripts/unwired-baseline.json` and the
gate fails when a **new** one appears — and also when a baseline entry is wired again,
or an allow-list entry no longer names a hole (REQ-A447: the ratchet must shrink, not
rot; reporting a stale entry was not enough).

### 3. Unused type export — informational

An `interface` / `type` export with no reference anywhere. Reported, never gated:
an unused exported type is usually deliberate API surface.

### 4. Unmounted component — hard gate (no baseline)

A `src/**/*.svelte` file that no production **entry chain** imports, statically or
dynamically. This is the `.svelte` analogue of check 1 and the historical
`ClipboardAnnounce.svelte` defect ("component + tests + docs, but no mount"). The
roots are the *true* entries (files nothing else imports, excluding `src/lib` and
components themselves) — a component is never its own root, or an orphan would
trivially "reach" itself and the check could never fire. A deliberately unmounted
component must be allow-listed with a reason.

### Import edges — static, bare, and **dynamic**

Reachability follows `import … from "…"` / `export … from "…"`, bare
`import "…"`, **and dynamic `import("…")`**. That last form is load-bearing:
`appRegistry.ts` lazy-loads every app screen through it, so when it was missed a
module reachable *only* that way was reported as a **dead module** — a hard-gate
failure with no baseline to absorb it (Round 30). `--selftest` pins the extractor
(and its negative controls: member access `obj.import(…)` and non-literal
`import(x)` are not edges); it runs first in `make lint` and `bun run check`.

## Running it

```sh
cd crates/amos-tauri/frontend-ts
node scripts/unwired-scan.mjs                 # gate (exit 1 on regression)
node scripts/unwired-scan.mjs --json          # machine-readable report
node scripts/unwired-scan.mjs --selftest      # pin the import-edge extractor
node scripts/unwired-scan.mjs --update-baseline   # re-record the backlog
```

It also runs as part of `bun run check` and `make lint` (hence CI) — the
`--selftest` first, then the gate — so a new unwired export, a newly-unreachable
module, or a component nobody mounts is caught at review time instead of by the
next manual audit.

## Handling a finding

1. **Wire it** — the default; it is almost always the intent.
2. **Delete it** — if it is genuinely dead (a shim superseded by another module, a
   duplicated implementation).
3. **Allow-list it** (`scripts/unwired-allowlist.json`) — only for a deliberate,
   documented library surface whose host does not exist yet. A non-empty `reason`
   is mandatory.
4. **Baseline it** (`--update-baseline`) — for the existing backlog, which the
   ratchet then freezes.

## Findings from this audit

### Whole modules unreachable from production (8)

| Module | Verdict |
| --- | --- |
| `lib/alarmNotify.ts` | **deleted** — dead `export *` shim; `svelte/osAlarmWatcher` imports `lib/alarmCore` directly |
| `lib/reminderNotify.ts` | **deleted** — dead `export *` shim; `svelte/osReminderWatcher` imports `lib/reminderCore` directly |
| `themeCore.ts` | **wired** — `svelte/theme.svelte.ts` had silently duplicated `readStored`/`writeStored`/`isThemeMode`/`resolveDark`/`applyDarkClass`; it now imports them from `lib/themeCore` |
| `systemButtons.ts` | **wired** — `svelte/osInputBridge.ts` now uses `buttonActionOf`/`keyActionOf`; this also fixes the H/V/A keyboard shortcuts, which never fired because keydown went through the hardware-name mapper |
| `lib/wm.ts` | allow-listed — split-layout bridge + pure placement helpers; awaits a split-screen surface (`docs/multi-window.md`) |
| `lib/bundle.ts` | allow-listed — web-bundle `srcdoc` inliner; awaits a real `amos-app://` origin host (`docs/appstore.md`) |
| `lib/sandboxBridge.ts` | allow-listed — deny-by-default capability seam; wiring is deferred device work (`docs/permissions-sandbox-audit-plan.md` Phase 3) |
| `lib/externalFiles.ts` | **wired** (REQ-A447) — `svelte/FilesApp.svelte` imports it for the external-collections section, so the allow-list entry was **removed** by the new stale rule (it had outlived the hole it excused) |

`wm.ts` is the notable one: a complete, unit-tested bridge to the Rust `wm_*`
commands with **zero importers** — it had been invisible because its test imports
it directly.

### The follow-up shim cleanup after deleting the two `export *` modules

The two deleted shims were re-exports; their tests were repointed at the real
cores and renamed so the file name no longer lies:

* `alarmNotify.test.ts` → `alarmSync.test.ts` (imports `lib/alarmCore`)
* `reminderNotify.test.ts` → `reminderCore.test.ts` (imports `lib/reminderCore`)
* `reminderNotify-pure.test.ts` → `reminderCorePure.test.ts` (stays DOM-free so it
  keeps counting toward the pure-batch coverage gate)

### Round 2 — the three defects the first round surfaced

Driving the same scan list from 129 → **123** baselined exports:

| Finding | Verdict |
| --- | --- |
| `lib/display.ts` `setScreenState`/`getScreenState` — **zero** call sites | **wired** — `docs/display-idle.md` §4 documents "lock/auto-off reports `off`, unlock reports `on`, boot re-asserts `on`", but nothing implemented it, so the daemon's energy governor never learned the display was off. New `svelte/osScreenState.ts` + one surface edge detector in `Shell.svelte` + a boot re-assert. |
| `lib/sound.ts` (`{ring,vibrate}`) **and** `lib/soundPrefs.ts` (`{notify,haptics}`) both owned the key `amos.sound` | **unified** — the Settings sound toggles wrote a schema the status bar could not read, so muting had no effect on the policy. `lib/sound.ts` is now the single owner (migration-tolerant `normalizeSound`, new `flipSound`); `lib/soundPrefs.ts` deleted. |
| `shouldRingOnArrival` / `shouldVibrateOnArrival` / `playNotifyTone` — doc says "used by the notification-arrival path", but no arrival path called them | **wired** — notifications arrived silently. `NotificationBanner.svelte` (which already detected arrivals) now rings/vibrates under the effective policy (persisted bits × DND). |

### Round 3 — dead legacy, an unwired preview/clear, and duplicated control orders

Driving the list from 123 → **115**:

| Finding | Verdict |
| --- | --- |
| `lib/time.ts` `batteryPercent` — the cosmetic `100 - getSeconds()` battery that `lib/batteryStatus` explicitly replaced; `SNOOZE_MS` — a ms constant nothing consumed | **deleted**; `DEFAULT_SNOOZE_MIN` is now the single snooze-default source, and `ClockApp`'s two magic `5`s read it. |
| `clipboard.ts` `previewClipboard` ("one-line preview for history pickers") and `clipboardClear` — zero call sites | **wired** — the Notes tray rendered `entryText` directly, so an image entry showed as `"—"`. It now previews honestly (`[image · mime]`, whitespace collapsed) and offers a clear-history action that only empties the list when the bridge confirms a count. |
| `camera.ts` `FLASH_ORDER` / `RATIO_ORDER` / `TIMER_PRESETS` / `FACING_ORDER` — exported + unit-tested, while `CameraApp` inlined the same orders as ternaries | **wired** — all four go through the tested `cycleAfter(order, current)` (the torch constraint is preserved via `setFlashState`). |

### Round 4 — a denial that masqueraded as an empty gallery

`lib/media.ts` is careful by design: it has its **own** bridge whose `call()` lets a
real Rust error *reject* (unlike `lib/backend.invoke`, which collapses errors into
`null`) precisely so "permission needed" is distinguishable from "offline". But
`PhotosApp` ran `mediaList` through `Promise.allSettled` and consumed only the
fulfilled values — so the documented `Unauthorized` error was **swallowed**, and a
denied gallery rendered exactly like an empty one.

`MusicApp`/`PlayerApp` already had it right (`unavailable` on rejection →
`player.unavailable`); `PhotosApp` now matches:

| Finding | Verdict |
| --- | --- |
| `PhotosApp` swallowed a rejected `media_list` | **fixed** — a rejection sets `nativeBlocked` and renders an honest "not authorized" strip with a **grant** action; no fabricated `native photos` region is shown while denied. |
| `media.ts` `mediaGrantRead` — zero call sites | **wired** — the grant action calls it for each listed collection (`camera`, `screenshots`), then reloads; the prompt clears only if the read then succeeds. |

Still baselined in this module and *why*: `mediaGrants` / `mediaRevoke` /
`mediaProviderName` want a media-access section in Settings (a UI to build), and
`mediaSave` is a **device** acceptance item (`docs/device-bringup-checklist.md`
G9: "快门后 `media_save` 写入 `DCIM/Camera`") — wiring it blind would claim device
behaviour that has not been verified on hardware.

### Scanner accuracy: doc comments no longer count as call sites

The scan originally counted **any** textual mention, including a module's own JSDoc.
That is exactly the trap the tool exists to catch — and it hid a real one:
`storeApps.loadStoreTiles` was reported as "wired" because its *doc comment* named
it, while nothing in production called it.

`stripBlockComments` now removes `/* … */` before counting. Line comments are
deliberately **kept**: `//` occurs inside string literals (`content://…`), so
stripping those would *under*-count real references. Re-running with the fix
immediately surfaced 3 more true findings (below).

### Round 5 — store-installed apps were invisible; superseded radio helpers

Driving the list 114 → **113** while *adding* the 3 newly-surfaced findings:

| Finding | Verdict |
| --- | --- |
| `storeApps.loadStoreTiles` / `getStoreTiles` / `subscribeStoreTiles` — the module cache nothing ever populated | **wired** — `HomeDock` and `AppLibrary` already render `ext: StoreTile[]` and `appRegistry` already maps the store screen, but `Shell.svelte` passed `ext: []` with the comment "hosts no store apps yet". The shell now loads the tiles once, re-loads on `notifyStoreTilesChanged()` (which `StoreApp` pokes after install/uninstall), and feeds both surfaces — so an installed store app is visible and addable. |
| Opening a `store:` tile rendered a **blank app frame** (no local Svelte screen exists) | **fixed honestly** — the app surface now shows the tile's manifest name + "installed, but this build has no web-bundle runtime host yet", instead of an empty frame. `midOf` names the id. |
| `settings.radioIcons` + `settings.applyConnectivity` — superseded by `netStatus.statusIcons` (which `StatusBar` uses and which adds real connectivity + the joined SSID) | **deleted** (with their tests; the behaviour is covered by `netStatus.test.ts`). |
| `privacyBackend.daemonAuthorize` — the documented "single chokepoint the daemon audits" | **baselined with a reason** — the daemon is *informed* (`daemonGrant`/`daemonRevoke` are wired from Permissions/Privacy) but never *asked*: all seven capability gates read the local ledger (`capSet(loadLedger(), …)`) synchronously. Converting them to a daemon-aware async check is a coordinated change across Camera/Maps/Mic/Interp/VoiceMemos; rushing it could weaken the gate, so it stays explicit debt. |

### Round 6 — in-app permission prompts never told the daemon

`privacyBackend` documents `perm_grant`/`perm_revoke` as **authoritative and
audited** ("the single chokepoint the daemon audits"), and the Privacy dashboard
renders the daemon's "recent access" audit trail.

But only **two** places mirrored to it — the dashboard (`PermissionsApp`) and the
settings page (`PrivacyPage`). The **eight in-app permission prompts** (Camera
auto-grant, Maps location, Magnifier camera, VoiceMemos mic, Interp mic, and the
three voice-mic buttons) wrote **only the local ledger**. So:

* a grant the user made in the app's own prompt never reached the daemon's
  authoritative store, and
* the same user action had **two different effects** depending on where it was made
  (settings vs. in-app), while the audit trail the dashboard shows omitted in-app
  grants entirely.

| Finding | Verdict |
| --- | --- |
| 8 × `saveLedger(grantCap(loadLedger(), …))` / `revokeCap` in Camera / Maps / Magnifier / VoiceMemos / Interp / StreamVoice / DeviceMic / VoiceMic | **wired** — one seam, `svelte/osPermissions.ts` (`grantCapability` / `revokeCapability`): persist locally (so the UI gate stays immediate) **and** mirror to the daemon. All 8 prompts now go through it. |
| `privacyBackend.daemonAuthorize` — the documented chokepoint, still uncalled | **wired** — `daemonVerdict()` exposes it and `PermissionsApp` now shows **drift**: a local grant the daemon *denies* is flagged with ⚠ (`perm.drift`), instead of the dashboard silently implying the two agree. `null` (offline / local-only capability) claims nothing. |

The *enforcement* gates still read the local ledger synchronously (that keeps the
UI immediate and works offline); what changed is that the daemon now always learns
the same facts, and disagreement is visible rather than invisible.

### Round 7 — the native alarm host only ever re-armed alarms that had already rung

`docs/native-alarm-bridge.md` states the frontend contract: push every **enabled**
alarm's next epoch-ms to the native scheduler. The implementation only did half of
it — `alarmCore.syncDueAlarmAlerts`'s sole `registerNativeAlarm` call sits inside
`nextArmments(rings, …)`, i.e. it re-arms only the alarms that **just fired**:

* a **newly created or re-enabled** alarm was never registered (worse after a boot
  where the Clock screen is never opened);
* a **disabled or deleted** alarm was never cancelled, so `cancelNativeAlarm` had
  zero call sites and the host scheduler could still wake the device for an alarm
  the user had switched off.

| Finding | Verdict |
| --- | --- |
| `cancelNativeAlarm` — zero call sites; fresh alarms never registered | **wired** — new `svelte/osAlarmArm.ts` reconciles the host with the list: arm every enabled alarm's next occurrence (idempotent, same id overwrites the time), cancel ids that are gone or disabled. `osAlarmWatcher` drives it **once at start** (a boot may never open Clock) and **on every `ALARM_KEY` change**. |
| `pollNativeAlarms` — still unused | **deliberately not wired, and now recorded as such** in `docs/native-alarm-bridge.md`: while the WebView lives, arrival is already decided by the wall-clock reconcile, so polling would add a second, possibly duplicate, delivery path. Revisit after device testing of "throttled process resumes". |

The bridge doc was also **stale**: it referenced `lib/alarmNotify.ts`, which round 2
deleted. Corrected.

### Round 8 — a resident voice listener that could never be stopped, and a PTY that never learned its size

Two more half-wired contracts found by reading the Rust command docs against the
call sites:

| Finding | Verdict |
| --- | --- |
| `assistantVoiceStop` — zero call sites | **wired**. The Rust semantics are explicit: `assistant_voice_start` opens a **resident** listener (a long-lived `Chat` stream that keeps relaying replies), `assistant_voice_end` only finalizes the current utterance, and `assistant_voice_stop` is what cancels the listener. `StreamVoiceButton` (press-and-hold) called start/feed/**end** only — so **every press left a resident daemon listener behind forever**. The button now cancels on **unmount** (releasing must *not* cancel, or it would cut off the answer being generated), tracked by an explicit `sessionOpen` flag set as soon as the host opened one. |
| `termResize` — zero call sites | **wired**. `term_spawn` starts every session at a fixed **120×24**, and nothing ever told the PTY otherwise, so wrapping and full-screen programs drew for the wrong grid. New pure `lib/terminal.ptySizeFor` (content box ÷ cell metrics, **`null` when unmeasurable** rather than inventing a size), and `TerminalApp` measures one character cell in the scrollback's own font, then pushes the real grid on attach and on every `ResizeObserver` change (same-size calls deduped). |

### Round 9 — the store's "updatable" decision was recomputed in the UI

`docs/appstore.md` places the semantic-version comparison — numeric, with
pre-release ordering — in the `amos-appstore` **domain**, and the host exposes the
result as `appstore_updatable` (ids) / `appstore_status` (per-app state). Both are
registered in `generate_handler`, and both typed wrappers had **zero call sites**,
while `StoreApp.svelte` carried its own `verLt` to decide whether to show "Update".

| Finding | Verdict |
| --- | --- |
| `backend.storeUpdatable` — zero call sites | **wired** — `load()` now fetches it once; the **host's answer is authoritative**, and the local `verLt` survives only as a documented fallback when the host cannot answer (`null`). Tests pin all three branches, including the two where the two disagree. |

### Deliberate non-wirings (recorded, not silent)

These remain in the baseline **on purpose**, and the reason is now written down so
they are decisions rather than unexplained debt:

| Export | Why not wired |
| --- | --- |
| `storeStatus(id)` / `storeFind(id)` | `storeStatus` is one round-trip per app for a state we already derive from the single `updatable` list; `storeFind` only helps when the catalog is *not* in memory, and the store page holds the whole catalog. |
| `pollNativeAlarms` | Arrival while the WebView lives is already decided by the wall-clock reconcile; polling adds a second, possibly duplicate delivery path (see `docs/native-alarm-bridge.md`). |
| `realDial` | Deliberately bypassed: AmOS-managed calls bind *our* in-call UI, which `ACTION_CALL` would hand to the system dialer (the comment lives in `PhoneApp`). |
| `mediaSave` / `mediaGrantWrite` | `mediaSave` is the device acceptance item (G9); a *write* grant should be requested by the flow that needs it rather than pre-granted from a settings page. (`normalizeGrant` **left this table in Round 42** — it was a pure reply parser that no reply was ever run through; `mediaGrants()` now applies it.) |
| `realtimeTts.onInterpFinal` | A convenience "parse final + speak" wrapper. `InterpApp` must parse the payload with **its own** seg model (`lib/interp.segOf`, which also feeds the persisted transcript), so routing through a second parser would mean two parsers for one payload — worse than the line it saves. |
| `emergency.quickEmergencyNumber(region)` | Mirrors the Rust `EmergencyMap::quick_dial`, but the frontend holds **no authoritative region**. A lock-screen one-tap number derived from locale/timezone would be a *guess* at what the user dials in a crisis; the daemon re-classifies and routes recognized codes to the privileged emergency provider, and `emergency.ts` documents the lock-screen constant as the product default. Region selection is device bring-up (see `docs/telephony.md`). |
| `backend.storeSearch` | Same decision as `storeFind` / `storeStatus`: the Store page holds the whole catalog in memory and renders it (no search box), so a per-query daemon round-trip would buy nothing. Remove this row if the store grows a paged/remote catalog. |
| `backend.storeBundleResource` / `storeBundleUri` | The appstore bundle **content** seam. Its host is the `amos-app://` origin + web-bundle runtime that does not exist yet — the same blocker that allow-lists `lib/bundle.ts`; wiring them would fabricate a resource host. |
| `backend.translateText` | The unary `Translate` RPC. `InterpApp` drives its **own** session (`interpret_text` / `interpret_audio`) whose segments feed the persisted transcript; a second, out-of-band translate path would fork that transcript (the same reasoning as `realtimeTts.onInterpFinal`). |
| `sensors.sensorAcquire` | Asks the **daemon's gRPC `SensorService`**, while the Settings sensor card consumes the **in-process** `sensor_host` feed (whose own gate, `sensor_host_acquire`, the frontend does not expose). Wiring this would query a *different* manager than the one producing the card — see Round 10. |
| `sensors.sensorPixels` | Returns a **pixel total**, while the panel shows `W×H`; wiring it would turn "1920×1080" into "2073600". |
| `contacts.contactById` | **wired (Round 41)** — the reason recorded here ("no duplicate to merge into") had gone **stale**: the *Spotlight → contact* deep link added to `ContactsApp` later resolved its target with a hand-rolled `contacts.find((c) => c.id === v.id)`. The screen now calls `contactById(contacts, v.id)`, so the tested lookup has its consumer and the baseline dropped **45 → 44**. |
| `calculator.calcDisplay` | A **single-line** display model used by the calculator's own unit tests; the two-line iOS UI computes its display from `cur`/`pendingOp`. It is the tests' display oracle — deleting it would delete assertions, not add coverage. (**`calcRun` left this table in REQ-A458**: Spotlight's calculation row evaluates through it — the app's own engine is what keeps the two surfaces from disagreeing — so the baseline dropped **115 → 114**.) |
| `ansi.hasEscape` | The ANSI parser already drops every escape safely; "mark the line as raw" was a proposed UI affordance that no screen needs. |
| `keepAwakeCore.resetHoldBusForTest` | A **test seam** for the module-singleton hold bus (tests must reset it between cases). It has no production caller *by construction*, and the `…ForTest` suffix states that. |
| `propsBus.resetPropsChannels` | A **test/setup seam**: the module-singleton channel registry must be wiped between cases (46 test call sites). No production path may clear *all* channels — the shell disposes only the ones it owns (`disposePropsChannel`, now wired in `Shell.onDestroy`). |
| `osAlarmArm.armedNativeAlarmIds` / `resetArmedNativeAlarmsForTest` | **Diagnostics / test seam** for the native exact-alarm bookkeeping: the accessor exposes "what this module believes is registered" and the `…ForTest` setter forgets it so each case starts clean. The host side is mocked in tests; production only ever calls `reconcileNativeAlarms`. |
| `sandboxBridge.decideCapabilityRequest` | The single value export of the allow-listed `sandboxBridge` module — same deferred host (a real postMessage/origin listener) as its module entry. |
| `cellularRadio.setCellularRadio` / `clearCellularRadio` | Allow-listed (see `scripts/unwired-allowlist.json`): the install/teardown halves of a **real** cellular radio source for the Notification Center. `amos-tauri` exposes no cellular-signal command, so the store stays at the honest `absent` default ("no modem" → no bars); wiring would fabricate a signal. Device bring-up (`TelephonyManager`). |
| `wm.ts` / `bundle.ts` / `sandboxBridge.ts` (modules) | Allow-listed: their hosts (split-screen UI, `amos-app://` origin, postMessage listener) do not exist yet. (`externalFiles.ts` was in this list until REQ-A447 — the Files screen wired it, so the entry was removed.) |

### Round 10 — two superseded event-reducer models, and a sensor bridge asymmetry

`lib/stream.ts` carried two reducer models ported from the React era. Grepping
every consumer showed they were referenced **only by their own test**:

* `ChatLog` (`chatLogInit` / `onAiToken` / `onAiComplete` / `chatLogReset`) — `AiApp` accumulates tokens into **its own** message model (text + cards + busy + abort).
* `InterpOutput` (`interpInit` / `INTERP_LINE_CAP` / `onInterpOutput` / `interpClear`) — the interpreter transcript is the **persisted segment store** in `lib/interp`.

These are not "unwired": they are a **parallel second model**, which is worse —
it invites a future reader to write state nobody reads. Removed, keeping the
parsers that are actually used (`tokenOf` / `cardOf` / `sessionMetaOf` /
`finalSegmentOf`); `stream.test.ts` was reduced to the survivors (including the
existing fault-injection cases).

**A bridge asymmetry worth recording** (found while checking the sensors cluster,
and deliberately *not* "fixed"): `lib/sensors.sensorAcquire` invokes the **gRPC**
`sensor_acquire` (the daemon's `SensorService`), while the Settings sensor card
consumes the **in-process** `crates/amos-tauri/src/sensor_host.rs` `sensor-data`
feed — whose own gate is `sensor_host_acquire` (returning `StreamGate{kind,hz,allowed,reason}`), which the frontend **does not expose at all**. Wiring
`sensorAcquire` there would ask a *different* manager than the one producing the
card's stream. Recorded rather than hooked up blindly.

`sensorCameraCount` is now used by `SensorPanel` (two inline `cameras.length`
derivations removed). `sensorPixels` stays baselined with a reason: it returns a
**pixel total**, while the panel displays `W×H` — wiring it would turn
"1920×1080" into "2073600".

### Round 11 — media access was observable but unmanageable

`lib/media` already exposed the **system** media-grant API — `mediaProviderName`,
`mediaAvailableCollections`, `mediaGrants`, `mediaRevoke` — and
`crates/amos-tauri/src/media.rs` documents that an ungranted collection returns a
descriptive error. All four had **zero call sites**, so: the user could not see
which media collections the OS had granted, and could not revoke any of them
(the only path was the one-shot in-app "grant read" prompt — strictly additive).

| Finding | Verdict |
| --- | --- |
| `mediaGrants` / `mediaRevoke` / `mediaProviderName` / `mediaAvailableCollections` | **wired** — Settings → 隐私与安全性 gained a **"系统媒体访问"** section (explicitly separate from the app-capability ledger above): real backend name, available-collection count, and one chip per grant shown via `canonicalPath` (`DCIM/Camera`, not the wire key), each revoking through `mediaRevoke` and then **re-reading** (never assuming the revoke took). Round 42: the reply is run through `normalizeGrant` (unknown/evolved rows are dropped; a non-array reply reads as `null`), so a malformed grant can never render as an `undefined` chip. |
| `PrivacyPage`'s revoke still hand-rolled `daemonRevoke` + `revokeCap` + `saveLedger` | **fixed** — now the round-6 seam `osPermissions.revokeCapability`, matching the other nine capability prompts. |

**Three honest states, pinned by tests:** bridge answered with grants → chips;
bridge answered with none → "no media access granted"; **bridge couldn't answer at
all → the whole section is not rendered** (never turn "couldn't ask" into "nothing
granted"); bridge answered but the grant list was unreadable → an explicit
"state unavailable".

### Round 12 — the same domain rule, copied at the call site (six times)

No new features: this round is purely about **a tested library rule being
re-implemented at its call site** — the pattern already caught with camera orders,
`radioIcons`, `themeCore`, `soundPrefs` and `storeUpdatable`.

| Call site | Duplicated rule | Now |
| --- | --- | --- |
| `reminderCore.collectDueAlerts` — **the predicate that decides whether a reminder notification fires** | `!r.completed && typeof r.dueAt === "number" && r.dueAt <= now` — verbatim `reminders.isOverdueNow` | calls `isOverdueNow`, **plus a new equivalence test** asserting the notifier's verdict equals the domain predicate across due / at-now / future / no-due / completed |
| `RemindersApp` priority picker | `{#each PRIORITY_LABELS as k, p}` — **the array index *is* the priority**, with an `as Priority` cast. One extra label would silently produce `priority: 4`, which the domain's `toPriority` then coerces back to 0 on reload (a silent data change) | `{#each PRIORITIES as p}` (the domain's valid set), labels indexed *by* priority, cast gone |
| `AiPage` (3 sites) | `provider !== "local"` inline | `isCloudProvider()` — which also restores the `p is CloudProviderId` **type predicate** the inline check loses |
| `MagnifierApp` reset | three `DEFAULT_*` assignments | `defaultMagnifierSettings()` |
| `MapsApp` zoom buttons (2) | `clampZoom(zoom ∓ 1)` | `zoomOut()` / `zoomIn()` |

`reminders.isPastDue` (overdue **by day**, for the red list marker) and
`isOverdueNow` (due **by the minute**, for notifications) are genuinely **two
different rules**, so both stay — noted so nobody "dedupes" them later.

### Round 13 — a whole read-only view model with zero consumers

`lib/externalFiles.ts` is a **complete** read-only view model — one entry point
(`buildExternalFileView`: normalize → dedupe → group → aggregate count/bytes) plus
`externalGlyph`, `formatBytes`, `sortExternalFiles`, `filterExternalByName`,
`recentExternalFiles`, `mergeDeduped` — whose own doc says
*"Wire: crates/amos-media → media_list → this lib"*. It had **zero consumers**, and
`FilesApp` had **no external-collection area at all**: the user could not see the
device's real files (Download / Pictures / Movies / Music / Recordings).

**Wired**: a collapsed **"设备文件" read-only section** in the Files app, deliberately
isolated from the `amos.files` tree (exactly the isolation the module documents):

* concurrent `mediaList` over the five standard collections;
* `buildExternalFileView` for the grouped view **and** the aggregate
  (`fileCount · totalBytes`), `canonicalPath` for human paths (`Download`,
  `DCIM/Camera`), per row `externalGlyph` + `formatBytes` + mtime + a "read-only" note;
* name filter (`filterExternalByName`) and **four view modes** — name / date / size /
  **recent** (`recentExternalFiles`, newest 20 with unknown mtime last).

**Three honest states:** bridge answered → list; **nothing readable while something
failed → a "not authorized" notice + grant action** (`mediaGrantRead` per collection,
then retry — the notice clears only if reading really works); **no media bridge →
the whole section is not rendered** (never turn "couldn't read" into "no files").

`mergeDeduped` stays baselined with a reason: merging the live list with local
recents by `uri` needs both layers to carry content handles **on a device**.

### Round 14 — a "release" that released nothing, and a hidden hold

Driving the same scan list from 87 → **85** baselined exports:

| Finding | Verdict |
| --- | --- |
| `lib/realtimeTts.ts` `resetPlayCtx` — zero call sites, and `InterpApp.svelte` had **no `onDestroy` at all** | **wired (and fixed)** — leaving the interpreter left the `AudioContext` created by `playPcm` running: an audio session held by a screen the user had already left. Worse, `resetPlayCtx` itself only nulled two references, so "release" released nothing. It now stops the source **and `close()`s the context** (best-effort, idempotent), and `InterpApp` calls it on teardown; the next final segment lazily rebuilds. Pinned by behaviour, not just a call-count: the fake `AudioContext` records `close()` (exactly once, second reset is a no-op) and the next segment must get a **fresh** context. |
| `lib/keepAwakeCore.ts` `heldReasons` — documented as "diagnostics / logging", zero consumers | **wired** — with auto screen-off set to 30 s the display still never slept during a call or video, and **nothing on screen said why** (identical to a broken timeout). The same reason bus the auto-off watcher reads is now shown in Settings → 显示与亮度 as a live **"保持唤醒"** readout: no holds → "无 · 屏幕将按上方时间熄屏" (an in-process read, so it is an authoritative answer, not a guess); holds → localized reasons (**通话中 / 视频播放中**), updated live via `onHoldChange`. An **unknown reason is printed verbatim rather than hidden** — a new hold must never become invisible again. Not rendered while auto-off is off (it would explain nothing). |

`realtimeTts.onInterpFinal` stays baselined with a reason: `InterpApp` must parse
each final payload with **its own** seg model (`lib/interp.segOf`, which also feeds
the persisted transcript); routing it through a second parser would mean two
parsers for one payload.

### Round 15 — a tested state machine and a tested tag rule, both re-implemented at the call site

| Finding | Verdict |
| --- | --- |
| `NoteEditor.svelte` hand-rolled the save machine (`dirty` boolean + `saveErr` string) while `lib/autoSave.initialSaveState` / `saveStateReducer` — a fully unit-tested `dirty / saving / saved / error` reducer — had **zero** call sites | **wired** — every draft change folds through `saveStateReducer(save, { type: "edit" })`, a successful write through `{ type: "saved" }`, a write that cannot land (the note is gone) through `{ type: "save_failed" }`, and `‹ back` through `{ type: "flush_started" }`. The header's "正在保存… / 保存于 HH:MM:SS / error" is now `save.status` instead of two ad-hoc booleans. `{ ...initialSaveState }` keeps the shared module constant out of Svelte's deep `$state` proxy. |
| `NotesApp.svelte` filtered the `#tag` chips inline (`activeAll.filter((n) => hasTag(n.text, tag))`) — the exact body of the tested `lib/notes.filterByTag` | **wired** — the call site is now `filterByTag(activeAll, tag)`, so a future change to what a tag token *is* cannot diverge between the domain and the screen. |
| `lib/voiceRecorder.blobToDataUrl` — "read a Blob as a `data:` URL (what the amos store persists)" | **deleted** — stale: recordings are stored as **binary** blobs in `lib/mediaStore` (IndexedDB), never base64-inflated into the KV store. Zero call sites, zero test refs. |
| `lib/voiceMemos.buildWavDataUrl` (with its private `wavBytesToDataUrl` / `toBase64`) — "a demo clip ready to play" | **deleted** — superseded: seed clips play via `buildWavBytes` → `new Blob` → `URL.createObjectURL`, not a base64 data URL. |

This is pinned by behaviour, not just a call count: `note-editor.svelte.test.ts`
asserts the status line goes **保存于 → 正在保存… (synchronously on input) → 保存于**
once the trailing-edge autosave really wrote the store, and that a save which
cannot land shows the honest "笔记已被删除" error rather than the generic saving
text.

### Round 16 — an unpinned blank app frame, a re-typed idle, and four superseded wrappers

| Finding | Verdict |
| --- | --- |
| `Shell.svelte`'s app surface had **no final branch**: an id that is neither an ext tile nor a loadable built-in screen rendered **nothing** (a blank frame) — the same class as Round 5's "opening a `store:` tile rendered a blank app frame", but for a plain unknown id (reachable through a link, a persisted layout or a manifest). `appMeta.isKnownApp` existed for exactly this and had zero callers. | **wired** — the app host now falls back to an honest `app-unavailable` panel; `isKnownApp(id)` distinguishes *"a built-in whose screen is not in this build"* from *"unknown app"*, and both name the id. |
| `timerStore.restoreTimerState` re-typed the idle countdown literal (`{ running: false, totalMs: 0, remainingMs: 0, endAtMs: 0 }`) twice, while `lib/time.timerInit()` — the domain's single source for that shape (the reducer resets to it) — had zero callers | **wired** — both idle returns are `timerInit()`. |
| `batteryStatus.resolveBattery(system, host)` | **deleted** — a two-source special case of the general `firstBattery([...])`, which is what `StatusBar` actually calls (it has a **third** source: the Tauri `hostBattery()` reading). The precedence scenarios live on in `firstBattery`'s tests. |
| `netguard.isEnforcing(s)` | **deleted** — `guardLevel(s) === "armed-enforced"` spelled as a boolean; `NetGuardPage` drives off `guardLevel`. |
| `ringtone.ringtoneIdForAlarm(alarm)` / `makeAlarmSamples(alarm)` | **deleted** — one-line `alarm.tone` un-wrappers of `ringtoneIdFor` / `makeToneSamples`, which `ClockApp`/`ringtonePlayer` already call with the token. |

Pinned by behaviour: `shell.svelte.test.ts` opens an unknown id and asserts the
honest panel (with the id), not a blank surface.

### Round 17 — an empty first-run address book, a re-typed Wi‑Fi default, and two redundant classifiers

| Finding | Verdict |
| --- | --- |
| `lib/contacts.seedContacts` — documented as "a small, sensible starter list for the first run" — had zero callers, so **Contacts / Phone / IncomingCall all opened empty on a fresh install** while Messages and VoiceMemos seed demo data | **wired** — the Shell seeds the address book **once at boot**, before any app surface can hydrate `amos.contacts`. It keys off an **absent** store (`readStoreValue(..., undefined)`), never an empty list, so an intentionally emptied address book is not resurrected on the next launch. |
| `lib/wifi.wifiInit()` — the default `WifiCfg` — had zero callers while `normalizeWifi`'s guard re-typed the same literal | **wired** — the guard falls back to `wifiInit()` (mirroring `bluetooth.normalizeBt` → `btInit`), so the default has a single source. |
| `lib/display.isOn` / `asScreenState` — `"on"｜"off"` ↔ boolean converters | **deleted** — the `screen_state_get` / `screen_state_set` wire is already **boolean** (`ScreenPayload{on}`); no production path ever holds a `"on"｜"off"` string, so the converters were vestigial. (`ScreenState` stays as the documented shared-file contract.) |
| `lib/interp.sessionEndedOf` | **deleted** — `InterpApp` dispatches on `payload.kind` directly, and the parsers it *does* call (`partialTextOf` / `segOf` / `errorOf`) extract data rather than merely re-confirming a kind the caller already knows. Round-10 precedent: remove a redundant parallel helper instead of forcing a dead call. |

Pinned by behaviour: `shell.svelte.test.ts` proves a fresh launch seeds a non-empty
address book **and** that an already-emptied one stays empty.

### Round 18 — the scanner was under-counting spread calls, and two rules re-derived at the call site

The tool that catches "defined but never wired" had a **false positive of its own**,
alongside two more call-site duplications and one duplicate implementation.

| Finding | Verdict |
| --- | --- |
| `unwired-scan.mjs` counted a **spread call** (`...fn(...)`) as *member access*, so a helper whose only production caller spreads it was reported dead — it hid `calendar.expandOccurrences` (called by `occurrencesInRange`), pinning a **wired** helper in the baseline forever. | **fixed** — the counting probe neutralises ellipses (`...`) before matching, so a spread call counts while genuine member access (`obj.name`) stays excluded. This is the second scanner-accuracy fix, after Round 5's `stripBlockComments`. |
| `WallpaperCard.svelte` validated the stored `background` with its **own** label map + a cast (`(initial.background as string) in MODE_LABEL … as BgModeId`) while `lib/wallpaper.isBgMode` — the tested type guard — had zero callers | **wired** — the card now asks `isBgMode(stored)`, so a mode added to the domain no longer needs the card's map edited in lock-step. |
| `AiPage.svelte` decided mock-vs-real with an inline `aiView.engine === "mock"`, re-deriving `lib/aiEngine.isRealEngine` (which also treats an *empty* engine as not-real) | **wired** — the branch is `!isRealEngine(aiView)`. |
| `lib/audio.frameToAssistantChunk(samples, fromRate)` | **deleted** — a **duplicate implementation** of the production path `lib/voice.pcmToAssistantChunk` (both are `encodeF32le(downsample(...))`; the latter is what `StreamVoiceButton` feeds to `assistant_voice_feed`). `docs/audio-hal-bridge.md` now names the one real path. |

Pinned by behaviour: `wallpaper.svelte.test.ts` asserts a stored *real* mode renders
as the active pill and an *unknown* value falls back to the default.

### Round 19 — a documented debt paid, and two settings pages that stopped copying their domain

| Finding | Verdict |
| --- | --- |
| `lib/providers.envFor` — "Env vars to (re)launch `amos-ai` with for the selected provider" — had zero callers; the AI settings page told the user to restart the daemon but never **with what** | **wired** — `AiPage` now renders the exact env (`AMOS_BACKEND`, `AMOS_API_ENDPOINT`, `AMOS_MODEL`, `AMOS_OLLAMA_HOST`, …) computed by the same `envFor` the launcher uses, so the readout cannot drift from what actually applies. The API key is shown as a **presence marker** (`AMOS_API_KEY=••••`), never the secret. This clears an entry the non-wirings table had recorded as debt. |
| `lib/bluetooth.renameDevice` — "Rename this device. Pure; blanks fall back to the default name" — had zero callers; the Bluetooth settings page showed this device's name **read-only** | **wired** — the name is now an editable field persisted through `renameDevice`, so a blank entry falls back to `AmOS` rather than saving an empty name. |
| `lib/wifi.isSaved` — "Whether a network is in the remembered list" — had zero callers; the list sorted remembered networks first but never **said** which they were | **wired** — a remembered row now carries a "已保存 / Saved" marker. |
| `lib/deviceMic.parseDeviceMicStatus` | **deleted** — a second parser for `device_mic_status`, but `lib/backend.deviceMicStatus` already returns the **typed** object (Tauri deserializes the wire), so the parser could only ever disagree with reality. |

Pinned by behaviour: `settings-pages.svelte.test.ts` renders `AiPage` (local →
`AMOS_BACKEND=ollama`; cloud → `AMOS_BACKEND=api` + endpoint; never a key line)
and `RadioPage` (a remembered SSID is marked Saved; renaming persists the trimmed
name).

### Round 20 — the backup listed stores that no longer existed, and omitted two that did

`lib/cloud.SYNC_STORES` ("the user-data stores included in a backup snapshot") was a
list of **string literals** instead of the key constants each store actually writes,
so it had silently drifted:

* `"amos.files.fav"` — the real key is `FILES_FAV_KEY` = `"amos.files.favorites"`, so
  **file favourites were never in any backup**;
* `"amos.messages"` — the *legacy* single-conversation key, replaced by
  `CONV_KEY` = `"amos.messages.convs"` (what `MessagesApp` writes), so **every message
  thread was omitted** while an empty legacy key was "backed up".

| Finding | Verdict |
| --- | --- |
| `SYNC_STORES` re-spelled store keys with literals | **wired to the single source** — each entry is now the exported key constant its own module writes (`NOTES_KEY`, `FILES_KEY`, `PHOTOS_KEY`, `CONV_KEY`, `MUSIC_KEY`, `FILES_FAV_KEY`, `REMINDERS_KEY`, `LISTS_KEY`), so the list can no longer silently diverge from the stores. This **fixes the data-loss bug**: favourites and message threads now snapshot. |
| `lib/messages.MSG_KEY` (`"amos.messages"`) — the superseded single-conversation key, referenced only by its own test after the conversation list landed | **deleted** — nothing writes or reads it; `CONV_KEY` is the real store. |

Pinned by behaviour: `settings.test.ts` seeds the `FILES_FAV_KEY` and `CONV_KEY`
stores, asserts the snapshot contains them, and asserts `SYNC_STORES` neither keeps
the stale literals nor is missing those constants.

### Round 21 — "ask my notes" never showed the index it was querying, and the dialer never used the names it had

| Finding | Verdict |
| --- | --- |
| `lib/rag.ragStatus()` — the daemon's own view of the index (chunks / dimension / **embedder**) — had zero callers, so the Notes "ask my notes" panel queried an index whose size and embedder (`mock` vs `ollama`) it never showed — exactly the honesty label the module exists to surface | **wired** — opening the panel reads `ragStatus()` once and prints "索引 {n} 段 · {dim} 维 · 嵌入器 {embedder}". `null` (no daemon) renders **nothing** — the panel already has an honest offline notice, and no index size is ever invented. |
| `lib/calllog.logNameFor(list, number)` — "name hint for a number from the log (best known)" — had zero callers while `PhoneApp`'s dialer showed only digits | **wired** — the dialer now shows the address-book name first, else `logNameFor`'s best known name from the call history (same digit-normalised equality as the recents list), so a number you have called before is named *before* you dial again. |
| `lib/photoLibrary.mergeMediaGallery` (with its private helpers and the `PhotoGallery` type) | **deleted** — a **superseded model**: `PhotosApp` deliberately renders the native collections in a **separate region** (with its own grant/denied states) instead of merging them into one gallery, so the merge and its cross-layer ranking had no host. |
| `lib/sensorLive.isSensorDataPayload(raw)` | **deleted** — a redundant exported re-check of `toSensorData(raw)`, which the live accumulator already gates every event with; the guard was test-only. |

Pinned by behaviour: `notes.svelte.test.ts` installs a fake bridge answering
`rag_status` and asserts the panel prints the daemon's real `7 / 384 / ollama`;
`phone.svelte.test.ts` seeds a call-log record and asserts the dialer names the
typed number.

### Round 22 — a live call you could not hang up, and a permissions page with no app view

| Finding | Verdict |
| --- | --- |
| `lib/backend.telephonyStatus()` — "list live calls (dialling / ringing / active)" — had zero callers, while `PhoneApp`'s call UI (`calling` / `activeId` / `talking` / `recording`) is **component-local** and only ever set by `startCall` and `onTelephonyEvent`. So leaving the app mid-call and reopening it showed a **bare keypad over a live call, with no way to hang up**; an inbound call answered elsewhere likewise stayed invisible, because the event handler ignores any call it never adopted (`call.id !== activeRef`). | **wired** — on mount (and on visibility/focus) the app asks the daemon for live calls and adopts an `Active` one; `null` / empty / `Ended` adopts nothing, so a call is never invented. |
| `lib/permissions.grantedCaps(ledger, app)` — "the capabilities `app` holds" — had zero callers; the dashboard was **capability-centric only** ("who holds 相机?"), so the equally natural **"what can this app access?"** had no answer anywhere | **wired** — a new **按应用 / By app** section lists every app holding at least one capability with its caps, read from the same `grantedCaps` helper (never re-derived). Hidden when nothing is granted. |

Pinned by behaviour: `phone.svelte.test.ts` installs a fake bridge answering
`telephony_status` and asserts the in-call UI (naming the peer) appears — and that
an empty reply leaves the keypad; `permissions.svelte.test.ts` seeds a ledger and
asserts the app-centric rows, and that nothing granted → no section.

### Round 23 — a block list you could only empty one rule at a time, and no way to see a rule would match

The 拦截 (blocklist) panel offered add + remove + the unknown-number switch, while two
typed wrappers for the same feature sat unused:

| Finding | Verdict |
| --- | --- |
| `lib/backend.blocklistCheck(address, channel)` — "why an address is blocked (`null` = allowed / unavailable)" — had zero callers, so the panel let you type an address and add a rule with **no indication** that a rule (or the unknown-number switch) already covered it — you could not tell whether you were about to double-block | **wired** — the field now shows a debounced live **"将被拦截 / Will be blocked"** notice naming the matching rule (or "unknown / withheld number"). Only a **positive** answer is rendered: `null` means both "allowed" and "bridge unavailable", so it is never shown as a promise that the number is safe. |
| `lib/backend.blocklistClear()` — "drop every rule (keeps the unknown-number switch)" — had zero callers, so the only way to empty the list was to remove rules **one at a time** | **wired** — a two-step **清空全部规则 / Clear all rules** action (the confirm tap is required, mirroring the call-history clear), after which the list is **re-read from the daemon** rather than assumed empty. |

Pinned by behaviour: `phone.svelte.test.ts` fakes `blocklist_check` and asserts the
preview appears with the matching pattern — and that a `null` reply shows **nothing**;
and that clear-all needs the confirm tap, then really empties the list.

### Round 24 — an OS permission the UI could contradict, and a wrapper that outlived its host

| Finding | Verdict |
| --- | --- |
| `lib/backend.micPermissionState()` — the **dialog-free** `RECORD_AUDIO` snapshot — had zero callers, so the device-mic button's only gate was the **local** capability ledger and the OS grant was first consulted when the user pressed. If the OS grant had been revoked outside AmOS the two disagreed silently, and a press looked like a no-op. | **wired** — the button reads the OS state once when bridged and says so in its title *before* you press ("系统未授予麦克风权限（RECORD_AUDIO）"). The read never prompts: only the user-initiated `start()` calls `micPermissionRequest`. |
| `lib/backend.mailInbox(limit)` — the INBOX convenience wrapper | **deleted** — a duplicate of `mailList(mailbox)`; `MailApp` lists the *selected* mailbox, so the typed alias had no independent caller. |
| `lib/clipboard.copySelection(text)` — "copy text out via the bridge" — had zero callers while `NotesApp` open-coded `clipboardWrite({ kind: "text", text })` at **three** sites | **wired** — all three now go through `copySelection`, so "copy text to the AmOS clipboard" has one name. |

Three more `backend` wrappers are now recorded as **deliberate** non-wirings, with
reasons (they had been baselined without explanation): `storeSearch` (the Store page
holds the whole catalog and has no search box — the same call already recorded for
`storeFind`/`storeStatus`), `storeBundleResource`/`storeBundleUri` (blocked on the
`amos-app://` bundle host — exactly what allow-lists `lib/bundle.ts`), and
`translateText` (the interpreter drives its own session whose segments feed the
transcript; a second translate path would fork it).

Pinned by behaviour: `voice-buttons.svelte.test.ts` fakes `mic_permission_state` and
asserts a denied OS grant is surfaced while the local ledger says granted — and that
`mic_permission_request` is **never** called by the read.

### Round 25 — a thread you had just read still counted as unread (and notified you about itself)

`MessagesApp` marked incoming messages read **only when you sent a reply** (or tapped
the "N 未读" banner). Merely **opening** a conversation left it unread, so:

* the thread kept its ● badge and its "N 未读" banner until you happened to send
  something;
* the notification effect scanned **every** conversation's unread — including the one
  on screen — so reading a thread could itself raise a notification for a message you
  were looking at.

| Finding | Verdict |
| --- | --- |
| No "opening a thread reads it" step | **fixed** — an idempotent effect marks the active conversation's incoming messages read, guarded to the **local** model (the real SMS store keeps its own state and must never be written by the demo path). |
| The notification effect did not exclude the open thread | **fixed** — it now skips the conversation being read (`activeId`; nothing is skipped while the real device folders are the visible model). |
| `lib/messages.markRead(list, index)` | **deleted** — a single-message variant superseded by `markAllRead`, which is what every real path uses (open / send). |

Pinned by behaviour: `messages.svelte.test.ts` asserts the seeded thread's incoming
messages are `read: true` after mount (and no "未读" copy remains), and that a
**second** thread's unread still produces a notification while the open thread's does
not.

### Round 26 — the world-clock picker re-implemented the city index it already had

`ClockApp`'s add-city picker kept a **`Map` built from `CITY_CATALOG`** purely to
convert a catalog entry into a bilingual `WorldCity`, and filtered the list with an
inline `label.includes(q) || zone.includes(q)` — both are exactly what `lib/cityIndex`
already exposes, and `searchCities` / `resolveCity` had zero callers.

| Finding | Verdict |
| --- | --- |
| `wcCityByZone` map + `addPickedCity`'s `map.get(wcPick)` | **wired** — `resolveCity(zone)` is now the lookup (the map is gone; the `wcAvail` loop already had the entry in hand and builds the `WorldCity` directly). |
| `wcAvailFiltered`'s inline catalog filter | **wired** — the catalog is searched by the domain (`searchCities(query, locale, excludeZones)`), which is locale-aware on the display name **and** the IANA zone, excludes the zones already offered, and **bounds** the result; presets (which may carry only an i18n key) are still matched locally, then the catalog results follow. |

Pinned by behaviour: `clock.svelte.test.ts` adds a "no match at all" case (the select
offers nothing and `+` is disabled — the honest empty state) alongside the existing
"搜索罗马 → 恰好 `Europe/Rome`" and "添加目录城市 香港" cases, which now run through
the domain search/resolve.

### Round 27 — an alarm that could not make a sound still looked like it was ringing

`ClockApp` started the ringtone with `startAlarmRing(first.tone)` and **ignored the
result**, so the animated "ringing" banner (`role="alert"`) claimed an alarm sound even
in an environment that cannot play one (no `Audio`/`AudioContext` at all — SSR, a
headless host, a locked-down WebView). `ringtonePlayer.activeRingtone()` — "which
ringtone (if any) is currently sounding" — had zero callers and is exactly that truth.

| Finding | Verdict |
| --- | --- |
| `ringtonePlayer.activeRingtone()` | **wired** — after starting the loop the Clock asks whether a ringtone is actually sounding; if not, the banner adds an honest **"此环境无法播放声音（静音响铃）"** note instead of implying audio. |
| `ringtonePlayer.ringtoneFilesEnabled()` | **deleted** — an accessor for the file-engine flag whose *setter* (`setRingtoneFilesEnabled`) is what the host actually calls; nothing read it. |

Pinned by behaviour: `clock.svelte.test.ts` removes `Audio`/`AudioContext` entirely,
renders a persisted ringing alarm, and asserts the silent note appears — then restores
the environment.

**Honest boundary (recorded):** the signal is authoritative when *no* engine can start
(the synth path returns `null`). With the **file** engine enabled the start is
optimistic — a file that fails to play falls back to synthesis **asynchronously** — so
this first read cannot see that later failure; the player's own fallback handles it,
and the note is not claimed in that window rather than guessed at.

### Round 28 — two helpers with no consumer, and the rest of the backlog written down

| Finding | Verdict |
| --- | --- |
| `lib/contacts.upsertContact(list, { id, … })` | **deleted** — a **third** way to write a contact alongside `addContact` / `editContact`, which are what `ContactsApp` actually calls; it had no consumer, and its `fav` handling differed subtly from the edit path. |
| `lib/camera.needsCrop(vw, vh, out)` | **deleted** — a predicate nothing ever asked: the capture path uses `fitCrop` / `zoomCrop` directly, and the viewfinder already renders `<video class="object-cover">`, so the preview *is* the same centre crop (there was no mismatch to report). |

Every remaining entry in the backlog is now **explained** rather than silent — the
non-wirings table above gained rows for `sensors.sensorAcquire` / `sensorPixels`,
`contacts.contactById` (later **wired** in Round 41 — its reason had gone stale),
`calculator.calcDisplay` (`calcRun` was wired in REQ-A458 — see the table), `ansi.hasEscape`,
`keepAwakeCore.resetHoldBusForTest` and `sandboxBridge.decideCapabilityRequest`. They
stay baselined (so a **new** export is still caught); what changes is that the backlog
is now a set of decisions, not a list of unknowns.

### Round 29 — the scan itself had a blind spot: `src/svelte/*.ts` was never scanned

The check that exists to catch "defined + tested + documented, but no production
call site" only looked at `src/lib/**`. Helper modules under `src/svelte/`
(`appRegistry`, `i18n`, `osInputBridge`, `osAlarmArm`, `osAutoOff`, `propsBus`,
`locale.svelte`, `cellularRadio`) are **not** components — they are ordinary `.ts`
modules with exports — so the exact defect class the scan exists to catch was
invisible there. Widening the symbol corpus to `src/lib/**` + `src/svelte/**/*.ts`
(excluding `.svelte` mount points) surfaced **11** findings, six of which were real:

| Finding | Verdict |
| --- | --- |
| `locale.svelte.setLocaleSafe(v)` — "guarded raw-string → Locale setter" — had zero callers, while the `SVELTE_LOCALE_EVENT` listener **re-implemented** the same `isLocale` guard inline | **wired** — the listener calls `setLocaleSafe`, so "validate a raw locale string" has one implementation. |
| `i18n.translate(dict, key, params)` — the pure lookup + `{param}` interpolation — was reachable in production only *through the dead `makeT`*; `locale.svelte.t()` carried its own private `interp` copy | **wired** — `t()` delegates to `translate`, and the duplicate `interp` is gone: **one** interpolation implementation for the whole UI. |
| `propsBus.disposePropsChannel(name)` — documented as "the React host calls this on unmount" — had zero callers after the React shell was removed, so the **new host (Shell) never disposed the channels it owns** | **wired** — `Shell.onDestroy` disposes the seven controlled channels it feeds (`home`, `editHome`, `appLibrary`, `lock`, `recents`, `spotlight`, `nc`), so a re-mounted shell starts from a clean snapshot instead of inheriting the previous mount's props. |
| `osAutoOff.osAutoOffDecisionHeld(last, now, timeout, held)` — the tested "a held screen never auto-sleeps" fold — had zero callers while `startOsAutoOff` **inlined** the equivalent hold branch | **wired** — the running loop now gates on `osAutoOffDecisionHeld` (hold is still activity-equivalent: it restarts the idle window, so release ends a full timeout later). |
| `osInputBridge.mapTelephonyPhase(detail)` + `TelephonyPhase` — expected `{ phase }` and lower-cased it, but the real wire is a `TelephonyCall` whose field is `state` (`Ringing`/`Active`/`Ended`), which `IncomingCall`/`PhoneApp` dispatch on directly | **deleted** — a parallel classifier that could not classify the actual payload. |
| `i18n.makeT()` (+ `TranslateFn`) — a bound-`t()` factory from the React era, referenced **nowhere** (not even a test); `locale.svelte.t` is the only `t` the shell uses | **deleted**. |
| `appRegistry.svelteAppIds()` — `Object.keys(SVELTE_APP_LOADERS)` behind a name; the registry test was its only caller | **deleted** — the test asserts the loader map's keys directly. |
| `cellularRadio.setCellularRadio` / `clearCellularRadio` | **allow-listed** — the install/teardown halves of a real cellular source; no host exists (no cellular-signal command), so the store stays at the honest `absent` default. |
| `propsBus.resetPropsChannels`, `osAlarmArm.armedNativeAlarmIds` / `resetArmedNativeAlarmsForTest` | **baselined** — test/diagnostic seams (see the non-wirings table). |

Pinned by behaviour: `svelte-tests/os-auto-off.test.ts` (**new**, 3 cases) drives the
*real* watcher under fake timers — it sleeps once at the persisted timeout, a
keep-awake hold prevents sleep for 60 s, and release starts a **fresh** window (no
instant sleep); `locale.svelte.test.ts` dispatches the host locale event and asserts a
valid value applies while `"fr"`/`null` are ignored; `shell.svelte.test.ts` mounts and
**unmounts** Shell and asserts the owned channel re-reads as clean.

### Round 30 — the reachability engine missed dynamic `import()`, and components were never checked at all

Two defects in the tooling itself, found by asking "what else can this scan not
see?":

| Finding | Verdict |
| --- | --- |
| **Import edges ignored dynamic `import("…")`** — `importSpecifiers` only matched `from "…"` and bare `import "…"`. `appRegistry.ts` lazy-loads **every** app screen through `import("./X.svelte")`, so a module reachable *only* through a lazy edge was reported as an **unreachable module**. That gate is a hard failure with **no baseline**, i.e. a false positive that blocks CI on correct code. Reproduced with a probe (`osBoot.ts` dynamically importing a new `lib/_tmp_dyn.ts`): before the fix the scan failed with `newly unreachable module(s): src/lib/_tmp_dyn.ts`; after it, the module is reachable (its *export* is still correctly flagged, since a lazy import does not call it). | **fixed** — edges now include `import("…")`, with a negative lookbehind so member access (`obj.import(…)`) and non-literal `import(x)` are **not** edges. |
| **No component-mount check** — the scan exempted `.svelte` as "mount points" but never verified that a component *is* mounted. This is the `.svelte` analogue of the dead-module check and the exact historical `ClipboardAnnounce.svelte` defect (component + tests + docs, missing a mount). | **added** — a new **hard gate**: a `src/**/*.svelte` file unreachable from the true entries (static **or** dynamic). Verified with an orphan-component negative control (flagged), then removed. |

The subtle part was the **root set**. A naive "files nothing imports" set makes the
orphan its own root, so it trivially reaches itself and the check can never fire
(this was caught by the orphan control failing to trigger on the first attempt).
Mount roots therefore exclude `src/lib` (checked separately) **and components
themselves**; `shell-entry.ts` is the real root and imports `Shell.svelte`, which
mounts the rest. `lib` roots stay "every production file outside `src/lib`", because
a lib module must never be its own root or *its* gate could never fire.

Current state: **70 components, 0 unmounted**; **102 lib modules, 0 unreachable**.
`--selftest` (8 assertions: 5 positive edge forms incl. dynamic, 3 negative) runs
first in `make lint` and `bun run check`, so a future edge form that silently stops
matching fails loudly instead of flipping real wiring into a false gate failure.

### Round 38 — the class this scan *cannot* see: a host command no screen ever asks for

The scan is one-directional: it starts from **frontend exports** and asks whether
production calls them. The mirror-image defect — a **host command the UI never
calls**, so a capability the host exposes is unreachable from any screen — is
invisible to it (and to `tsc`, and to the Rust gate, which only counts *within*
the workspace).

Round 38 found exactly that:

| Finding | Verdict |
| --- | --- |
| `perm_grants_all` (`amos-tauri/src/privacy_client.rs` → `PrivacyManager::grants_snapshot`, whose own doc says *"the authority a permission **review** must read"*) had **no frontend wrapper and no UI consumer**: the dashboard's review views (capability sections / "By app") read only the **local** ledger `amos.permissions`. The daemon's store is reloaded from `AMOS_PRIVACY_PATH`, so it survives a cleared/reinstalled WebView profile — and then a camera/mic grant **really applies** while the review page shows nothing and offers no way to revoke it. The opposite direction (local grant, daemon denies) already had a ⚠ marker, so the page *looked* symmetric. | **wired** — `lib/privacyBackend.daemonGrantsAll()` (offline/failed ⇒ `null`) + the inverse pure map `capForWire` (an unknown wire key ⇒ `null`, never invented into a capability label); `PermissionsApp` renders a "守护进程已授权（本机账本未列出）" section listing only grants the local ledger does **not** have, with a revoke that goes to the authority and then **re-reads** it. A `null` answer renders nothing — "cannot ask" is never shown as "nothing is granted". |

So this backlog stays the frontend-side work list; the reverse direction needs a
separate check (a host-command → UI-consumer scan) if we want it gated.

### Round 39 — the sweep that blind-spot note predicted: a documented flow no screen could perform

Round 38 recorded that "a host command no UI ever calls" is invisible to every
gate. Round 39 ran that check **by hand** (a throwaway probe: extract the names in
`generate_handler!`, then look for each as a string literal in `frontend-ts/src`
production files):

* **174** registered commands, and **all 174 are declared** `#[tauri::command]` —
  a command in the handler list with no implementation (which would fail only at
  runtime) does not exist. Good news, and worth having measured.
* **26** registered commands have no frontend production call site. Most are
  deliberate (allow-listed `wm.ts` host, `real_dial` / `scheduler_alarm_poll` /
  `mail_inbox` recorded as non-wirings above, `sensor_host_*` developer seams,
  `perm_record_audit` called from the Rust devcare bridge, `interpret_*` lifecycle
  calls the daemon emits). **One was a real defect:**

| Finding | Verdict |
| --- | --- |
| `system_set_context` / `system_peek_context` / `system_clear_context` (`wm.rs` `SystemContext` — the multi-window "selection → AI" mechanism) had **zero frontend callers**, while `docs/gui-verify.md` scenario D1/D2 documents the user flow (Notes → "发送到 AI" → AI screen shows "已附加系统上下文") and `docs/multi-window.md` §4 lists it as shipped. The Rust half is complete and unit-tested, and `chat_agent` (which the AI screen **does** call) already merges `system_selection` into every request — so the *only* thing missing was the UI: nothing could attach a per-window entry, and the promised "what is attached" hint did not exist. | **wired** — `lib/backend.system{Set,Clear,Peek}Context` typed wrappers; `svelte/appLinks.sendToAi(source, text)` (attaches `AI_TARGET_WINDOW` and opens the AI app; `AI_TARGET_WINDOW` is one constant shared with `sendChat`'s `targetWindow`); Notes' editor toolbar gained **✦ 发送到 AI**; the AI screen peeks on mount and after every send and shows the source + a one-line preview, with ✕ dropping it at the daemon. A `null` peek shows nothing — "cannot ask" is never rendered as "nothing attached". |

The probe is now a **gate**: `scripts/tauri-command-scan.mjs` (Round 40) — see the
next section. Its 20 deliberate entries live in
`scripts/tauri-command-allowlist.json` **with a reason each**.

### Round 40 — the probe became a gate, and the gate immediately found a dead write-through

`scripts/tauri-command-scan.mjs` is the reverse-direction gate: it reads the
`generate_handler![…]` list and fails when a registered command

* has no `#[tauri::command]` implementation (a "command not found" that would only
  show up at runtime), **or** is declared but never registered (unreachable), **or**
* is reached by no consumer: no quoted literal of its name in production frontend
  code, no call from Rust production code, and no entry in
  `scripts/tauri-command-allowlist.json` **with a reason**.

It runs in `make lint` (after `rust-unwired-scan`) with `--selftest` first.
Negative controls: a synthetic registered-but-unconsumed command **fails** the
gate; a synthetic declared-but-unregistered one fails it; an allow-list entry
whose command is now consumed is reported as `[stale]`. Matching is deliberately
*loose on the frontend side* (any quoted literal counts) because a missed finding
is quieter than a false CI failure; a command reached through a computed name is
documented as out of scope.

Triage of the 20 non-consumers found **one real defect** behind them:

| Finding | Verdict |
| --- | --- |
| `store_set` / `store_remove` had no consumer because the whole **write-through** was dead: `lib/amosStore.writeJson` (and `lib/themeCore.writeStored`, `svelte/locale.svelte.setLocale`) mirrored through `window.Amos.storeWrite`, and **nothing in the repo ever provides `window.Amos`** — no `initialization_script`, no Kotlin `addJavascriptInterface("Amos", …)`, no HTML shim. So `docs/multi-window.md` §5's documented chain (`A.storeWrite(k,v)` → `invoke("store_set")`) never ran: the Rust `SharedStore` was never written, while `shell-entry.boot()` → `hydrateFromSystemStore()` still **overwrites localStorage from that (stale) snapshot** — i.e. the OS could silently roll a user's settings back, and `docs/calendar.md` / `gui-verify.md` described a mirror that did not exist. | **wired** — new typed `lib/backend.systemStoreSet(key, value)` (`store_set`); `writeStoreValue` uses it (fire-and-forget, localStorage stays this window's immediate truth); `writeStored` and `setLocale` mirror through the same call; the dead `window.Amos` shim and its `declare global` are gone. `store_remove` **stays allow-listed** (no screen removes a whole key; the inbound `{value:null}` path keeps cross-window symmetry). Pinned by `amosStore.test.ts` (JSON mirror with the exact raw string, offline no-throw, raw-not-JSON for the theme key) + `osPermissions.test.ts` (the ledger write now shows up as `store_set`). |

### Round 41 — the recorded reasons re-verified, and docs that describe a host that no longer exists

Two follow-ups to Round 40's honest boundary:

**(a) One "deliberate non-wiring" reason had gone stale.** The non-wirings table
recorded `contacts.contactById` as *"a lookup the screen does not need … it has no
duplicate to merge into"*. That held when written, but the *Spotlight → contact* deep
link added to `ContactsApp` afterwards resolved its target with a hand-rolled
`contacts.find((c) => c.id === v.id)` — the very duplicate the reason said did not
exist. `ContactsApp` now calls `contactById(contacts, v.id)`, restoring the tested
pure lookup as the single source and ratcheting the baseline **45 → 44**. (The other
baselined symbols were re-read against their recorded reasons and still hold.)

**(b) Documentation that describes a removed host.** Round 40 found docs describing a
store mirror that did not exist; re-reading the doc set for the same class ("it
describes a component that is not there") found a React-migration cluster:
`docs/ARCHITECTURE.md`'s entire frontend section (`src/App.tsx`, `src/apps.tsx`,
`src/components/`), `docs/os-shell-bridge-checklist.md` ("production is still the React
`App.tsx` host"; a hardware-button row still marked *待接线* after
`svelte/osInputBridge.ts` wired it), `docs/hardware-buttons.md` (flow diagram + ASR
pointing at `App.tsx` / `components/VoiceMicButton.tsx`), `docs/appstore.md`,
`docs/semantic-ui.md`, `docs/permissions-sandbox-audit-plan.md`,
`docs/UI_APPLE_HIG_AUDIT.md`, the frontend `README.md` (a React-era "migration target"
doc), and the current-tense "the React shell owns / keeps in sync" comments in
`src/svelte/**` and `src/lib/**`. None of those files exist. Each is now rewritten to
the real Svelte entry (`index.html → shell-entry.ts → mount(Shell.svelte)`,
`svelte/appRegistry.ts`) or explicitly marked historical; genuine provenance notes
("port of the former React X") are kept, but no longer cite a dead path.

Verification: `docs-link-scan` OK; `unwired-scan` **44** (0 new); `bun run check`
EXIT=0 (`tsc` + `svelte-check` + all tests + scans).

### Round 42 — a tested "reply parser" that no reply was ever run through

Triaging the remaining backlog for the recurring bypass pattern (a tested pure rule
re-implemented or skipped at its call site) found one in `lib/media.ts`:

| Finding | Verdict |
| --- | --- |
| `media.normalizeGrant` — *"Coerce a raw grant; null when either field is malformed"* — was exported, unit-tested and documented as **"a pure reply parser"**, yet the one function that receives grants, `mediaGrants()` (`media_grants`), simply cast the wire (`call<Grant[]>(…)`): **no reply was ever run through the parser**. A malformed / evolved row (e.g. a collection this build does not know) therefore reached **Settings → 隐私与安全性 → 系统媒体访问** as if it were a real typed grant, rendering a chip labelled `undefined · read` (`canonicalPath` has no default case). | **wired** — `mediaGrants()` now maps the reply through `normalizeGrant` and **drops** rows that are not an `{access, collection}` pair this build understands; a non-array reply is treated as **"could not read"** (`null`, never a fabricated empty set — the page's existing honest-`null` rule). Baseline ratchets **44 → 43**. Pinned by `media.test.ts` (offline → `null`; mixed valid/invalid rows → only the valid pairs survive, never throws; object reply → `null`). |

### Round 44 — the interface the screens consume was a hand-copy of the declared one

The scan reports *value* exports as gated findings and *type* exports as
informational. Reading that informational list for the same class Round 43 fixed in
Rust (a documented seam re-implemented at its own call site) found one in
`svelte/propsBus.ts`:

| Finding | Verdict |
| --- | --- |
| `ChannelUp` — the declared **UP** half of a channel (`on`/`emit`) — was exported but **unreferenced**, while `PropsChannel<T>` (the interface **every controlled screen actually consumes**, e.g. `EditHome.svelte`) **hand-copied the same `emit`/`on` pair** instead of extending it. A future change to `ChannelUp` (an added method, a narrowed `detail`) would silently not apply to the interface the screens use — the two declarations could drift. | **merged** — `PropsChannel<T> extends ChannelDown<T>, ChannelUp {}`; the UP contract has one definition and `ChannelUp` is referenced, so it left the informational unused-type list (**5 → 4**). Value-export baseline unchanged (**43**). |

Three current-tense comments describing the **removed React shell** (the Round 40/41
class: a component that is not there) were corrected in the same pass, keeping the
provenance but dropping dead paths: `svelte/EditHome.svelte` ("the lib/appIcon single
source the React EditHome uses" → every home surface renders from),
`svelte/VoiceMicButton.svelte` and `svelte/StreamVoiceButton.svelte` (both cited
`components/*.tsx`, which do not exist).

### Round 45 — the reverse direction: docs cite symbols that do not exist

Rounds 40/41 audited "a doc that describes a component which is not there" by hand.
Round 45 made it mechanical: extract every backticked snake_case token from
`docs/**` (plus `CHANGELOG`/`README`/`CONTRIBUTING`) and check it still exists as an
identifier anywhere under `crates/**`. With a test-name-shaped filter (≥3
underscores) that is 203 tokens, 8 of them absent; widening to ≥2 underscores gives
394 tokens and 22 absent. **Five documents** carried real drift (the rest are
external binaries, DOM events, adb/sbt subcommands, Svelte compiler codes,
integration-test *file* names, or CHANGELOG entries that correctly describe
something already deleted):

| Where | Cited (does not exist) | Reality |
| --- | --- | --- |
| `docs/devcare.md` REQ-DC22 | `apps_applies_the_uninstall_policy`, `permission_review_groups_grants_and_refuses_unknown_tags` | the requirement's evidence is `the_preview_and_the_enforcement_agree_for_every_package`, `uninstall_policy_holds_for_a_pinned_package_not_in_the_registry`, `the_permission_review_is_shaped_from_daemon_rows` (+ domain `permissions::tests::groups_granted_resources_by_app_and_ignores_denied`, `unattributable_grants_are_dropped`) — a traceability row that cannot be traced |
| `docs/media.md` | `media_item_roundtrips_serde` | only `media_item_new_validates_and_round_trips` exists |
| `docs/hermes-integration.md` | `parse_hermes_sse_chunk` | the real parsers are `parse_hermes_token` (native `type:"token"` frames) and `parse_sse_chunk` (OpenAI delta fallback) |
| `docs/local-models.md` | `interpret_feed_audio` | the command is `interpret_audio` |
| `docs/android-storage-unify.md` | `media_list_images` / `media_list_files` / `media_save_to_gallery` | these were *proposed* shapes; the shipped surface is `media_list` / `media_save` / `media_load` / `media_read_range` — now annotated in place (the plan body is kept as history) |

Same pass, one comment whose *field* name was wrong: `amos-appstore`'s
`ffi::CCommitResult` doc said "`code` matches the public constants", but the field
is `status` (the parent module's constants are `STATUS_*`).

**Deliberately not gated.** Of the 22 absent tokens only five documents were real
drift — the probe stays a manual round because doc prose quotes external commands
(`adb`, `cargo`, `osascript`), DOM event names, and vitest *sentences*. A gate would
need a whitelist roughly as large as the corpus; the honest boundary is recorded
instead.

### Round 46 — a call the UI makes whose command the host never had (REQ-A517)


Round 45 read the docs against the code. This round read the **two sides of the bridge**
against each other, in the one direction nothing looked at: every other gate starts from
either the frontend exports (`unwired-scan`), the Rust `pub fn`s (`rust-unwired-scan`), or
the **registered** command list (`tauri-command-scan` check 2 — "a command no screen asks
for"). Nothing asked the mirror question — *does the command the UI calls exist at all?*

Measured (production `frontend-ts/src`, tests excluded): 243 distinct literal
`invoke("…")` / `call("…")` names, 268 registered commands, and **exactly one** call with
no command behind it: `lib/media.ts::mediaStreamBase()` → `media_stream_base`. That name
appears nowhere else in the repository — no `#[tauri::command]` fn, not in
`generate_handler![]`. So the call always resolved to the offline value **and** wrote a
`command-failed` entry into the diagnostic ledger on every call: a failure the user cannot
act on, invented by the client.

Where it came from is the interesting part. `docs/archive/2026-09/zh/MOBILE_FINAL_AUDIT_2026_SEP17.md`
records a **build** failure on 2026-09-17 (`PhotosApp` imported functions that did not
exist) and its fix: write the three functions. The build went green; the audit recorded the
effect as "照片应用可正确获取媒体流基础URL / 可正确渲染原生媒体缩略图". The capability never
existed — `nativeStreamUrl()` is downstream of a base that is always `null`, and
`nativeTileKind()` had no caller at all. A fix that satisfies the compiler is not a fix.

| What | State before | State now |
| --- | --- | --- |
| `media.ts::mediaStreamBase` | calls a command that does not exist; always `null`; plants a fake `command-failed` | **deleted** |
| `photoLibrary.ts::nativeStreamUrl` | always `null` (no base can ever exist) | **deleted** |
| `photoLibrary.ts::nativeTileKind` | a second shape of the glyph decision that `photoGlyph` already makes; no caller | **deleted** |
| The claim in `photoLibrary.ts`'s header | "kept for a later, device-only thumbnail load" (reads as a choice) | the truth: **no host streaming endpoint exists**; restore the host half first |
| `scripts/tauri-command-scan.mjs` | registered → consumed only | **check 3: every literal call the UI makes must be registered**, with `scripts/tauri-call-allowlist.json` (currently `[]` — zero tolerance) and stale-entry reporting |

Evidence: `node scripts/tauri-command-scan.mjs` ⇒ `242 distinct literal call(s) (34 computed,
not checkable)` and OK; the three deleted exports show up as the ratchet shrinking
(`unwired-baseline.json` **111 → 108** `values`, "referenced nowhere" **18 → 15**).
**Negative control**: putting `mediaStreamBase` back verbatim makes check 3 fail on exactly
that name (naming the caller file); restoring the file byte-for-byte returns the run to
green (`sha256` compared).

**Honest boundary**: real thumbnails are **not** implemented by this round — the Photos screen
shows the same glyph tiles it always did (that path was always the honest one). What changed
is that the repository no longer describes a pipeline it does not have, and the next
frontend stub of this shape is refused by a gate instead of discovered by an audit.
Restoring the feature needs the **host half** first (a media stream endpoint per
`docs/android-storage-unify.md` Phase B/C, plus a *registered* `media_stream_base`), then the
consumer. Also worth recording: the "Value-export backlog (ratcheted, 43 entries)" heading
further down this page is a count from an earlier round — the baseline measures **108**
`values` today (`wm.ts` 7, `bundle.ts` 0, `backend.ts` 5, `pushNotifications.ts` 22,
`nfc.ts` 18).

### Round 47 — a wrapper nothing imports is not a screen (REQ-A518)

Round 46 read the two sides of the **bridge call**. This round followed the same thread one step
further: the three dead modules that round had just been staring at (`biometric.ts`, `ble.ts`,
`nfc.ts`) call host commands — *are those registered?* Yes. And `tauri-command-scan` reported all
of them as **consumed**, because check 2's rule was "the name appears as a quoted literal anywhere
in production frontend code" — including inside a module **no screen can import**.

Measured (two independent methods agree: the scan after the fix, and a scratch probe before it):
**15 registered commands** — `biometric_available`, `biometric_authenticate`, the seven `ble_*`,
six `nfc_*` — have *every* frontend mention inside `src/lib/biometric.ts` / `ble.ts` / `nfc.ts`,
three files `unwired-allowlist.json` records (with reasons, under `unwired-scan`'s **hard** gate)
as unreachable. The gate whose header cites the dead "selection → AI" flow as its reason to exist
was blind to its own defect class for these 15.

The heavier half is what the blindness *did*:

| Step | What happened |
| --- | --- |
| 1 | The blind rule counted the wrapper's literals as a consumer, so the commands reported as wired. |
| 2 | With the commands "wired", their accurate allow-list entries became `[stale]`. |
| 3 | The stale state was a **`console.log` note**, not a failure, worded "now consumed — shrink with a reason". Deleting an accurate record looked like housekeeping. |
| 4 | The records were deleted. The reasons in `unwired-allowlist.json` still assert the opposite ("the two commands are registered and already allow-listed in `scripts/tauri-command-allowlist.json`") — a claim that had been false for at least one commit, and **no gate cross-checks the two files**. |

So the fix is threefold: check 2's consumer corpus now **excludes** the modules the frontend's own
ledger records as unreachable (pure `liveConsumerFiles`, pinned by three selftest assertions); a
**stale allow-list entry now fails** the run (matching `unwired-scan`, with a message telling the
reader to `git log -p` the name before deleting anything); and the **15 records are restored** with
substantive reasons that name the missing screen, which makes those two cited claims true again.

Two deliberate boundaries: check 3 ("does this command exist?") does **not** apply the filter —
reachability is irrelevant to existence, and a bad call inside a dead module is the same defect the
moment the module is wired (filtering would be the *miss* direction); and the reachability decision
is taken from `unwired-allowlist.json` rather than by recomputing the import graph, because
`unwired-scan.mjs` runs its scan and calls `process.exit` at module top level, so it cannot be
imported. The composition is sound: an unreachable module *must* be listed there (hard gate), and a
listed module is excluded here.

**Honest boundary**: none of the 15 capabilities gained a UI in this round — the BLE, NFC and
biometric screens still do not exist. What changed is the ledger: it now says "registered host API
whose wrapper is unreachable — the missing piece is a screen" instead of "wired", and the mechanism
that erased that statement cannot run silently any more.


### Round 48 — the promise the search box already made (REQ-A528)

Rounds 46–47 cleared the *instrument* side of these dead modules. This round wired one of them,
and the entry point was not a plan or an audit note — it was the **settings search alias**:

```ts
lock: ["password", "passcode", "pin", "密码", "面容"],   // SettingsApp.svelte
```

A user who searches 面容 / Face ID is sent to the passcode page. That page had **only** a passcode
field and a switch; `src/lib/biometric.ts` (host wrapper *and* the written-down semantics for the
prompt: user gesture required, `available` does not explain why, `fallback` must be handled as
verified) was reachable from nothing, and the two host commands were registered with no consumer.
So the shell had a promise (the alias), a seam (the module, fully tested) and a host (two live
commands) — and no surface. That is the same shape as Round 46/47's findings, one layer up.

What the page now does, each line taken from the module's own contract:

| Situation | The row says | Why not something shorter |
| --- | --- | --- |
| the answer has not arrived | “正在检查设备…” | before REQ-A528 the page painted “this device has no biometrics” on the first frame — a false statement on a phone that has Face ID (the **i18n dead-key check** caught it: `lock.biometricChecking` was written but unused) |
| `null` (no bridge / desktop) | “此设备没有生物识别” and **no button** | a button that cannot work is the REQ-A468 defect |
| hardware, nothing enrolled | “要先在系统设置里登记”, **no button** | the platform would refuse with `not_enrolled` immediately |
| ready | “{label} 已可用” + a verify button | the label is the **host's** (the platform's own localized name) |
| `authenticated` / `fallback` / `cancelled` / `unavailable` | four distinct sentences | a fallback is not a success-by-biometrics and a cancellation is not a failure; collapsing them hides what the platform told us |
| `not_enrolled` / `locked_out` / other error | guidance, or the platform's own string verbatim | a swallowed error reads as “the button did nothing” |

Two things were **deleted** rather than kept:

* `lib/biometric.ts::biometricLabel()` — it returned hard-coded Chinese (`面容 ID` / `指纹` / `虹膜`),
  and it is now called from a locale-aware screen, so an English UI would have shown Chinese. Naming
  a biometric is copy: it moved to i18n (`lock.biometricKind*`, both locales), with the host's label
  preferred over any local list.
* the module's entry in `unwired-allowlist.json` and the two commands' entries in
  `tauri-command-allowlist.json` — the ratchets **fired by themselves** the moment the page existed
  (`5 baseline entr(y/ies) now wired`, `1 allow-list entr(y/ies) no longer name a hole`,
  `2 allow-list entr(y/ies) no longer name a hole`), which is how the shrink was found rather than
  remembered. Baseline values **108 → 103**, command allow-list **35 → 33**, unreachable modules
  **12 → 11**.

Boundary, said out loud: the row **verifies identity and gates nothing** — no path in this repository
is released by it yet, and the copy says so (`lock.biometricHint`) instead of implying “unlock”.



### Value-export backlog (ratcheted)


The baseline today (43), by module:

* `wm.ts` (16) / `bundle.ts` (4) — **allow-listed modules**: their symbols stay
  baselined so a *new* one is still caught. Their hosts (the split-screen surface and
  the `amos-app://` web-bundle runtime) do not exist yet.
* `backend.ts` (8) — typed RPC wrappers whose Rust command has no UI consumer yet;
  several are *deliberate* (see the non-wirings table above).
* `media.ts` (2) — `mediaSave` (device-gated DCIM write) / `mediaGrantWrite` (a write
  grant should arrive with the flow that needs it). `normalizeGrant` was wired in
  Round 42.
* `calculator.ts` (1) — `calcDisplay`, the tests' display oracle (the two-line iOS
  screen computes its display from `cur`/`pendingOp`). `calcRun` left this list in
  REQ-A458: Spotlight's calculation row evaluates through it.
* `sensors.ts` (2) — `sensorAcquire` (asks a *different* manager than the card the
  Settings page reads, Round 10) / `sensorPixels` (a pixel total for a `W×H` panel).
* `osAlarmArm.ts` (2) — `armedNativeAlarmIds` / `resetArmedNativeAlarmsForTest`:
  diagnostic / test seams found only after Round 29 widened the corpus.
* Single symbols (all explained in the non-wirings table above): `ansi.hasEscape`,
  `emergency.quickEmergencyNumber`, `externalFiles.mergeDeduped`,
  `keepAwakeCore.resetHoldBusForTest`, `realtimeTts.onInterpFinal`,
  `sandboxBridge.decideCapabilityRequest`, `propsBus.resetPropsChannels`.

`sound.ts`, `display.ts`, `themeCore.ts`, `clipboard.ts`, `camera.ts`, `time.ts`,
`media.ts`, `storeApps.ts`, `settings.ts`, `privacyBackend.ts`, `alarmCore.ts`,
`terminal.ts`, `stream.ts`, `externalFiles.ts`, `realtimeTts.ts`, `keepAwakeCore.ts`,
`notes.ts`, `autoSave.ts`, `voiceMemos.ts`, `voiceRecorder.ts`, `appMeta.ts`,
`batteryStatus.ts`, `netguard.ts`, `ringtone.ts`, `contacts.ts`, `interp.ts`,
`wifi.ts`, `aiEngine.ts`, `audio.ts`, `calendar.ts`, `wallpaper.ts`, `providers.ts`,
`bluetooth.ts`, `deviceMic.ts`, `rag.ts`, `calllog.ts`, `photoLibrary.ts`,
`sensorLive.ts`, `permissions.ts`, `backend.ts`, `clipboard.ts`, `messages.ts`,
`cityIndex.ts`, `ringtonePlayer.ts`, `contacts.ts` and `camera.ts` have been worked off
across rounds 2–29, which is what moved 129 → 43. (The baseline *rose* by 3 in
Round 29 only because the scan's corpus was **widened** — the three new entries are
explained test seams, not regressions; the ratchet still fails on any new one.)
Round 41 removed one more (`contactById`, whose recorded reason had gone stale) and
Round 42 another (`normalizeGrant`, a reply parser no reply was run through).

This backlog is the concrete work list for future rounds; the ratchet guarantees
it can only shrink-or-hold, never silently grow.

## REQ-A412 — the device-feature libraries enter the backlog (and two of them were broken)

The `bun run typecheck` gate was red with **39** errors, almost all of them in the
newest modules (REQ-A409/A410's device features). Working through them turned up two
defects that had nothing to do with types — and they are precisely the defects this
document's family exists for:

| Defect | Shape | Why no gate saw it |
| --- | --- | --- |
| `ble.ts::bleOnValueChanged`, `nfc.ts::subscribeNfcTag` never subscribed | `.listen` called on `bridged()` — a **boolean** — so it threw and the file's own `try/catch` swallowed it. Every BLE value / NFC tag event was silently dropped | The tests asserted `typeof result === "boolean"` and ran **unbridged** (where a no-op is correct) |
| `nfc_read_bytes` could not be called at all | The only caller sends `tagId`; the Rust parameter was named `_tag_id`, so Tauri looked up a different key and answered "invalid args" before reaching the glue | `tauri-args-scan` (Round 46) *did* see it — it is in this family for exactly this reason |

Both are fixed (see `CHANGELOG.md` REQ-A412); the third member of the family,
`tauri-command-scan`, also got its `sensor_host_record_video` case resolved in REQ-A411
(declared `#[tauri::command]` but missing from `generate_handler!`).

**What enters the backlog here**, with reasons in
`scripts/unwired-allowlist.json` (module gate) and counts in
`scripts/unwired-baseline.json` (the ratchet moved `values` **81 → 113**, `modules`
2, `components` 8 — nothing was removed):

| Module | What it is | What is missing |
| --- | --- | --- |
| `src/lib/biometric.ts` | host wrapper for `biometric_available` / `biometric_authenticate` | **wired in REQ-A528**: the biometric row lives on the passcode page (`LockPage.svelte`), which is where the settings search alias (`面容` / `face id`) had been pointing all along — the entry is gone from this backlog and from `unwired-allowlist.json` |
| `src/lib/ble.ts` | BLE GATT client (Kotlin bridge + Web Bluetooth fallback) | the BLE screen (scan → connect → services → read/write/subscribe) |
| `src/lib/gps.ts` | read-only location view model (`readGnss`, `accuracyLabel`, `describeLocation`, `isAndroidBackend`) | **wired in REQ-A582**: the 「定位」 block in `LiveSensors.svelte` (Settings ▸ Diagnostics) is the screen this module was waiting for — it shows the four honest states (`unavailable` / `absent` / `no-fix` / `fix`), the accuracy label, the coordinates and the device-vs-simulated badge. Wiring it exposed an ambiguity the module's own docs called out but its reader did not honour (`gnssSnapshot` collapsed "no bridge" and "no GNSS hardware" into one `null`), so `readGnss` names the four states instead. The entry is gone from `unwired-allowlist.json`; the three wired exports are gone from `unwired-baseline.json` (98 remain, down from 101). |
| `src/lib/nfc.ts` | NDEF encode/decode + dispatch/read/write/format + tag subscription | the NFC screen |

**Honest boundary**: these four are still unwired — the rows above are a work list,
not a claim that the features work. What changed is that the gate now reads the
truth (a documented, tested library surface awaiting a screen) instead of a defect
invisible to `tsc`, and that the two *broken* seams inside them are fixed and pinned
by tests.

### Round 49 — the remote PWA opener: a tested host command with no screen yet (Gap 6) — **wired in REQ-A560**

`appstore::pwa_open_remote` is the Gap-6 **remote PWA opener** host command. Its whole
chain is implemented and tested in the `amos-appstore` domain (`open_remote_pwa`:
`https://` enforced at the seam, operator host allow-list from `AMOS_PWA_REMOTE_ALLOW`
with no wildcard, 10 s timeout, 256 KiB body cap, the *existing* strict
`PwaManifest::parse` + `validate`, `eval_js` refused by name), and the command itself is
a thin `spawn_blocking` wrapper that maps a refusal to `ErrorCode::AppStoreInstallFailed`
with the `StoreError` attached as the cause.

| Command | What it is | What is missing |
| --- | --- | --- |
| `pwa_open_remote` | fetch → validate → install a remote PWA manifest | **nothing: wired in REQ-A560.** Both halves of this round's pair landed — the one-line `generate_handler!` registration (`appstore::pwa_open_remote,`) that makes the name *registered*, and the screen: `PwaHubApp.svelte`'s "add from URL" form (outside the load-state branches, so an **empty** index is exactly where it shows up), backed by `lib/pwaIndex.ts::openRemotePwa`, which returns the host's refusal verbatim and **reloads the index** on success — the new tile is the proof. The entry is gone from this backlog and from `scripts/tauri-command-allowlist.json` (the scan now reports the command as consumed: `255 distinct literal call(s)`, `32 allow-listed`). Honest boundary unchanged: the real HTTPS client needs `--features appstore-live`, and without it the host answers with a typed error naming the missing feature, which the form displays as-is. |

This entry was the forward-looking half of the pair: it became *valid* only once the
one-line `generate_handler!` registration landed in `crates/amos-tauri/src/lib.rs`
(`appstore::pwa_open_remote,`), because the scan's stale rule requires an allow-list
name to be a **registered** command. That registration has now landed — as has the
screen, so the allow-list entry is removed rather than valid-but-unused.

---

### Round 50 — the enterprise section is built: three finished panels + their list consumer leave the backlog (REQ-A584)

`docs/SHORTCUTS_ENTERPRISE_UI_SPEC.md` places four enterprise surfaces in **Settings ▸ 企业功能**
(MDM / 模板 / 审计 / API). All four panels existed (700–1140 lines each, fully i18n'd, backed by the
wired `lib/enterprise/*` managers and — for MDM — the `amos-mdm` crate with end-to-end tests), and the
section was never built, so **nothing in the UI could reach any of them**: the audit trail
(`lib/enterprise/audit.ts`, wired) had no reading UI at all, and MDM could not be configured from the
shell that ships it.

`settings/EnterprisePage.svelte` is that section, and the entry chain is complete end to end:
`Sub` member → `PAGE_KEY` title → an index row (its own group, above 系统) → search aliases
(`enterprise` / `mdm` / `audit` / `api` / `webhook` / 企业 / 审计 / 接口 …) → the render branch.
The two contract tests that exist for exactly this (`settingsReach.test.ts` REQ-A488 and
`settingsPageBodies.test.ts` REQ-A499) pass without being touched.

| Entry | What it was | Disposition |
| --- | --- | --- |
| `src/svelte/modules/MDMPanel.svelte` | MDM configuration panel | **mounted** — first tab |
| `src/svelte/modules/AuditLogViewer.svelte` | audit-trail reader | **mounted** — second tab (this is the audit trail's first reading UI) |
| `src/svelte/modules/APISettings.svelte` | API token + webhooks | **mounted** — third tab |
| `src/svelte/components/VirtualList.svelte` | list virtualization component | **reachable again** — its only consumer is the audit panel, so it stopped being "dead because its consumer was dead" |
| `src/svelte/modules/TemplateLibrary.svelte` | the spec's fourth tab (企业模板) | **deliberately NOT mounted**: its catalogue has no producer (`templateManager.syncTemplates` / `initializeEnterprise` are called only from tests), so it would render a permanently empty screen. The page names this in the user's words (`settings.enterpriseTemplatesMissing`) instead of showing a tab that looks broken; the entry stays in `unwired-allowlist.json` with its reason. |

**Ratchet**: `unwired-allowlist.json` **12 → 8** entries, `unwired-baseline.json` values **98 → 97**
(`lib/enterprise/index.ts::initializeEnterprise` is now called from production — the panels initialize
the enterprise layer on mount — so its baseline entry had to go too).

**Honest boundary**: this makes the three panels *reachable and rendered*; it does not add device MDM
enrollment or a template-sync producer. The MDM **backend** was already wired and tested
(`amos-mdm`, `admin_auth`); what was missing was the surface, and that is what landed.

---

### Round 51 — the un-adopted lazy loader is adopted, and the three defects that only a caller sees are fixed (REQ-A587)

The backlog's own words for `src/svelte/components/LazyImage.svelte` were: *"Adopting it is a
**measured** performance change (the photo grid renders one page of 60 tiles), not a wiring detail — so
it is kept, not deleted."* This round does exactly that and records the measurement.

**Wired**: the gallery tile is now *glyph underneath, lazy image on top*, so a page of 60 tiles starts
**0** image decodes at render time (60 before) and a tile whose image fails is no longer a blank box.
Widening the measurement: only the tiles the viewport has seen get a real `src` (asserted as "reveal 4 →
exactly 4").

**Three defects that only a real caller sees** (all fixed):

| # | What it was | Why it matters to a caller |
| --- | --- | --- |
| 1 | no placeholder ⇒ `src={placeholder \|\| ""}` | `<img src="">` makes the browser request the **page's own URL** and paint a broken-image glyph |
| 2 | preloaded through `new Image()`, then handed the URL to the element | a data URL was decoded **twice**, and nothing appeared until the off-DOM load finished |
| 3 | its `<style>` forced `width: 100%; height: auto` | fights any caller that positions the image (`absolute inset-0 h-full w-full object-cover`) |

The rewrite is **element-driven** (the `<img>`'s own `load`/`error` events), carries no layout of its
own (`display: block` plus a `hidden-until-loaded` hook for the no-placeholder case), and adds
`loading="lazy"` / `decoding="async"` so the "no `IntersectionObserver` ⇒ show it immediately"
fallback is backed by the browser too.

**Tests**: the component had none (that is what "un-adopted" meant). It now has seven, plus a
controllable `IntersectionObserver` helper for this suite (`svelte-tests/lazy-observer.ts`) — happy-dom
ships one that can never fire, since it has no layout and no scroll.

**Ratchet**: the entry is gone from `unwired-allowlist.json` (components allow-listed: **1**).

**Honest boundary**: the gain is counted in *decodes started at render*, not in milliseconds — no
real-browser timing was done. The other two surfaces the entry named (the camera preview and tab
favicons) are **still eager**: they have no measurement behind them, and wiring them to claim a win
nobody read would be the shape this repo refuses.

---

### Round 52 — the Dock's request-attention half gets the caller the ledger asked for (REQ-A589)

The entry for `dock_request_attention` said exactly what was missing: *"nothing requests attention:
the shell has no 'this app wants you' moment that a bounce would add to … **Wire it when a background
delivery that the user might miss exists.**"* This round both names that moment and wires it.

**The moment**: a remote push that lands while the shell window is **hidden**
(`document.visibilityState !== "visible"`) — i.e. minimized / not being presented. The push watcher
(`svelte/osPushWatcher.ts`) already knows when a delivery really landed (it returns how many were
added), so the bounce is one line after that write.

**Why the signal is visibility, not focus**: an AmOS *app window* is its own WebView, so the launcher
window's `document.hasFocus()` is `false` while the user is actively working inside AmOS — bouncing
then would be a false alarm, and a false bounce is user-visible noise. The host offers nothing better:
there is no "is the application frontmost" query (checked: the only `is_active` in the tree is
AirPlay's discovery state), and deriving one from *window* focus would answer a different question. So
the rule is "the user cannot see the window", and the honest consequence is that a delivery arriving
while the window is merely *behind* other windows does not bounce — the badge still carries the count.

**Level**: `"info"` only (one bounce). `"critical"` keeps bouncing until the user clicks, and the push
payload carries no interruption level, so asking for critical would invent urgency the sender never
expressed. `requestAttention(level)` can send either; the watcher deliberately sends `"info"`.

**A defect the new caller exposed**: the watcher's "how many were added" was
`merged.length - held.length`, and the merge **caps** the list — so at the cap a delivery that really
landed reported **0**. Harmless while nothing read the number; wrong the moment the bounce keyed on it
(the user most behind would get no bounce). It now counts ids that were not already held.

**Tests**: `lib/__tests__/dockBadge.test.ts` grew the attention half (the pure decision, the visibility
read incl. "no `document` ⇒ never claim the user is away", and the command's wire contract incl. the
lowercase `"critical"`), and `src/__tests__/osPushWatcher.test.ts` grew the four end-to-end cases
(hidden ⇒ one `{level:"info"}` call, visible ⇒ none, nothing new ⇒ none, at the cap ⇒ still counted).

**Ratchet**: the entry is gone from `scripts/tauri-command-allowlist.json` (**32 → 31** allow-listed;
`256` distinct literal calls). The command was already registered; what changed is that a screen now
asks for it.

### `interpret_end_of_speech` — wired in REQ-A741 (the interpreter's "end this sentence")

The allow-list entry read, verbatim: *"Manual/VAD utterance boundary for the interpreter session.
The screen drives start/audio/pause/resume/stop; a \"finish this sentence\" affordance does not exist
yet."* That was honest about the gap and stayed true for a while — the command existed
(`interpret.rs:398`, registered at `lib.rs:465`), and its four strings sat in the **i18n** allow-list
under the same excuse (*"stubbed … not yet wired to a UI button"*). Two exemptions, one missing
button.

**What landed**: `lib/backend.ts::interpretEndOfSpeech(sessionId)` (wire key `sessionId`, pinned by
`tauri-args-scan.mjs`), and a button in `InterpApp.svelte`'s `{#if running}` control group
(`data-testid="interp-end-sentence"`) driving `endUtterance()`. The handler is deliberately honest on
two edges: it only sends the command when `partial` is non-empty (the screen's only signal that a
sentence is in flight — the daemon sets it on a `partial` event and clears it on `segment_final`), and
it reads the outcome from `bridgeDiag`, because the command answers `Result<(), String>` and `()`
serializes to `null` — the same value `invoke` returns on failure. `PhoneApp` uses the same pattern
for its `()`-returning commands.

**Ratchet**: the entry is gone from `scripts/tauri-command-allowlist.json` (**18 → 17** allow-listed;
`278` distinct literal calls), and the four `interp.end*` strings are gone from
`frontend-ts/scripts/i18n-allowlist.json` (**41 → 37**), now referenced by production. Both shrinks
fired by themselves when the button existed, rather than being remembered — which is the point of the
ratchet.

### `WebhookManager.trigger` — the ledger's excuse was the opposite of the truth (REQ-A910 / F-DEV-121)

This section is not about a *wired* export. It is about the excuse that kept an export off this
document's radar, and about the second method that excuse quietly hid.

`scripts/dead-member-allowlist.json` carries an entry for `webhooks.ts::getWebhook`, and its reason
read, verbatim: *"triggerWebhook 在生产里是活的，所以这不是「整套没接」，是**读半边没接**"* — "the
publisher (`triggerWebhook`) is live in production, so this is not 'the whole thing is unwired', it is
just the read half." Both halves of that sentence are false:

* **The named method does not exist.** `grep -rn triggerWebhook` across the repository returns **zero**
  hits. The real name is `WebhookManager.trigger` (`webhooks.ts:193`). A phantom name in a ledger reason
  is exactly the shape `scripts/claim-scan.mjs` was built to catch — and it did catch it, which is how
  the round started.
* **The method it *meant* is also unwired.** `grep -rn '\.trigger(' src/` (excluding `__tests__`)
  returns **zero** production call sites. So the whole chain `trigger → processEventQueue →
  sendWebhook` never runs in production. `modules/APISettings.svelte` (`availableEvents`, line 424) lets
  a user attach a webhook to each of seven events (`shortcut_create` / `shortcut_run` /
  `shortcut_update` / `shortcut_delete` / `shortcut_share` / `template_install` / `mdm_policy_change`),
  and **nothing ever emits them** — so `triggerCount` and the success rate are permanently `0`.

So the gap is not "the read half of the panel is unconnected." It is **the entire delivery chain has no
producer**. Wiring a read-only list would not make a single webhook fire.

**Why the second method stayed invisible**: `dead-member-scan` decides "is this member referenced?"
with a **substring** test, and `trigger` is a substring of `triggerCount` and `lastTriggeredAt`. So this
zero-caller public method never appears on that lamp — the same class as F-DEV-098 (`contains` asks
whether a word occurs, not whether it is the binding). **Same file, same reason line, two lamps
disagreeing.**

**What this round changed (scope correction only — no behaviour)**: the `getWebhook` reason now states
the measured truth and says the old wording was false in two places; the two `ForTest` reasons were
repointed at real symbols (`setConfigForTest` / `clearConfigForTest`) instead of the bare tag `ForTest`;
and `@deprecated` (a TSDoc/JSDoc tag, not a repo identifier — the same class as `EADDRINUSE` and
`NSApplication.dockTile`: a thing written in a comment, which a comment-stripped corpus can never
resolve by construction) is registered in `scripts/claim-allowlist.json`. **Not** touched:
`webhooks.ts`, `APISettings.svelte`, and `dead-member-scan`'s substring predicate.

**Ratchet**: `scripts/claim-scan.mjs` went from **3 FAIL** (`@deprecated`, `ForTest`, `triggerWebhook`)
to **OK** — 40 ledger files, 755 claimed tokens (580 distinct), 12 allow-listed — with its 26-assertion
`--selftest` passing. The remaining gap (no event source) is left for a round that has a producer.

### `quickEmergencyNumber` — wired in REQ-A912 / F-TEL-007 (the lock screen's one-tap emergency number)

The ledger listed `src/lib/emergency.ts::quickEmergencyNumber` as unwired. It was — and the consequence
was life-safety, not cosmetic.

`quickEmergencyNumber(region)` is the TypeScript mirror of the Rust `EmergencyMap::quick_dial`
(`crates/amos-telephony/src/number.rs`): CN/CN-HK/CN-MO/JP → `110`, KR → `112`, US/CA/MX → `911`,
AU/NZ → `000`, and the empty/unknown region → the universal `112`. It has a unit test that pins every
one of those regions. What it did **not** have was a single production caller — which is exactly why the
scanner wrote it into this ledger.

`LockScreen.svelte` — the whole-screen surface shown while the device is locked — dialed a **constant**:
`telephonyDial(EMERGENCY_QUICK_NUMBER, true)`, with `EMERGENCY_QUICK_NUMBER === "110"` (used for the
dial and for the label at four sites, so they were at least self-consistent — consistently wrong). For a
locked user in any jurisdiction that does not recognize `110` (Korea's police is `112`, AU/NZ dial
`000`, the US dials `911`…), the lock screen's **only** emergency affordance dialed a number that
connects to nobody — no ring, no error, and `telephonyDial`'s optimistic result gives the user no way
to tell.

**This is the correction of a booked mitigation.** FMEA **F-TEL-005** (REQ-A685) records its mitigation
as including "前端镜像同步" — the front-end mirror brought in line. The mirror *was* brought in line
(KR/AU/NZ all now agree with Rust). But a mirror nothing reads is not a mitigation: the lock screen kept
dialing the constant. The separation — *the mirror is right, the screen is wrong* — is invisible to
every gate: `unwired-scan` records "an unused export in an otherwise-wired module" as a **baseline line**
(treated as known/deliberate), and the unit test only asks *what the function returns per region*, never
*who reads it*.

**What this round changed**: `emergency.ts` gains `deviceQuickEmergencyNumber()`, which reads the
device's own BCP-47 locale (`navigator.language`) through a new `regionFromLocale` helper (2-letter
region subtag, skipping 4-letter scripts, underscore separator accepted, 3-digit M.49 passthrough, and
`""` when the tag names no region) and maps it with `quickEmergencyNumber`. A locale naming no region
falls to the universal `112` — never a single country's code. `LockScreen.svelte` reads it once on mount
(the OS locale does not change under a locked screen) and uses that one value for **both the dial and
the label**, so the displayed number and the dialed number cannot drift. `EMERGENCY_QUICK_NUMBER` is
**kept** — it is still the dialer Emergency page's highlighted primary code (`PhoneApp.svelte:787`); only
the lock-screen affordance changed.

**Ratchet**: the `::quickEmergencyNumber` line is removed from `scripts/unwired-baseline.json` by hand —
**not** via `--update-baseline`, which would also have rewritten a concurrent round's ledger entries
(`PUSH_STATUS_FIELDS`, `hostFsWriteText`). `bun test src/__tests__/emergency.test.ts` ⇒ 10 pass;
`bunx vitest run svelte-tests/lockscreen.svelte.test.ts` ⇒ 9 pass (four new DOM cases dial from
`ko-KR` / `en-US` / `en` / `en-AU` through a captured `invoke` and assert the label contains the dialed
number). Two negative controls, each restored byte-identically by sha256: hardcoding `110` again turns 4
DOM cases red; breaking the region regex turns 4 unit + 2 DOM cases red.
