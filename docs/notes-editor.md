# Full-page note editor — design (Notes)

Status: **implemented** (2026-09-09). `lib/autoSave.ts` + `NoteEditor.svelte`
exist and are wired into `NotesApp` as a view-swap; audit-fixes are in. Design
record below kept as the reference for behaviour/semantics. Visual/desktop
feel still needs an on-app run to confirm.

## Goal
Give Notes a *dedicated, distraction-free, auto-saving* editing surface for an
opened note — the "整页编辑器" feel — while keeping the current list + inline
edit intact. Auto-save belongs to this editor only; the lightweight inline path
keeps its manual Save / Cancel (discard) semantics.

## Editor form
- Renders the **whole body of one note** as its source (Markdown-ish text, the
  same as `NotesApp`'s `editVal`). One textarea, auto-growing, near-full-height.
- A minimal top bar: **‹ back** (returns to the list) · **title** = first line
  (`noteTitle`) · a **saved-at HH:MM:SS** readout.
- A compact toolbar reusing the tested helpers: **＋ 任务 / ☑ 勾选 / Tab·Enter
  indent-continuation** (`lib/noteEditing.ts`) and a **live rich-text preview**
  toggle (`fmtInline`). All already unit-tested.
- First line is the display title; it is **not a separate field** (matches iOS
  Notes and current `noteTitle`), avoiding a split-data model.

## Enter / return (navigation)
- **Enter**: from `NotesApp`, a per-note "编辑" affordance opens this editor as a
  **local full-app overlay inside `NotesApp`** (a full-bleed view), **not** a new
  Shell surface. Rationale: Notes already owns the list + note identity, so we
  avoid touching `Shell.svelte` / `shellState` surfaces (edit/return plumbing,
  back-stack, app switch) and keep the change contained. The overlay is
  full-height and covers the list; content scrolls independently.
- **Return**: ‹ back **flushes any pending autosave** then closes to the list;
  the row re-reads the store (so the edited title/preview/`ts` reflect the save).

## Auto-save & "cancel" semantics (the important decision)
- **Autosave**: edits buffer in local draft state; a **debounced** persist
  (e.g. 800 ms idle) writes the whole note back to the shared `amos.notes` store
  as an **upsert-by-id that preserves `created` and bumps `ts`** (reuse
  `notes.ts::editNote` / a store upsert). `ts` → "edited" (`editedOf`) shows the
  existing `· 已编辑` marker in the list.
- **There is intentionally NO destructive "cancel/discard" in the full-page
  editor** — it auto-saves, so leaving never loses work. If an accidental edit
  must be undone, that is **undo of the last edit**, not a "discard"; we do not
  fake a separate discardable buffer on top of a shared store (that would let
  list and editor disagree).
- The **existing inline Save / Cancel (discard)** stays exactly as-is for the
  lightweight list-path. The two surfaces have different, clearly-documented
  semantics; both write the same store shape so they never drift.
- **Save status**: indicator shows `保存于 HH:MM:SS` when idle-saved, and
  "正在保存…" while the debounce hasn't fired; failures surface honestly (store
  write is best-effort in the KV layer, reused for all notes).

## Relationship to the existing list (`NotesApp.svelte`)
- The list / inline / batch / tags / tasks / created-edited UI is **unchanged**.
- The editor is an **opt-in, contained addition**: a new `NoteEditor.svelte`
  (own file, no edits to the existing inline branch) plus pure `lib/autoSave.ts`
  (debounce/save-state, injectable clock) so it is headless-testable without a
  running app. `NotesApp` mounts it only while the editor is open; all existing
  `notes.svelte.test.ts` cases must stay green.
- Row data flows: list holds `notes` from the store; when a save lands, Notes
  re-sorts/keeps the note in place and updates its `ts`/preview (no new
  timestamp churn on identical text — reuse `editNote`'s no-op rule).

## Mobile vs desktop
- **Mobile**: full-height editor, bottom auto-grow area clears the on-screen
  keyboard, auto-focus on open, `done`-key / ‹ back to leave; toolbar buttons
  are thumb-reachable.
- **Desktop**: taller fixed editor, keyboard-first (Enter/Tab handled in
  `noteEditing.ts`), same top bar; the ‹ back is also reachable via a button.
- Shared: identical data/store path, identical autosave semantics — only layout /
  input ergonomics differ. No split behavior.

## Pure-logic to build first (headless-testable, no UI risk)
`lib/autoSave.ts`:
- `debounce(fn, ms, clock?)` returning `{ schedule, cancel, flush }` with an
  injectable `now`/timer (mock-clock tests: coalescing, trailing fire, cancel,
  flush-before-leave).
- A `saveState` reducer `{ dirty, status: 'saved'|'saving'|'error' }` driven by
  `edit` / `saved` / `save_failed` events.
`lib/noteEditor.ts` (optional, pure): `initialTitle(text)`, `savedStamp(now)`,
and any transform glue — reused only by `NoteEditor.svelte`.

## Acceptance (when built)
- Pure: `autoSave` + `noteEditor` suites (mock clock) green.
- DOM: a new `svelte-tests/note-editor.svelte.test.ts` (open editor → type →
  flush via fake-clock/tick → list shows updated title & `ts`; ‹ back returns;
  existing list row marker `· 已编辑` appears after a save). All existing
  `notes.svelte.test.ts` stay green; `tsc` + `svelte-check` 0/0.

### Audit outcomes folded in (2026-09-09)
- **Leave never loses work**: `onDestroy` flushes (not cancels) the debouncer, so
  any close path — not only ‹ back — persists pending keystrokes.
- **No silent save of a removed note**: `commit` first checks the note still
  exists in the store; if not it surfaces an honest error and writes nothing
  (never claims a save it didn't make).
- Verified: `note-editor.svelte.test.ts` 3, `notes.svelte.test.ts` 12 (15 DOM),
  `tsc` + `svelte-check` 0/0.

