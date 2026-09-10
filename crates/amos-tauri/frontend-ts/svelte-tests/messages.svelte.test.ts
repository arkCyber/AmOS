/**
 * DOM tests for the Svelte 5 messages screen (MessagesApp.svelte).
 *
 * Pure message logic is unit-tested once against lib/messages.ts (shared by the
 * React + Svelte UIs). Here we verify the Svelte UI wiring: the seeded thread,
 * sending a message, and clearing to the empty state.
 */
import { describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import MessagesApp from "../src/svelte/MessagesApp.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { CONV_KEY, seedConversations } from "../src/lib/messages";
import { beforeEach } from "vitest";
import { tick } from "svelte";

// Each test starts from a fresh, single seeded 小安 conversation (the Messages
// screen persists to the shared store, which is not reset between tests).
beforeEach(() => {
  writeStoreValue(CONV_KEY, seedConversations(Date.now()));
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const input = (h: { container: HTMLElement }) =>
  h.container.querySelector('input[aria-label="message-input"]') as HTMLInputElement | null;

describe("MessagesApp.svelte", () => {
  test("shows the seeded thread + contact header", () => {
    const host = render(MessagesApp);
    expect(txt(host)).toContain("小安");
    // seeded thread is non-empty → no "暂无消息"
    expect(txt(host)).not.toContain("暂无消息");
  });

  test("sending a message appends it", async () => {
    const host = render(MessagesApp);
    const before = txt(host);
    await fireEvent.input(input(host)!, { target: { value: "你好 Amos" } });
    const sendBtn = [...host.container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "send",
    );
    expect(sendBtn).toBeTruthy();
    await fireEvent.click(sendBtn as HTMLButtonElement);
    expect(txt(host)).toContain("你好 Amos");
    // input cleared
    expect(input(host)!.value).toBe("");
    expect(before.length).toBeGreaterThan(0);
  });

  test("clear empties the thread", async () => {
    const host = render(MessagesApp);
    const clearBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("清空会话"),
    );
    expect(clearBtn).toBeTruthy();
    await fireEvent.click(clearBtn as HTMLButtonElement);
    expect(txt(host)).toContain("暂无消息");
  });

  test("adding a new contact opens an empty thread and switches to it", async () => {
    const host = render(MessagesApp);
    const ni = host.container.querySelector('input[aria-label="new-contact"]') as HTMLInputElement | null;
    expect(ni).toBeTruthy();
    await fireEvent.input(ni as HTMLInputElement, { target: { value: "李四" } });
    const addBtn = host.container.querySelector('button[aria-label="add-contact"]') as HTMLButtonElement | null;
    expect(addBtn).toBeTruthy();
    await fireEvent.click(addBtn as HTMLButtonElement);
    await tick();
    // new empty thread becomes active
    expect(txt(host)).toContain("李四");
    expect(txt(host)).toContain("暂无消息");
  });

  test("each thread keeps its own messages (send stays in the active one)", async () => {
    const host = render(MessagesApp);
    // add 李四 (the new-contact row is always visible)
    const ni = host.container.querySelector('input[aria-label="new-contact"]') as HTMLInputElement;
    await fireEvent.input(ni, { target: { value: "李四" } });
    await fireEvent.click(host.container.querySelector('button[aria-label="add-contact"]') as HTMLButtonElement);
    await tick();
    // send a message to 李四
    const msgIn = host.container.querySelector('input[aria-label="message-input"]') as HTMLInputElement;
    await fireEvent.input(msgIn, { target: { value: "给李四的私信" } });
    const sendBtn = host.container.querySelector('button[aria-label="send"]') as HTMLButtonElement;
    await fireEvent.click(sendBtn);
    await tick();
    expect(txt(host)).toContain("给李四的私信");
    // switch back to 小安 chip → that message must not leak
    const xiaoanChip = [...host.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim().startsWith("小安"),
    ) as HTMLButtonElement;
    expect(xiaoanChip).toBeTruthy();
    await fireEvent.click(xiaoanChip);
    await tick();
    expect(txt(host)).not.toContain("给李四的私信");
  });

  test("deleting a thread (only when >1) removes it and selects another", async () => {
    const host = render(MessagesApp);
    // only one thread → no delete button yet
    expect(host.container.querySelector('button[aria-label="delete-thread"]')).toBeNull();
    const ni = host.container.querySelector('input[aria-label="new-contact"]') as HTMLInputElement;
    await fireEvent.input(ni, { target: { value: "王五" } });
    await fireEvent.click(host.container.querySelector('button[aria-label="add-contact"]') as HTMLButtonElement);
    await tick();
    expect(host.container.querySelector('button[aria-label="delete-thread"]')).toBeTruthy();
    await fireEvent.click(host.container.querySelector('button[aria-label="delete-thread"]') as HTMLButtonElement);
    await tick();
    // falls back to the remaining 小安 thread
    expect(txt(host)).toContain("小安");
    expect(txt(host)).not.toContain("王五");
  });

  test("shows real device SMS threads when a provider is bridged", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "sms_snapshot") {
          return [
            {
              id: "1",
              address: "13800138000",
              display_name: "家人",
              last_text: "回吗",
              last_ts_ms: 1_700_000_000_000,
              unread: 1,
            },
          ];
        }
        if (cmd === "sms_messages") {
          return [
            {
              thread_id: "1",
              id: "m1",
              from_me: false,
              text: "晚上回家吃饭吗？",
              ts_ms: 1_700_000_000_000,
              read: false,
            },
          ];
        }
        if (cmd === "sms_send") return "sent";
        return null;
      },
      listen: async () => () => {},
    };
    const host = render(MessagesApp);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    await tick();
    expect(host.container.querySelector('[data-testid="real-sms-badge"]')).toBeTruthy();
    expect(txt(host)).toContain("家人");
    expect(txt(host)).toContain("晚上回家吃饭吗？");
    // local-only affordances are hidden in real-SMS mode
    expect(host.container.querySelector('input[aria-label="new-contact"]')).toBeNull();
  });
});
