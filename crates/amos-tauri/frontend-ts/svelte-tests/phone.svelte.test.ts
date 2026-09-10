/**
 * DOM tests for the Svelte 5 phone screen (PhoneApp.svelte) — offline UI parts.
 * Pure dial logic is in lib/phone (shared); dialing/record paths need the OS
 * telephony daemon and are verified on-device (ON_DEVICE_ACCEPTANCE.md). Here we
 * test keypad entry/backspace/clear, tab switching, the emergency page, and that
 * dialing WITHOUT a daemon shows a localized error (never a phantom "calling").
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import PhoneApp from "../src/svelte/PhoneApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { CALLLOG_KEY } from "../src/lib/calllog";
import { messagesChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState, surface } from "../src/svelte/shellState.svelte";

afterEach(() => {
  cleanup();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const key = (h: { container: HTMLElement }, aria: string) =>
  h.container.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement | null;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Open the 「拦截」 tab (matched by its label, not by index). */
const openBlockTab = (h: { container: HTMLElement }) => {
  const tab = [...h.container.querySelectorAll('button[role="tab"]')].find((b) =>
    (b.textContent ?? "").includes("拦截"),
  ) as HTMLButtonElement;
  return fireEvent.click(tab);
};

/** Open the 「最近」 tab (the call-history page). */
const openHistoryTab = (h: { container: HTMLElement }) => {
  const tab = [...h.container.querySelectorAll('button[role="tab"]')].find((b) =>
    (b.textContent ?? "").includes("最近"),
  ) as HTMLButtonElement;
  return fireEvent.click(tab);
};

/** Install a fake Tauri bridge; returns the captured invoke calls. */
const fakeBridge = (handler: (cmd: string, args?: Record<string, unknown>) => unknown) => {
  const calls: Record<string, unknown>[] = [];
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, ...(args ?? {}) });
      return handler(cmd, args);
    },
    listen: async () => () => {},
  };
  return calls;
};

const NO_STATUS = {
  has_call_rules: false,
  has_sms_rules: false,
  role_supported: false,
  role_held: false,
  role_requestable: false,
};

