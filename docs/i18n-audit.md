# UI dictionary audit — key parity, `{param}` parity, dead keys, hard-coded markup copy, unresolvable `t(…)` references, and nameless controls

## Why this exists

`src/i18n/locales/{en,zh}.ts` are the **only** source of user-visible copy. Two
failure modes are invisible to every other gate:

* a **dead key** — copy that can never be shown (its screen was renamed, the
  affordance was removed, an iteration was superseded). These accumulate silently;
  the last manual sweep deleted **29** at once, and nothing stopped them returning.
* a **placeholder mismatch** — `en` says `{n}` while `zh` says `{count}` (or omits
  it). `tsc` cannot see it (both are just strings), so at runtime one locale
  silently drops the value or prints a raw `{count}`.

`scripts/i18n-scan.mjs` turns both into a gate. It carries **eight** checks in total:
the three dictionary properties (1–3), the markup checks (4: hard-coded CJK copy, 5:
hard-coded English copy, 6: a test-hook id used as an accessible name), and — added by
REQ-A183 — **7: a `t(…)` reference the dictionary cannot answer** and **8: an
interactive element with no usable accessible name**, both described below.

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

## Check 5 — hard-coded **English** copy in markup (REQ-A180)

Check 4 keys off the **CJK** character set, so it only ever saw copy in the
dictionary's own language. The gap was recorded here as an honest boundary ("非 CJK
语言（如纯英文硬编码）不在此门内") — and Round 49's own findings list shows it biting:
`NotesApp.svelte` had `aria-label="Copy to AmOS clipboard"` next to a Chinese
`title=`, and the English half was left in place.

`englishCopy` closes it for the decidable cases: **multi-word** English, **or a single
all-letters word**, in `title` / `placeholder` / `alt` / `aria-label` or a text node.
Hard gate, same allow-list. (The single-word half came second, REQ-A181: an icon-only
control's accessible name is usually one word — `aria-label="lock"`, `"shutter"`,
`"backspace"`.)

* What keeps it decidable is the **separator**: every test hook in this corpus is
  kebab/snake/slug (`block-add`, `spotlight-new-note`, `note-compose`), i.e. contains
  `-`, `_` or `.`, while copy never does.
* The non-copy single tokens that remain (`HDR` — a camera mode chip; `A` — an avatar
  initial; `debug`/`info`/`warn`/`error` — the diagnostic ledger's log levels) are
  allow-listed **with a reason** in `scripts/i18n-literal-allowlist.json`, so a *new*
  one appears as a finding instead of passing silently.
* **Out of scope (honest):** anything inside `<script>`. (The kebab/snake/slug values
  that check 5 skips are *not* ignored overall — check 6 below catches them from the
  other direction: as accessible names that must not be hooks at all.)

## Check 6 — a test-hook id used as an accessible name (REQ-A182)

Check 5 has to step around kebab/snake/slug values, because that is how this repo's
DOM tests find elements. But the same value sits in `aria-label`, so it **is** the
accessible name — a screen reader announces "note-compose", and it **overrides** any
visible text the control already has. 60 such attributes were found across 9
components (`NotesApp` 18, `MessagesApp` 13, `PhoneApp` 10, `NoteEditor` 6, `FilesApp`
5, `SpotlightPanel` 3, `AiApp` 2, `ClockApp` 2, `QuarantinePanel` 1).

Treatment, per site, in one pass:

| Situation | Treatment |
| --- | --- |
| the control names itself (visible text, or an `<input>` inside `<label>`) | **drop** the label; the hook moves to `data-testid` |
| `<input>` / `<textarea>` / `<select>` / icon-only / a role-carrying container | keep the hook as `data-testid` **and** add a real `t(...)` name — an existing key where the feature already rendered that label (`files.search`, `note.placeholder`, `message.toPlaceholder`, `phone.blockPlaceholder`, `note.editorPlaceholder`, …), else a new one (`note.editLabel`, `phone.blockKindLabel`, `phone.blockChannelLabel`) |

Because the hook **value is unchanged**, the DOM-test rewrite is mechanical: 119
`[aria-label="…"]` selectors became `[data-testid="…"]` (plus three helper calls
inlined to the same attribute). Hard gate — a new `aria-label="some-thing"` cannot
creep back in.


## Check 7 — a `t(…)` reference the dictionary cannot answer (REQ-A183)

Checks 1–3 audit the **dictionary**: parity, `{param}` parity, dead keys. Nothing
audited the **reference side**, and nothing else can either:

* `t()` is declared `t(key: string, params?)` (`src/svelte/locale.svelte.ts`) — *not*
  `MessageKey` — so `tsc`/`svelte-check` accept any string;
* `translate()` falls back to the key itself (`const base = raw ?? key`,
  `src/svelte/i18n.ts`), and an unsupplied param prints as itself
  (`String(params[k] ?? \`{${k}}\`)`).

So both of these type-check clean and ship garbage to the user:

| Call site | What the user sees |
| --- | --- |
| `t("note.backTypo")` | `note.backTypo` — the raw key, in place of a button label |
| `t("message.blockSenderDone")` (needs `{addr}`) | `已屏蔽 {addr}：…` — the raw placeholder |

`keyRefs` extracts every literal `t("key")` / `` t(`key`) `` from production `.ts` +
`.svelte` sources together with the params the call supplies; `keyRefProblems` then
compares that against `zh` (key parity makes `en` equivalent). Undecidable param shapes
(a variable, a call, a spread) are **counted and reported, never judged** — that is the
honest boundary, not a silent pass.

State at introduction: **1 124** literal references, **125** param-carrying calls,
**0** findings, **0** undecidable param shapes. The gate is what keeps 0 at 0.

Negative controls (each mutation ⇒ the matching FAIL, then byte-identical restore via
`cmp`): `t("a11y.back")` → `t("a11y.backTypo")` ⇒ *no such key — t() would render
"a11y.backTypo" to the user*; `t("message.blockSenderDone", { addr })` → without params
⇒ *missing {addr} — t() would render "{addr}" to the user*.

## Check 8 — an interactive element with no usable accessible name (REQ-A183)

This is the other half of check 6, and the failure mode check 6's own fix can create.
Check 6's table said to **drop** the label when "the control names itself (visible
text…)". For `NoteEditor.svelte`'s back button the "visible text" is the glyph `‹`:

