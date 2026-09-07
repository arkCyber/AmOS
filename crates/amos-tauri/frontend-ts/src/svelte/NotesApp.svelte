<script lang="ts">
  // NotesApp.svelte — Svelte 5 (runes) port of the React `Notes` in src/apps.tsx.
  // All note logic reuses pure lib/notes.ts; rich-text segments (fmtInline) are
  // rendered reactively; copy/paste go through lib/clipboard (offline no-op), and
  // the ClipboardTray history is rendered inline from clipboardHistory(). Store
  // key: amos.notes.
  import {
    NOTES_KEY,
    completeAllTasks,
    editNote,
    fmtInline,
    fmtTime,
    normalizeNotes,
    noteDayOf,
    noteListProgress,
    notePreview,
    noteStats,
    noteTitle,
    notesOf,
    orderPinned,
    prependNote,
    removeNote,
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
    tagsOf,
    hasTag,
  } from "../lib/notes";
  import type { Note } from "../lib/notes";
  import { clipboardHistory, clipboardRead, clipboardWrite, entryText } from "../lib/clipboard";
  import type { ClipboardEntry } from "../lib/clipboard";
  import { iconSvg } from "../lib/sysIcons";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { exportTxtFile } from "../lib/backend";
  import { t } from "./locale.svelte";

  const seeded = normalizeNotes(readStoreValue<unknown>(NOTES_KEY, []));
  let notes = $state<Note[]>(seeded);
  let text = $state("");
  let editingId = $state<string | null>(null);
  let editVal = $state("");
  let trayOpen = $state(false);
  let trayItems = $state<ClipboardEntry[]>([]);
  let mode = $state<"all" | "archived" | "trash">("all");
  let searchQ = $state("");
  let openId = $state<string | null>(null);
  let selecting = $state(false); // multi-select batch mode
  let selected = $state<string[]>([]);


  const persist = (list: Note[]) => {
    writeStoreValue(NOTES_KEY, list);
    notes = list;
  };

  const add = () => {
    const v = text.trim();
    if (!v) return;
    const now = Date.now();
    const next = prependNote(notes, v, now);
    persist(next);
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
  };
  const saveEdit = () => {
    if (!editingId) return;
    persist(editNote(notes, editingId, editVal, Date.now()));
    cancelEdit();
  };
  const copyEditing = async () => {
    if (!editingId) return;
    await clipboardWrite({ kind: "text", text: editVal });
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
  let selTag = $state<string | null>(null); // active #tag filter (lowercased)
  const activeAll = $derived(
    orderPinned(searchNotes(notesOf(notes, undefined), mode === "all" ? searchQ : "")),
  );
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
    return tag ? activeAll.filter((n) => hasTag(n.text, tag)) : activeAll;
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
        await clipboardWrite({ kind: "text", text });
      } catch {
        /* clipboard unavailable — message still informs */
      }
      exportMsg = t("note.exportCopied");
    }
  };
  const composeStats = $derived(noteStats(text));
  const statsOf = (n: Note) => noteStats(n.text);
  const collapsed = (n: Note) =>
    !editingThis(n.id) && openId !== n.id && tasksOf(n.text).length === 0;

  const setStateOf = (id: string, st: "archived" | "trash" | undefined) =>
    persist(setNoteState(notes, id, st));

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
    <button onclick={add} class="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95">{t("note.add")}</button>
    <span class="text-xs opacity-50">{t("note.stats", { chars: String(composeStats.chars), lines: String(composeStats.lines) })}</span>
  </div>

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
              <span class="truncate text-[15px] font-medium">{noteTitle(n.text) || t("note.untitled")}</span>
            </div>
          </button>
        {:else if collapsed(n)}
          <button onclick={() => (openId = n.id)} class="block w-full rounded-2xl bg-white/60 p-3 text-left shadow-sm ring-1 ring-black/5 transition active:bg-white/80 dark:bg-white/[0.06] dark:ring-white/10">
            <div class="flex items-start justify-between gap-2">
              <span class="truncate text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">{noteTitle(n.text) || t("note.untitled")}</span>
              <span class="shrink-0 pt-0.5 text-xs text-neutral-500">{stampOf(n)}</span>
            </div>
            {#if notePreview(n.text)}
              <p class="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{notePreview(n.text)}</p>
            {/if}
            <div class="mt-1 flex items-center gap-2 text-xs text-neutral-500">
              {#if mode === "all" && n.pinned}
                <span class="text-amber-500">📌</span>
              {/if}
              {#if taskSummary(n.text).total > 0}
                <span class="text-accent">☑ {taskSummary(n.text).done}/{taskSummary(n.text).total}</span>
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
                <textarea bind:value={editVal} rows={3} aria-label="note-edit" class="w-full resize-none rounded-xl bg-white/70 p-2 text-sm outline-none dark:bg-neutral-900/70"></textarea>
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
                <div class="mt-2 flex items-center justify-between text-xs">
                  <span class="opacity-60">{fmtTime(n.ts)}</span>
                  <div class="flex gap-2">
                    <button onclick={() => void copyEditing()} aria-label="Copy to AmOS clipboard" title="复制到系统剪贴板" class="opacity-70 hover:opacity-100">⧉</button>
                    <button onclick={() => void pasteEditing()} aria-label="Paste from AmOS clipboard" title="从系统剪贴板粘贴" class="opacity-70 hover:opacity-100">📋</button>
                    <button onclick={() => (trayOpen = !trayOpen)} aria-label="Clipboard history" aria-pressed={trayOpen} title="剪贴板历史" class="opacity-70 hover:opacity-100">🕘</button>
                    <button onclick={cancelEdit} class="opacity-70 hover:underline">{t("note.cancel")}</button>
                    <button onclick={saveEdit} class="font-semibold text-accent hover:underline">{t("note.save")}</button>
                  </div>
                </div>
                {#if trayOpen}
                  <div class="mt-2 rounded-xl bg-neutral-200/60 p-2 text-xs dark:bg-neutral-800/60">
                    {#if trayItems.length === 0}
                      <p class="opacity-50">（剪贴板暂无历史 / 离线）</p>
                    {:else}
                      {#each trayItems as e, i (i)}
                        <button onclick={() => pickFromTray(e)} class="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-white/40">{entryText(e) || "—"}</button>
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
                  <span>{fmtTime(n.ts)}</span>
                  <span>· {statsOf(n).chars} {t("note.chars")}</span>
                </span>
                <div class="flex flex-wrap gap-2">
                  <button onclick={() => void doExportOne(n)} title={t("note.export")} class="hover:underline">↧ {t("note.export")}</button>
                  {#if mode === "all"}
                    <button onclick={() => persist(togglePin(notes, n.id))} title={t("note.pin")} class={"hover:underline " + (n.pinned ? "text-amber-500" : "opacity-70")}>{n.pinned ? "★" : "☆"}</button>
                    <button onclick={() => setStateOf(n.id, "archived")} class="hover:underline">{t("note.archive")}</button>
                    <button onclick={() => beginEdit(n)} class="text-accent hover:underline">{t("note.edit")}</button>
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
</div>

