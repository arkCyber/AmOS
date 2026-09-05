import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ClipboardTray } from "../components/ClipboardTray";
import type { ClipboardEntry } from "../lib/clipboard";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (ev: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();

let history: ClipboardEntry[] = [];
const seed = (): ClipboardEntry[] => [
  { seq: 2, source: "browser", owner: "browser", timestamp_ms: 2, payload: { kind: "text", text: "second copy" } },
  { seq: 1, source: "notes", owner: "notes", timestamp_ms: 1, payload: { kind: "html", html: "<b>first</b>", plain: "first copy" } },
];

async function invoke(cmd: string) {
  if (cmd === "clipboard_history") return history;
  if (cmd === "clipboard_read") return history[0] ?? null;
  return null;
}

beforeEach(() => {
  history = seed();
  listeners.clear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: (channel: string, cb: Listener) => {
      listeners.set(channel, cb);
      return () => {
        listeners.delete(channel);
      };
    },
  };
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const wait = () => new Promise((r) => setTimeout(r, 0));
async function flush() {
  await act(async () => {
    await wait();
    await wait();
  });
}
function emit(channel: string, payload: unknown) {
  listeners.get(channel)?.({ payload });
}

const mounted: { root: Root; host: HTMLElement }[] = [];
function mount(open: boolean, onPick: (e: ClipboardEntry) => void, onClose: () => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<ClipboardTray open={open} onPick={onPick} onClose={onClose} />);
  mounted.push({ root, host });
  return host;
}
function rowByText(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
}

describe("ClipboardTray (fake __TAURI_INTERNALS__, DOM)", () => {
  test("loads history, renders rows, tapping a row hands its entry to onPick", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const host = mount(true, onPick, onClose);
    await flush();

    expect(host.textContent).toContain("second copy");
    expect(host.textContent).toContain("first copy");

    const row = rowByText(host, "second copy");
    expect(row).toBeDefined();
    await act(async () => {
      row!.click();
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ seq: 2 });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("✕ button closes; a new clipboard-changed notice refreshes the list", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const host = mount(true, onPick, onClose);
    await flush();

    await act(async () => {
      rowByText(host, "✕")!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // A later write arrives: history grows, and the still-open tray refetches.
    history = [...seed(), { seq: 3, source: "files", owner: "files", timestamp_ms: 3, payload: { kind: "text", text: "third copy" } }];
    await act(async () => {
      emit("clipboard-changed", { seq: 3, timestamp_ms: 3, source: "files" });
    });
    await flush();
    expect(host.textContent).toContain("third copy");
  });

  test("empty history shows an empty-state hint", async () => {
    history = [];
    const host = mount(true, vi.fn(), vi.fn());
    await flush();
    expect(host.textContent).toContain("暂无复制历史");
  });
});
