/**
 * spotlightSearch.ts — what the desktop Spotlight lists, and in what order (REQ-A458).
 *
 * The desktop overlay used to search **only** apps (`results: AppEntry[]`, a substring match on
 * name/id). macOS's Spotlight answers three different questions in one box — "what is this?", "what
 * is this worth?", "where is this?" — and the shell already owns an engine for the middle one (the
 * Calculator app) and a matcher for the last one (`lib/files.ts::searchFiles`). What was missing
 * was the **rule for putting them in one list**, which is what this module is: pure, so the order
 * and the caps are testable without a DOM.
 *
 * Deliberately *not* here: the search itself. Apps are matched by the caller (it owns the
 * translated names), files by `searchFiles` (the domain matcher), the calculation by `calcQuery`.
 * This module only **ranks and bounds** what those produce — one place, so the overlay and its
 * tests cannot disagree about what a query shows.
 */

/** What a row is. The overlay renders one badge per kind, so the user knows what Enter will do. */
export type SpotlightKind = "calc" | "app" | "file";

export interface SpotlightRow {
  kind: SpotlightKind;
  /** What Enter acts on: an app id, a file id, or the computed value. */
  id: string;
  /** A stable list key (ids repeat across kinds — a file can share an app's name). */
  key: string;
  title: string;
  /** A second line (where a file lives, what a calculation was), or `null`. */
  subtitle: string | null;
  /** The app glyph; `null` for rows that render their own icon. */
  icon: string | null;
}

export interface SpotlightInputs {
  /** Apps matching the query, already localized and **in the order the caller wants them**. */
  apps: ReadonlyArray<{ id: string; name: string; icon: string }>;
  /** File hits from the domain matcher, already projected to what a row shows. */
  files: ReadonlyArray<{ id: string; name: string; subtitle: string | null }>;
  /** The computed value of the query, or `null` when it is not a calculation. */
  calculation: string | null;
  /** How many rows the query produced before the caps (for the "还有 N 项" line). */
}

/**
 * Caps. Both are **bounds, not taste** (Power of 10 rule 3): the list is rendered inside a fixed
 * 400 px panel, and an unbounded result list is how a search box becomes a scrollbar with a
 * text field attached. The caller learns what was cut for the "还有 N 项" line, so a bounded list
 * never silently hides a match.
 */
export const SPOTLIGHT_MAX_APPS = 6;
export const SPOTLIGHT_MAX_FILES = 4;

/** What the query produced, and what the caps left out. */
export interface SpotlightResults {
  rows: SpotlightRow[];
  /** Matches the caps cut, per kind — the UI must say so when non-zero. */
  hidden: { apps: number; files: number };
}

/**
 * Build the list for `query`.
 *
 * Order is macOS's: the calculation first (it is the one answer that is *about the query itself*),
 * then the apps the user can name, then the files they were probably looking for. An empty or
 * whitespace-only query produces an empty list — the panel shows its hint, not an arbitrary
 * "everything" list.
 */
export function buildSpotlightResults(query: string, inputs: SpotlightInputs): SpotlightResults {
  const q = query.trim();
  if (q === "") return { rows: [], hidden: { apps: 0, files: 0 } };

  const rows: SpotlightRow[] = [];
  if (inputs.calculation !== null) {
    rows.push({
      kind: "calc",
      id: inputs.calculation,
      key: `calc:${q}`,
      title: inputs.calculation,
      subtitle: q,
      icon: null,
    });
  }

  const apps = inputs.apps.slice(0, SPOTLIGHT_MAX_APPS);
  for (const a of apps) {
    rows.push({ kind: "app", id: a.id, key: `app:${a.id}`, title: a.name, subtitle: null, icon: a.icon });
  }

  const files = inputs.files.slice(0, SPOTLIGHT_MAX_FILES);
  for (const f of files) {
    rows.push({
      kind: "file",
      id: f.id,
      key: `file:${f.id}`,
      title: f.name,
      subtitle: f.subtitle,
      icon: null,
    });
  }

  return {
    rows,
    hidden: {
      apps: Math.max(0, inputs.apps.length - apps.length),
      files: Math.max(0, inputs.files.length - files.length),
    },
  };
}