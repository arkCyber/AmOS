# UI dictionary audit — key parity, `{param}` parity, and dead keys

## Why this exists

`src/i18n/locales/{en,zh}.ts` are the **only** source of user-visible copy. Two
failure modes are invisible to every other gate:

* a **dead key** — copy that can never be shown (its screen was renamed, the
  affordance was removed, an iteration was superseded). These accumulate silently;
  the last manual sweep deleted **29** at once, and nothing stopped them returning.
* a **placeholder mismatch** — `en` says `{n}` while `zh` says `{count}` (or omits
  it). `tsc` cannot see it (both are just strings), so at runtime one locale
  silently drops the value or prints a raw `{count}`.

`scripts/i18n-scan.mjs` turns both into a gate.

## What it checks

Corpus: `crates/amos-tauri/frontend-ts`. Production = `src/**` minus
`*.test.*`/`__tests__/` and minus `src/i18n/locales/`; tests = `src/__tests__` +
`svelte-tests/`; **contract** = every `crates/**/*.rs` + `proto/*.proto`.

### 1. Key parity — hard gate

`en` and `zh` must expose exactly the same key set. (`en` is typed
`Record<MessageKey, string>` off `zh`, so `tsc` already catches most drift; this is
the standalone restatement.)

### 2. Placeholder parity — hard gate

For every key, the sorted set of `{param}` names must be identical in `en` and
`zh`. 0 mismatches today.

### 3. Dead key — hard gate (no baseline)

A key no production file references. Before calling a key dead, three exclusions
run, because deleting a live string is worse than leaving a dead one:

| Exclusion | Why | Example |
| --- | --- | --- |
| **Contract key** — the quoted literal `"key"` also appears in `crates/**` or `proto/*.proto` | the Rust daemon *emits* the key and the UI renders it through a dynamic `t(data.key)`; deleting it breaks a daemon↔UI contract | `care.uninstall.protected` is `UninstallVerdict::reason_key()`; `care.<area\|junk\|battery>.*` come from `amos-devocare` |
| **Dynamic namespace** — a `` `prefix.${…}` `` template exists in production | the key is built at runtime | `t(\`message.folder.${f}\`)`, `t(\`weather.city.${c.id}\`)`, `` `player.origin.${o}` `` |
| **Allow-list** — `scripts/i18n-allowlist.json`, `{ key, reason }` | deliberate ahead-of-host copy | (none today) |

Everything else is reported, split into *referenced nowhere* and *only a test
references it* (a test-only key is a fixture masquerading as product copy).

## Running it

```sh
cd crates/amos-tauri/frontend-ts
node scripts/i18n-scan.mjs                 # gate (exit 1 on any finding)
node scripts/i18n-scan.mjs --json          # machine-readable report
node scripts/i18n-scan.mjs --selftest      # pin the parser/classifier
```

It runs in `bun run check` and `make lint` (hence CI), self-test first.

## Check 4 — hard-coded markup copy (Round 49)

The three checks above audit the **dictionary**; none of them could see copy that
never reached it. `hardcodedCopy` scans the **markup** half of every production
`.svelte` file (everything after `</script>`, before `<style>`, HTML comments
removed) for literals containing CJK: text nodes, translatable attributes
(`title`/`placeholder`/`alt`/`aria-label`) and string literals inside `{…}`
expressions. A finding is a **hard gate**.

