/**
 * spotlight-search.svelte.test.ts — the desktop Spotlight's three kinds of row (REQ-A458).
 *
 * The ranking rule is pure and unit-tested (`src/__tests__/spotlightSearch.test.ts`) and the
 * calculator's own semantics are pinned in `src/__tests__/calculator.test.ts`. What these cases
 * pin is the **wiring**, one case per promise a row makes:
 *
 *   • a calculation reaches the clipboard (and says so), because the shell cannot seed the
 *     Calculator window with a value;
 *   • a file row queues the cross-window reveal **and** opens the Files window — a row that
 *     opened Files at the root would be a different promise;
 *   • a bare number or a malformed query produces no calculation row (no row beats a row that
 *     says nothing).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import SpotlightOverlay from "../src/svelte/SpotlightOverlay.svelte";
import { LAYOUT_KEY, readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { FILES_KEY, FILES_REVEAL_KEY } from "../src/lib/files";
import { zh } from "../src/i18n/locales/zh";

type Call = { cmd: string; args?: Record<string, unknown> };
let calls: Call[] = [];

function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "wm_layout_snapshot") {
        return {
          screen_w: 1496,
          screen_h: 882,
          split: null,
          candidates: [],
          form: "desktop",
          columns: 4,
          multi_window: true,
          free_resize: true,
          divider_gap: 8,
        };
      }
      if (cmd === "wm_windows") return { windows: [] };
      // The bridge answers a clipboard write with the stored entry (REQ: `null` = refused, so
      // answering `null` here would model a refusal).
      if (cmd === "clipboard_write") return { seq: 1, payload: { kind: "text", text: "7" } };
      if (cmd === "wm_open" || cmd === "wm_focus") return { windows: [] };
      return null;
    },
    listen: async () => () => {},
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

/** Type a query into the search field and let the derived results settle. */
async function search(container: HTMLElement, q: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
  await fireEvent.input(input, { target: { value: q } });
  await tick();
  await settle();
  return input;
}

const row = (container: HTMLElement, kind: string) =>
  container.querySelector<HTMLElement>(`[data-testid="spotlight-row-${kind}"]`);

beforeEach(() => {
  window.localStorage.clear();
  calls = [];
  installHost();
  writeStoreValue(LAYOUT_KEY, { page: ["clock"], dock: [], hidden: [] });
  writeStoreValue(FILES_KEY, [
    { id: "rep", type: "file", name: "报告.txt", content: "季度数字", ts: 3 },
    { id: "doc", type: "folder", name: "文档", ts: 2 },
  ]);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("SpotlightOverlay — calculation + file rows (REQ-A458)", () => {
  test("a calculation is listed first and goes to the clipboard, saying so", async () => {
    const { container } = render(SpotlightOverlay, { props: { onclose: () => {} } });
    await tick();
    const input = await search(container, "3+4");

    const calc = row(container, "calc");
    expect(calc, "a calculation row must appear").toBeTruthy();
    expect(calc!.textContent ?? "").toContain("7");
    expect(calc!.textContent ?? "").toContain(zh["desktop.spotlightKind.calc"]);

    await fireEvent.keyDown(input, { key: "Enter" });
    await settle();
    expect(
      calls.some((c) => c.cmd === "clipboard_write" && (c.args?.payload as { text?: string })?.text === "7"),
      "Enter on a calculation must copy the value",
    ).toBe(true);
    expect(container.querySelector('[data-testid="spotlight-notice"]')?.textContent ?? "").toContain(
      zh["desktop.spotlightCopied"],
    );
  });

  test("a file row queues the cross-window reveal and opens Files", async () => {
    const onclose = vi.fn();
    const { container } = render(SpotlightOverlay, { props: { onclose } });
    await tick();
    await search(container, "报告");

    const fileRow = row(container, "file");
    expect(fileRow, "a file hit must appear").toBeTruthy();
    expect(fileRow!.textContent ?? "").toContain("报告.txt");
    expect(fileRow!.textContent ?? "").toContain(zh["desktop.spotlightKind.file"]);
    // Where the hit lives is part of the row (a global search must say so): this one is at the
    // root, so the Files screen renders its own "root" label — no subtitle is invented here.
    expect(readStoreValue<{ id: string } | null>(FILES_REVEAL_KEY, null)).toBeNull();

    await fireEvent.click(fileRow!);
    await settle();
    expect(readStoreValue<{ id: string }>(FILES_REVEAL_KEY, { id: "" }).id).toBe("rep");
    expect(
      calls.some((c) => c.cmd === "wm_open" && c.args?.label === "files"),
      "the Files window must be opened",
    ).toBe(true);
    expect(onclose).toHaveBeenCalled();
  });

  test("a bare number or a malformed query yields NO calculation row", async () => {
    const { container } = render(SpotlightOverlay, { props: { onclose: () => {} } });
    await tick();
    await search(container, "42");
    expect(row(container, "calc")).toBeNull();
    await search(container, "abc");
    expect(row(container, "calc")).toBeNull();
    // A unit word is not arithmetic: the alphabet is the app's own key set, so "7 days" is a
    // search for text, not a calculation. (`1+` **is** one — the engine answers the accumulator,
    // which `src/__tests__/calculator.test.ts` pins on purpose.)
    await search(container, "7 days");
    expect(row(container, "calc")).toBeNull();
  });
});