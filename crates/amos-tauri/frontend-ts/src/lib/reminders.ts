/* Reminders domain kernel (iOS-style 提醒事项) — pure + headless-friendly.
 *
 * Data is persisted by the UI through the shared amos.* store (localStorage +
 * the Rust store bridge). Everything here is a pure function over plain arrays
 * so it can be unit-tested without a DOM and reused by future backends.
 *
 * "Smart views" mirror iOS: 全部 / 今天 / 计划 / 旗标 / 已完成. Custom lists are
 * ordinary colour-coded folders; reminders always belong to exactly one list.
 */

export type Priority = 0 | 1 | 2 | 3; // none | low | medium | high

export interface Reminder {
  id: string;
  title: string;
  /** Owning list id (DEFAULT_LIST_ID = the built-in inbox list). */
  listId: string;
  priority: Priority;
  flagged: boolean;
  createdAt: number;
  notes?: string;
  /** Scheduled instant (epoch ms). Absent = not scheduled. */
  dueAt?: number;
  /** Due for a whole day — time of day is not important. */
  allDay?: boolean;
  completed?: boolean;
  completedAt?: number;
}

export interface ReminderList {
  id: string;
  /** Built-in inbox has a localized name; user lists are plain text + colour. */
  custom: boolean;
  name: string;
  color: ColorName;
  createdAt: number;
}

/** iOS-like list palette. */
export const COLOR_NAMES = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "indigo",
  "purple",
  "pink",
  "gray",
] as const;
export type ColorName = (typeof COLOR_NAMES)[number];

export const REMINDERS_KEY = "amos.reminders";
export const LISTS_KEY = "amos.reminderLists";
export const REMINDER_CAP = 400;
export const DEFAULT_LIST_ID = "inbox";
export const DAY_MS = 86_400_000;

export const PRIORITIES: readonly Priority[] = [0, 1, 2, 3];

// Process-local monotonic counter so ids stay unique even for two reminders
// created in the same millisecond (deterministic within a process for tests).
let seq = 0;
export function makeId(now: number): string {
  seq += 1;
  return `${now.toString(36)}-${seq}`;
}

/* ---- date helpers (local time, ms-based so they are trivial to fake) ---- */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}
/** Whole-day difference between `a` and `b` (positive when `a` is later). */
export function dayDiff(a: number, b: number): number {
  return Math.round((startOfDay(a) - startOfDay(b)) / DAY_MS);
}

export function isComplete(r: Reminder): boolean {
  return !!r.completed;
}
/** True when the reminder is due at or before `now` and still pending. */
export function isOverdueNow(r: Reminder, now: number): boolean {
  return !isComplete(r) && typeof r.dueAt === "number" && r.dueAt <= now;
}
/* ---- corruption guards: tolerate malformed/bogus persisted data ---- */
function toPriority(v: unknown): Priority {
  return v === 0 || v === 1 || v === 2 || v === 3 ? v : 0;
}
function toColor(v: unknown): ColorName {
  return (COLOR_NAMES as readonly string[]).includes(v as string)
    ? (v as ColorName)
    : "blue";
}

export function normalizeReminders(v: unknown): Reminder[] {
  if (!Array.isArray(v)) return [];
  const out: Reminder[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.title !== "string") continue;
    const title = (o.title as string).trim();
    if (!title) continue;
    const createdAt =
      typeof o.createdAt === "number" && Number.isFinite(o.createdAt)
        ? o.createdAt
        : typeof o.ts === "number" && Number.isFinite(o.ts)
          ? (o.ts as number)
          : 0;
    const baseId = typeof o.id === "string" && o.id ? o.id : `${createdAt.toString(36)}-${out.length}`;
    let id = baseId;
    let k = 1;
    while (seen.has(id)) id = `${baseId}-${k++}`;
    seen.add(id);
    const r: Reminder = {
      id,
      title,
      listId: typeof o.listId === "string" && o.listId ? o.listId : DEFAULT_LIST_ID,
      priority: toPriority(o.priority),
      flagged: o.flagged === true,
      createdAt,
    };
    if (typeof o.notes === "string") r.notes = o.notes;
    if (typeof o.dueAt === "number" && Number.isFinite(o.dueAt)) r.dueAt = o.dueAt;
    if (o.allDay === true) r.allDay = true;
    if (o.completed === true) {
      r.completed = true;
      if (typeof o.completedAt === "number" && Number.isFinite(o.completedAt)) r.completedAt = o.completedAt;
      else r.completedAt = createdAt;
    }
    out.push(r);
  }
  return out.length > REMINDER_CAP ? out.slice(out.length - REMINDER_CAP) : out;
}

