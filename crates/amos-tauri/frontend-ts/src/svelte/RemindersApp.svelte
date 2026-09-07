<script lang="ts">
  // RemindersApp.svelte — Svelte 5 (runes) single-source implementation of the
  // reminders screen. All domain logic reuses pure lib/reminders.ts;
  // data is persisted through the shared amos.* store under amos.reminders /
  // amos.reminderLists, exactly like the retired React screen, so the shell-mounted
  // OS notifier (lib/reminderNotify.ts) keeps firing on the same markers.
  import {
    COLOR_NAMES,
    DEFAULT_LIST_ID,
    LISTS_KEY,
    REMINDERS_KEY,
    SMART_VIEWS,
    addList,
    addReminder,
    completedOf,
    counts,
    formatDueAt,
    fmtTime,
    isPastDue,
    normalizeLists,
    normalizeReminders,
    pendingOf,
    removeList,
    removeReminder,
    remindersInSmart,
    searchReminders,
    seedLists,
    seedReminders,
    toggleComplete,
    updateReminder,
    type ColorName,
    type Priority,
    type Reminder,
    type ReminderList,
    type SmartView,
  } from "../lib/reminders";
  import { readStoreValue, writeStoreValue } from "../lib/amosStore";
  import { iconSvg } from "../lib/sysIcons";
  import { t } from "./locale.svelte";

  /* iOS-like palette for colored list dots (literal Tailwind classes). */
  const DOT: Record<ColorName, string> = {
    red: "text-red-500",
    orange: "text-orange-500",
    yellow: "text-yellow-500",
    green: "text-green-500",
    teal: "text-teal-500",
    blue: "text-blue-500",
    indigo: "text-indigo-500",
    purple: "text-purple-500",
    pink: "text-pink-500",
    gray: "text-neutral-400",
  };
  const PRIORITY_GLYPH: Record<Priority, string> = { 0: "", 1: "①", 2: "②", 3: "‼" };
  const PRIORITY_LABELS = [
    "reminder.priorityNone",
    "reminder.priorityLow",
    "reminder.priorityMedium",
    "reminder.priorityHigh",
  ] as const;

  type Sel = { kind: "smart"; view: SmartView } | { kind: "list"; id: string };
  interface Draft {
    title: string;
    notes: string;
    dateStr: string; // "YYYY-MM-DD" (empty = not scheduled)
    timeStr: string; // "HH:MM"
    allDay: boolean;
    priority: Priority;
    flagged: boolean;
    listId: string;
  }

  /* ---- seed / init from the shared store (mirrors React mount read) ---- */
  const now0 = Date.now();
  let initLists = normalizeLists(readStoreValue<unknown>(LISTS_KEY, []));
  if (!initLists.some((x) => x.id === DEFAULT_LIST_ID)) {
    initLists = initLists.length
      ? [seedLists(now0)[0]!, ...initLists]
      : seedLists(now0);
    writeStoreValue(LISTS_KEY, initLists);
  }
  let initRem = normalizeReminders(readStoreValue<unknown>(REMINDERS_KEY, []));
  if (!initRem.length) {
    initRem = seedReminders(now0);
    writeStoreValue(REMINDERS_KEY, initRem);
  }
  let lists = $state<ReminderList[]>(initLists);
  let reminders = $state<Reminder[]>(initRem);

  const persistLists = (l: ReminderList[]) => {
    const c = normalizeLists(l);
    writeStoreValue(LISTS_KEY, c);
    lists = c;
  };
  const persistReminders = (l: Reminder[]) => {
    const c = normalizeReminders(l);
    writeStoreValue(REMINDERS_KEY, c);
    reminders = c;
  };

  /* ---- overdue refresh tick ---- */
  let tick = $state(Date.now());
  $effect(() => {
    const id = window.setInterval(() => (tick = Date.now()), 20_000);
    return () => window.clearInterval(id);
  });

  /* ---- selection + search state ---- */
  let sel = $state<Sel>({ kind: "smart", view: "all" });
  let searchOpen = $state(false);
  let query = $state("");
  let showCompleted = $state(false);

  /* ---- compose / edit form state ---- */
  let formOpen = $state(false);
  let editId = $state<string | null>(null);
  let showSchedule = $state(false);
  const blank = (listId: string): Draft => ({
    title: "",
    notes: "",
    dateStr: "",
    timeStr: "09:00",
    allDay: false,
    priority: 0,
    flagged: false,
    listId,
  });
  function dateToInput(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const fromReminder = (r: Reminder): Draft => ({
    title: r.title,
    notes: r.notes ?? "",
    dateStr: typeof r.dueAt === "number" ? dateToInput(r.dueAt) : "",
    timeStr: typeof r.dueAt === "number" ? fmtTime(r.dueAt) : "09:00",
    allDay: !!r.allDay,
    priority: r.priority,
    flagged: r.flagged,
    listId: r.listId,
  });
  let draft = $state<Draft>(blank(DEFAULT_LIST_ID));

  const openNew = () => {
    const listId = sel.kind === "list" ? sel.id : DEFAULT_LIST_ID;
    editId = null;
    draft = blank(listId);
    showSchedule = false; // a brand-new reminder starts unscheduled
    formOpen = true;
  };
  const openEdit = (r: Reminder) => {
    editId = r.id;
    draft = fromReminder(r);
    // Reveal the date/time editor when the reminder already has a schedule
    showSchedule = typeof r.dueAt === "number";
    formOpen = true;
  };
  const closeForm = () => {
    formOpen = false;
    editId = null;
  };
  /** Build an epoch-ms from native date/time inputs (local time), or undefined. */
  function buildDue(dateStr: string, timeStr: string, allDay: boolean): number | undefined {
    if (!dateStr) return undefined;
    const [y, m, d] = dateStr.split("-").map(Number);
    if (!y || !m || !d) return undefined;
    if (allDay) return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    const [hh, mm] = timeStr.split(":").map(Number);
    return new Date(y, m - 1, d, Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0, 0, 0).getTime();
  }
  const commit = () => {
    const title = draft.title.trim();
    if (!title) return;
    const dueAt = buildDue(draft.dateStr, draft.timeStr, draft.allDay);
    const next = {
      title,
      listId: draft.listId,
      priority: draft.priority,
      flagged: draft.flagged,
      notes: draft.notes.trim() || undefined,
      ...(dueAt === undefined
        ? { dueAt: undefined as number | undefined, allDay: undefined as boolean | undefined }
        : { dueAt, allDay: draft.allDay }),
    };
    const n = Date.now();
    if (editId) persistReminders(updateReminder(reminders, editId, next));
    else persistReminders(addReminder(reminders, next, n));
    closeForm();
  };

  const editing = $derived(editId ? reminders.find((r) => r.id === editId) : undefined);
  const canSnooze = $derived(
    !!editing && typeof editing.dueAt === "number" && editing.dueAt <= tick,
  );
  const snooze = () => {
    if (!editId) return;
    const later = Date.now() + 3_600_000;
    persistReminders(updateReminder(reminders, editId, { dueAt: later, allDay: false }));
    closeForm();
  };

  /* ---- list creation ---- */
  let newListOpen = $state(false);
  let newListName = $state("");
  let newListColor = $state<ColorName>("blue");
  const createList = () => {
    if (!newListName.trim()) return;
    persistLists(addList(lists, { name: newListName, color: newListColor }, Date.now()));
    newListName = "";
    newListOpen = false;
  };
  const deleteList = (id: string) => {
    if (id === DEFAULT_LIST_ID) return;
    persistReminders(reminders.map((r) => (r.listId === id ? { ...r, listId: DEFAULT_LIST_ID } : r)));
    persistLists(removeList(lists, id));
    if (sel.kind === "list" && sel.id === id) sel = { kind: "smart", view: "all" };
  };

  /* ---- selection-derived view ---- */
  const selIsSmart = $derived(sel.kind === "smart");
  const selIsCompleted = $derived(sel.kind === "smart" && sel.view === "completed");
  const searching = $derived(query.trim().length > 0);
  const c = $derived(counts(reminders, tick));
  const baseShown = $derived(
    sel.kind === "smart"
      ? remindersInSmart(reminders, sel.view, tick)
      : pendingOf(reminders, sel.id),
  );
  const shown = $derived(searching ? searchReminders(baseShown, query) : baseShown);
  const listCompleted = $derived(sel.kind === "list" ? completedOf(reminders, sel.id) : []);

  const completeAllVisible = () => {
    const ids = new Set(baseShown.filter((r) => !r.completed).map((r) => r.id));
    if (ids.size === 0) return;
    const n = Date.now();
    persistReminders(
      reminders.map((r) =>
        ids.has(r.id) && !r.completed ? { ...r, completed: true, completedAt: n } : r,
      ),
    );
  };

  function listNameOf(l: ReminderList[], id: string, fallback: string): string {
    const f = l.find((x) => x.id === id);
    if (!f) return fallback;
    return f.custom ? f.name : fallback;
  }
  const smartLabel = (v: SmartView): string =>
    v === "all"
      ? t("reminder.all")
      : v === "today"
        ? t("reminder.today")
        : v === "scheduled"
          ? t("reminder.scheduled")
          : v === "flagged"
            ? t("reminder.flagged")
            : t("reminder.completed");
  const smartCount = (v: SmartView): number =>
    v === "all"
      ? c.total
      : v === "today"
        ? c.today
        : v === "scheduled"
          ? c.scheduled
          : v === "flagged"
            ? c.flagged
            : c.completed;
  const inboxLabel = $derived(t("app.reminders"));
  const selTitle = $derived(
    sel.kind === "smart" ? smartLabel(sel.view) : listNameOf(lists, sel.id, inboxLabel),
  );
  const dueWords = $derived({
    today: t("reminder.today"),
    tomorrow: t("reminder.tomorrow"),
    yesterday: t("reminder.yesterday"),
  });
  const listColor = (id: string): string => {
    const l = lists.find((x) => x.id === id);
    return l ? DOT[l.color] : DOT.blue;
  };

  /* Per-row metadata (mirrors the React ReminderRow). */
  function rowMeta(r: Reminder) {
    const done = !!r.completed;
    const past = !done && isPastDue(r, tick);
    const dueLabel =
      typeof r.dueAt === "number" ? formatDueAt(r.dueAt, r.allDay, tick, dueWords) : null;
    return { done, past, dueLabel };
  }

  /* class token helpers inlined from components/ui.tsx (React-free) */
  const GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
  const ROW = "flex items-center justify-between gap-3 px-4 py-3";
  const SUB = "h-px bg-black/5 dark:bg-white/10";
  const FIELD = "w-full rounded-lg bg-black/5 px-2.5 py-1.5 text-sm outline-none dark:bg-white/10";
  const btn = (kind: "neutral" | "accent" | "danger", size: "sm" | "md" = "md"): string => {
    const pad = size === "sm" ? "px-3 py-1 text-xs" : "px-3 py-1 text-sm";
    const tone =
      kind === "accent"
        ? "bg-accent text-white"
        : kind === "danger"
          ? "bg-danger text-white"
          : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100";
    return `${pad} rounded-full ${tone} transition active:scale-95 disabled:opacity-40`;
  };
</script>

<div class="flex h-full flex-col">
  <!-- list chips -->
  <div class="flex shrink-0 gap-1.5 overflow-x-auto px-3 py-2">
    {#each SMART_VIEWS as v (v)}
      <button
        onclick={() => (sel = { kind: "smart", view: v })}
        aria-pressed={sel.kind === "smart" && sel.view === v}
        class={sel.kind === "smart" && sel.view === v
          ? "shrink-0 rounded-full bg-accent px-3 py-1 text-xs text-white"
          : "shrink-0 rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"}
      >
        {smartLabel(v)}
        {#if v !== "completed"}<span class="opacity-60"> {smartCount(v)}</span>{/if}
      </button>
    {/each}
    <span class="mx-1 h-5 w-px shrink-0 self-center bg-neutral-300 dark:bg-neutral-600"></span>
    {#each lists as l (l.id)}
      <button
        onclick={() => (sel = { kind: "list", id: l.id })}
        aria-pressed={sel.kind === "list" && sel.id === l.id}
        class={sel.kind === "list" && sel.id === l.id
          ? "shrink-0 rounded-full bg-accent px-3 py-1 text-xs text-white"
          : "shrink-0 rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"}
      >
        <span class={sel.kind === "list" && sel.id === l.id ? "" : DOT[l.color]}>● </span>
        {l.custom ? l.name : inboxLabel}
        <span class="opacity-60"> {pendingOf(reminders, l.id).length}</span>
      </button>
    {/each}
    <button
      onclick={() => (newListOpen = !newListOpen)}
      class="shrink-0 rounded-full bg-neutral-200 px-2 py-1 text-xs dark:bg-neutral-700"
      aria-label={t("reminder.newList")}
    >
      ＋
    </button>
  </div>

  <!-- new-list creator -->
  {#if newListOpen}
    <div class="mx-3 mb-1 shrink-0">
      <div class={GROUP}>
        <div class={ROW}>
          <input
            bind:value={newListName}
            onkeydown={(e) => {
              if (e.key === "Enter") createList();
            }}
            placeholder={t("reminder.listName")}
            aria-label={t("reminder.listName")}
            class={FIELD}
          />
          <button onclick={createList} disabled={!newListName.trim()} class={btn("accent", "sm")}>
            {t("reminder.create")}
          </button>
        </div>
        <div class={SUB}></div>
        <div class="flex flex-wrap gap-1.5 px-4 py-2.5">
          {#each COLOR_NAMES as col (col)}
            <button
              onclick={() => (newListColor = col)}
              aria-label={col}
              class={"grid h-6 w-6 place-items-center rounded-full text-xs " +
                DOT[col] +
                (newListColor === col ? " ring-2 ring-neutral-400" : "")}
            >
              ●
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  <!-- active list header -->
  <div class="flex shrink-0 items-center gap-2 px-4 pb-1 pt-1">
    <span class="truncate text-lg font-semibold text-neutral-800 dark:text-neutral-100">{selTitle}</span>
    {#if sel.kind === "list" && !searching}
      <span class="shrink-0 text-xs opacity-50">
        {shown.length} / {pendingOf(reminders, sel.id).length}
      </span>
    {/if}
    {#if sel.kind === "list" && sel.id !== DEFAULT_LIST_ID && !searching}
      <button
        onclick={() => {
          if (sel.kind === "list") deleteList(sel.id);
        }}
        class="shrink-0 text-xs text-danger"
        aria-label={t("reminder.deleteList")}
      >
        {t("reminder.deleteList")}
      </button>
    {/if}
    <button
      onclick={() => {
        if (searchOpen) query = "";
        searchOpen = !searchOpen;
      }}
      aria-pressed={searchOpen}
      aria-label={t("reminder.search")}
      title={t("reminder.search")}
      class="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-full bg-neutral-200/70 text-sm dark:bg-neutral-700/70"
      data-icon={searchOpen ? "x" : "search"}
    >
      {@html iconSvg(searchOpen ? "x" : "search", "h-[15px] w-[15px]")}
    </button>
  </div>

  <!-- search field -->
  {#if searchOpen}
    <div class="flex shrink-0 items-center gap-2 px-3 pb-1.5">
      <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl bg-black/5 px-2.5 py-1 ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10">
        <span class="shrink-0 opacity-50" data-icon="search">{@html iconSvg("search", "h-3.5 w-3.5")}</span>
        <input
          bind:value={query}
          placeholder={t("reminder.search")}
          aria-label={t("reminder.search")}
          class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-black/30 dark:placeholder:text-white/30"
        />
        {#if searching}
          <span class="shrink-0 text-[10px] text-accent">
            {t("reminder.matches", { n: shown.length })}
          </span>
        {/if}
        {#if query}
          <button onclick={() => (query = "")} aria-label={t("reminder.clear")} data-icon="x" class="grid h-5 w-5 shrink-0 place-items-center rounded-full text-neutral-400">
            {@html iconSvg("x", "h-3 w-3")}
          </button>
        {/if}
      </div>
    </div>
  {/if}
  <!-- rows -->
  <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
    <div class={GROUP}>
      {#if shown.length === 0}
        <p class="px-4 py-8 text-center text-sm opacity-50">
          {selIsCompleted
            ? t("reminder.completedEmpty")
            : searching
              ? t("reminder.noMatch")
              : t("reminder.empty")}
        </p>
      {:else}
        {#each shown as r, i (r.id)}
          {@const meta = rowMeta(r)}
          {#if i > 0}<div class={SUB}></div>{/if}
          <div class={ROW + " items-start"}>
              <button
                onclick={() => persistReminders(toggleComplete(reminders, r.id, Date.now()))}
                aria-label={meta.done ? "undone" : "done"}
                class={"mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 text-sm leading-none transition active:scale-90 " +
                  (meta.done
                    ? "border-accent bg-accent text-white"
                    : meta.past
                      ? "border-danger text-transparent"
                      : "border-neutral-400 dark:border-neutral-500")}
              >
                {meta.done ? "✓" : ""}
              </button>
              <div class="min-w-0 flex-1 cursor-pointer" role="button" tabindex="0" onclick={() => openEdit(r)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEdit(r); } }}>
                <div class={"text-[15px] leading-snug " +
                  (meta.done
                    ? "text-neutral-400 line-through dark:text-neutral-500"
                    : meta.past
                      ? "font-semibold text-danger"
                      : "text-neutral-800 dark:text-neutral-100")}>
                  {r.title}
                </div>
                {#if meta.dueLabel || selIsSmart || r.flagged || PRIORITY_GLYPH[r.priority]}
                  <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                    {#if selIsSmart}
                      <span class={listColor(r.listId)}>{listNameOf(lists, r.listId, inboxLabel)}</span>
                    {/if}
                    {#if meta.dueLabel}
                      <span class={meta.done
                        ? "text-neutral-400"
                        : meta.past
                          ? "font-semibold text-danger"
                          : "text-accent"}>
                        {meta.past ? `${t("reminder.overdue")} ` : ""}{meta.dueLabel}
                      </span>
                    {/if}
                    {#if PRIORITY_GLYPH[r.priority]}
                      <span class="text-orange-500" aria-label="high priority">{PRIORITY_GLYPH[r.priority]}</span>
                    {/if}
                    {#if r.flagged}<span class="text-orange-500">⚑</span>{/if}
                    {#if r.notes}<span class="truncate opacity-50">{r.notes}</span>{/if}
                  </div>
                {/if}
              </div>
            </div>
        {/each}
      {/if}
      {#if !selIsSmart && listCompleted.length > 0}
        <div class={SUB}></div>
        <button
          onclick={() => (showCompleted = !showCompleted)}
          aria-pressed={showCompleted}
          class={ROW + " cursor-pointer"}
        >
          <span class="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
            <span class="transition-transform">{showCompleted ? "▾" : "▸"}</span>
            <span class="opacity-80">{`${t("reminder.completed")} (${listCompleted.length})`}</span>
          </span>
        </button>
        {#if showCompleted}
          {#each listCompleted as r (r.id)}
            {@const meta = rowMeta(r)}
            <div class={SUB}></div>
            <div class={ROW + " items-start"}>
                <button
                  onclick={() => persistReminders(toggleComplete(reminders, r.id, Date.now()))}
                  aria-label={meta.done ? "undone" : "done"}
                  class={"mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 text-sm leading-none transition active:scale-90 " +
                    (meta.done
                      ? "border-accent bg-accent text-white"
                      : meta.past
                        ? "border-danger text-transparent"
                        : "border-neutral-400 dark:border-neutral-500")}
                >
                  {meta.done ? "✓" : ""}
                </button>
                <div class="min-w-0 flex-1 cursor-pointer" role="button" tabindex="0" onclick={() => openEdit(r)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEdit(r); } }}>
                  <div class={"text-[15px] leading-snug " +
                    (meta.done
                      ? "text-neutral-400 line-through dark:text-neutral-500"
                      : meta.past
                        ? "font-semibold text-danger"
                        : "text-neutral-800 dark:text-neutral-100")}>
                    {r.title}
                  </div>
                  {#if meta.dueLabel || r.flagged || PRIORITY_GLYPH[r.priority]}
                    <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      {#if meta.dueLabel}
                        <span class={meta.done
                          ? "text-neutral-400"
                          : meta.past
                            ? "font-semibold text-danger"
                            : "text-accent"}>
                          {meta.past ? `${t("reminder.overdue")} ` : ""}{meta.dueLabel}
                        </span>
                      {/if}
                      {#if PRIORITY_GLYPH[r.priority]}
                        <span class="text-orange-500" aria-label="high priority">{PRIORITY_GLYPH[r.priority]}</span>
                      {/if}
                      {#if r.flagged}<span class="text-orange-500">⚑</span>{/if}
                      {#if r.notes}<span class="truncate opacity-50">{r.notes}</span>{/if}
                    </div>
                  {/if}
                </div>
              </div>
          {/each}
        {/if}
      {/if}
    </div>
  </div>
  <!-- compose / edit form -->
  {#if !selIsCompleted}
    <div class="shrink-0 border-t border-neutral-200/70 px-3 py-2 dark:border-neutral-800">
      {#if !formOpen}
        <div class="flex items-center gap-2">
          <button onclick={openNew} class="min-w-0 flex-1 rounded-xl px-3 py-2 text-left text-[15px] text-accent">
            ＋ {t("reminder.new")}
          </button>
          {#if !searching && baseShown.length > 0}
            <button
              onclick={completeAllVisible}
              class="shrink-0 rounded-full bg-accent/15 px-3 py-2 text-xs text-accent"
            >
              ✓ {t("reminder.completeAll")} ({baseShown.length})
            </button>
          {/if}
        </div>
      {:else}
        <div class="max-h-[46vh] overflow-y-auto">
          <div class={GROUP}>
            <div class="px-4 py-2">
              <input
                bind:value={draft.title}
                onkeydown={(e) => {
                  if (e.key === "Enter") commit();
                }}
                placeholder={t("reminder.titlePlaceholder")}
                aria-label={t("reminder.titlePlaceholder")}
                class="w-full text-[15px] outline-none"
              />
              <input
                bind:value={draft.notes}
                placeholder={t("reminder.notesPlaceholder")}
                aria-label={t("reminder.notesPlaceholder")}
                class="mt-0.5 w-full text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
              />
              {#if showSchedule}
                <div class="mt-2 space-y-2 rounded-xl bg-black/5 p-2 dark:bg-white/10">
                  <div class="flex items-center gap-2">
                    <span class="w-10 shrink-0 text-xs opacity-60">{t("reminder.date")}</span>
                    <input
                      type="date"
                      bind:value={draft.dateStr}
                      class="min-w-0 flex-1 rounded-lg bg-white/70 px-2 py-1 text-xs outline-none dark:bg-neutral-900/70"
                    />
                    {#if draft.dateStr}
                      <button
                        onclick={() => {
                          draft.dateStr = "";
                          draft.allDay = false;
                        }}
                        class="shrink-0 rounded-full bg-neutral-300 px-2 py-0.5 text-[10px] dark:bg-neutral-700"
                      >
                        {t("reminder.clear")}
                      </button>
                    {/if}
                  </div>
                  {#if !draft.allDay}
                    <div class="flex items-center gap-2">
                      <span class="w-10 shrink-0 text-xs opacity-60">{t("reminder.time")}</span>
                      <input
                        type="time"
                        bind:value={draft.timeStr}
                        class="rounded-lg bg-white/70 px-2 py-1 text-xs outline-none dark:bg-neutral-900/70"
                      />
                    </div>
                  {/if}
                  <div class="flex items-center justify-between">
                    <span class="text-xs opacity-60">{t("reminder.allDay")}</span>
                    <button
                      role="switch"
                      aria-checked={draft.allDay}
                      aria-label={t("reminder.allDay")}
                      onclick={() => (draft.allDay = !draft.allDay)}
                      class={"h-7 w-[46px] shrink-0 rounded-full p-0.5 transition " +
                        (draft.allDay ? "bg-green-500" : "bg-neutral-300 dark:bg-neutral-600")}
                    >
                      <span class={"block h-6 w-6 rounded-full bg-white shadow transition-transform " +
                        (draft.allDay ? "translate-x-[18px]" : "translate-x-0")}></span>
                    </button>
                  </div>
                  {#if canSnooze}
                    <button
                      onclick={snooze}
                      class="w-full rounded-lg bg-accent/15 px-2 py-1.5 text-xs text-accent"
                    >
                      ⏰ {t("reminder.snooze")}
                    </button>
                  {/if}
                </div>
              {/if}
                          <div class="mt-2 space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="shrink-0 text-xs opacity-60">{t("reminder.priority")}</span>
                  <div class="flex flex-wrap justify-end gap-1">
                    {#each PRIORITY_LABELS as k, p (k)}
                      <button
                        onclick={() => (draft.priority = p as Priority)}
                        aria-pressed={draft.priority === p}
                        class={"rounded-full px-2 py-0.5 text-[10px] " +
                          (draft.priority === p
                            ? "bg-accent text-white"
                            : "bg-neutral-200 dark:bg-neutral-700")}
                      >
                        {t(k)}
                      </button>
                    {/each}
                  </div>
                </div>
                <div class="flex items-center justify-between">
                  <span class="text-xs opacity-60">{t("reminder.flag")}</span>
                  <button
                    role="switch"
                    aria-checked={draft.flagged}
                    aria-label={t("reminder.flag")}
                    onclick={() => (draft.flagged = !draft.flagged)}
                    class={"h-7 w-[46px] shrink-0 rounded-full p-0.5 transition " +
                      (draft.flagged ? "bg-green-500" : "bg-neutral-300 dark:bg-neutral-600")}
                  >
                    <span class={"block h-6 w-6 rounded-full bg-white shadow transition-transform " +
                      (draft.flagged ? "translate-x-[18px]" : "translate-x-0")}></span>
                  </button>
                </div>
                <div class="flex items-center justify-between">
                  <span class="text-xs opacity-60">{t("reminder.list")}</span>
                  <select
                    bind:value={draft.listId}
                    class="max-w-[60%] rounded-lg bg-neutral-200 px-1 py-0.5 text-xs outline-none dark:bg-neutral-700"
                  >
                    {#each lists as l (l.id)}
                      <option value={l.id}>{l.custom ? l.name : inboxLabel}</option>
                    {/each}
                  </select>
                </div>
              </div>
            </div>
            <div class={SUB}></div>
            <div class="flex items-center justify-between gap-2 px-4 py-2">
              <div class="flex gap-1.5">
                <button onclick={closeForm} class={btn("neutral", "sm")}>
                  {t("reminder.cancel")}
                </button>
                {#if editId}
                  <button
                    onclick={() => {
                      if (editId) persistReminders(removeReminder(reminders, editId));
                      closeForm();
                    }}
                    class={btn("danger", "sm")}
                  >
                    {t("reminder.delete")}
                  </button>
                {/if}
              </div>
              <div class="flex items-center gap-2">
                <button onclick={() => (showSchedule = !showSchedule)} class={btn("neutral", "sm")}>
                  {t("reminder.schedule")}
                </button>
                <button onclick={commit} disabled={!draft.title.trim()} class={btn("accent", "sm")}>
                  {editId ? t("reminder.save") : t("reminder.add")}
                </button>
              </div>
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>





