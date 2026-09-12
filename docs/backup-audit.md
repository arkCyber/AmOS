# Store-key / backup audit — "a store nobody classified"

## Why this exists

`lib/cloud.ts` snapshots the user-data stores into a local backup, and the Settings
hint promises that **"data is snapshotted"** (`settings.icloudHint`). Twice the list
**drifted from the stores that exist** — `amos.files.fav` never matched
`FILES_FAV_KEY`, the legacy `amos.messages` never matched `CONV_KEY` — so file
favourites and every message thread were missing from every backup (fixed in
Round 20 by using each store's own key constant).

Round 50 found the mirror failure: the list was **incomplete on purpose**. Contacts,
calendar events + calendars, alarms, the call log, voice memos, in-app captures, SMS
drafts and the interpreter transcript are content the user created, and none of them
were in a backup whose copy tells the user their data is snapshotted. The snapshot
covered 8 stores; it now covers 17.

The durable fix is not "add 9 entries" but a **classification gate**
(`scripts/store-scan.mjs`): every `amos.*` store key that appears in production must
be **either** in `SYNC_STORES` **or** in `scripts/store-allowlist.json` under a named
kind whose reason is recorded once. A new store key therefore fails `make lint` until
someone decides which it is — it can never silently miss every backup.

## What it checks

1. **Unclassified key** — a `"amos.…"` literal that is neither in `SYNC_STORES` (the
   list is read out of `lib/cloud.ts` and its entries resolved through the real key
   constants, never copied) nor allow-listed. *Hard gate.*
2. **Stale `SYNC_STORES` entry** — a listed key no store writes: it backs up nothing
   and lies about the snapshot. *Hard gate.*
3. **Unresolvable entry** — a `SYNC_STORES` member that is not a quoted literal and
   not a known `X_KEY` constant. *Hard gate.*
4. **Stale allow-list entry** — reported (with a reason to shrink), so the list
   cannot rot.

Corpus: production `src/**` (`.ts`, `.svelte`; tests and the locale dictionaries are
excluded). Dot-form keys only: `amos-media` / `amos-svelte-locale` are DOM event
names, not stores.

## The classification (the reviewed artifact)

`scripts/store-allowlist.json` names four kinds, each with its reason recorded once:

| Kind | Meaning |
| --- | --- |
| `configuration` | user-set preferences / UI state (toggles, layout, theme+locale, per-app settings, the permission ledger, chosen cities/clock) — losing them costs a re-setup, not content, and a restored backup must not silently re-grant capabilities or move the theme across devices |
| `derived` | state the app recomputes or that only matters for the current run (fired flags, the RAG index id list, recents, in-app history, the AI session pointer, a running countdown, notification-centre history, debug counters) |
| `device-state` | mirrors of OS state (wifi, bluetooth, cellular, flashlight): the device is the source of truth and could contradict a restored copy |
| `meta` | the backup blob itself |

Today: **52 store keys — 17 backed up, 35 classified** (20 configuration, 10 derived,
4 device-state, 1 meta).

## Findings (Round 50)

| Finding | Verdict |
| --- | --- |
| `SYNC_STORES` omitted 9 content stores (`amos.contacts`, `amos.calendar`, `amos.calendars`, `amos.alarms`, `amos.calllog`, `amos.vmemos`, `amos.captures`, `amos.sms.drafts`, `amos.interp.log`) while the copy promised "data is snapshotted" | **wired** — added to `SYNC_STORES` via each store's own constant (imports added; contacts/calendar/alarms/call-log/voice-memo/capture/draft/transcript data now snapshots) |
| The other 35 keys had no recorded decision | **classified** in `scripts/store-allowlist.json` with a per-kind reason, so the omission is now an explicit choice |

## Findings (Round 51) — the backup was write-only

Classifying *what* goes into a backup is only half the promise. The snapshot was
written to `amos.cloud.backup` by "Sync now" and **nothing else in the repo ever
read that key**: no restore, no way to see what the backup held, and — because the
blob was never consumed — a corrupt or forged backup had never been rejected.

| Finding | Verdict |
| --- | --- |
| No restore path: the Settings hint promises "data is snapshotted as a local backup" but the backup could never be put back | **wired** — `lib/cloud.restoreStores` + a "恢复本地备份 / Restore local backup" button, with an honest result line |
| The page never said what the backup holds (or that a fresh one is mostly empty `[]` defaults) | **shown** — `summarizeBackup` renders `filled/total` stores |
| A forged blob could have re-granted a capability (`amos.permissions`), moved a radio (`amos.wifi`) or invented a store | **refused** — restore whitelists `SYNC_STORES` and reports every other key; a malformed blob writes **nothing** |

## Findings (Round 52) — the blob had no identity

A backup you can put back is still incomplete if the blob does not say **what it is**.
The snapshot was a bare store map, and "when was it taken?" lived in a *separate*
settings pref (`amos.settings.cloudLast`), which can outlive the blob it was written
alongside; there was also no format version, so a future shape change would have been
silently interpreted as the current one.

| Finding | Verdict |
| --- | --- |
| "Last synced {time}" was read from the settings pref, so it was still claimed after the blob was cleared/corrupt — promising a backup that no longer existed | **fixed** — the time comes from the blob's own `at`; with no restorable backup the page claims no sync time at all |
| The blob carried no timestamp of its own (a restored *old* blob was labelled with the newest sync) | **fixed** — `snapshotStores(stores, at)` writes `{v, at, stores}` |
| No format version: a blob written by a future build would be restored as if it were today's shape | **fixed** — `BACKUP_VERSION` + a restore that **refuses** a newer blob (`reason: "unsupported-version"`) instead of guessing |
| Shipping an envelope could have bricked existing backups | **avoided** — a pre-envelope (legacy) blob is still read and restored; it simply reports `v: null, at: null` |

## Findings (Round 53) — a rejected write was silent

`amosStore.writeJson` wrapped the whole write in `try { … } catch { /* ignore */ }`, so
a **quota-exceeded / unavailable localStorage** was indistinguishable from success — and
`AccountPage.syncNow` then set its own state from the snapshot it had only *tried* to
write. The page reported "本地备份：N/17 个存储有内容" and "上次同步 …" for bytes that were
never stored. A backup that exists only in the UI is worse than no backup.

| Finding | Verdict |
| --- | --- |
| Write failures (full/unavailable storage, unencodable value) were swallowed | **reported** — `writeJson` returns whether the value landed, and logs a `store` **error** (data loss is an error — the same rule the corrupt-value quarantine follows) |
| Nothing could tell the caller, so the backup page claimed a snapshot it had not stored | **fixed** — `writeStoreValueChecked` + a verified `syncNow`: on failure the page says "备份写入失败…" and the summary keeps describing whatever **is** stored (the previous backup, or none) |
| A failed write still fired `amos-store-changed`, so a same-window consumer would re-read a value that never changed | **fixed** — the event is dispatched only after the write lands |
| Every other write path keeps its fire-and-forget signature | **preserved** — `writeStoreValue` stays `void`; no call site had to change |
| `writeJson` must stay **total** (never throw): callers like `addRecent`/`pushRecent`/`savePrefs` rely on it | **preserved** — the change notification is best-effort (a host `window` without an event bus must not turn a successful write into a thrown error). The full gate run caught this: moving `dispatchEvent` out of the old blanket `try` broke `android`/`core`/`interp` tests whose `window` stub has no event bus, so a regression test now pins it |

Boundary: the Rust `store_set` write-through is still fire-and-forget (best effort), so the
outcome reported here is the **local** store's — the copy this window reads back from.

## Findings (Round 55) — a restore counted attempts, not outcomes

`restoreStores` took a `void` writer, so it reported `restored` from the keys it
*called*. The Settings page could therefore say "已恢复 17 个存储" while every write was
rejected (full/unavailable storage) — the same lie as Round 53's unverified backup
write, in the restore direction.

| Finding | Verdict |
| --- | --- |
| The writer **could not** report an outcome (`(key, value) => void`) | **changed** — `RestoreWriter = (key, value) => boolean`; an attempt that cannot be confirmed is not a restore |
| Rejected writes were counted as restored | **fixed** — the report partitions into `restored` / `failed`, and the page says "已恢复 N 个存储；M 个写入失败…" instead of a clean count |
| The page passed the unchecked `writeStoreValue` | **fixed** — it passes `writeStoreValueChecked` |

## Restore: what it does and does not do

`restoreStores(raw, write)` is pure (the store writer is injected), and:

- writes **only** `SYNC_STORES` keys, in snapshot order (same fixed order as
  `snapshotStores`);
- **honours the writer's answer**: a store it could not store is reported in `failed`,
  never counted in `restored` (claiming stores that were never written is the same lie
  as a backup that was never stored);
- treats a malformed/absent blob as `ok: false, reason: "malformed"` and writes
  **zero** keys — a corrupt backup must never blank the user's stores, i.e. "restore"
  ≠ "wipe";
- refuses a blob from a **newer** format (`ok: false, reason: "unsupported-version"`)
  rather than applying a shape it cannot interpret;
- reports (and refuses) any key the blob carries that is not backup-eligible, so
  configuration and device-state keys can never be applied by a restore. That is the
  same line `store-allowlist.json` draws, now enforced at *write-back* time as well.

Deliberately **out of scope** (stated, not implied): there is still no cloud
upload/download endpoint — this restores the *local* snapshot only; the backup is
plaintext `localStorage` (no encryption, no key management); and `parseBackup`
distinguishes a valid-but-empty blob (`{}`) from a corrupt one (`null`) so the UI can
stay honest instead of offering a restore from garbage. Reading a legacy blob is a
compatibility path, not a promise that every future version keeps it forever — a
future `BACKUP_VERSION` bump is what makes a *newer* blob refusable, and the version
marker is what makes that decision possible at all.

## Running it

```sh
cd crates/amos-tauri/frontend-ts
node scripts/store-scan.mjs                 # gate (exit 1 on any finding)
node scripts/store-scan.mjs --json          # machine-readable
node scripts/store-scan.mjs --selftest      # pin the extractor (8 assertions)
```

It runs in `bun run check` and `make lint` (hence CI), self-test first. Negative
controls verified: trimming `SYNC_STORES` back to the old 8 keys ⇒ the gate names the
9 content stores; adding `export const BM_KEY = "amos.bookmarks"` ⇒ FAIL as
unclassified; both restored ⇒ OK.
