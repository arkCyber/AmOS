/**
 * spotlight-panel.svelte.test.ts — Svelte CONTROLLED search overlay (Spotlight).
 *
 * Shell owns `open` (over propsBus "spotlight"); search text is local; choosing a
 * result emits 'open'(id)+'close'. Tests: default results, text filtering,
 * choose emits, closed renders nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import SpotlightPanel from "../src/svelte/SpotlightPanel.svelte";
import { propsChannel, resetPropsChannels, type PropsChannel } from "../src/svelte/propsBus";
import { contactsChannel, filesChannel, notesChannel, phoneChannel, settingsChannel } from "../src/svelte/appLinks";
import { resetShellState, surface } from "../src/svelte/shellState.svelte";
import { readStoreValue } from "../src/lib/amosStore";

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function. (`window.localStorage` is a per-access proxy, so the prototype
 * cannot be patched — the window property itself is replaced.)
 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

const bus = (): PropsChannel<{ open: boolean }> => propsChannel<{ open: boolean }>("spotlight");

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
});
afterEach(() => {
  resetPropsChannels();
  resetShellState();
});

async function renderOpen() {
  bus().set({ open: true });
  const { container } = render(SpotlightPanel);
  await tick();
  return container;
}

describe("SpotlightPanel.svelte (controlled via propsBus 'spotlight')", () => {
  test("renders search box and default results when open", async () => {
    const container = await renderOpen();
    expect(container.querySelector('input[placeholder]')).toBeTruthy();
    // "common.done" button present (localized via i18n) and at least one row.
    expect(container.querySelector("button")).toBeTruthy();
  });

  test("typing filters results to matches", async () => {
    const container = await renderOpen();
    const input = container.querySelector("input") as HTMLInputElement;
    // Type the zh title for clock ("时钟") — result rows filter to it.
    await fireEvent.input(input, { target: { value: "时" } });
    await tick();
    // With only "时" matched (clock/weather contain 时), fewer than the full list.
    expect(container.textContent ?? "").toContain("时");
  });

  test("choosing a result emits 'open' then 'close'", async () => {
    const container = await renderOpen();
    const events: [string, unknown][] = [];
    const off = bus().on((e, d) => events.push([e, d]));
    // First result row button (results are ordered by APPS).
    const row = container.querySelector("button[aria-label]") as HTMLButtonElement | null;
    expect(row).toBeTruthy();
    await fireEvent.click(row!);
    const openDetail = events.find(([e]) => e === "open")?.[1];
    expect(typeof openDetail).toBe("string");
    expect(events.map(([e]) => e)).toContain("close");
    off();
  });

  test("a non-empty query offers the note action; an empty one does not", async () => {
    const container = await renderOpen();
    // Nothing typed yet ⇒ no action rows (there is nothing to save).
    expect(container.querySelector('button[aria-label="spotlight-new-note"]')).toBeNull();

    const input = container.querySelector("input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "买牛奶和鸡蛋" } });
    await tick();
    const action = container.querySelector(
      'button[aria-label="spotlight-new-note"]',
    ) as HTMLButtonElement | null;
    expect(action).toBeTruthy();
    expect(action?.textContent ?? "").toContain("买牛奶和鸡蛋");
  });

  test("the note action saves the query as a note and opens Notes", async () => {
    const container = await renderOpen();
    const events: [string, unknown][] = [];
    const off = bus().on((e, d) => events.push([e, d]));
    const input = container.querySelector("input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "随手记一句" } });
    await tick();

    await fireEvent.click(
      container.querySelector('button[aria-label="spotlight-new-note"]') as HTMLButtonElement,
    );
    await tick();

    const stored = readStoreValue<{ id: string; text: string }[]>("amos.notes", []);
    expect(stored.map((n) => n.text)).toContain("随手记一句");
    // The Notes deep link carries the *new* note's id, and the sheet closes.
    expect(notesChannel().get()?.noteId).toBe(stored[0]?.id ?? "");
    expect(events.map(([e]) => e)).toContain("close");
    off();
  });

  test("a rejected note save is reported and the sheet stays open", async () => {
    const container = await renderOpen();
    const input = container.querySelector("input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "存不进去" } });
    await tick();

    const restore = failWritesFor("amos.notes");
    try {
      await fireEvent.click(
        container.querySelector('button[aria-label="spotlight-new-note"]') as HTMLButtonElement,
      );
      await tick();
      // Nothing was stored ⇒ nothing closes, nothing is claimed.
      expect(container.textContent ?? "").toContain("本机存储写入失败");
      expect(container.querySelector("h2")).toBeTruthy();
      const action = container.querySelector('button[aria-label="spotlight-new-note"]');
      expect(action?.textContent ?? "").toContain("存不进去");
    } finally {
      restore();
    }
  });

  test("renders nothing when closed", async () => {
    bus().set({ open: false });
    const { container } = render(SpotlightPanel);
    await tick();
    expect(container.querySelector("h2")).toBeNull();
  });

  test("searches NOTES by content and opens that note (domain matcher + deep link)", async () => {
    window.localStorage.setItem(
      "amos.notes",
      JSON.stringify([
        { id: "n1", text: "买菜清单\n西红柿鸡蛋", ts: 1000 },
        { id: "n2", text: "会议记录", ts: 2000 },
      ]),
    );
    let linked: { noteId: string } | null = null;
    const off = notesChannel().subscribe((v) => {
      if (v) linked = v;
    });
    const container = await renderOpen();
    // A word from the note BODY matches (searchNotes reads the whole text).
    await fireEvent.input(container.querySelector("input") as HTMLInputElement, {
      target: { value: "西红柿" },
    });
    await tick();

    const row = container.querySelector('[data-testid="spot-note-n1"]') as HTMLButtonElement | null;
    expect(row).toBeTruthy();
    expect(row?.textContent ?? "").toContain("买菜清单");
    // The unrelated note is not offered.
    expect(container.querySelector('[data-testid="spot-note-n2"]')).toBeNull();

    await fireEvent.click(row as HTMLButtonElement);
    // The link is set for the Notes screen AND the shell switches to it.
    expect(linked?.noteId).toBe("n1");
    expect(surface()).toEqual({ kind: "app", id: "notes" });
    off();
  });

  test("searches FILE CONTENTS and deep-links into Files", async () => {
    window.localStorage.setItem(
      "amos.files",
      JSON.stringify([
        { id: "d1", type: "folder", name: "文档", ts: 1000 },
        { id: "f1", type: "file", name: "笔记.txt", parent: "d1", content: "西红柿炒蛋的做法", ts: 2000 },
        { id: "f2", type: "file", name: "other.txt", content: "与此无关", ts: 3000 },
      ]),
    );
    let linked: { id: string } | null = null;
    const off = filesChannel().subscribe((v) => {
      if (v) linked = v;
    });
    const container = await renderOpen();
    // The word only appears in the file's BODY, never in its name.
    await fireEvent.input(container.querySelector("input") as HTMLInputElement, {
      target: { value: "西红柿" },
    });
    await tick();

    const row = container.querySelector('[data-testid="spot-file-f1"]') as HTMLButtonElement | null;
    expect(row).toBeTruthy();
    expect(row?.textContent ?? "").toContain("笔记.txt");
    // The row says where the file lives (breadcrumb from the Files domain).
    expect(row?.textContent ?? "").toContain("文档");
    // The unrelated file is not offered.
    expect(container.querySelector('[data-testid="spot-file-f2"]')).toBeNull();

    await fireEvent.click(row as HTMLButtonElement);
    expect(linked?.id).toBe("f1");
    expect(surface()).toEqual({ kind: "app", id: "files" });
    off();
  });

  test("searches CONTACTS (name and number) and deep-links into Contacts", async () => {
    window.localStorage.setItem(
      "amos.contacts",
      JSON.stringify([
        { id: "c1", name: "张伟", phones: ["13800000001"], fav: false, ts: 1000 },
        { id: "c2", name: "李娜", phones: ["13900000002"], fav: false, ts: 2000 },
      ]),
    );
    let linked: { id: string } | null = null;
    const off = contactsChannel().subscribe((v) => {
      if (v) linked = v;
    });
    const container = await renderOpen();
    await fireEvent.input(container.querySelector("input") as HTMLInputElement, {
      target: { value: "张伟" },
    });
    await tick();

    const row = container.querySelector(
      '[data-testid="spot-contact-c1"]',
    ) as HTMLButtonElement | null;
    expect(row).toBeTruthy();
    expect(container.querySelector('[data-testid="spot-contact-c2"]')).toBeNull();

    await fireEvent.click(row as HTMLButtonElement);
    expect(linked?.id).toBe("c1");
    expect(surface()).toEqual({ kind: "app", id: "contacts" });
    off();
  });

  test("a number-like query offers the dial action (prefill), not for prose", async () => {
    const container = await renderOpen();
    const input = container.querySelector("input") as HTMLInputElement;

    // Prose: only the note action — Spotlight never pretends "买牛奶" is a number.
    await fireEvent.input(input, { target: { value: "买牛奶" } });
    await tick();
    expect(container.querySelector('button[aria-label="spotlight-dial"]')).toBeNull();

    await fireEvent.input(input, { target: { value: "+86 138-0000-0000" } });
    await tick();
    const dial = container.querySelector(
      'button[aria-label="spotlight-dial"]',
    ) as HTMLButtonElement | null;
    expect(dial).toBeTruthy();
    // The label shows the *stripped* dial string (what the dialler will actually send).
    expect(dial?.textContent ?? "").toContain("+8613800000000");

    const events: [string, unknown][] = [];
    const off = bus().on((e, d) => events.push([e, d]));
    await fireEvent.click(dial as HTMLButtonElement);
    await tick();

    // The Phone screen is asked to prefill — and the sheet closes.
    expect(phoneChannel().get()?.number).toBe("+8613800000000");
    expect(surface()).toEqual({ kind: "app", id: "phone" });
    expect(events.map(([e]) => e)).toContain("close");
    off();
  });

  test("app results follow this device's real use, and invent nothing", async () => {
    // "ma" matches maps / mail / magnifier by app id (and NOT camera — c-a-m-e-r-a).
    const OPENED = ["maps", "mail", "magnifier"];
    const openAndType = async () => {
      const container = await renderOpen();
      await fireEvent.input(container.querySelector("input") as HTMLInputElement, {
        target: { value: "ma" },
      });
      await tick();
      return container;
    };
    const idsOf = (container: HTMLElement) => {
      const all = [
        ...container.querySelectorAll('[data-testid^="spot-app-"]'),
      ].map((b) => (b.getAttribute("data-testid") ?? "").replace("spot-app-", ""));
      return all.filter((id) => OPENED.includes(id));
    };

    // Nothing has been opened yet ⇒ registry order (maps, mail, magnifier).
    expect(idsOf(await openAndType())).toEqual(["maps", "mail", "magnifier"]);

    // Now the user has opened 放大镜 then 地图 (amos.recents is most-recent-first).
    window.localStorage.setItem("amos.recents", JSON.stringify(["magnifier", "maps"]));
    // The two opened apps come first in usage order; the never-opened one keeps its
    // registry place behind them — no invented popularity.
    expect(idsOf(await openAndType())).toEqual(["magnifier", "maps", "mail"]);
  });

  test("every query can be handed to Settings' own search", async () => {
    const container = await renderOpen();
    // Nothing typed ⇒ no actions at all (there is nothing to hand over).
    expect(container.querySelector('button[aria-label="spotlight-settings"]')).toBeNull();

    const input = container.querySelector("input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "亮度" } });
    await tick();
    const row = container.querySelector(
      'button[aria-label="spotlight-settings"]',
    ) as HTMLButtonElement | null;
    expect(row).toBeTruthy();
    expect(row?.textContent ?? "").toContain("亮度");

    const events: [string, unknown][] = [];
    const off = bus().on((e, d) => events.push([e, d]));
    await fireEvent.click(row as HTMLButtonElement);
    await tick();
    // Settings gets the text (no page was chosen for it) and the shell switches.
    expect(settingsChannel().get()?.query).toBe("亮度");
    expect(surface()).toEqual({ kind: "app", id: "settings" });
    expect(events.map(([e]) => e)).toContain("close");
    off();
  });
});
