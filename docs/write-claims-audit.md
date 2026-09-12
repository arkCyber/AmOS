# Write-claim audit — "a success message is an assertion"

## The rule

A user-visible claim about stored data (`已保存` / `Saved to Photos` / `已恢复 N 个存储` /
a row that only exists in the UI) must be backed by a **verified** write. In this
codebase that means `writeStoreValueChecked` (returns whether the value landed) rather
than the fire-and-forget `writeStoreValue`, and an honest error when it did not land.

Why it matters: `localStorage` fails silently when it is full or unavailable, and
swallowing that (which `writeJson` used to do) turns data loss into a *claim* that the
data is safe. The user only finds out when the album/note/passcode is gone.

## Verified so far

| Area | What is verified | Round |
| --- | --- | --- |
| Backup — "Sync now" | the snapshot write; on failure the page says "备份写入失败…" and claims no summary/time | 53 |
| Backup — "Restore" | every store write, partitioned into `restored` / `failed`; the page says "已恢复 N 个存储；M 个写入失败" | 55 |
| Notes — full-page editor | `保存于 HH:MM:SS` only after the write landed (a rejected write is the reducer's `save_failed` + `note.saveFailed`) | 54 |
| Notes — list | nothing is applied on a rejected write; the draft stays in the box, the inline editor stays open, `note-store-error` banner | 54 |
| Camera — photo | `已保存到相册` only after the album write landed (else `camera.saveFailed`) | 56 |
| Camera — video | `已保存到媒体库` only when the library index landed; a rejected index removes the orphaned bytes and reports `camera.saveFailed` | 56 |
| Lock passcode | `已保存` only after the config landed; a rejected write keeps the previous state and says `lock.saveFailed` | 56 |
| Radio (Wi‑Fi / Bluetooth) | the in-memory config moves only when the write landed; otherwise `radio-store-error` + `settings.radioSaveFailed` | 56 |
| Contacts | a rejected write shows the shared `store-write-error` banner, adds no row, and keeps the typed name/number in the form | 57 |
| Voice memos | a rejected rename keeps the row in edit mode with the title intact + the banner | 57 |
| Reminders (list + reminders) | a rejected write shows the banner, adds no reminder/list, and keeps the compose form open with the draft | 57 |
| Calendar (events + calendars) | a rejected write shows the banner, adds no phantom event, keeps the editor open; a failed calendar delete does **not** go on to reassign its events | 57 |
| Files (tree + favourites) | a rejected write shows the banner, adds/renames nothing, and keeps the create form / inline rename with the typed name | 58 |
| Music (playlist) | a rejected delete keeps the track (it is still in the store) and reports it | 58 |
| Messages (threads + drafts) | a rejected write shows the banner and adds/changes no thread | 58 |
| Photos (library + video favourite) | a rejected delete keeps the photo (the viewer stays open); a rejected video-favourite does not draw the heart | 58 |
| Interpreter transcript | a rejected clear keeps the transcript; a rejected segment write reports that the history was not stored | 58 |
| Call log — finished incoming call | a rejected append is **queued in memory** (`queuePendingCall`) and retried by the Phone history screen — which is also where the user looks for it — with `phone.pendingCalls` shown while it is still pending; the row is never silently lost | 86 |

**The pattern** (docs → code): content screens persist through a single
`persist*(next): boolean` choke point that uses `writeStoreValueChecked`, sets
`storeErr = t("common.storeWriteFailed")` on failure, **does not apply** the change, and
renders `<StoreErrorBar message={storeErr} />` at the top of the screen. A rejected write
therefore never becomes a row the store does not have, and the message clears on the
next successful write.

Tests pin each of these by installing a storage whose writes of exactly one key throw
`QuotaExceededError` (see `failWritesFor` in the suites) and asserting the *claim* never
appears.

## Mechanized (Round 59)

`scripts/write-scan.mjs` (in `bun run check` **and** `make lint`, `--selftest` first)
turns the rule above into a gate: every production `writeStoreValue(<content key>)` call
site must be **either** `writeStoreValueChecked` (the caller asks and acts on the answer)
**or** listed in `scripts/write-allowlist.json` under a kind whose reason is recorded
once. Writes of configuration/derived keys are ignored — no screen claims those are
saved content. A **new** unverified content write fails lint until someone decides which
it is; a stale allow-list entry is reported so the list cannot rot.

Current reading (measured by the gate, not by hand):

```
[write-scan] 87 write call(s): 28 verified, 13 classified, 46 non-content.
```

**The gate immediately found three sites a line-based `grep` had missed** (a call split
across lines hides its key from a line-oriented search): the video-capture **delete**
(`lib/cameraCapture.removeVideoCapture`), the clock's **alarm list** effect
(`ClockApp`), and the **call log** append (`IncomingCall`). The first two were real user
content and are now verified: the delete only removes the bytes once the index really
dropped the row (and reports otherwise), and the alarm effect reports a rejected write.
The third is classified below. That is the argument for the gate in one paragraph: the
hand inventory said "9 real user paths left" and was wrong.

## Round 60 — the last hole: the parameterised wrapper

`createStoreValue(...)` (src/svelte/store.ts) hands out a `save()` whose key is a
*parameter*, so `write-scan` can never resolve it — and Round 59's allow-list reason
("its callers are covered by the same rule where they write content") **was not true**:
the callers call `.save()`, not `writeStoreValue`. Production used it for real content —
the call log (`PhoneApp` clear + append, `ContactsApp` append) and the calculator
history.

| Finding | Verdict |
| --- | --- |
| `save()` returned `void`, so a caller could not know | **fixed** — `save(v): boolean` via `writeStoreValueChecked`; the type now forces the question |
| The callers applied the change regardless | **fixed** — `PhoneApp` (clear is destructive!) and `ContactsApp` report through the shared banner; `CalculatorApp` only sets its local history when the write landed (a rejected write dispatches no change event, so a phantom entry would have stayed on screen) |
| The allow-list reason over-claimed | **fixed** — the `generic-wrapper` kind was **deleted** (the site is no longer an unverified write); the gate reported it as `[stale]`, which is how the over-claim surfaced |

Blind spot that remains, stated: the gate matches `writeStoreValue*` calls by name, so a
*future* `.save()` caller writing content is invisible to it — the mitigation is the
return type (a caller who ignores `false` is visibly ignoring a value) and the tests
above, not a lint rule.



## Round 63 — who may touch `localStorage` directly

The write gate matches `writeStoreValue*` **by name**, so a store written with a raw
`localStorage.setItem` would be invisible to it — and there were five such files. They
are not all mistakes (theme/locale/session ids are plain strings read *before* the JSON
layer exists at boot, and `svelte/store.ts` applies a payload the **host** declared
authoritative), but nothing recorded *why*, and one of them had quietly drifted.

| Finding | Verdict |
| --- | --- |
| Nothing checked direct `localStorage` writes; a new bypass would pass every gate | **gated** — `write-scan` now requires every production file that calls `localStorage.setItem`/`removeItem` to be listed in `scripts/write-allowlist.json` (`localWrites`) under a kind with a reason, and reports stale entries |
| `lib/backend.ts`'s session write was the **only** raw store with **no** Rust write-through, unlike `themeCore`/`locale` (whose comments promise "one write-through, no second mechanism") | **fixed** — the raw session pointer now mirrors via `store_set` like the others; a unit test pins both the raw bytes and the mirror |
| The five sites were undocumented | **classified** — kinds `store-seam`, `raw-string-store` (theme/locale/session), `host-mirror` |

## Round 65 — "ask, but don't listen" is still a lie

The gate's rule was "either `writeStoreValueChecked` **or** allow-listed", which could be
satisfied by renaming a call and **throwing the answer away** — the caller would still
apply a change the store rejected. The corpus had no such site, so this closes the loop
before someone writes one.

| Finding | Verdict |
| --- | --- |
| A `writeStoreValueChecked(...)` whose result is discarded (a bare statement, or `void …`) passed the gate | **gated** — `write-scan` now fails it: the answer must be used (`if (!…)`, assignment, ternary, `return`, …). Sites with a reason can be allow-listed under `ignoredResults`; stale entries are reported |
| Nothing distinguished "asked" from "asked *and acted*" | **pinned** — `resultDiscarded` classifies a call by the token after its closing `)` and the statement boundary before it, with 7 selftest assertions covering the forms |

Current reading: 27 selftest assertions, and the production corpus has **0** discarded
answers (the rule holds for every existing site).

## Round 86 — the last recorded residual gap: the incoming-call row

Round 59 classified the incoming-call append as a `system-event` and recorded the gap
honestly: *"a rejected write costs that one history row, silently"* — because the call
overlay is closing and no screen is left to report a failure. That was true of the code, and
it was the only gap in this document that was **not** a choice about a claim (like the
`demo-seed` or `derived-tick` kinds) but a row the user expected to be there.

| Finding | Verdict |
| --- | --- |
| The append used the fire-and-forget `writeStoreValue` | **fixed** — `writeStoreValueChecked`; the answer decides whether the row is queued |
| A rejected row was lost for good | **fixed** — `queuePendingCall` keeps it in memory (bounded like the log, de-duplicated per call), and the Phone history screen — the place the user looks for it — flushes it through the same checked write |
| Nothing told the user | **fixed** — while a queued call still cannot be written, that screen shows `phone.pendingCalls` (“N call(s) not written to history yet”) instead of an empty-looking history |
| The allow-list entry said the gap was accepted | **retired** — the gate flagged the entry `[stale]` (“shrink with a reason”), which is exactly its job; the kind is kept as `system-event-removed` with the reason, not deleted silently |

Boundary, stated: the queue is **in memory**, so a transient failure (storage full, then
freed) is recovered but a **reload** before a successful flush still loses the row —
persisting the pending marker would need the very storage that just failed. A negative
control also removed one line of the new code (a flush-on-mount call) and showed it changed
nothing: the store's `subscribe` callback runs synchronously, so subscribing *is* the flush,
and the redundant call was deleted rather than left as decoration.

Round 59 classified the demo seeds on the claim that they are "re-derived on every mount
while the store is empty". Reading the guards for real showed the claim was right about
the *mechanism* and wrong about the *rule*: six of them treated `[]` as "never
initialised", so **a user who deleted everything got the demo fixtures back on the next
mount** — deleted photos, threads, events, reminders, memos and files reappearing.
`Shell.seedContactsOnce` already documented the correct rule ("an intentionally emptied
address book must stay empty" — it tests the key being **absent**, not empty).

| Finding | Verdict |
| --- | --- |
| Files / Photos / Messages / VoiceMemos / Calendar / Reminders re-seeded an **emptied** store | **fixed** — every seed now seeds only when the key is **absent** (`readStoreValue(key, undefined)`) |
| The built-in calendar/list still has to exist, or its rows are unreachable | **kept** — a *missing* built-in is still repaired; only the demo *content* is gated on absence. Commented as a repair, not a re-seed |
| The allow-list reason described the old behaviour | **corrected** — the `demo-seed` reason now states the absence rule, and each app pins it with a "not re-seeded" test |

## Not verified yet (explicit, not implied)

The classified sites, by kind (each kind's reason is written once in
`scripts/write-allowlist.json`):

| Kind | Sites | Why it is acceptable |
| --- | --- | --- |
| `demo-seed` | 12 (Files, Music, Reminders ×2, Messages, Photos, Calendar ×2, VoiceMemos, Shell, plus the built-in-calendar/list **repair** writes in Calendar and Reminders) | first-run demo fixtures, written **only when the key is absent** (an emptied store stays empty; each app pins it with a test). The two repair writes run while the key exists and insert only the built-in entry, so a row is never left unreachable |
| `derived-tick` | 1 (`alarmCore`) | the `ringing` marker is derived, self-healing state written by the background watcher, not a user edit |
| `system-event` *(retired, round 86)* | 0 | this used to hold the incoming-call append as an accepted **residual gap** ("a rejected write costs that one history row, silently"). Round 86 removed the gap: the append is a checked write whose rejected row is queued and flushed by the Phone history (see the verified table above). The gate reported the entry `[stale]`, which is how the retirement surfaced; the kind remains in the allow-list as `system-event-removed` so the *reason* it disappeared is on the record |
| `store-seam`, `raw-string-store`, `host-mirror`, `session-id` | 5 files (the `localWrites` list) | direct `localStorage` writes: the seam itself, three deliberately-**raw** string stores (theme / locale / session ids are read at boot before the JSON layer exists, and each mirrors via `store_set`), and the host-authoritative cross-window mirror in `svelte/store.ts` |