export function normalizeLists(v: unknown): ReminderList[] {
  if (!Array.isArray(v)) return [];
  const out: ReminderList[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id : "";
    if (!id || seen.has(id)) continue;
    const custom = o.custom === true;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!custom && id === DEFAULT_LIST_ID && !name) {
      // built-in inbox present but unnamed — fine, UI localizes its name.
    } else if (!name) {
      continue; // custom lists need a name
    }
    seen.add(id);
    out.push({
      id,
      custom,
      name,
      color: toColor(o.color),
      createdAt:
        typeof o.createdAt === "number" && Number.isFinite(o.createdAt) ? o.createdAt : 0,
    });
  }
  return out;
}
/* ---- seeds (demo data shown on first run, like other AmOS apps) ---- */
export function seedLists(now: number): ReminderList[] {
  const inbox: ReminderList = {
    id: DEFAULT_LIST_ID,
    custom: false,
    name: "",
    color: "blue",
    createdAt: now,
  };
  return [
    inbox,
    { id: "work", custom: true, name: "工作", color: "indigo", createdAt: now + 1 },
    { id: "life", custom: true, name: "生活", color: "green", createdAt: now + 2 },
  ];
}

export function seedReminders(now: number): Reminder[] {
  const day = startOfDay(now);
  const base: Array<Omit<Reminder, "id">> = [
    { title: "给手机充电", listId: "life", priority: 1, flagged: false, createdAt: now, dueAt: day + 22 * 3_600_000, allDay: false },
    { title: "写周报", listId: "work", priority: 3, flagged: true, createdAt: now + 1, notes: "整理本周进展", dueAt: day + 3 * DAY_MS, allDay: false },
    { title: "去健身", listId: "life", priority: 0, flagged: false, createdAt: now + 2, dueAt: day + DAY_MS, allDay: true },
    { title: "跟进客户邮件", listId: "work", priority: 2, flagged: false, createdAt: now + 3, dueAt: day + 5 * DAY_MS, allDay: false },
    { title: "阅读一篇论文", listId: DEFAULT_LIST_ID, priority: 0, flagged: false, createdAt: now + 4 },
    { title: "买牛奶", listId: "life", priority: 1, flagged: false, createdAt: now - DAY_MS, completed: true, completedAt: now - 3_600_000 },
  ];
  return base.map((r) => ({ ...r, id: makeId(now) }));
}

/* ---- CRUD (immutable array helpers) ---- */
function patchById(list: Reminder[], id: string, fn: (r: Reminder) => Reminder): Reminder[] {
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return list;
  return list.map((r) => (r.id === id ? fn(r) : r));
}

/** Append a new reminder (iOS adds below the last row, above "new reminder").
 * Refuses a blank title and trims surrounding whitespace. */
export function addReminder(list: Reminder[], draft: Omit<Reminder, "id" | "createdAt" | "completed" | "completedAt">, now: number): Reminder[] {
  const title = draft.title.trim();
  if (!title) return list;
  const r: Reminder = { ...draft, title, id: makeId(now), createdAt: now };
  return [...list, r];
}

export function updateReminder(list: Reminder[], id: string, patch: Partial<Reminder>): Reminder[] {
  return patchById(list, id, (r) => ({ ...r, ...patch }));
}

export function complete(list: Reminder[], id: string, now: number): Reminder[] {
  return patchById(list, id, (r) => ({ ...r, completed: true, completedAt: now }));
}
export function uncomplete(list: Reminder[], id: string): Reminder[] {
  return patchById(list, id, (r) => ({ ...r, completed: undefined, completedAt: undefined }));
}
export function toggleComplete(list: Reminder[], id: string, now: number): Reminder[] {
  const r = list.find((x) => x.id === id);
  if (!r) return list;
  return isComplete(r) ? uncomplete(list, id) : complete(list, id, now);
}
export function removeReminder(list: Reminder[], id: string): Reminder[] {
  return list.filter((r) => r.id !== id);
}
/* ---- list management ---- */
export function addList(lists: ReminderList[], draft: { name: string; color: ColorName }, now: number): ReminderList[] {
  const name = draft.name.trim();
  if (!name) return lists;
  return [...lists, { id: makeId(now), custom: true, name, color: draft.color, createdAt: now }];
}
export function removeList(lists: ReminderList[], id: string): ReminderList[] {
  return lists.filter((l) => l.id !== id);
}