describe("PhoneApp.svelte (offline UI)", () => {
  test("keypad digits append; backspace and clear work", async () => {
    const host = render(PhoneApp);
    await fireEvent.click(key(host, "1")!);
    await fireEvent.click(key(host, "2")!);
    await fireEvent.click(key(host, "3")!);
    expect(txt(host)).toContain("123");
    await fireEvent.click(key(host, "backspace")!);
    expect(txt(host)).toContain("12");
    await fireEvent.click(key(host, "clear")!);
    expect(txt(host)).not.toContain("12");
  });

  test("tabs switch between pages", async () => {
    const host = render(PhoneApp);
    const tab = (label: string) =>
      [...host.container.querySelectorAll('button[role="tab"]')].find((b) =>
        (b.textContent ?? "").trim() === label,
      ) as HTMLButtonElement | undefined;
    // emergency page lists the quick numbers
    await fireEvent.click(tab("紧急")!);
    expect(txt(host)).toContain("110");
    expect(txt(host)).toContain("119");
    // recent page (empty offline → localized empty text is non-whitespace)
    await fireEvent.click(tab("最近")!);
    expect(txt(host)).toContain("最近");
  });

  test("dialing without a daemon shows a localized error, not a fake calling screen", async () => {
    const host = render(PhoneApp);
    await fireEvent.click(key(host, "1")!);
    await fireEvent.click(key(host, "3")!);
    await fireEvent.click(key(host, "8")!);
    const callBtn = host.container.querySelector('button[aria-label="call"]');
    expect(callBtn).toBeTruthy();
    await fireEvent.click(callBtn as HTMLButtonElement);
    await new Promise((r) => setTimeout(r, 10)); // let realDial/telephonyDial settle
    // offline: no in-call UI, but a role=alert with the localized dial error
    expect(host.container.querySelector('button[aria-label="end"]')).toBeFalsy();
    expect(host.container.querySelector('[role="alert"]')).toBeTruthy();
  });

  test("blocklist tab adds, lists and removes rules through the bridge", async () => {
    let rules: Record<string, unknown>[] = [];
    let unknown = false;
    const calls = fakeBridge((cmd, args) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: unknown, rules };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "blocklist_add") {
        const r = {
          id: `${String(args?.pattern)}|exact|both`,
          pattern: String(args?.pattern),
          kind: String(args?.kind),
          channel: String(args?.channel),
          label: String(args?.label ?? ""),
          created_ms: 1,
        };
        rules = [...rules, r];
        return r;
      }
      if (cmd === "blocklist_remove") {
        rules = rules.filter((r) => r.id !== args?.id);
        return true;
      }
      if (cmd === "blocklist_set_unknown") {
        unknown = args?.on === true;
        return null;
      }
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    await fireEvent.input(host.container.querySelector('input[aria-label="block-number"]') as HTMLInputElement, {
      target: { value: "1069" },
    });
    await fireEvent.click(host.container.querySelector('button[aria-label="block-add"]') as HTMLButtonElement);
    await flush();
    const added = calls.find((c) => c.cmd === "blocklist_add");
    expect(added?.pattern).toBe("1069");
    expect(added?.kind).toBe("exact");
    expect(added?.channel).toBe("both");
    expect(txt(host)).toContain("1069");
    // The unknown-number switch reaches the same rule store.
    await fireEvent.click(host.container.querySelector('button[aria-label="block-unknown"]') as HTMLButtonElement);
    await flush();
    expect(calls.find((c) => c.cmd === "blocklist_set_unknown")?.on).toBe(true);
    // Removing the rule drops it from the list.
    await fireEvent.click(host.container.querySelector('button[aria-label="block-remove-1069"]') as HTMLButtonElement);
    await flush();
    expect(rules.length).toBe(0);
  });

  test("the 拦截 tab shows ONLY the block panel (never the emergency page)", async () => {
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    // Regression: the tab chain used to end in a bare `{:else}` (the emergency
    // page), so the 拦截 tab rendered the whole emergency list *above* the block
    // panel — the "拦截页面不正常" the user reported. Guard both directions.
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="blocklist-panel"]')).toBeTruthy();
    expect(host.container.querySelector('button[aria-label="紧急呼叫 110"]')).toBeNull();
    expect(txt(host)).not.toContain("紧急号码");
    // …and the emergency tab still renders its own page (and no block panel).
    const emTab = [...host.container.querySelectorAll('button[role="tab"]')].find((b) =>
      (b.textContent ?? "").includes("紧急"),
    ) as HTMLButtonElement;
    await fireEvent.click(emTab);
    await flush();
    expect(host.container.querySelector('button[aria-label="紧急呼叫 110"]')).toBeTruthy();
    expect(host.container.querySelector('[data-testid="blocklist-panel"]')).toBeNull();
  });

  test("a rejected rule surfaces the honest error instead of silently doing nothing", async () => {
    // Tauri *rejects* the command promise on a domain rejection; without a catch
    // this used to leave the screen unchanged with no explanation.
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "blocklist_add") throw new Error("invalid number");
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    await fireEvent.input(host.container.querySelector('input[aria-label="block-number"]') as HTMLInputElement, {
      target: { value: "abc" },
    });
    await fireEvent.click(host.container.querySelector('button[aria-label="block-add"]') as HTMLButtonElement);
    await flush();
    const alert = host.container.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").toContain("号码无效");
    expect(calls.some((c) => c.cmd === "blocklist_add")).toBe(true);
  });

  test("a call rule without the Call Screening role shows a grant prompt that requests it", async () => {
    let roleHeld = false;
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") {
        return {
          block_unknown: false,
          rules: [{ id: "r", pattern: "10086", kind: "exact", channel: "call", label: "", created_ms: 1 }],
        };
      }
      if (cmd === "blocklist_status") {
        return {
          has_call_rules: true,
          has_sms_rules: false,
          role_supported: true,
          role_held: roleHeld,
          role_requestable: true,
        };
      }
      if (cmd === "blocklist_request_role") {
        roleHeld = true;
        return true;
      }
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeTruthy();
    await fireEvent.click(
      host.container.querySelector('button[aria-label="block-grant-role"]') as HTMLButtonElement,
    );
    await flush();
    expect(calls.some((c) => c.cmd === "blocklist_request_role")).toBe(true);
    // After the role is granted the UI says blocking is actually live.
    expect(host.container.querySelector('[data-testid="block-role-held"]')).toBeTruthy();
  });

  test("re-probes the Call Screening role when the app resumes", async () => {
    // The grant happens in the system's own Activity, so the answer arrives after
    // `blocklist_request_role` already returned. Coming back to the foreground
    // must re-read the status instead of showing a stale "needs granting" banner.
    let roleHeld = false;
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") {
        return {
          block_unknown: false,
          rules: [{ id: "r", pattern: "10086", kind: "exact", channel: "call", label: "", created_ms: 1 }],
        };
      }
      if (cmd === "blocklist_status") {
        return {
          has_call_rules: true,
          has_sms_rules: false,
          role_supported: true,
          role_held: roleHeld,
          role_requestable: true,
        };
      }
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeTruthy();
    const before = calls.filter((c) => c.cmd === "blocklist_status").length;
    // User answers the system dialog (granted) → our WebView becomes visible again.
    roleHeld = true;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(calls.filter((c) => c.cmd === "blocklist_status").length).toBeGreaterThan(before);
    expect(host.container.querySelector('[data-testid="block-role-held"]')).toBeTruthy();
    // A revoke outside the app is reflected the same way (honest both directions).
    roleHeld = false;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeTruthy();
  });

  test("call rules nobody enforces say so instead of rendering nothing", async () => {
    // Desktop / Android-without-the-role: `role_supported` is false and the glue is
    // not requestable, so no grant can be offered. Rules alone reject nothing, and
    // an empty banner would read as "all good" — the state must be rendered.
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot")
        return {
          block_unknown: false,
          rules: [{ id: "r", pattern: "10086", kind: "exact", channel: "call", label: "", created_ms: 1 }],
        };
      if (cmd === "blocklist_status")
        return {
          has_call_rules: true,
          has_sms_rules: false,
          role_supported: false,
          role_held: false,
          role_requestable: false,
        };
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="block-role-unavailable"]')).toBeTruthy();
    // Nothing can be asked for here → no dead grant button, and no false "held".
    expect(host.container.querySelector('button[aria-label="block-grant-role"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="block-role-held"]')).toBeNull();
  });

  test("a held role reports active and never offers the grant button", async () => {
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot")
        return {
          block_unknown: false,
          rules: [{ id: "r", pattern: "10086", kind: "exact", channel: "call", label: "", created_ms: 1 }],
        };
      if (cmd === "blocklist_status")
        return {
          has_call_rules: true,
          has_sms_rules: false,
          role_supported: true,
          role_held: true,
          role_requestable: true,
        };
      return null;
    });
    const host = render(PhoneApp);
    await openBlockTab(host);
    await flush();
    expect(host.container.querySelector('[data-testid="block-role-held"]')).toBeTruthy();
    expect(host.container.querySelector('button[aria-label="block-grant-role"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="block-role-needed"]')).toBeNull();
  });

  test("recents offers a one-tap block that adds an exact/both rule", async () => {
    writeStoreValue(CALLLOG_KEY, [{ number: "18616091470", ts: 1 }]);
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "blocklist_add") {
        return { id: "x", pattern: "18616091470", kind: "exact", channel: "both", label: "", created_ms: 1 };
      }
      return null;
    });
    const host = render(PhoneApp);
    const recent = [...host.container.querySelectorAll('button[role="tab"]')].find((b) =>
      (b.textContent ?? "").includes("最近"),
    ) as HTMLButtonElement;
    await fireEvent.click(recent);
    await flush();
    const blockBtn = host.container.querySelector(
      'button[aria-label="block-caller-18616091470"]',
    ) as HTMLButtonElement;
    expect(blockBtn).toBeTruthy();
    await fireEvent.click(blockBtn);
    await flush();
    const added = calls.find((c) => c.cmd === "blocklist_add");
    expect(added?.pattern).toBe("18616091470");
    expect(added?.kind).toBe("exact");
    expect(added?.channel).toBe("both");
  });

  test("the history page lists calls with direction/time and can call back", async () => {
    const now = Date.now();
    writeStoreValue(CALLLOG_KEY, [
      { number: "18616091470", ts: now, direction: "missed" },
      { number: "10086", ts: now - 5000, direction: "outgoing" },
    ]);
    const calls = fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      if (cmd === "telephony_dial") return { id: "c1", state: "Dialing" };
      return null;
    });
    const host = render(PhoneApp);
    await openHistoryTab(host);
    await flush();
    const rows = host.container.querySelectorAll('[data-testid="history-row"]');
    expect(rows.length).toBe(2);
    // newest first + direction is carried through (no guessing for legacy rows)
    expect(rows[0]!.getAttribute("data-direction")).toBe("missed");
    expect(rows[1]!.getAttribute("data-direction")).toBe("outgoing");
    // the missed summary is shown (1 missed)
    expect(host.container.querySelector('[data-testid="missed-count"]')).toBeTruthy();
    // call back places a real call for that row's number
    await fireEvent.click(
      host.container.querySelector('button[aria-label="call-back-18616091470"]') as HTMLButtonElement,
    );
    await flush();
    const dial = calls.find((c) => c.cmd === "telephony_dial");
    expect(dial?.number).toBe("18616091470");
  });

  test("history direction filters narrow the rows and tell an empty filter apart", async () => {
    const now = Date.now();
    writeStoreValue(CALLLOG_KEY, [
      { number: "18616091470", ts: now, direction: "missed" },
      { number: "10086", ts: now - 5000, direction: "outgoing" },
      { number: "13800138000", ts: now - 9000, direction: "incoming" },
    ]);
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openHistoryTab(host);
    await flush();
    const rows = () => host.container.querySelectorAll('[data-testid="history-row"]');
    const chip = (f: string) =>
      host.container.querySelector(`button[data-filter="${f}"]`) as HTMLButtonElement;
    expect(rows().length).toBe(3);
    expect(host.container.querySelector('[data-testid="history-filters"]')).toBeTruthy();
    await fireEvent.click(chip("missed"));
    await flush();
    expect(rows().length).toBe(1);
    expect(rows()[0]!.getAttribute("data-direction")).toBe("missed");
    await fireEvent.click(chip("incoming"));
    await flush();
    expect(rows().length).toBe(1);
    expect(rows()[0]!.getAttribute("data-direction")).toBe("incoming");
    // back to everything
    await fireEvent.click(chip("all"));
    await flush();
    expect(rows().length).toBe(3);
  });

  test("an empty direction filter is honest (not 'no recent calls')", async () => {
    writeStoreValue(CALLLOG_KEY, [{ number: "10086", ts: Date.now(), direction: "outgoing" }]);
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openHistoryTab(host);
    await flush();
    await fireEvent.click(
      host.container.querySelector('button[data-filter="missed"]') as HTMLButtonElement,
    );
    await flush();
    const empty = host.container.querySelector('[data-testid="history-empty"]')!;
    expect(empty.textContent).toContain("该筛选下暂无记录");
    expect(empty.textContent).not.toContain("暂无最近通话");
  });

  test("clearing the history is two-step, cancellable, and really empties the log", async () => {
    writeStoreValue(CALLLOG_KEY, [{ number: "10086", ts: Date.now(), direction: "outgoing" }]);
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openHistoryTab(host);
    await flush();
    const el = (aria: string) =>
      host.container.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement;
    // First tap only arms the confirm — nothing is cleared yet.
    await fireEvent.click(el("history-clear"));
    await flush();
    expect(host.container.querySelectorAll('[data-testid="history-row"]').length).toBe(1);
    // Cancel keeps the log.
    await fireEvent.click(el("history-clear-cancel"));
    await flush();
    expect(host.container.querySelectorAll('[data-testid="history-row"]').length).toBe(1);
    // Arm again and confirm → the log is gone and the persisted value is empty.
    await fireEvent.click(el("history-clear"));
    await flush();
    await fireEvent.click(el("history-clear-confirm"));
    await flush();
    expect(host.container.querySelectorAll('[data-testid="history-row"]').length).toBe(0);
    expect(txt(host)).toContain("暂无最近通话");
    expect(readStoreValue<unknown[]>(CALLLOG_KEY, [null])).toEqual([]);
    // An empty log hides the filter chips too (there is nothing to filter).
    expect(host.container.querySelector('[data-testid="history-filters"]')).toBeNull();
  });

  test("回短信 deep-links to Messages addressed to that number", async () => {
    writeStoreValue(CALLLOG_KEY, [{ number: "18616091470", ts: Date.now(), direction: "incoming" }]);
    fakeBridge((cmd) => {
      if (cmd === "blocklist_snapshot") return { block_unknown: false, rules: [] };
      if (cmd === "blocklist_status") return NO_STATUS;
      return null;
    });
    const host = render(PhoneApp);
    await openHistoryTab(host);
    await flush();
    await fireEvent.click(
      host.container.querySelector('button[aria-label="sms-back-18616091470"]') as HTMLButtonElement,
    );
    await flush();
    // Messages is asked for that address and the shell switches to it.
    expect(messagesChannel().get()?.composeTo).toBe("18616091470");
    const s = surface();
    expect(s.kind).toBe("app");
    if (s.kind === "app") expect(s.id).toBe("messages");
  });
});