```svelte
<!-- before A182: aria-label="note-editor-back"  (a hook, read out verbatim) -->
<button data-testid="note-editor-back" onclick={back}>‹</button>
```

…which leaves a screen reader announcing "‹, button" — the defect class check 6 exists
to remove, reintroduced by its treatment. Nothing saw it: check 4 keys off CJK, check 5
off English, check 6 off hook shape (`-`, `_`, `.` separators).

`nameProblems` computes an accessible-name approximation per markup element (controls
plus the ARIA roles that are useless unnamed) and flags two shapes: **`none`** — nothing
readable, and **`symbol`** — only glyphs/emoji.

| Name source | Counted as a name? |
| --- | --- |
| `aria-label` / `aria-labelledby` / `title` — literal or `{…}` expression | yes (an *empty* literal does not) |
| a text field's `placeholder` | yes — weak (it vanishes while typing) but present |
| a `<label>` wrapping the element, or linked `for="…"` ↔ `id="…"` | yes |
| visible text or a `{…}` expression in the content, **outside `aria-hidden` subtrees** | yes |
| `data-testid` | **no** — a hook is not a name |
| glyph-only content (`‹`, `✕`, `＋`) | **no** → `symbol` |
| an icon in an `aria-hidden` span, `{@html iconSvg(…)}` | **no** → `none` |

Also checked: `role="button|link|checkbox|switch|tab|…|dialog|region|img|progressbar"`
containers (an unnamed `role="region"` is not a landmark at all). Not controls, so not
reported: `input type="hidden"`, a `href`-less `<a>`, `aria-hidden` elements.