/* ---- smart views ---- */
export type SmartView = "all" | "today" | "scheduled" | "flagged" | "completed";
export const SMART_VIEWS: readonly SmartView[] = ["all", "today", "scheduled", "flagged", "completed"];

export interface ViewCounts {
  total: number;
  today: number;
  scheduled: number;
  flagged: number;
  completed: number;
  /** Due/overdue still pending — drives the home-screen badge. */
  due: number;
}

export function counts(reminders: Reminder[], now: number): ViewCounts {
  let total = 0;
  let today = 0;
  let scheduled = 0;
  let flagged = 0;
  let completed = 0;
  let due = 0;
  const eod = startOfDay(now) + DAY_MS;
  for (const r of reminders) {
    if (isComplete(r)) {
      completed++;
      continue;
    }
    total++;
    if (r.flagged) flagged++;
    if (typeof r.dueAt === "number") {
      scheduled++;
      if (r.dueAt < eod) today++; // due today or earlier (overdue still counts to Today)
      if (r.dueAt <= now) due++; // reached/overdue → badge
    }
  }
  return { total, today, scheduled, flagged, completed, due };
}

/** Smart-view memberships (pure selectors returning copies). */
export function remindersInSmart(reminders: Reminder[], view: SmartView, now: number): Reminder[] {
  const eod = startOfDay(now) + DAY_MS;
  const pending = (r: Reminder) => !isComplete(r);
  const byDue = (a: Reminder, b: Reminder) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity);
  const byCompleted = (a: Reminder, b: Reminder) => (b.completedAt ?? 0) - (a.completedAt ?? 0);
  switch (view) {
    case "all":
      return reminders.filter(pending);
    case "today":
      return reminders.filter((r) => pending(r) && typeof r.dueAt === "number" && r.dueAt < eod).sort(byDue);
    case "scheduled":
      return reminders.filter((r) => pending(r) && typeof r.dueAt === "number").sort(byDue);
    case "flagged":
      return reminders.filter((r) => pending(r) && r.flagged);
    case "completed":
      return reminders.filter(isComplete).sort(byCompleted);
  }
}

/** Incomplete reminders of one list (insertion order). */
export function pendingOf(list: Reminder[], listId: string): Reminder[] {
  return list.filter((r) => !isComplete(r) && r.listId === listId);
}
export function completedOf(list: Reminder[], listId: string): Reminder[] {
  return list
    .filter((r) => isComplete(r) && r.listId === listId)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
}

/** Case-insensitive substring search over title + notes; empty query passes all. */
export function searchReminders(list: Reminder[], query: string): Reminder[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (r) => r.title.toLowerCase().includes(q) || (r.notes ?? "").toLowerCase().includes(q),
  );
}
/* ---- human-facing formatting (locale words injected from the UI) ---- */
export interface DueWords {
  today: string;
  tomorrow: string;
  yesterday: string;
}
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** Short, locale-neutral calendar date (adds the year when it differs). */
function fmtDate(ms: number, now: number): string {
  const d = new Date(ms);
  const n = new Date(now);
  const m = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === n.getFullYear() ? m : `${d.getFullYear()}/${m}`;
}

/** A human "when" label for a scheduled reminder (whole-day vs with a time). */
export function formatDueAt(ms: number, allDay: boolean | undefined, now: number, w: DueWords): string {
  const dd = dayDiff(ms, now);
  const datePart =
    dd === 0 ? w.today : dd === 1 ? w.tomorrow : dd === -1 ? w.yesterday : fmtDate(ms, now);
  if (allDay) return datePart;
  return `${datePart} ${fmtTime(ms)}`;
}
/** A reminder due on a previous day that is still pending (iOS marks it red). */
export function isPastDue(r: Reminder, now: number): boolean {
  return !isComplete(r) && typeof r.dueAt === "number" && r.dueAt < startOfDay(now);
}