* A string in the `<script>` block is deliberately **out of scope** — that is where
  seeds/fixtures live (calendar demo events, music tracks, the city index). A
  script-side *user-visible* message is found by review, not by this check (this
  round found and fixed one: `NoteEditor`'s deleted-note save error).
* The allow-list `scripts/i18n-literal-allowlist.json` (`{ literal, reason }`) holds
  deliberate cases — today one: the language picker lists each language by its own
  name (`中文`), which must not be translated.

## Findings from this audit (Round 49, REQ-A110)

The check found **19 hard-coded, user-visible literals** — every one of them
invisible to English users except as Chinese text:

| Where | Before | After |
| --- | --- | --- |
| `NoteEditor.svelte` | `placeholder="开始输入…"`, `☑ 勾选`, `＋ 任务`, `预览`, `正在保存…`, `保存于 {time}` (and a script-side `笔记已被删除，改动未保存`) | `note.editorPlaceholder` / `note.editorToggleTask` / `note.editorPrefixTask` / `note.editorPreview` / `note.saving` / `note.savedAt` / `note.editorDeleted` |
| `NotesApp.svelte` (14) | 8 Chinese `title=` tooltips (Markdown import, the task/preview toolbar ×2, clipboard copy/paste/history, `.md` export) + the `点按笔记…`/`列表按修改时间…` preference hints + the `整页` button | `note.importMdHint`, `note.editor*Hint`, `note.copyHint`/`pasteHint`/`clipHistoryHint`, `note.exportMdHint`, `note.tapToEditHint`, `note.sortHint`, `note.fullPage` |
| `InterpApp.svelte` | `{seg.srcLang ? … : "源"}` fallback chip | `interp.srcUnknown` ("未标注" / "n/a") |

The same file mixed English `aria-label`s with Chinese `title`s (`aria-label="Copy to
AmOS clipboard" title="复制到系统剪贴板"`), which is what made the gap easy to miss.
Also corrected while here: `NoteEditor.svelte`'s header comment claimed it was
"Standalone (**not yet wired into NotesApp**)" — it has been mounted by
`NotesApp.svelte` (`openEditor` → the "整页 / Full page" button) for several rounds,
and `note-editor.svelte.test.ts` said the same.

Pinned by behaviour: `note-editor.svelte.test.ts` and `notes.svelte.test.ts` each
render in **`en`** and assert the English labels (plus "no CJK anywhere in the
editor"); the zh wording is unchanged, so the older assertions still hold.

## Findings from this audit (Round 31)

15 dead keys deleted from **both** dictionaries (1150 → **1135**), the two
test-only fixtures rewired to live keys:

| Key(s) | Verdict |
| --- | --- |
| `care.root`, `care.score`, `care.noData`, `care.memoryDelta` | **deleted** — not emitted by `amos-devocare` and not referenced in the UI; superseded by `care.grade`/`care.items`/the boost + memory rows. |
| `clock.zone` | **deleted** — superseded by `clock.world` (the tab label actually rendered). |
| `player.nowPlaying` | **deleted** — the player shows controls + `player.count`, never a "Now playing" title. |
| `shell.lock` | **deleted** — superseded by `shell.lockTitle` / `shell.unlock`. |
| `files.externalHint` | **deleted** — copy for a Files *external-collections* section that does not exist yet (the same missing host that allow-lists `lib/externalFiles.ts`). Re-add it with that section. |
| `calendar.add`, `calendar.newCalendar`, `calendar.color`, `calendar.selectDay`, `calendar.readOnlyDefault` | **deleted** — leftovers from an earlier calendar UI; the shipped screen uses `calendar.create`, `calendar.calendarName`, `calendar.deleteCalendar`, … |
| `home.greeting`, `count.notifications` | **deleted + tests rewired** — referenced only by `i18n.test.ts` as generic fixtures; it now uses live keys (`clock.world`, `care.items`) instead, so the dictionary carries no test-only copy. |

**Kept (not dead):** the 9 `care.*` contract keys above — a naive cleanup would
have deleted live strings, which is exactly why the Rust corpus is consulted.

## Honest boundary

The scan is **static**: it proves a key is referenced, not that a screen renders
it, and it treats any literal occurrence (including one in a comment) as a
reference — conservative in the direction that avoids deleting live copy. Keys
built from a **contract string the daemon only constructs at runtime** (rather
than a literal) cannot be seen and would need an allow-list entry; no such key is
known today.
