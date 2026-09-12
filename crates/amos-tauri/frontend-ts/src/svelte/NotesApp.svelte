<script lang="ts">
  // NotesApp.svelte — Svelte 5 (runes) implementation of the notes app.
  // All note logic reuses pure lib/notes.ts; rich-text segments (fmtInline) are
  // rendered reactively; copy/paste go through lib/clipboard (offline no-op), and
  // the ClipboardTray history is rendered inline from clipboardHistory(). Store
  // key: amos.notes.
  import {
    NOTES_KEY,
    completeAllTasks,
    editNote,
    duplicateNote,
    fmtInline,
    fmtTime,
    normalizeNotes,
    noteDayOf,
    noteListProgress,
    notePreview,
    noteStats,
    noteTitle,
    notesOf,
    createdOf,
    editedOf,
    orderByModified,
    orderPinned,
    prependNote,
    removeNote,
    searchHighlight,
    searchNotes,
    setNoteState,
    setManyState,
    setPinned,
    removeMany,
    exportBaseName,
    noteExportText,
    tasksOf,
    taskSummary,
    togglePin,
    toggleTaskInNote,
    toggleTaskInText,
    stripInlineMarkers,
    tagsOf,
    filterByTag,
  } from "../lib/notes";
  import type { Note } from "../lib/notes";
  import {
    hitSourceLabel,
    initialRagUi,
    NOTES_RAG_INDEXED_KEY,
    ragUiReducer,
    type RagUiState,
  } from "../lib/notesRag";
  import { askNotes, liveRagClient, syncNotesIndex } from "../lib/notesRagRun";
  import { ragStatus, type RagHit, type RagStatus } from "../lib/rag";
  import {
    enterContinuesTask,
    prefixTaskAtLine,
    shiftLineIndent,
    toggleTaskLineAt,
  } from "../lib/noteEditing";
  import { clipboardHistory, clipboardRead, clipboardClear, copySelection, entryText, previewClipboard } from "../lib/clipboard";
  import { notesChannel, sendToAi } from "./appLinks";
  import type { ClipboardEntry } from "../lib/clipboard";
  import { iconSvg } from "../lib/sysIcons";
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import { bridged, exportTxtFile, getAiStatus } from "../lib/backend";
  import {
    aiIsUnavailable,
    classifyAiAvailability,
    type AiAvailability,
  } from "../lib/aiAvailability";
  import { t } from "./locale.svelte";
  import NoteEditor from "./NoteEditor.svelte";
  import { markdownTitleOf, parseMarkdownImport, toMarkdownFile } from "../lib/markdown";
  import { loadNotesPrefs, saveNotesPrefs, type NotesPrefs } from "../lib/notePrefs";
  // Display title: prefer a `# heading`, else the first line, else the untitled label.
  const titleOf = (text: string) =>
    stripInlineMarkers(markdownTitleOf(text) || noteTitle(text)) || t("note.untitled");

  const seeded = normalizeNotes(readStoreValue<unknown>(NOTES_KEY, []));
  let notes = $state<Note[]>(seeded);
  let text = $state("");
  // A rejected store write (full/unavailable storage) must be visible: the list is
  // rendered from this in-memory copy, so applying a change the store never accepted
  // would show data that silently vanishes on reload.
  let notesErr = $state("");
  let editingId = $state<string | null>(null);
  // Editor affordances: caret-based task ops + a live rich-text preview toggle.
  let editEl = $state<HTMLTextAreaElement | null>(null);
  let previewOn = $state(false);
  let editVal = $state("");
  let trayOpen = $state(false);
  let trayItems = $state<ClipboardEntry[]>([]);
  let mode = $state<"all" | "archived" | "trash">("all");
  let searchQ = $state("");
  let openId = $state<string | null>(null);
  let armedEmpty = $state(false);
  let selecting = $state(false); // multi-select batch mode
  let selected = $state<string[]>([]);
  // Full-page editor (NoteEditor, docs/notes-editor.md): set to a note to swap the
  // list view for that note's auto-saving editor; null shows the normal list.
  let editor = $state<Note | null>(null);
  // Notes preference: tap a collapsed row to open the full-page editor directly.
  let prefs = $state<NotesPrefs>(loadNotesPrefs());

  // ---- "Ask my notes": local RAG retrieval (docs/offline-rag-pdf.md) ----
  // The daemon holds the vector index; this panel indexes the active notes
  // (idempotent upsert) then retrieves the passages nearest to a question.
  let askOpen = $state(false);
  let askQ = $state("");
  let askHits = $state<RagHit[] | null>(null);
  let askOffline = $state(false);
  let ragUi = $state<RagUiState>(initialRagUi);
  const ragBusy = $derived(ragUi.phase !== "idle");

  // Daemon-confirmed index state (indexed chunks / dimension / embedder label),
  // read once when the panel opens. `null` (no daemon) renders NOTHING — the panel
  // already shows an honest offline notice, and we never invent an index size.
  let ragState = $state<RagStatus | null>(null);
  let ragProbed = false;
  $effect(() => {
    if (!askOpen || ragProbed || !bridged()) return;
    ragProbed = true;
    void ragStatus().then((s) => {
      ragState = s;
    });
  });

  // AI is NOT required for Notes to work — this is only an honest, non-blocking
  // indicator. Probe once in the background; never gate note CRUD/search on it.
  let aiAvail = $state<AiAvailability>(
    classifyAiAvailability({ bridged: bridged(), status: null }),
  );
  let aiProbed = false;
  $effect(() => {
    if (aiProbed) return;
    if (!bridged()) {
      aiAvail = "offline"; // no Tauri shell -> no daemon/AI path
      aiProbed = true;
      return;
    }
    aiProbed = true;
    getAiStatus().then((s) => {
      // Daemon unreachable / no reply => treat as offline (never fake real).
      aiAvail = s ? classifyAiAvailability({ bridged: true, status: s }) : "offline";
    });
  });
  // Show the hint only when AI can't really serve (offline or mock); notes still work.
  const aiOffline = $derived(aiIsUnavailable(aiAvail));
  // Distinguish "no AI at all (offline)" from "daemon is only a mock (no real model)".
  const aiHintKey = $derived(aiAvail === "mock" ? "note.aiMock" : "note.aiOffline");


  /**
   * Persist the note list and report whether the store accepted it. `false` means
   * nothing was written (full/unavailable storage): the caller must **not** apply the
   * change to the in-memory list or discard a draft, or the UI would show/shed data
   * that will not survive a reload.
   */
  const persist = (list: Note[]): boolean => {
    if (!writeStoreValueChecked(NOTES_KEY, list)) {
      notesErr = t("note.saveFailed");
      return false;
    }
    notesErr = "";
    notes = list;
    return true;
  };

  const openEditor = (n: Note) => {
    if (n.state) return; // only active notes open in the editor
    editor = n;
  };
  const closeEditor = () => {
    editor = null;
    // Re-read the store so auto-saves from the editor show up in the list rows.
    notes = normalizeNotes(readStoreValue<unknown>(NOTES_KEY, []));
  };
  // Tapping a collapsed row: expand inline by default, or (pref on) open the
  // full-page editor. Archived/trash rows always expand inline.
  const rowTap = (n: Note) => {
    if (prefs.openInEditor && mode === "all" && !n.state) {
      openEditor(n);
      return;
    }
    openId = n.id;
  };

  // ---- Deep link: Spotlight → one note ------------------------------------------
  // The Spotlight chooser sets the `notes` channel and opens this app; we then reveal
  // that note (full-page editor for an active note, else its own tab expanded inline).
  // The link is *consumed* (channel cleared) so re-opening Notes never re-fires it,
  // and an id that no longer exists is honestly ignored (the list is what's shown).
  let linkNonce = 0;
  $effect(() => {
    return notesChannel().subscribe((v) => {
      if (!v || v.noteId.trim() === "" || v.nonce === linkNonce) return;
      linkNonce = v.nonce;
      const target = notes.find((n) => n.id === v.noteId);
      if (target) {
        if (target.state === "archived") {
          mode = "archived";
          openId = target.id;
        } else if (target.state === "trash") {
          mode = "trash";
          openId = target.id;
        } else {
          mode = "all";
          openEditor(target);
        }
      }
      notesChannel().set({ noteId: "", nonce: linkNonce });
    });
  });

  const add = () => {
    const v = text.trim();
    if (!v) return;
    const now = Date.now();
    const next = prependNote(notes, v, now);
    // The draft stays in the box (and unexpanded) when the store rejected it — the
    // user's typed text must never be cleared into a write that did not happen.
    if (!persist(next)) return;
    openId = next[0]?.id ?? null;
    text = "";
  };
  const beginEdit = (n: Note) => {
    editingId = n.id;
    editVal = n.text;
  };
  const cancelEdit = () => {
    editingId = null;
    editVal = "";
    editEl = null;
    previewOn = false;
  };
  const saveEdit = () => {
    if (!editingId) return;
    // Keep the inline editor open with the draft when the write was rejected, instead
    // of closing over edits that were never stored.
    if (!persist(editNote(notes, editingId, editVal, Date.now()))) return;
    cancelEdit();
  };
  const copyEditing = async () => {
    if (!editingId) return;
    await copySelection(editVal);
  };
  const pasteEditing = async () => {
    const e = await clipboardRead();
    const p = e ? entryText(e) : "";
    if (!p) return;
    editVal = editVal && editVal.trim() ? `${editVal}\n${p}` : p;
  };
  const pickFromTray = (e: ClipboardEntry) => {
    const pasted = entryText(e);
    if (!pasted) return;
    editVal = editVal && editVal.trim() ? `${editVal}\n${pasted}` : pasted;
    trayOpen = false;
  };

  const editingThis = (id: string) => editingId === id;
  const editTasks = $derived(tasksOf(editVal));

  // ---- Editor keybindings / caret-based task affordances (pure transforms) ----
  const queueCaret = (ta: HTMLTextAreaElement, pos: number) => {
    queueMicrotask(() => {
      try {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      } catch {
        /* caret restore is best-effort */
      }
    });
  };
  const onEditKey = (e: KeyboardEvent) => {
    const ta = e.currentTarget as HTMLTextAreaElement;
    const val = ta.value;
    const off = ta.selectionStart ?? 0;
    if (e.key === "Enter") {
      const r = enterContinuesTask(val, off);
      if (r && r.changed) {
        e.preventDefault();
        editVal = r.text;
        queueCaret(ta, r.cursor);
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      const r = shiftLineIndent(val, off, 2, e.shiftKey);
      if (r.changed) {
        editVal = r.text;
        queueCaret(ta, r.cursor);
      }
    }
  };
  const editCaret = () => editEl?.selectionStart ?? editVal.length;
  const toggleAtCaret = () => {
    const r = toggleTaskLineAt(editVal, editCaret());
    if (r && r.changed) editVal = r.text;
  };
  const prefixAtCaret = () => {
    const r = prefixTaskAtLine(editVal, editCaret());
    if (r && r.changed) editVal = r.text;
  };

  let selTag = $state<string | null>(null); // active #tag filter (lowercased)
  const activeAll = $derived.by(() => {
    const base = searchNotes(notesOf(notes, undefined), mode === "all" ? searchQ : "");
    return prefs.sortByModified ? orderByModified(base) : orderPinned(base);
  });
  const tagRow = $derived.by(() => {
    const map = new Map<string, { name: string; count: number }>();
    for (const n of activeAll)
      for (const tg of tagsOf(n.text)) {
        const k = tg.toLowerCase();
        const e = map.get(k);
        if (e) e.count += 1;
        else map.set(k, { name: tg, count: 1 });
      }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  });
  const active = $derived.by(() => {
    const tag = selTag;
    // The domain owns the tag rule (`lib/notes.filterByTag`); never re-filter at
    // the call site (a tested rule copied inline is how a future tag syntax change
    // silently diverges — see docs/unwired-exports-audit.md Round 15).
    return tag ? filterByTag(activeAll, tag) : activeAll;
  });
  const archived = $derived(notesOf(notes, "archived"));
  const trashed = $derived(notesOf(notes, "trash"));
  const agg = $derived(noteListProgress(notesOf(notes, undefined)));
  const view = $derived(mode === "all" ? active : mode === "archived" ? archived : trashed);
  const selInView = $derived(view.filter((n) => selected.includes(n.id)).map((n) => n.id));
  const toggleSel = (id: string) => {
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
  };
  const exitSel = () => {
    selecting = false;
    selected = [];
  };
  const runBatch = (fn: (sel: string[]) => Note[]) => {
    persist(fn(selInView));
    exitSel();
  };
  const bPin = () => runBatch((s) => setPinned(notes, s, true));
  const bArch = () => runBatch((s) => setManyState(notes, s, "archived"));
  const bTrash = () => runBatch((s) => setManyState(notes, s, "trash"));
  const bRestore = () => runBatch((s) => setManyState(notes, s, undefined));
  const bDelete = () => runBatch((s) => removeMany(notes, s));
  let exportMsg = $state("");
  const doExportOne = async (n: Note) => {
    const name = exportBaseName(new Date());
    const text = noteExportText([n]);
    const res = await exportTxtFile(name, text);
    if (res?.path) exportMsg = `${t("note.exportedTo")} ${res.name}`;
    else {
      try {
        await copySelection(text);
      } catch {
        /* clipboard unavailable — message still informs */
      }
      exportMsg = t("note.exportCopied");
    }
  };
  const composeStats = $derived(noteStats(text));
  const statsOf = (n: Note) => noteStats(n.text);

  // "Import Markdown": treat the compose box as a pasted Markdown doc → add a note
  // with the front-matter-stripped, normalized body.
  const importMd = () => {
    const parsed = parseMarkdownImport(text);
    if (!parsed) return;
    const now = Date.now();
    persist(prependNote(notes, parsed.body, now));
    text = "";
    exportMsg = `已导入「${parsed.title || "未命名"}」`;
  };

  // "Export .md": serialise one note as a Markdown file and copy to the AmOS
  // clipboard (no on-device md writer yet — same honest fallback as the .txt path
  // without a backend).
  const doExportMd = async (n: Note) => {
    const fileText = toMarkdownFile({
      title: markdownTitleOf(n.text) || noteTitle(n.text) || "未命名",
      text: n.text,
      created: createdOf(n),
      modified: n.ts,
    });
    try {
      await copySelection(fileText);
    } catch {
      /* clipboard unavailable — message still informs */
    }
    exportMsg = "已复制 .md 到剪贴板（未连接后端）";
  };

  // "Ask my notes": index (upsert) the active notes, prune stale ids, then
  // query. Only daemon-confirmed outcomes are recorded; an offline (null) reply
  // is surfaced honestly instead of looking like an empty result.
  const runAsk = async () => {
    const q = askQ.trim();
    if (!q || ragBusy) return;
    askHits = null;
    askOffline = false;
    ragUi = ragUiReducer(ragUi, { type: "index_started" });
    try {
      const known = readStoreValue<string[]>(NOTES_RAG_INDEXED_KEY, []);
      const res = await syncNotesIndex(liveRagClient, notesOf(notes, undefined), known);
      writeStoreValue(NOTES_RAG_INDEXED_KEY, res.indexed);
      ragUi = ragUiReducer(ragUi, { type: "index_done" });
    } catch (e) {
      ragUi = ragUiReducer(ragUi, { type: "index_failed", error: String(e) });
      return;
    }
    ragUi = ragUiReducer(ragUi, { type: "ask_started" });
    try {
      const res = await askNotes(liveRagClient, q);
      askOffline = res === null;
      askHits = res ? res.hits : null;
      ragUi = ragUiReducer(ragUi, { type: "ask_done" });
    } catch (e) {
      ragUi = ragUiReducer(ragUi, { type: "ask_failed", error: String(e) });
    }
  };
  const toggleAsk = () => {
    askOpen = !askOpen;
    if (!askOpen) {
      askHits = null;
      askOffline = false;
      ragUi = ragUiReducer(ragUi, { type: "reset" });
    }
  };

  const collapsed = (n: Note) =>
    !editingThis(n.id) && openId !== n.id && tasksOf(n.text).length === 0;

  const setStateOf = (id: string, st: "archived" | "trash" | undefined) =>
    persist(setNoteState(notes, id, st));

  const dupeOf = (id: string) => persist(duplicateNote(notes, id, Date.now()));

  /**
   * Empty the system clipboard history (foreground-gated on the Rust side). Only
   * clears the on-screen list when the bridge confirms a count — an offline `null`
   * must not look like a successful wipe.
   */
  const clearTray = async () => {
    const removed = await clipboardClear();
    if (removed !== null) trayItems = [];
  };

  // Fetch the inline clipboard-history tray only while open.
  $effect(() => {
    if (!trayOpen) {
      trayItems = [];
      return;
    }
    let alive = true;
    void clipboardHistory(20).then((v) => {
      if (alive && v) trayItems = v;
    });
    return () => {
      alive = false;
    };
  });

  const stampOf = (n: Note): string => {
    const dd = noteDayOf(n.ts, Date.now());
    const dt = new Date(n.ts);
    if (dd === 0) return fmtTime(n.ts);
    if (dd === -1) return t("note.yesterday");
    return dt.getFullYear() === new Date().getFullYear()
      ? `${dt.getMonth() + 1}/${dt.getDate()}`
      : `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
  };
  const chipCls = (on: boolean) =>
    `rounded-full px-3 py-1 text-xs ${on ? "bg-accent text-white" : "bg-neutral-300 dark:bg-neutral-700"}`;
  const switchMode = (m: "all" | "archived" | "trash") => {
    mode = m;
    armedEmpty = false; // leaving the trash tab drops an armed "empty" state
    if (m !== "all") selTag = null;
    if (selecting) exitSel(); // select mode is scoped to the current tab
  };
  const selectAllInView = () => {
    const ids = view.map((n) => n.id);
    selected = ids.length > 0 && ids.every((id) => selected.includes(id)) ? [] : ids;
  };
  const pickTag = (name: string) => {
    const k = name.toLowerCase();
    selTag = selTag === k ? null : k;
  };
</script>

<div class="p-4">
  {#if aiOffline}
    <p role="status" data-testid="note-ai-offline" class="mb-2 rounded-lg bg-black/5 px-3 py-1.5 text-[11px] text-neutral-500 dark:bg-white/10 dark:text-neutral-400">
      {t(aiHintKey)}
    </p>
  {/if}
  {#if notesErr}
    <p
      role="status"
      data-testid="note-store-error"
      class="mb-2 rounded-lg bg-black/5 px-3 py-1.5 text-[11px] text-danger dark:bg-white/10"
    >
      {notesErr}
    </p>
  {/if}
  {#if editor}
    <NoteEditor note={editor} onClose={closeEditor} />
  {:else}
  {#if exportMsg}
    <p role="status" class="mb-2 rounded-lg bg-black/5 px-3 py-1.5 text-xs text-accent dark:bg-white/10">{exportMsg}</p>
  {/if}
  <textarea
    bind:value={text}
    rows={3}
    placeholder={t("note.placeholder")}
    aria-label="note-compose"
    class="mb-2 w-full resize-none rounded-2xl bg-black/5 p-3 text-sm text-neutral-900 outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:text-neutral-100 dark:ring-white/10 dark:placeholder:text-white/30"
  ></textarea>
  <div class="flex items-center justify-between">
    <span class="flex items-center gap-2">
      <button onclick={add} class="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95">{t("note.add")}</button>
      <button onclick={importMd} aria-label="note-import-md" title={t("note.importMdHint")} class="rounded-full bg-black/5 px-3 py-1.5 text-sm dark:bg-white/10">⇪ md</button>
      <button onclick={toggleAsk} aria-label="note-ask-toggle" aria-pressed={askOpen} class="rounded-full bg-black/5 px-3 py-1.5 text-sm dark:bg-white/10">🔍 {t("note.ask")}</button>
    </span>
    <span class="text-xs opacity-50">{t("note.stats", { chars: String(composeStats.chars), lines: String(composeStats.lines) })}</span>
  </div>

  {#if askOpen}
    <div class="mt-2 rounded-2xl bg-black/5 p-3 text-sm dark:bg-white/10" data-testid="note-ask">
      <div class="flex items-center gap-2">
        <input
          bind:value={askQ}
          onkeydown={(e) => e.key === "Enter" && runAsk()}
          placeholder={t("note.askPlaceholder")}
          aria-label="note-ask-q"
          class="min-w-0 flex-1 rounded-full bg-white/70 px-3.5 py-1.5 text-sm text-neutral-900 outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-black/20 dark:text-neutral-100 dark:ring-white/10 dark:placeholder:text-white/30"
        />
        <button onclick={runAsk} disabled={ragBusy || !bridged()} aria-label="note-ask-run" class="rounded-full bg-accent px-4 py-1.5 text-sm text-white disabled:opacity-50">{t("note.askRun")}</button>
      </div>
      {#if ragState}
        <p data-testid="note-rag-status" class="mt-1 text-[11px] opacity-60">
          {t("note.ragStatus", {
            n: String(ragState.indexed),
            dim: String(ragState.dimension),
            embedder: ragState.embedder,
          })}
        </p>
      {/if}
      {#if !bridged()}
        <p role="status" class="mt-2 text-[11px] opacity-70">{t("note.askOffline")}</p>
      {:else if ragUi.phase === "indexing"}
        <p role="status" class="mt-2 text-[11px] opacity-70">{t("note.askIndexing")}</p>
      {:else if ragUi.phase === "asking"}
        <p role="status" class="mt-2 text-[11px] opacity-70">{t("note.askAsking")}</p>
      {:else if ragUi.phase === "error"}
        <p role="status" class="mt-2 text-[11px] text-danger">{ragUi.error}</p>
      {:else if askOffline}
        <p role="status" class="mt-2 text-[11px] opacity-70">{t("note.askOffline")}</p>
      {:else if askHits && askHits.length === 0}
        <p role="status" class="mt-2 text-[11px] opacity-70">{t("note.askEmpty")}</p>
      {:else if askHits}
        <p class="mt-2 text-[11px] opacity-60">{t("note.askHits", { n: String(askHits.length) })}</p>
        <ul class="mt-1 flex flex-col gap-1">
          {#each askHits as h (h.id + "\u0000" + h.passage)}
            <li class="rounded-xl bg-white/60 p-2 text-xs dark:bg-black/20">
              <div class="text-[10px] opacity-60">{t("note.askFrom", { title: hitSourceLabel(h.id, notes) })}</div>
              <div class="whitespace-pre-wrap">{h.passage}</div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if mode === "all"}
    <div class="mt-2 flex flex-col gap-1 text-xs opacity-70">
      <label class="flex items-center gap-2">
        <input type="checkbox" bind:checked={prefs.openInEditor} onchange={() => saveNotesPrefs(prefs)} aria-label="note-pref-open-in-editor" />
        {t("note.tapToEditHint")}
      </label>
      <label class="flex items-center gap-2">
        <input type="checkbox" bind:checked={prefs.sortByModified} onchange={() => saveNotesPrefs(prefs)} aria-label="note-pref-sort-by-modified" />
        {t("note.sortHint")}
      </label>
    </div>
  {/if}

  {#if mode === "all"}
    <input
      bind:value={searchQ}
      placeholder={t("note.search")}
      aria-label="note-search"
      class="mt-2 w-full rounded-full bg-black/5 px-3.5 py-1.5 text-sm text-neutral-900 outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:text-neutral-100 dark:ring-white/10 dark:placeholder:text-white/30"
    />
  {/if}

  <div class="mt-3 flex flex-wrap gap-1.5">
    <button onclick={() => switchMode("all")} aria-pressed={mode === "all"} class={chipCls(mode === "all")}>{t("note.tabNotes")} ({notesOf(notes, undefined).length})</button>
    <button onclick={() => switchMode("archived")} aria-pressed={mode === "archived"} class={chipCls(mode === "archived")}>{t("note.tabArchived")} ({archived.length})</button>
    <button onclick={() => switchMode("trash")} aria-pressed={mode === "trash"} class={chipCls(mode === "trash")}>{t("note.tabTrash")} ({trashed.length})</button>
  </div>

  {#if mode === "trash" && trashed.length > 0}
    <div class="mt-2 flex items-center justify-end gap-2 text-xs">
      {#if armedEmpty}
        <span class="text-danger">{t("note.emptyTrashConfirm")}</span>
        <button onclick={() => { armedEmpty = false; persist(removeMany(notes, trashed.map((n) => n.id))); }} aria-label="note-empty-trash-confirm" class="text-danger hover:underline">{t("note.deleteForever")}</button>
        <button onclick={() => (armedEmpty = false)} class="opacity-60 hover:underline">{t("note.cancel")}</button>
      {:else}
        <button onclick={() => (armedEmpty = true)} aria-label="note-empty-trash" class="text-danger hover:underline">{t("note.emptyTrash")}</button>
      {/if}
    </div>
  {/if}

  {#if mode === "all" && (tagRow.length > 0 || selTag)}
    <div class="mt-2 flex flex-wrap items-center gap-1.5">
      {#if selTag}
        <button onclick={() => (selTag = null)} aria-pressed="true" title={t("note.clearTag")} class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] text-accent ring-1 ring-accent/50">#{selTag}<span data-icon="x" class="grid h-3 w-3 place-items-center">{@html iconSvg("x", "h-3 w-3")}</span></button>
      {/if}
      {#each tagRow as tg (tg.name.toLowerCase())}
        {@const k = tg.name.toLowerCase()}
        <button onclick={() => pickTag(tg.name)} aria-pressed={selTag === k} class={"rounded-full px-2.5 py-0.5 text-[11px] " + (selTag === k ? "bg-accent text-white" : "bg-black/5 text-accent ring-1 ring-accent/40 dark:bg-white/10")}>#{tg.name} ({tg.count})</button>
      {/each}
    </div>
  {/if}

  {#if mode === "all" && agg.notes > 0}
    <p class="mt-2 text-xs text-accent">{t("note.progressAgg", { done: String(agg.done), total: String(agg.total), notes: String(agg.notes) })}</p>
  {/if}


  {#if selecting || view.length > 0}
    <div class="mt-2 flex flex-wrap items-center gap-1.5">
      {#if selecting}
        <span class="mr-1 text-xs opacity-70">已选 {selInView.length}</span>
        <button onclick={selectAllInView} class="rounded-full bg-black/5 px-3 py-1 text-xs dark:bg-white/10">{t("note.selectAll")}</button>
        {#if mode === "all"}
          <button onclick={bPin} disabled={selInView.length === 0} class="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10">★ {t("note.pin")}</button>
          <button onclick={bArch} disabled={selInView.length === 0} class="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10">{t("note.archive")}</button>
          <button onclick={bTrash} disabled={selInView.length === 0} class="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10">{t("note.delete")}</button>
        {/if}
        {#if mode === "archived"}
          <button onclick={bRestore} disabled={selInView.length === 0} class="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10">{t("note.restore")}</button>
          <button onclick={bTrash} disabled={selInView.length === 0} class="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10">{t("note.delete")}</button>
        {/if}
        {#if mode === "trash"}
          <button onclick={bRestore} disabled={selInView.length === 0} class="rounded-full bg-black/5 px-3 py-1 text-xs disabled:opacity-30 dark:bg-white/10">{t("note.restore")}</button>
          <button onclick={bDelete} disabled={selInView.length === 0} class="rounded-full bg-red-500/15 px-3 py-1 text-xs text-danger disabled:opacity-30">{t("note.deleteForever")}</button>
        {/if}
        <button onclick={exitSel} class="ml-auto text-xs text-accent">{t("note.done")}</button>
      {:else}
        <button onclick={() => (selecting = true)} class="ml-auto rounded-full bg-black/5 px-3 py-1 text-xs dark:bg-white/10">{t("note.select")}</button>
      {/if}
    </div>
  {/if}

  <div class="mt-3 space-y-2">
    {#if view.length === 0}
      <p class="py-6 text-center text-sm opacity-60">{t("note.empty")}</p>
    {:else}
      {#each view as n (n.id)}
        {#if selecting}
          <button onclick={() => toggleSel(n.id)} aria-pressed={selected.includes(n.id)} class={"block w-full rounded-2xl p-3 text-left shadow-sm ring-1 transition " + (selected.includes(n.id) ? "bg-accent/15 ring-accent dark:bg-accent/20" : "bg-white/60 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10")}>
            <div class="flex items-center gap-2">
              <span aria-hidden="true" class={"grid h-5 w-5 shrink-0 place-items-center rounded-full text-[12px] " + (selected.includes(n.id) ? "bg-accent text-white" : "border border-black/20 text-transparent dark:border-white/40")}>✓</span>
              <span class="truncate text-[15px] font-medium">{titleOf(n.text)}</span>
            </div>
          </button>
        {:else if collapsed(n)}
          <button onclick={() => rowTap(n)} class="block w-full rounded-2xl bg-white/60 p-3 text-left shadow-sm ring-1 ring-black/5 transition active:bg-white/80 dark:bg-white/[0.06] dark:ring-white/10">
            <div class="flex items-start justify-between gap-2">
              <span class="truncate text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
                {#if mode === "all" && searchQ.trim() && searchHighlight(titleOf(n.text), searchQ)}
                  {searchHighlight(titleOf(n.text), searchQ)?.before}<mark class="rounded-sm bg-amber-300/70 px-0.5 text-inherit dark:bg-amber-400/40">{searchHighlight(titleOf(n.text), searchQ)?.match}</mark>{searchHighlight(titleOf(n.text), searchQ)?.after}
                {:else}{titleOf(n.text)}{/if}
              </span>
              <span class="shrink-0 pt-0.5 text-xs text-neutral-500">{stampOf(n)}</span>
            </div>
            {#if notePreview(n.text)}
              <p class="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                {#if mode === "all" && searchQ.trim() && searchHighlight(notePreview(n.text), searchQ)}
                  {searchHighlight(notePreview(n.text), searchQ)?.before}<mark class="rounded-sm bg-amber-300/70 px-0.5 text-inherit dark:bg-amber-400/40">{searchHighlight(notePreview(n.text), searchQ)?.match}</mark>{searchHighlight(notePreview(n.text), searchQ)?.after}
                {:else}{notePreview(n.text)}{/if}
              </p>
            {/if}
            <div class="mt-1 flex items-center gap-2 text-xs text-neutral-500">
              {#if mode === "all" && n.pinned}
                <span class="text-amber-500">📌</span>
              {/if}
              {#if taskSummary(n.text).total > 0}
                <span class="text-accent">☑ {taskSummary(n.text).done}/{taskSummary(n.text).total}</span>
              {/if}
              {#if editedOf(n)}
                <span class="text-accent">· {t("note.edited")}</span>
              {/if}
              <span class="ml-auto text-accent">{t("note.open")}</span>
            </div>
          </button>
        {:else}
          <div class="rounded-2xl bg-white/60 p-3 shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
            {#if !editingThis(n.id) && tasksOf(n.text).length === 0}
              <div class="mb-1 flex justify-end">
                <button onclick={() => (openId = null)} aria-label={t("note.collapse")} class="text-xs text-accent">⌃ {t("note.collapse")}</button>
              </div>
            {/if}

            {#if editingThis(n.id)}
              <div>
                <textarea
                  bind:this={editEl}
                  bind:value={editVal}
                  onkeydown={onEditKey}
                  rows={6}
                  aria-label="note-edit"
                  class="w-full resize-y rounded-xl bg-white/70 p-2 text-sm leading-relaxed outline-none dark:bg-neutral-900/70"
                ></textarea>
                {#if editTasks.length > 0}
                  <div class="mt-2 rounded-xl bg-white/50 p-2 dark:bg-neutral-900/50">
                    <div class="text-xs opacity-50">{t("note.tasks")} · {editTasks.filter((tk) => tk.done).length}/{editTasks.length}</div>
                    {#each editTasks as tk, i (i + "-" + tk.label)}
                      <button onclick={() => (editVal = toggleTaskInText(editVal, i))} class="flex w-full items-start gap-2 py-0.5 text-left text-sm">
                        <span class="mt-0.5">{tk.done ? "☑" : "☐"}</span>
                        <span class={tk.done ? "opacity-50 line-through" : ""}>{tk.label}</span>
                      </button>
                    {/each}
                  </div>
                {/if}
                <div class="mt-2 flex items-center gap-1.5 text-xs">
                  <button
                    onclick={toggleAtCaret}
                    title={t("note.editorToggleTaskHint")}
                    aria-label="note-edit-toggle-task"
                    class="rounded-full bg-black/5 px-2.5 py-1 dark:bg-white/10"
                  >☑ {t("note.editorToggleTask")}</button>
                  <button
                    onclick={prefixAtCaret}
                    title={t("note.editorPrefixTaskHint")}
                    aria-label="note-edit-prefix-task"
                    class="rounded-full bg-black/5 px-2.5 py-1 dark:bg-white/10"
                  >＋ {t("note.editorPrefixTask")}</button>
                  <button
                    onclick={() => (previewOn = !previewOn)}
                    aria-pressed={previewOn}
                    aria-label="note-edit-preview"
                    title={t("note.editorPreviewHint")}
                    class={"rounded-full px-2.5 py-1 " + (previewOn ? "bg-accent text-white" : "bg-black/5 dark:bg-white/10")}
                  >{t("note.editorPreview")}</button>
                </div>

                {#if previewOn && editVal.trim()}
                  <div aria-label="note-preview" class="mt-2 whitespace-pre-wrap rounded-xl bg-white/40 p-2 text-sm leading-relaxed ring-1 ring-black/5 dark:bg-neutral-900/40 dark:ring-white/10">
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

                <div class="mt-2 flex items-center justify-between text-xs">
                  <span class="opacity-60">{fmtTime(n.ts)}</span>
                  <div class="flex gap-2">
                    <button onclick={() => void copyEditing()} aria-label="Copy to AmOS clipboard" title={t("note.copyHint")} class="opacity-70 hover:opacity-100">⧉</button>
                    <button onclick={() => void pasteEditing()} aria-label="Paste from AmOS clipboard" title={t("note.pasteHint")} class="opacity-70 hover:opacity-100">📋</button>
                    <button onclick={() => (trayOpen = !trayOpen)} aria-label="Clipboard history" aria-pressed={trayOpen} title={t("note.clipHistoryHint")} class="opacity-70 hover:opacity-100">🕘</button>
                    <button
                      onclick={() => sendToAi("notes", editVal)}
                      aria-label="note-send-ai"
                      title={t("note.sendToAi")}
                      class="opacity-70 hover:opacity-100"
                    >✦ {t("note.sendToAi")}</button>
                    <button onclick={cancelEdit} class="opacity-70 hover:underline">{t("note.cancel")}</button>
                    <button onclick={saveEdit} class="font-semibold text-accent hover:underline">{t("note.save")}</button>
                  </div>
                </div>
                {#if trayOpen}
                  <div class="mt-2 rounded-xl bg-neutral-200/60 p-2 text-xs dark:bg-neutral-800/60">
                    {#if trayItems.length === 0}
                      <p class="opacity-50">{t("clipboard.empty")}</p>
                    {:else}
                      <div class="mb-1 flex justify-end">
                        <button
                          onclick={() => void clearTray()}
                          aria-label={t("clipboard.clearHistory")}
                          title={t("clipboard.clearHistory")}
                          class="rounded px-1.5 py-0.5 opacity-60 hover:bg-white/40 hover:opacity-100"
                        >{t("clipboard.clearHistory")}</button>
                      </div>
                      {#each trayItems as e, i (i)}
                        <button onclick={() => pickFromTray(e)} class="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-white/40">{previewClipboard(e)}</button>
                      {/each}
                    {/if}
                  </div>
                {/if}
              </div>
            {:else}
              <p class="whitespace-pre-wrap text-sm">
                {#each fmtInline(n.text) as seg, i (i)}
                  {#if seg.tag}<button type="button" onclick={() => { mode = "all"; pickTag(seg.text.slice(1)); }} class="text-accent font-medium underline decoration-accent/40 underline-offset-2">{seg.text}</button>
                  {:else if seg.bold}<strong class="font-semibold">{seg.text}</strong>
                  {:else if seg.hl}<mark class="rounded bg-amber-200 px-0.5 dark:bg-amber-500/40">{seg.text}</mark>
                  {:else if seg.link && seg.url}<a href={seg.url} target="_blank" rel="noreferrer" class="break-all text-accent underline">{seg.text}</a>
                  {:else if seg.strike}<s class="opacity-60">{seg.text}</s>
                  {:else}{seg.text}{/if}
                {/each}
              </p>


              {#if tasksOf(n.text).length > 0}
                <div class="mt-1.5 rounded-xl bg-neutral-200/50 p-1.5 dark:bg-neutral-800/40">
                  <div class="flex flex-col">
                    {#each tasksOf(n.text) as tk, i (i + "-" + tk.label)}
                      <button onclick={() => persist(toggleTaskInNote(notes, n.id, i))} class="flex items-start gap-1.5 py-0.5 text-left text-sm">
                        <span class={tk.done ? "text-accent" : "opacity-50"}>{tk.done ? "☑" : "☐"}</span>
                        <span class={tk.done ? "text-neutral-400 line-through" : ""}>{tk.label}</span>
                      </button>
                    {/each}
                  </div>
                  <div class="mt-0.5 flex items-center gap-2 text-xs text-accent">
                    <span>{taskSummary(n.text).done}/{taskSummary(n.text).total} ✓</span>
                    {#if taskSummary(n.text).done < taskSummary(n.text).total}
                      <button onclick={() => persist(completeAllTasks(notes, n.id))} class="underline hover:text-neutral-900 dark:hover:text-white">{t("note.completeAll")}</button>
                    {/if}
                  </div>
                </div>
              {/if}
              <div class="mt-2 flex items-center justify-between text-xs opacity-60">
                <span class="flex gap-1.5">
                  <span title={editedOf(n) ? new Date(createdOf(n)).toLocaleString() : undefined}>{fmtTime(n.ts)}{editedOf(n) ? ` · ${t("note.edited")}` : ""}</span>
                  <span>· {statsOf(n).chars} {t("note.chars")}</span>
                </span>
                <div class="flex flex-wrap gap-2">
                  <button onclick={() => void doExportOne(n)} title={t("note.export")} class="hover:underline">↧ {t("note.export")}</button>
                  <button onclick={() => void doExportMd(n)} aria-label="note-export-md" title={t("note.exportMdHint")} class="hover:underline">⇩ .md</button>
                  {#if mode === "all"}
                    <button onclick={() => persist(togglePin(notes, n.id))} title={t("note.pin")} class={"hover:underline " + (n.pinned ? "text-amber-500" : "opacity-70")}>{n.pinned ? "★" : "☆"}</button>
                    <button onclick={() => setStateOf(n.id, "archived")} class="hover:underline">{t("note.archive")}</button>
                    <button onclick={() => dupeOf(n.id)} aria-label="note-duplicate" title={t("note.duplicate")} class="hover:underline">⧉ {t("note.duplicate")}</button>
                    <button onclick={() => beginEdit(n)} class="text-accent hover:underline">{t("note.edit")}</button>
                    <button onclick={() => openEditor(n)} class="text-accent hover:underline">{t("note.fullPage")}</button>
                  {/if}
                  {#if mode === "all" || mode === "archived"}
                    <button onclick={() => setStateOf(n.id, "trash")} class="text-danger hover:underline">{t("note.delete")}</button>
                  {/if}
                  {#if mode === "archived"}
                    <button onclick={() => setStateOf(n.id, undefined)} class="text-accent hover:underline">{t("note.restore")}</button>
                  {/if}
                  {#if mode === "trash"}
                    <button onclick={() => setStateOf(n.id, undefined)} class="text-accent hover:underline">{t("note.restore")}</button>
                    <button onclick={() => persist(removeNote(notes, n.id))} class="text-danger hover:underline">{t("note.deleteForever")}</button>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/if}
      {/each}
    {/if}
  </div>
{/if}
</div>

