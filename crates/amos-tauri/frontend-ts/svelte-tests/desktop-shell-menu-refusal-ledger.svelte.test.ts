/**
 * desktop-shell-menu-refusal-ledger.svelte.test.ts — a refused **menu-row** action on the
 * desktop goes into the shell's diagnostic ledger, not only into a `console.warn` (REQ-A1846).
 *
 * What this pins, in the user's language: pressing `⌘,` (or picking Window ▸ Zoom, or Help ▸
 * Amos Help) while the host refuses leaves no trace a person can retrieve on the device. The
 * ledger (`lib/debugLog.ts`, bounded ring, read back by Settings ▸ AI) is the shell's one
 * surface for exactly that — `debugLog.ts`'s own header names the alternative ("every failure
 * path inventing its own `console.warn` that nobody can retrieve later") as the thing it
 * replaces — and the shell's **chord** path for the same intent already reports there
 * (`DesktopShell.reportIntentOutcome` → `refusedChordMessage` → `amosWarn("shell", …)`).
 *
 * Why the two doors matter on macOS: `crates/amos-tauri/src/menu.rs` gives the native
 * Preferences item the `CmdOrCtrl+,` accelerator, so on macOS the key event is the OS's and
 * what fires is `menu.preferences` — the menu door. (On Windows/Linux there is no native menu
 * bar, so the shell's own chord binding is the door and its report already lands in the
 * ledger.) The menu door used to report through `console.warn` alone: on a device with no
 * devtools console that is silence, and it is gone after a reload.
 *
 * The observation channel is the bounded diagnostic ledger, windowed **by mark** (`seq`), never
 * by length — the ring is bounded, so a length delta is empty exactly when the ledger is
 * busiest (REQ-A853). The `backend` area row `invoke` itself writes on a throw is deliberately
 * filtered out: this file measures what the **shell** reported.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import { resetDesktopFeaturesForTest } from "../src/lib/desktopFeatures";
import { clearDiag, recentDiag, type DiagEntry } from "../src/lib/debugLog";
import { setLocale } from "../src/svelte/locale.svelte";
import { isBootFact } from "./shellHostBootFacts";

const settle = () => new Promise((r) => setTimeout(r, 40));

const DESKTOP_SNAPSHOT = {
  screen_w: 1496,
  screen_h: 882,
  split: null,
  candidates: [],
  form: "desktop",
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
  rail_width: 0,
};

/**
 * A fake host whose `wm_open` refuses with a typed code, plus a captured `menu-event`
 * subscription so a case can deliver the id the host's native menu bar would deliver.
 */
function installHost(code: string): (id: string) => void {
  let deliver: ((id: string) => void) | null = null;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "wm_open") throw { code, message: "scripted refusal" };
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows: [] };
      if (cmd === "desktop_features_disabled") return [];
      if (cmd === "stage_snapshot") return { enabled: false, on_stage: [], parked: [] };
      if (cmd === "spaces_list") return [{ id: "space-0", name: "Space 0", windows: [] }];
      if (cmd === "spaces_active") return 0;
      if (isBootFact(cmd)) return null;
      return null;
    },
    listen: async (channel: string, cb: (e: { payload: unknown }) => void) => {
      if (channel === "menu-event") deliver = (id: string) => cb({ payload: id });
      return () => {};
    },
  };
  return (id: string) => deliver?.(id);
}

/** What the **shell** wrote to the ledger after `mark` — the bridge's own rows excluded. */
function shellRowsAfter(mark: number): DiagEntry[] {
  return recentDiag().filter((e) => e.seq > mark && e.area === "shell");
}

const markNow = () => recentDiag(1)[0]?.seq ?? 0;

beforeEach(() => {
  window.localStorage.clear();
  clearDiag();
  setLocale("zh");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  clearDiag();
  vi.restoreAllMocks();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  resetDesktopFeaturesForTest();
});

async function mountDesktop(): Promise<void> {
  render(DesktopShell);
  await tick();
  await settle();
}

describe("DesktopShell.svelte — a refused menu-row action reaches the ledger", () => {
  test("a refused Preferences open (⌘, on macOS) is recorded, not only console-warned", async () => {
    const fireMenu = installHost("amos.wm.window_cap");
    await mountDesktop();

    const mark = markNow();
    fireMenu("menu.preferences");
    await settle();

    const rows = shellRowsAfter(mark);
    expect(rows.map((r) => r.msg)).toContain("wm_open(settings) refused");
    expect(rows.map((r) => r.detail).join("\n")).toContain("amos.wm.window_cap");
  });

  test("the Amos Help row — the row beside it — is recorded the same way", async () => {
    const fireMenu = installHost("amos.wm.window_cap");
    await mountDesktop();

    const mark = markNow();
    fireMenu("menu.amos-help");
    await settle();

    const rows = shellRowsAfter(mark);
    expect(rows.map((r) => r.msg)).toContain("wm_open(settings) refused");
    expect(rows.map((r) => r.detail).join("\n")).toContain("amos.wm.window_cap");
  });
});
