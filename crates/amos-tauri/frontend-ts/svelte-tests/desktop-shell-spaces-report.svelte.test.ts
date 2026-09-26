/**
 * desktop-shell-spaces-report.svelte.test.ts — the desktop shell's chord-driven Spaces
 * switches must report the **whole** answer the host gave them (REQ-A1825).
 *
 * What this pins, in the user's language: `⌃←` / `⌃→`, the trackpad swipe and `⌃1…9` all switch
 * Spaces, and when the host says *"switched, but these windows did not follow"* or *refuses*
 * with a typed reason, the shell says so — in the same words the Spaces panel and Mission
 * Control use. The defect this covers is that these two call sites were the only Spaces owners
 * in the repo that read neither half: they dropped `SpaceSwitchReport.hide_failed` /
 * `show_failed` on the floor and, on refusal, wrote a hand-written English sentence naming the
 * raw `amos.*` code instead of going through `lib/spaces.ts::spacesFailure` (the one
 * code→sentence rule, F-SH-577).
 *
 * The observation channel is the bounded diagnostic ledger (`lib/debugLog.ts`), windowed **by
 * mark** (`seq`), never by length — the ledger is a ring, so a length delta is not "what
 * arrived" (REQ-A853). The `backend` area row that `invoke` itself writes on a throw is
 * deliberately filtered out: this file is about what the **shell** reported, not the bridge.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import { resetDesktopFeaturesForTest } from "../src/lib/desktopFeatures";
import { clearDiag, recentDiag, type DiagEntry } from "../src/lib/debugLog";
import { setLocale, t } from "../src/svelte/locale.svelte";
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

type SwitchAnswer =
  | { kind: "report"; hideFailed: number; showFailed: number }
  | { kind: "refuse"; code: string };

/**
 * A fake host whose `spaces_switch` answer is scripted. Everything else the shell reads at boot
 * (or that the swipe path needs) answers honestly so the only signal in the ledger is the one
 * this file is measuring.
 */
function installHost(spaceCount: number, active: number, answer: SwitchAnswer) {
  const switches: number[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows: [] };
      if (cmd === "desktop_features_disabled") return [];
      if (cmd === "stage_snapshot") return { enabled: false, on_stage: [], parked: [] };
      if (cmd === "spaces_list") {
        return Array.from({ length: spaceCount }, (_, i) => ({
          id: `space-${i}`,
          name: `Space ${i}`,
          windows: [],
        }));
      }
      if (cmd === "spaces_active") return active;
      if (cmd === "spaces_switch") {
        const index = (args as { index?: number } | undefined)?.index ?? -1;
        switches.push(index);
        if (answer.kind === "refuse") {
          throw { code: answer.code, message: "scripted refusal" };
        }
        return {
          index,
          hide_failed: Array.from({ length: answer.hideFailed }, (_, i) => ({
            label: `win-${i}`,
            reason: "gone",
          })),
          show_failed: Array.from({ length: answer.showFailed }, (_, i) => ({
            label: `win-s-${i}`,
            reason: "gone",
          })),
        };
      }
      if (isBootFact(cmd)) return null;
      return null;
    },
    listen: async () => () => {},
  };
  return switches;
}

/** One horizontal swipe sample, enough to cross the tracker's threshold as a "previous". */
function swipe(root: HTMLElement): void {
  for (const deltaX of [50, 50, 50, 150]) {
    const ev = new WheelEvent("wheel", {
      deltaX,
      deltaY: 0,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, "ctrlKey", { value: false, configurable: true });
    root.dispatchEvent(ev);
  }
}

/** A `⌃<digit>` chord on the window, where `1` addresses Space 0. */
function directChord(digit: string): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: digit, ctrlKey: true, bubbles: true, cancelable: true }),
  );
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

async function mountDesktop(): Promise<HTMLElement> {
  const { container } = render(DesktopShell);
  await tick();
  await settle();
  return container.querySelector('[data-testid="desktop-shell-root"]') as HTMLElement;
}

describe("DesktopShell.svelte — a Spaces switch reports its whole answer", () => {
  test("a swipe that switched but left windows behind says so, in the shared sentence", async () => {
    installHost(3, 0, { kind: "report", hideFailed: 1, showFailed: 0 });
    const root = await mountDesktop();
    expect(root).toBeTruthy();

    const mark = markNow();
    swipe(root);
    await settle();

    const rows = shellRowsAfter(mark);
    expect(rows.map((r) => r.msg)).toContain(t("spaces.switchPartial", { n: 1 }));
  });

  test("a refused swipe names the host's typed reason, not a hand-written English string", async () => {
    installHost(3, 0, { kind: "refuse", code: "amos.spaces.lock_failed" });
    const root = await mountDesktop();
    expect(root).toBeTruthy();

    const mark = markNow();
    swipe(root);
    await settle();

    const msgs = shellRowsAfter(mark).map((r) => r.msg);
    expect(msgs).toContain(t("spaces.errorLockFailed"));
    expect(msgs.join("\n")).not.toContain("Failed to switch to space");
    expect(msgs.join("\n")).not.toContain("refused");
  });

  test("⌃2 (the direct chord) reports the same refusal the swipe path does", async () => {
    installHost(3, 0, { kind: "refuse", code: "amos.spaces.index_out_of_bounds" });
    const root = await mountDesktop();
    expect(root).toBeTruthy();

    const mark = markNow();
    directChord("2");
    await settle();

    const msgs = shellRowsAfter(mark).map((r) => r.msg);
    expect(msgs).toContain(t("spaces.errorOutOfBounds"));
    expect(msgs.join("\n")).not.toContain("refused");
  });
});
