import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  clipboardClear,
  clipboardHistory,
  clipboardRead,
  clipboardWrite,
  copySelection,
  entryText,
  onClipboardChanged,
  previewClipboard,
  type ClipboardEntry,
  type ClipboardNotice,
} from "../lib/clipboard";

function textEntry(payload: ClipboardEntry["payload"], seq = 1): ClipboardEntry {
  return { seq, source: "notes", owner: "notes", timestamp_ms: 1, payload };
}

describe("clipboard pure helpers", () => {
  test("entryText picks the plain representation per kind", () => {
    expect(entryText(textEntry({ kind: "text", text: "hello" }))).toBe("hello");
    expect(
      entryText(textEntry({ kind: "html", html: "<b>hi</b>", plain: "hi" })),
    ).toBe("hi");
    expect(
      entryText(textEntry({ kind: "uris", uris: ["a.txt", "b.txt"], text: "two files" })),
    ).toBe("two files");
    expect(
      entryText(textEntry({ kind: "uris", uris: ["a.txt"], text: "" })),
    ).toBe("a.txt");
    expect(
      entryText(textEntry({ kind: "image", mime: "image/png", data_b64: "aA==" })),
    ).toBe("");
  });

  test("previewClipboard labels binary payloads and collapses text", () => {
    expect(
      previewClipboard(textEntry({ kind: "image", mime: "image/png", data_b64: "aA==" })),
    ).toBe("[image · image/png]");
    expect(
      previewClipboard(textEntry({ kind: "text", text: "  a\n  b  " })),
    ).toBe("a b");
  });

  test("copySelection degrades to false when not bridged (no window)", async () => {
    // Outside Tauri the backend bridge is absent, so this is a clean false.
    expect(await copySelection("anything")).toBe(false);
  });
});

function setWindow(obj: Record<string, unknown>) {
  (globalThis as { window?: unknown }).window = obj;
}

let realWindow: unknown;
beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

describe("clipboard bridge wrappers", () => {
  test("write/read/history/clear route + forward args when bridged", async () => {
    const store = new Map<string, string>();
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const fake = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        if (cmd === "clipboard_clear") return 3;
        return {
          seq: 1,
          source: "notes",
          owner: "notes",
          timestamp_ms: 1,
          payload: { kind: "text", text: "x" },
        } as ClipboardEntry;
      },
      listen: async () => async () => {},
    };
    setWindow({
      __TAURI_INTERNALS__: fake,
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });

    // clipboardWrite: with and without an explicit source.
    const last = () => calls[calls.length - 1]!;
    const withSrc = await clipboardWrite({ kind: "text", text: "hello" }, "notes");
    expect(withSrc).not.toBeNull();
    expect(withSrc!.payload.kind).toBe("text");
    expect(last().args.source).toBe("notes");
    await clipboardWrite({ kind: "text", text: "solo" });
    expect(last().args.source).toBeUndefined();

    // read/history accept optional args and omit them when undefined.
    await clipboardRead();
    expect(last().args).toEqual({});
    await clipboardRead(7);
    expect(last().args.seq).toBe(7);
    await clipboardHistory();
    expect(last().args).toEqual({});
    await clipboardHistory(10);
    expect(last().args.limit).toBe(10);

    // clear returns the removed-entry count from the daemon.
    expect(await clipboardClear()).toBe(3);

    const routed = calls.map((c) => c.cmd);
    for (const cmd of ["clipboard_write", "clipboard_read", "clipboard_history", "clipboard_clear"]) {
      expect(routed).toContain(cmd);
    }
  });

  test("clipboardChanged subscribes and forwards a metadata-only notice", async () => {
    const store = new Map<string, string>();
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    const invoked: string[] = [];
    const fake = {
      invoke: async (cmd: string) => {
        invoked.push(cmd);
        return cmd === "clipboard_subscribe" ? 1 : null;
      },
      listen: async (ch: string, h: (e: { payload: unknown }) => void) => {
        handlers[ch] = h;
        return async () => {};
      },
    };
    setWindow({
      __TAURI_INTERNALS__: fake,
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });

    const box: { n: ClipboardNotice | undefined } = { n: undefined };
    const un = await onClipboardChanged((n) => {
      box.n = n;
    });
    expect(un).not.toBeNull(); // REQ-A838：监听成立，才谈得上"已订阅"
    const h = handlers["clipboard-changed"];
    expect(typeof h).toBe("function");
    // REQ-A557: subscribing **opts in** — without this the host never applies its
    // per-window throttle (F-CLB-002) and floods every window instead.
    expect(invoked).toContain("clipboard_subscribe");
    h!({ payload: { seq: 9, timestamp_ms: 2, source: "wechat" } });
    expect(box.n).toBeDefined();
    if (box.n) {
      expect(box.n.seq).toBe(9);
      expect(box.n.timestamp_ms).toBe(2);
      expect(box.n.source).toBe("wechat");
    }
    un!();
  });

  test("clipboardChanged listens before opting in, so no notice falls in the gap", async () => {
    const order: string[] = [];
    const fake = {
      invoke: async (cmd: string) => {
        order.push(`invoke:${cmd}`);
        return 1;
      },
      listen: async () => {
        order.push("listen");
        return async () => {};
      },
    };
    setWindow({
      __TAURI_INTERNALS__: fake,
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
    });

    await onClipboardChanged(() => {});
    // Listening first means a copy landing mid-call is still delivered by the host's global
    // `emit`; opting in first would open a window where neither path reaches this window.
    expect(order).toEqual(["listen", "invoke:clipboard_subscribe"]);
  });

  test("a refused listen must NOT opt in — the opt-in would close the path that still works", async () => {
    // REQ-A838 / F-SH-267, the sharp instance of the family.
    //
    // The host's delivery has two modes (`clipboard.rs::broadcast_changed`): with no subscriber
    // it uses a global `emit` that reaches every window; once a window opts in, delivery becomes
    // `emit_to` for subscribers only. `onClipboardChanged` listens first and *then* opts in —
    // and that order is only safe while the listen actually succeeded. If `listen` is refused
    // but we opt in anyway, the host moves this window off the global broadcast and onto a
    // subscriber list we are **not on**: every clipboard notice is then dropped, and the window
    // looks exactly as subscribed as a quiet one. The correct move on a refused listen is to
    // leave the host on the global path — no opt-in, and `null` back to the caller.
    const invoked: string[] = [];
    const fake = {
      invoke: async (cmd: string) => {
        invoked.push(cmd);
        return 1;
      },
      listen: async () => {
        throw new Error("event plugin refused the registration");
      },
    };
    setWindow({
      __TAURI_INTERNALS__: fake,
      localStorage: { getItem: () => null, setItem: () => {} },
    });

    expect(await onClipboardChanged(() => {})).toBeNull();
    expect(invoked).not.toContain("clipboard_subscribe");
  });

  test("copySelection is true when the bridge returns an entry", async () => {
    const store = new Map<string, string>();
    const fake = {
      invoke: async () => ({
        seq: 1,
        source: "notes",
        owner: "notes",
        timestamp_ms: 1,
        payload: { kind: "text", text: "hi" },
      }),
      listen: async () => async () => {},
    };
    setWindow({
      __TAURI_INTERNALS__: fake,
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    expect(await copySelection("hi")).toBe(true);
  });
});