Findings **1** — the back button above, fixed with `aria-label={t("a11y.back")}` (an
existing key, the same one `ClockApp.svelte` already uses for its identical `‹` button).
An independent throwaway probe (accname approximation over all 78 production components,
**508** interactive elements) agrees: **117** carry `aria-label`/`title`, **391** name
themselves, **0** were unnamed — i.e. the class A182 left open ("icon-only controls may
have no name at all") is measured **empty**; the real follow-up was one step in the
opposite direction. After the fix: 0 nameless, 0 symbol-named.

Negative control: delete the `aria-label` line ⇒ *interactive element with no usable
accessible name: src/svelte/NoteEditor.svelte `<button>` only a glyph ("‹")*; restore
byte-identical (`cmp`).



**26 literals** across **14 components** — the accessible names and tooltips of
icon-only controls, i.e. exactly what a screen reader reads out. The whole
always-on chrome was affected:

| Where | Before (rendered to a zh user too) | After |
| --- | --- | --- |
| `StatusBar.svelte` | `aria-label="network status"`, `aria-label="flashlight on"`, `title="Flashlight"`, `aria-label="battery level"`, `battery: charging 80%` / `battery: 80%` (built in the component) | `a11y.networkStatus` / `a11y.flashlightOn` / `a11y.flashlight` / `a11y.batteryLevel` / `a11y.battery`{pct} / `a11y.batteryCharging`{pct} |
| `lib/netStatus.ts` | built the titles as English **sentences** (`"Wi‑Fi · SSID · no internet"`, `"Airplane mode"`, `"Bluetooth"`) | returns **keys** (`a11y.wifiWithSsid`{ssid}, `a11y.wifi`, `a11y.wifiNoInternet`{ssid}, `a11y.wifiNoConnection`, `a11y.bluetooth`, `a11y.airplaneMode`); the status bar renders them |
| `CameraApp`, `MapsApp` | `"zoom slider"`, `"last photo"`, `"zoom in"`, `"zoom out"` | `a11y.zoomSlider` / `a11y.lastPhoto` / `a11y.zoomIn` / `a11y.zoomOut` |
| `HomeDock`, `LockScreen`, `AppLibrary` | `"home screen"`, `"home pages"`, `"battery level"`, `"clear search"` | `a11y.homeScreen` / `a11y.homePages` / `a11y.batteryLevel` / `a11y.clearSearch` |
| `NotificationCenter`, `PhoneApp` | `"edit home"` (label **and** tooltip), `"call duration"` | `a11y.editHome` / `a11y.callDuration` |
| `PhotosApp`, `RemindersApp` | `"native photos"`, `"favourite video"`, `"close video"`, `"high priority"` ×2 | `a11y.nativePhotos` / `a11y.favouriteVideo` / `a11y.closeVideo` / `a11y.highPriority` |
| `VoiceMicButton`, `StreamVoiceButton`, `DeviceMicButton` | `"voice input"`, `"streaming voice input"`, `"device voice input"` | `a11y.voiceInput` / `a11y.streamingVoiceInput` / `a11y.deviceVoiceInput` |
| `NotesApp` | `aria-label="Copy to AmOS clipboard"` / `"Paste from AmOS clipboard"` / `"Clipboard history"` | **reuses the existing tooltip keys** `note.copyHint` / `note.pasteHint` / `note.clipHistoryHint` (no duplicate copy) |

The DOM tests that selected those elements by their English label now select the
**localised** value (`zh["a11y.…"]`, or `en[…]` in the one suite that renders `en`) —
which is a stronger assertion: it pins that the label follows the locale.

## Findings from this audit (REQ-A181)

The single-word half found **25 more** labels across **12 components** — the same
class (icon-only controls announcing English to a zh user): `AppLibrary`/`Shell`
`back`/`home`, `NotificationCenter` `search`/`recents`/`lock`/`clear`/`dismiss`,
`PhoneApp` `call`/`end`/`backspace`/`clear`, `ClockApp` `reset`/`lap`, `MusicApp`
`previous`/`next`, `CameraApp` `shutter`, `MessagesApp`/`AiApp` `send`, `FilesApp`
`favorite`, `InterpApp` `mic`, `PhotosApp` `video`.

12 of them got an `a11y.*` key; the rest **reuse a key the same feature already
renders for the same control** (`phone.clear`, `phone.call`, `nc.clear`,
`clock.lap`, `message.send`, `player.prev`/`next`, `shell.search`, `shell.recents`) —
reuse was decided by looking up the *value* in the whole `en` dictionary, so no
duplicate copy was introduced.

### The assertion that was green and proved nothing

While updating the tests, `home-dock.svelte.test.ts` refused to pass:

```js
expect(container.querySelector('button[aria-label="search"]')).toBeNull();
```

…under a comment saying the P2 change **removed** the dock-parallel Spotlight pill.
`HomeDock.svelte` still renders a spotlight pill (`data-testid="home-search-entry"`,
wired to `home.emit("search")`) — so the assertion was wrong on **two** counts: it
selected English while `shell.search` renders 搜索 (it could never match), and if it
had matched it would have contradicted the shipped design. CHANGELOG already records
this exact trap being fixed once, in `scripts/smoke-ui.mjs`, by switching to the
language-independent `data-testid`. The test is now rewritten to assert the shipped
behaviour (exactly one entry, and clicking it emits `search`) through that hook.

## Honest boundary

The scan is **static**: it proves a key is referenced, not that a screen renders
it, and it treats any literal occurrence (including one in a comment) as a
reference — conservative in the direction that avoids deleting live copy. Keys
built from a **contract string the daemon only constructs at runtime** (rather
than a literal) cannot be seen and would need an allow-list entry; no such key is
known today.

Check 7's own boundaries (REQ-A183): a **dynamic** reference (`` t(`message.folder.${f}`) ``,
6 namespaces today) stays out of reach — it is checked only for the prefix; params passed
in a shape static analysis cannot read are counted, not judged (0 today); and `t()` being
typed `key: string` is left as-is (narrowing it to `MessageKey` would be a *stronger* fix
for literal keys, and is the natural follow-up for whoever takes that refactor).

Check 8's own boundaries (REQ-A183): a control named **only** by `placeholder` passes
(the HTML accname fallback makes it a real, if fragile, name — the whole
`settings`-search/`mail.body` family is in this shape); a name supplied by a runtime
`aria-label={…}` expression is trusted without evaluating it; and markup inside `<script>`
(a template literal building a DOM fragment) is out of scope, as in checks 4–5.

