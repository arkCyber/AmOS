/* Reminders (提醒事项) — iOS-style, persisted through the shared amos.* store.
 *
 * Smart views (全部/今天/计划/旗标/已完成) + colour-coded custom lists. Each
 * reminder has title/notes, an optional date(+time) due, a priority and a flag.
 * Completing moves it to 已完成. Reaching a due time fires an OS-level app
 * notification (see lib/reminderNotify.ts, mounted in the Shell) so the badge
 * / banner alert you wherever you are; the shell clears them when this app is
 * opened — the same read-semantics as Messages/Mail.
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { FIELD, GROUP, ROW, SUB, Switch, btn } from "./ui";
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

/* iOS-like palette for the colored list dots. Literal classes so Tailwind JIT
 * picks them up. */
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

const PRIORITY_GLYPH: Record<Priority, string> = {
  0: "",
  1: "①",
  2: "②",
  3: "‼",
};

function ReminderRow({
  r,
  now,
  showListTag,
  listTag,
  listTagColor,
  dueWords,
  overduePrefix,
  onToggle,
  onOpen,
}: {
  r: Reminder;
  now: number;
  showListTag: boolean;
  listTag: string;
  listTagColor: string;
  dueWords: { today: string; tomorrow: string; yesterday: string };
  overduePrefix: string;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const done = !!r.completed;
  const past = !done && isPastDue(r, now);
  const dueLabel = typeof r.dueAt === "number" ? formatDueAt(r.dueAt, r.allDay, now, dueWords) : null;
  return (
    <div className={ROW + " items-start"}>
      <button
        onClick={onToggle}
        aria-label={done ? "undone" : "done"}
        className={
          "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 text-sm leading-none transition active:scale-90 " +
          (done
            ? "border-accent bg-accent text-white"
            : past
              ? "border-danger text-transparent"
              : "border-neutral-400 dark:border-neutral-500")
        }
      >
        {done ? "✓" : ""}
      </button>
      <div className="min-w-0 flex-1 cursor-pointer" onClick={onOpen}>
        <div
          className={
            "text-[15px] leading-snug " +
            (done
              ? "text-neutral-400 line-through dark:text-neutral-500"
              : past
                ? "font-semibold text-danger"
                : "text-neutral-800 dark:text-neutral-100")
          }
        >
          {r.title}
        </div>
        {(dueLabel || showListTag || r.flagged || PRIORITY_GLYPH[r.priority]) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            {showListTag && <span className={listTagColor}>{listTag}</span>}
            {dueLabel && (
              <span className={done ? "text-neutral-400" : past ? "font-semibold text-danger" : "text-accent"}>
                {past ? `${overduePrefix} ` : ""}
                {dueLabel}
              </span>
            )}
            {PRIORITY_GLYPH[r.priority] && (
              <span className="text-orange-500" aria-label="high priority">
                {PRIORITY_GLYPH[r.priority]}
              </span>
            )}
            {r.flagged && <span className="text-orange-500">⚑</span>}
            {r.notes && <span className="truncate opacity-50">{r.notes}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

type Sel = { kind: "smart"; view: SmartView } | { kind: "list"; id: string };

interface Draft {
  title: string;
  notes: string;
  dateStr: string; // "YYYY-MM-DD" (empty = no schedule)
  timeStr: string; // "HH:MM"
  allDay: boolean;
  priority: Priority;
  flagged: boolean;
  listId: string;
}

const PRIORITY_LABELS = ["reminder.priorityNone", "reminder.priorityLow", "reminder.priorityMedium", "reminder.priorityHigh"] as const;

function dateToInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Build an epoch-ms from native date/time inputs (local time), or undefined. */
function buildDue(dateStr: string, timeStr: string, allDay: boolean): number | undefined {
  if (!dateStr) return undefined;
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  if (allDay) return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(y, m - 1, d, Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0, 0, 0).getTime();
}

function listNameOf(lists: ReminderList[], id: string, fallback: string): string {
  const l = lists.find((x) => x.id === id);
  if (!l) return fallback;
  return l.custom ? l.name : fallback;
}

export default function RemindersApp() {
  const { t } = useI18n();
  const inboxLabel = t("app.reminders");

  const [lists, setLists] = useState<ReminderList[]>(() => {
    const l = normalizeLists(readStoreValue<unknown>(LISTS_KEY, []));
    if (l.some((x) => x.id === DEFAULT_LIST_ID)) return l;
    const merged = l.length ? [seedLists(Date.now())[0]!, ...l] : seedLists(Date.now());
    writeStoreValue(LISTS_KEY, merged);
    return merged;
  });
  const [reminders, setReminders] = useState<Reminder[]>(() => {
    const r = normalizeReminders(readStoreValue<unknown>(REMINDERS_KEY, []));
    if (r.length) return r;
    const s = seedReminders(Date.now());
    writeStoreValue(REMINDERS_KEY, s);
    return s;
  });

  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 20_000);
    return () => window.clearInterval(id);
  }, []);

  const persistLists = (l: ReminderList[]) => {
    const c = normalizeLists(l);
    writeStoreValue(LISTS_KEY, c);
    setLists(c);
  };
  const persistReminders = (l: Reminder[]) => {
    const c = normalizeReminders(l);
    writeStoreValue(REMINDERS_KEY, c);
    setReminders(c);
  };

  /* ---- selection + smart-list state ---- */
  const [sel, setSel] = useState<Sel>({ kind: "smart", view: "all" });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const c = counts(reminders, tick);

  const selIsSmart = sel.kind === "smart";
  const selIsCompleted = selIsSmart && sel.view === "completed";
  const searching = query.trim().length > 0;
  const baseShown = selIsSmart
    ? remindersInSmart(reminders, sel.view, tick)
    : pendingOf(reminders, sel.id);
  const shown = searching ? searchReminders(baseShown, query) : baseShown;
  // Per-list "已完成" section (custom lists + the built-in inbox list view).
  const listCompleted = !selIsSmart ? completedOf(reminders, sel.id) : [];
  /** Complete every pending reminder in the current view (today/scheduled/list…). */
  const completeAllVisible = () => {
    const ids = new Set(baseShown.filter((r) => !r.completed).map((r) => r.id));
    if (ids.size === 0) return;
    const now = Date.now();
    persistReminders(
      reminders.map((r) =>
        ids.has(r.id) && !r.completed ? { ...r, completed: true, completedAt: now } : r,
      ),
    );
  };
  /* ---- compose / edit form ---- */
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
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
  const [draft, setDraft] = useState<Draft>(() => blank(DEFAULT_LIST_ID));

  const openNew = () => {
    const listId = sel.kind === "list" ? sel.id : DEFAULT_LIST_ID;
    setEditId(null);
    setDraft(blank(listId));
    setShowSchedule(false); // a brand-new reminder starts unscheduled
    setFormOpen(true);
  };
  const openEdit = (r: Reminder) => {
    setEditId(r.id);
    setDraft(fromReminder(r));
    // Reveal the date/time editor when the reminder already has a schedule
    // (otherwise there'd be no way to see or change its due date in edit mode).
    setShowSchedule(typeof r.dueAt === "number");
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditId(null);
  };
  const commit = () => {
    const title = draft.title.trim();
    if (!title) return;
    const dueAt = buildDue(draft.dateStr, draft.timeStr, draft.allDay);
    const next = {
      title,
      listId: draft.listId,
      priority: draft.priority,
      flagged: draft.flagged,
      // Always set notes (trimmed, or undefined to truly clear on edit).
      notes: draft.notes.trim() || undefined,
      ...(dueAt === undefined
        ? { dueAt: undefined as number | undefined, allDay: undefined as boolean | undefined }
        : { dueAt, allDay: draft.allDay }),
    };
    const now = Date.now();
    if (editId) persistReminders(updateReminder(reminders, editId, next));
    else persistReminders(addReminder(reminders, next, now));
    closeForm();
  };

  // Quick "remind again" for a past-due reminder: push its due time ~1 hour out
  // (the OS notifier re-alerts because the dueAt marker no longer matches).
  const editing = editId ? reminders.find((r) => r.id === editId) : undefined;
  const canSnooze = !!editing && typeof editing.dueAt === "number" && editing.dueAt <= tick;
  const snooze = () => {
    if (!editId) return;
    const later = Date.now() + 3_600_000;
    persistReminders(updateReminder(reminders, editId, { dueAt: later, allDay: false }));
    closeForm();
  };

  /* ---- list creation ---- */
  const [newListOpen, setNewListOpen] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [newListColor, setNewListColor] = useState<ColorName>("blue");
  const createList = () => {
    if (!newListName.trim()) return;
    persistLists(addList(lists, { name: newListName, color: newListColor }, Date.now()));
    setNewListName("");
    setNewListOpen(false);
  };
  const deleteList = (id: string) => {
    if (id === DEFAULT_LIST_ID) return;
    // Move that list's reminders to the inbox, then drop the list.
    persistReminders(reminders.map((r) => (r.listId === id ? { ...r, listId: DEFAULT_LIST_ID } : r)));
    persistLists(removeList(lists, id));
    if (sel.kind === "list" && sel.id === id) setSel({ kind: "smart", view: "all" });
  };

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
    v === "all" ? c.total : v === "today" ? c.today : v === "scheduled" ? c.scheduled : v === "flagged" ? c.flagged : c.completed;
  const smartView = (v: SmartView) => smartLabel(v);

  const selTitle = selIsSmart ? smartView(sel.view) : listNameOf(lists, sel.id, inboxLabel);
  const dueWords = { today: t("reminder.today"), tomorrow: t("reminder.tomorrow"), yesterday: t("reminder.yesterday") };
  const listColor = (id: string) => {
    const l = lists.find((x) => x.id === id);
    return l ? DOT[l.color] : DOT.blue;
  };

  return (
    <div className="flex h-full flex-col">
      {/* list chips */}
      <div className="flex shrink-0 gap-1.5 overflow-x-auto px-3 py-2">
        {SMART_VIEWS.map((v) => (
          <button
            key={v}
            onClick={() => setSel({ kind: "smart", view: v })}
            aria-pressed={selIsSmart && sel.view === v}
            className={selIsSmart && sel.view === v ? "shrink-0 rounded-full bg-accent px-3 py-1 text-xs text-white" : "shrink-0 rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"}
          >
            {smartLabel(v)}
            {v !== "completed" && <span className="opacity-60"> {smartCount(v)}</span>}
          </button>
        ))}
        <span className="mx-1 h-5 w-px shrink-0 self-center bg-neutral-300 dark:bg-neutral-600" />
        {lists.map((l) => (
          <button
            key={l.id}
            onClick={() => setSel({ kind: "list", id: l.id })}
            aria-pressed={sel.kind === "list" && sel.id === l.id}
            className={sel.kind === "list" && sel.id === l.id ? "shrink-0 rounded-full bg-accent px-3 py-1 text-xs text-white" : "shrink-0 rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"}
          >
            <span className={sel.kind === "list" && sel.id === l.id ? "" : DOT[l.color]}>● </span>
            {l.custom ? l.name : inboxLabel}
            <span className="opacity-60"> {pendingOf(reminders, l.id).length}</span>
          </button>
        ))}
        <button
          onClick={() => setNewListOpen((o) => !o)}
          className="shrink-0 rounded-full bg-neutral-200 px-2 py-1 text-xs dark:bg-neutral-700"
          aria-label={t("reminder.newList")}
        >
          ＋
        </button>
      </div>
      {/* new-list creator */}
      {newListOpen && (
        <div className="mx-3 mb-1 shrink-0">
          <div className={GROUP}>
            <div className={ROW}>
              <input
                autoFocus
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createList();
                }}
                placeholder={t("reminder.listName")}
                aria-label={t("reminder.listName")}
                className={FIELD}
              />
              <button onClick={createList} disabled={!newListName.trim()} className={btn("accent", "sm")}>
                {t("reminder.create")}
              </button>
            </div>
            <div className={SUB} />
            <div className="flex flex-wrap gap-1.5 px-4 py-2.5">
              {COLOR_NAMES.map((col) => (
                <button
                  key={col}
                  onClick={() => setNewListColor(col)}
                  aria-label={col}
                  className={
                    "grid h-6 w-6 place-items-center rounded-full text-xs " +
                    DOT[col] +
                    (newListColor === col ? " ring-2 ring-neutral-400" : "")
                  }
                >
                  ●
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* active list header */}
      <div className="flex shrink-0 items-center gap-2 px-4 pb-1 pt-1">
        <span className="truncate text-lg font-semibold text-neutral-800 dark:text-neutral-100">{selTitle}</span>
        {!selIsSmart && !searching && (
          <span className="shrink-0 text-xs opacity-50">
            {shown.length} / {pendingOf(reminders, sel.id).length}
          </span>
        )}
        {!selIsSmart && sel.id !== DEFAULT_LIST_ID && !searching && (
          <button
            onClick={() => deleteList(sel.id)}
            className="shrink-0 text-xs text-danger"
            aria-label={t("reminder.deleteList")}
          >
            {t("reminder.deleteList")}
          </button>
        )}
        <button
          onClick={() => {
            setSearchOpen((o) => !o);
            if (searchOpen) setQuery("");
          }}
          aria-pressed={searchOpen}
          aria-label={t("reminder.search")}
          title={t("reminder.search")}
          className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-full bg-neutral-200/70 text-sm dark:bg-neutral-700/70"
        >
          {searchOpen ? "✕" : "🔍"}
        </button>
      </div>

      {/* search field (filters the current view by title / notes) */}
      {searchOpen && (
        <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl bg-black/5 px-2.5 py-1 ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10">
            <span className="opacity-50">🔍</span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("reminder.search")}
              aria-label={t("reminder.search")}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-black/30 dark:placeholder:text-white/30"
            />
            {searching && (
              <span className="shrink-0 text-[10px] text-accent">
                {t("reminder.matches", { n: shown.length })}
              </span>
            )}
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label={t("reminder.clear")}
                className="shrink-0 text-neutral-400"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}

      {/* rows */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        <div className={GROUP}>
          {shown.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm opacity-50">
              {selIsCompleted
                ? t("reminder.completedEmpty")
                : searching
                  ? t("reminder.noMatch")
                  : t("reminder.empty")}
            </p>
          ) : (
            shown.map((r, i) => (
              <div key={r.id}>
                {i > 0 && <div className={SUB} />}
                <ReminderRow
                  r={r}
                  now={tick}
                  showListTag={selIsSmart}
                  listTag={listNameOf(lists, r.listId, inboxLabel)}
                  listTagColor={listColor(r.listId)}
                  dueWords={dueWords}
                  overduePrefix={t("reminder.overdue")}
                  onToggle={() => persistReminders(toggleComplete(reminders, r.id, Date.now()))}
                  onOpen={() => openEdit(r)}
                />
              </div>
            ))
          )}

          {/* collapsible per-list 已完成 section (mirrors iOS "show completed") */}
          {!selIsSmart && listCompleted.length > 0 && (
            <>
              <div className={SUB} />
              <button
                onClick={() => setShowCompleted((s) => !s)}
                aria-pressed={showCompleted}
                className={ROW + " cursor-pointer"}
              >
                <span className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
                  <span className="transition-transform">{showCompleted ? "▾" : "▸"}</span>
                  <span className="opacity-80">{`${t("reminder.completed")} (${listCompleted.length})`}</span>
                </span>
              </button>
              {showCompleted &&
                listCompleted.map((r) => (
                  <div key={r.id}>
                    <div className={SUB} />
                    <ReminderRow
                      r={r}
                      now={tick}
                      showListTag={false}
                      listTag=""
                      listTagColor=""
                      dueWords={dueWords}
                      overduePrefix={t("reminder.overdue")}
                      onToggle={() => persistReminders(toggleComplete(reminders, r.id, Date.now()))}
                      onOpen={() => openEdit(r)}
                    />
                  </div>
                ))}
            </>
          )}
        </div>
      </div>

      {/* compose / edit form */}
      {!selIsCompleted && (
        <div className="shrink-0 border-t border-neutral-200/70 px-3 py-2 dark:border-neutral-800">
          {!formOpen ? (
            <div className="flex items-center gap-2">
              <button onClick={openNew} className="min-w-0 flex-1 rounded-xl px-3 py-2 text-left text-[15px] text-accent">
                ＋ {t("reminder.new")}
              </button>
              {!searching && baseShown.length > 0 && (
                <button
                  onClick={completeAllVisible}
                  className="shrink-0 rounded-full bg-accent/15 px-3 py-2 text-xs text-accent"
                >
                  ✓ {t("reminder.completeAll")} ({baseShown.length})
                </button>
              )}
            </div>
          ) : (
            <div className="max-h-[46vh] overflow-y-auto">
              <div className={GROUP}>
                <div className="px-4 py-2">
                  <input
                    autoFocus
                    value={draft.title}
                    onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commit();
                    }}
                    placeholder={t("reminder.titlePlaceholder")}
                    aria-label={t("reminder.titlePlaceholder")}
                    className="w-full text-[15px] outline-none"
                  />
                  <input
                    value={draft.notes}
                    onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                    placeholder={t("reminder.notesPlaceholder")}
                    aria-label={t("reminder.notesPlaceholder")}
                    className="mt-0.5 w-full text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                  />
                  {/* schedule block */}
                  {showSchedule && (
                    <div className="mt-2 space-y-2 rounded-xl bg-black/5 p-2 dark:bg-white/10">
                      <div className="flex items-center gap-2">
                        <span className="w-10 shrink-0 text-xs opacity-60">{t("reminder.date")}</span>
                        <input
                          type="date"
                          value={draft.dateStr}
                          onChange={(e) => setDraft((d) => ({ ...d, dateStr: e.target.value }))}
                          className="min-w-0 flex-1 rounded-lg bg-white/70 px-2 py-1 text-xs outline-none dark:bg-neutral-900/70"
                        />
                        {draft.dateStr && (
                          <button
                            onClick={() => setDraft((d) => ({ ...d, dateStr: "", allDay: false }))}
                            className="shrink-0 rounded-full bg-neutral-300 px-2 py-0.5 text-[10px] dark:bg-neutral-700"
                          >
                            {t("reminder.clear")}
                          </button>
                        )}
                      </div>
                      {!draft.allDay && (
                        <div className="flex items-center gap-2">
                          <span className="w-10 shrink-0 text-xs opacity-60">{t("reminder.time")}</span>
                          <input
                            type="time"
                            value={draft.timeStr}
                            onChange={(e) => setDraft((d) => ({ ...d, timeStr: e.target.value }))}
                            className="rounded-lg bg-white/70 px-2 py-1 text-xs outline-none dark:bg-neutral-900/70"
                          />
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-xs opacity-60">{t("reminder.allDay")}</span>
                        <Switch
                          on={draft.allDay}
                          onToggle={() => setDraft((d) => ({ ...d, allDay: !d.allDay }))}
                          label={t("reminder.allDay")}
                        />
                      </div>
                      {canSnooze && (
                        <button
                          onClick={snooze}
                          className="w-full rounded-lg bg-accent/15 px-2 py-1.5 text-xs text-accent"
                        >
                          ⏰ {t("reminder.snooze")}
                        </button>
                      )}
                    </div>
                  )}
                  {/* priority / flag / list rows */}
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="shrink-0 text-xs opacity-60">{t("reminder.priority")}</span>
                      <div className="flex flex-wrap justify-end gap-1">
                        {PRIORITY_LABELS.map((k, p) => (
                          <button
                            key={k}
                            onClick={() => setDraft((d) => ({ ...d, priority: p as Priority }))}
                            aria-pressed={draft.priority === p}
                            className={
                              "rounded-full px-2 py-0.5 text-[10px] " +
                              (draft.priority === p
                                ? "bg-accent text-white"
                                : "bg-neutral-200 dark:bg-neutral-700")
                            }
                          >
                            {t(k)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs opacity-60">{t("reminder.flag")}</span>
                      <Switch
                        on={draft.flagged}
                        onToggle={() => setDraft((d) => ({ ...d, flagged: !d.flagged }))}
                        label={t("reminder.flag")}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs opacity-60">{t("reminder.list")}</span>
                      <select
                        value={draft.listId}
                        onChange={(e) => setDraft((d) => ({ ...d, listId: e.target.value }))}
                        className="max-w-[60%] rounded-lg bg-neutral-200 px-1 py-0.5 text-xs outline-none dark:bg-neutral-700"
                      >
                        {lists.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.custom ? l.name : inboxLabel}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
                <div className={SUB} />
                <div className="flex items-center justify-between gap-2 px-4 py-2">
                  <div className="flex gap-1.5">
                    <button onClick={closeForm} className={btn("neutral", "sm")}>
                      {t("reminder.cancel")}
                    </button>
                    {editId && (
                      <button
                        onClick={() => {
                          if (editId) persistReminders(removeReminder(reminders, editId));
                          closeForm();
                        }}
                        className={btn("danger", "sm")}
                      >
                        {t("reminder.delete")}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setShowSchedule((s) => !s)} className={btn("neutral", "sm")}>
                      {t("reminder.schedule")}
                    </button>
                    <button onClick={commit} disabled={!draft.title.trim()} className={btn("accent", "sm")}>
                      {editId ? t("reminder.save") : t("reminder.add")}
                    </button>
                  </div>
                </div>

                </div>
              </div>
          )}
        </div>
      )}

    </div>
  );
}

