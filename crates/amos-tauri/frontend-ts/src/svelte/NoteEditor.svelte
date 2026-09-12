<script lang="ts">
  // NoteEditor.svelte — a full-bleed, auto-saving editor for ONE note.
  // Design: docs/notes-editor.md. Mounted by `NotesApp.svelte` (the "整页 / full
  // page" button swaps the list for this editor — see `openEditor`): it receives an
  // existing `note`, edits its whole body, and auto-saves back to the shared
  // `amos.notes` store (preserving `created`, bumping `ts`). No destructive
  // "discard": ‹ back flushes any pending save, so leaving loses no work **that the
  // store accepted** — a rejected write (full/unavailable storage) is reported as a
  // failed save rather than silently claimed as "saved".
  import { onDestroy } from "svelte";
  import type { Note } from "../lib/notes";
  import { NOTES_KEY, editNote, fmtInline } from "../lib/notes";
  import { readStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import {
    clockLabel,
    createDebouncer,
    initialSaveState,
    saveStateReducer,
    type SaveState,
  } from "../lib/autoSave";
  import {
    enterContinuesTask,
    prefixTaskAtLine,
    shiftLineIndent,
    toggleTaskLineAt,
  } from "../lib/noteEditing";
  import { t } from "./locale.svelte";

  let { note, onClose }: { note: Note; onClose: () => void } = $props();
  // Read the (immutable-for-this-editor) identity once through a closure so svelte
  // treats it as an intentional initial capture, not a stray local reference.
  const capture = () => ({ id: note.id, text: note.text, ts: note.ts });
  const initial = capture();

  let editVal = $state(initial.text);
  let previewOn = $state(false);
  let lastSaved = $state(initial.ts);
  let saveErr = $state("");
  // The dirty/saving/saved/error machine lives in the tested `lib/autoSave`
  // reducer — the editor must not re-implement it with ad-hoc booleans (see
  // docs/unwired-exports-audit.md Round 15). `{ ...initialSaveState }` keeps the
  // shared module constant out of Svelte's deep `$state` proxy.
  let save = $state<SaveState>({ ...initialSaveState });
  let el = $state<HTMLTextAreaElement | null>(null);

  const commit = () => {
    const cur = readStoreValue<Note[]>(NOTES_KEY, []);
    // The note may have been archived/removed (e.g. in another window). Never
    // silently claim a save we didn't make — surface it honestly.
    if (!cur.some((n) => n.id === initial.id)) {
      saveErr = t("note.editorDeleted");
      save = saveStateReducer(save, { type: "save_failed" });
      return;
    }
    const now = Date.now();
    const next = editNote(cur, initial.id, editVal, now);
    // The write is **verified**: reporting "保存于 HH:MM:SS" for a draft the store
    // rejected would claim a save that did not happen (the edits would be gone on
    // leaving). A rejected write is surfaced as a failed save instead.
    if (!writeStoreValueChecked(NOTES_KEY, next)) {
      saveErr = t("note.saveFailed");
      save = saveStateReducer(save, { type: "save_failed" });
      return;
    }
    lastSaved = now;
    saveErr = "";
    save = saveStateReducer(save, { type: "saved" });
  };
  const deb = createDebouncer(() => commit(), 600);
  // Flush (not cancel) on unmount: however the editor is closed — not just via
  // ‹ back — pending keystrokes are saved, never lost.
  onDestroy(() => deb.flush());

  /** One "the draft changed" event → `edit` (dirty + saving) + (re)arm the debounce. */
  const markEdit = () => {
    save = saveStateReducer(save, { type: "edit" });
    deb.schedule();
  };
  const onInput = () => {
    markEdit();
  };
  const back = () => {
    save = saveStateReducer(save, { type: "flush_started" });
    deb.flush(); // never lose the last keystrokes
    onClose();
  };

  const queueCaret = (ta: HTMLTextAreaElement, pos: number) => {
    queueMicrotask(() => {
      try {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      } catch {
        /* best-effort */
      }
    });
  };
  const onKey = (e: KeyboardEvent) => {
    const ta = e.currentTarget as HTMLTextAreaElement;
    const val = ta.value;
    const off = ta.selectionStart ?? 0;
    if (e.key === "Enter") {
      const r = enterContinuesTask(val, off);
      if (r && r.changed) {
        e.preventDefault();
        editVal = r.text;
        queueCaret(ta, r.cursor);
        markEdit();
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      const r = shiftLineIndent(val, off, 2, e.shiftKey);
      if (r.changed) {
        editVal = r.text;
        queueCaret(ta, r.cursor);
        markEdit();
      }
    }
  };
  const caret = () => el?.selectionStart ?? editVal.length;
  const toggleAtCaret = () => {
    const r = toggleTaskLineAt(editVal, caret());
    if (r && r.changed) {
      editVal = r.text;
      markEdit();
    }
  };
  const prefixAtCaret = () => {
    const r = prefixTaskAtLine(editVal, caret());
    if (r && r.changed) {
      editVal = r.text;
      markEdit();
    }
  };
</script>

<div class="flex h-full flex-col bg-white dark:bg-neutral-900">
  <div class="flex items-center gap-2 border-b border-black/5 px-3 py-2 dark:border-white/10">
    <button
      aria-label="note-editor-back"
      onclick={back}
      class="shrink-0 rounded-full px-2 py-0.5 text-sm opacity-70 hover:opacity-100"
    >‹</button>
    <span class="truncate text-[15px] font-semibold">{editVal.split("\n")[0]?.trim() || "…"}</span>
    <span data-testid="note-editor-status" class="ml-auto shrink-0 text-xs opacity-60">
      {#if save.status === "error"}<span class="text-danger">{saveErr || t("note.saveFailed")}</span>
      {:else if save.status === "saving"}{t("note.saving")}
      {:else}{t("note.savedAt", { time: clockLabel(new Date(lastSaved)) })}{/if}
    </span>
  </div>

  <textarea
    bind:this={el}
    bind:value={editVal}
    oninput={onInput}
    onkeydown={onKey}
    aria-label="note-editor-textarea"
    placeholder={t("note.editorPlaceholder")}
    class="w-full flex-1 resize-none bg-transparent p-3 text-sm leading-relaxed outline-none"
  ></textarea>

  <div class="flex items-center gap-1.5 border-t border-black/5 px-3 py-2 text-xs dark:border-white/10">
    <button
      onclick={toggleAtCaret}
      aria-label="note-editor-toggle-task"
      title={t("note.editorToggleTaskHint")}
      class="rounded-full bg-black/5 px-2.5 py-1 dark:bg-white/10"
    >☑ {t("note.editorToggleTask")}</button>
    <button
      onclick={prefixAtCaret}
      aria-label="note-editor-prefix-task"
      title={t("note.editorPrefixTaskHint")}
      class="rounded-full bg-black/5 px-2.5 py-1 dark:bg-white/10"
    >＋ {t("note.editorPrefixTask")}</button>
    <button
      onclick={() => (previewOn = !previewOn)}
      aria-pressed={previewOn}
      aria-label="note-editor-preview"
      title={t("note.editorPreviewHint")}
      class={"rounded-full px-2.5 py-1 " + (previewOn ? "bg-accent text-white" : "bg-black/5 dark:bg-white/10")}
    >{t("note.editorPreview")}</button>
  </div>

  {#if previewOn && editVal.trim()}
    <div
      aria-label="note-editor-preview-body"
      class="max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-black/5 px-3 py-2 text-sm leading-relaxed dark:border-white/10"
    >
      {#each fmtInline(editVal) as seg, i (i)}
        {#if seg.tag}<span class="font-medium text-accent underline decoration-accent/40 underline-offset-2">{seg.text}</span>
        {:else if seg.bold}<strong class="font-semibold">{seg.text}</strong>
        {:else if seg.hl}<mark class="rounded bg-amber-200 px-0.5 dark:bg-amber-500/40">{seg.text}</mark>
        {:else if seg.link && seg.url}<a href={seg.url} target="_blank" rel="noreferrer" class="break-all text-accent underline">{seg.text}</a>
        {:else if seg.strike}<s class="opacity-60">{seg.text}</s>
        {:else}{seg.text}{/if}
      {/each}
    </div>
  {/if}
</div>
