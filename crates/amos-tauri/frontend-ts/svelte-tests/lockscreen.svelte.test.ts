/**
 * lockscreen.svelte.test.ts — Svelte whole-screen locked surface.
 *
 * Shell shows LockScreen while locked; it emits 'unlock' when the PIN is entered
 * (or immediately when no PIN is configured) and runs an emergency dial. Pure
 * pin/unlock/emergency offline behaviour is what we test here (no daemon).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import LockScreen from "../src/svelte/LockScreen.svelte";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { writeStoreValue } from "../src/lib/amosStore";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
});
afterEach(() => {
  resetPropsChannels();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const key = (c: HTMLElement, aria: string) =>
  c.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement | null;

/** The one-tap emergency button (the only button on the lock screen with an aria-label). */
const emergencyButton = (c: HTMLElement) =>
  [...c.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")) as HTMLButtonElement;

/** Let the dial's sequential `await`s (real_dial → backend kind → host status → daemon) land. */
const settle = () => new Promise((r) => setTimeout(r, 40));

describe("LockScreen.svelte", () => {
  test("with no PIN configured, tapping unlock emits 'unlock'", async () => {
    writeStoreValue("amos.lock", { enabled: false });
    const { container } = render(LockScreen);
    await tick();
    const events: string[] = [];
    const off = propsChannel<{ ready?: boolean }>("lock").on((e) => events.push(e));
    // No keypad when no PIN → the unlock button is the one without an aria-label
    // (the emergency button carries an aria-label).
    const unlock = [...container.querySelectorAll("button")].find((b) => !b.getAttribute("aria-label"));
    expect(unlock).toBeTruthy();
    await fireEvent.click(unlock as HTMLButtonElement);
    expect(events).toContain("unlock");
    off();
  });

  test("entering the correct PIN then ✓ emits 'unlock'", async () => {
    writeStoreValue("amos.lock", { enabled: true, pin: "1234" });
    const { container } = render(LockScreen);
    await tick();
    const events: string[] = [];
    const off = propsChannel<{ ready?: boolean }>("lock").on((e) => events.push(e));
    for (const d of ["1", "2", "3", "4"]) {
      await fireEvent.click(key(container, d)!);
    }
    await fireEvent.click(key(container, "✓")!);
    expect(events).toContain("unlock");
    off();
  });

  test("a wrong PIN shows the failure mark and does NOT unlock", async () => {
    writeStoreValue("amos.lock", { enabled: true, pin: "1234" });
    const { container } = render(LockScreen);
    await tick();
    const events: string[] = [];
    const off = propsChannel<{ ready?: boolean }>("lock").on((e) => events.push(e));
    for (const d of ["9", "9", "9", "9"]) {
      await fireEvent.click(key(container, d)!);
    }
    await fireEvent.click(key(container, "✓")!);
    expect(events).not.toContain("unlock");
    // ✗ failure glyph shown.
    expect((container.textContent ?? "").includes("✗")).toBe(true);
    off();
  });
});

describe("LockScreen.svelte — the one-tap emergency dial is the device's region", () => {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "language");
  const withLanguage = (language: string) =>
    Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
  afterEach(() => {
    if (original) Object.defineProperty(window.navigator, "language", original);
  });

  /**
   * A **desktop** bridge: no real platform path (`real_dial` answers nothing and the host
   * reports `on_device:false`) and a daemon backed by the mock. This is the one
   * configuration in which the emergency dial may legitimately reach the daemon, so the
   * region question — *which number* is dialed — is asked here.
   */
  function installDialBridge() {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: unknown) => {
        calls.push({ cmd, args });
        if (cmd === "telephony_real_dial_status")
          return { on_device: false, available: false, reason: "host" };
        if (cmd === "telephony_backend_kind") return { kind: "mock", detail: "", real: false };
        if (cmd === "telephony_dial") return { id: "sim-1" };
        return null;
      },
      listen: async () => () => {},
    };
    return calls;
  }

  /** Dial from a device locale and return what the bridge actually received. */
  async function dialFrom(language: string) {
    withLanguage(language);
    const calls = installDialBridge();
    const { container } = render(LockScreen);
    await tick();
    const btn = emergencyButton(container);
    await fireEvent.click(btn);
    await settle();
    return { dial: calls.find((c) => c.cmd === "telephony_dial"), label: btn.getAttribute("aria-label") };
  }

  test("a ko-KR device dials 112 — not the CN/JP 110, which reaches nobody in Korea", async () => {
    const { dial, label } = await dialFrom("ko-KR");
    expect(dial?.args).toEqual({ number: "112", emergency: true });
    expect(label).toContain("112");
  });

  test("a US device dials 911", async () => {
    const { dial, label } = await dialFrom("en-US");
    expect(dial?.args).toEqual({ number: "911", emergency: true });
    expect(label).toContain("911");
  });

  test("a locale naming no region falls back to the universal 112, never a country's code", async () => {
    const { dial, label } = await dialFrom("en");
    expect(dial?.args).toEqual({ number: "112", emergency: true });
    expect(label).toContain("112");
  });

  test("the label states the number that is dialed (they cannot drift)", async () => {
    const { dial, label } = await dialFrom("en-AU");
    const dialed = (dial?.args as { number: string }).number;
    expect(dialed).toBe("000"); // AU/NZ emergency, not 911
    expect(label).toContain(dialed);
  });
});

describe("LockScreen.svelte — the emergency dial takes the real platform path first", () => {
  /** Install a bridge from a `cmd → reply` map; every unlisted command answers `null`. */
  function install(replies: Record<string, unknown>) {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: unknown) => {
        calls.push({ cmd, args });
        return cmd in replies ? replies[cmd] : null;
      },
      listen: async () => () => {},
    };
    return calls;
  }

  async function dial(bridge: Array<{ cmd: string; args: unknown }>) {
    const { container } = render(LockScreen);
    await tick();
    const btn = emergencyButton(container);
    const label = btn.getAttribute("aria-label") ?? "";
    await fireEvent.click(btn);
    await settle();
    return { container, label };
  }

  test("a device where ACTION_CALL works hands the emergency call to the platform, not the daemon", async () => {
    const calls = install({
      real_dial: "dialing via Android Telecom",
      telephony_backend_kind: { kind: "android", detail: "", real: true },
      telephony_dial: { id: "must-not-be-used" },
    });
    const { label } = await dial(calls);
    expect(calls.map((c) => c.cmd)).toContain("real_dial");
    // The order is the fix: an emergency dial reaches the platform **before** any daemon —
    // even a genuinely real one — is asked (a daemon that answered could only pretend).
    expect(calls.map((c) => c.cmd)).not.toContain("telephony_dial");
    // …and the number the platform is handed is the number the button named.
    const dialed = calls.find((c) => c.cmd === "real_dial")?.args as { number: string };
    expect(label).toContain(dialed.number);
    expect(dialed.number).not.toBe("");
  });

  test("a device with no real path refuses instead of handing an emergency call to the mock", async () => {
    const calls = install({
      real_dial: null,
      telephony_backend_kind: { kind: "unconfigured", detail: "", real: false },
      telephony_real_dial_status: { on_device: true, available: false, reason: "no dial context" },
      telephony_dial: { id: "must-not-be-used" },
    });
    const { container } = await dial(calls);
    expect(calls.map((c) => c.cmd)).not.toContain("telephony_dial");
    expect(container.textContent ?? "").toContain(zh["shell.emergencyUnreachable"]);
    expect(container.textContent ?? "").not.toContain(zh["phone.simulatedCall"]);
  });

  test("a desktop with no telephony stack places a simulated call — and says so on screen", async () => {
    const calls = install({
      real_dial: null,
      telephony_backend_kind: { kind: "mock", detail: "", real: false },
      telephony_real_dial_status: { on_device: false, available: false, reason: "host" },
      telephony_dial: { id: "sim-1" },
    });
    const { container } = await dial(calls);
    expect(calls.map((c) => c.cmd)).toContain("telephony_dial");
    expect(container.textContent ?? "").toContain(zh["phone.simulatedCall"]);
    expect(container.textContent ?? "").not.toContain(zh["shell.emergencyUnreachable"]);
  });

  // The in-flight guard is not a "a call is up" fact: `placeOutgoingCall` resolves when the
  // attempt is *placed*, and this screen keeps no in-call state to stay disabled for. Left
  // set on success, the one control a locked user reaches without authenticating stayed
  // `disabled` and read "正在呼叫 …" for the rest of the lock session.
  const callingGlyph = zh["shell.emergencyCalling"].split("{num}")[0];
  const idleGlyph = zh["shell.emergency"].split("{num}")[0];

  test("a handed-off emergency call does not latch the button — it stays usable and says who owns the call", async () => {
    const calls = install({
      real_dial: "dialing via Android Telecom",
      telephony_backend_kind: { kind: "android", detail: "", real: true },
      telephony_dial: { id: "must-not-be-used" },
      // The role probe answers "another dialer holds it" — the honest case for the
      // hand-off sentence. Without this the probe is refused, and (REQ-A1547) a refusal
      // must not be read as "the system dialer owns the call".
      telephony_default_dialer_status: { role_supported: true, role_held: false, role_requestable: true },
    });
    const { container } = await dial(calls);
    const btn = emergencyButton(container);
    expect(btn.disabled, "the emergency button is re-enabled once the attempt resolves").toBe(false);
    expect(container.textContent ?? "").not.toContain(callingGlyph);
    expect(btn.textContent ?? "").toContain(idleGlyph);
    // …and the outcome is disclosed rather than left silent (the system dialer owns it).
    expect(container.textContent ?? "").toContain(zh["phone.handedToSystem"]);
    // A locked user can dial again — the second press really reaches the platform.
    await fireEvent.click(btn);
    await settle();
    expect(calls.filter((c) => c.cmd === "real_dial").length).toBe(2);
  });

  // REQ-A1547 / F-SH-785. This screen is the third consumer of `placeOutgoingCall`
  // (`PhoneApp` and `ContactsApp` are the other two) and the only one that never asked
  // `ROLE_DIALER`: it printed 「已交给系统拨号器」 on **every** hand-off. When AmOS *is*
  // the default phone app, Telecom resolves the call straight back into this app's own
  // in-call service (fixed id `real`) — there is no other dialer, the sentence is false,
  // and the locked user has no hang-up anywhere. The sibling comment even claims to match
  // PhoneApp, which does the opposite (`if (role) dialerRole = role;`).
  test("AmOS 自己是默认电话应用 → 不假装「已交给系统」，打开电话应用并说实话 (REQ-A1547)", async () => {
    const calls = install({
      real_dial: "dialing via Android Telecom",
      telephony_backend_kind: { kind: "android", detail: "", real: true },
      telephony_default_dialer_status: { role_supported: true, role_held: true, role_requestable: true },
      wm_open: { windows: [] },
    });
    const { container } = await dial(calls);
    expect(calls.some((c) => c.cmd === "wm_open"), "the in-call surface is brought up").toBe(true);
    expect(container.textContent ?? "").toContain(zh["shell.emergencyOwned"]);
    expect(container.textContent ?? "").not.toContain(zh["phone.handedToSystem"]);
  });

  test("探针被拒（无判决）→ 不假装「已交给系统」，也不沉默 (REQ-A1547)", async () => {
    // `telephony_default_dialer_status` is absent ⇒ `invoke` folds the refusal to `null`.
    const calls = install({
      real_dial: "dialing via Android Telecom",
      telephony_backend_kind: { kind: "android", detail: "", real: true },
      wm_open: { windows: [] },
    });
    const { container } = await dial(calls);
    expect(calls.some((c) => c.cmd === "wm_open"), "the in-call surface is brought up").toBe(true);
    expect(container.textContent ?? "").toContain(zh["shell.emergencyRoleUnread"]);
    expect(container.textContent ?? "").not.toContain(zh["phone.handedToSystem"]);
  });

  test("a simulated emergency call does not latch the button either", async () => {
    const calls = install({
      real_dial: null,
      telephony_backend_kind: { kind: "mock", detail: "", real: false },
      telephony_real_dial_status: { on_device: false, available: false, reason: "host" },
      telephony_dial: { id: "sim-1" },
    });
    const { container } = await dial(calls);
    const btn = emergencyButton(container);
    expect(btn.disabled).toBe(false);
    expect(container.textContent ?? "").not.toContain(callingGlyph);
    expect(btn.textContent ?? "").toContain(idleGlyph);
    // The simulated disclosure survives — only the in-flight state was cleared.
    expect(container.textContent ?? "").toContain(zh["phone.simulatedCall"]);
  });
});

describe("LockScreen.svelte — real battery indicator", () => {
  const settle = () => new Promise((r) => setTimeout(r, 40));
  const lockBatt = (c: HTMLElement) => c.querySelector('[data-testid="lock-battery"]');

  function installBridge(systemHealth: unknown, hostBatteryPayload?: unknown) {
    const invoke = async (cmd: string) => {
      if (cmd === "system_health") return systemHealth;
      if (cmd === "system_host_battery") return hostBatteryPayload ?? null;
      return null;
    };
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      listen: async () => () => {},
    };
  }

  test("renders no battery when no real source reports a level (honest, unobtrusive)", async () => {
    const { container } = render(LockScreen);
    await tick();
    await settle();
    expect(lockBatt(container)).toBeNull();
  });

  test("shows the REAL battery top-right when the host reports a level", async () => {
    installBridge({}, { level_pct: 75, charging: false });
    const { container } = render(LockScreen);
    await tick();
    await settle();
    const b = lockBatt(container);
    expect(b).not.toBeNull();
    expect(b?.textContent ?? "").toContain("75%");
    // The drawn "75%" is `aria-hidden` and the container's name is what AT reads, so
    // the name must carry the level — a constant "Battery level" hides it (REQ-A1016).
    expect(b?.getAttribute("aria-label")).toBe(zh["a11y.battery"].replace("{pct}", "75%"));
  });

  test("shows the host battery even when the daemon is away — the same reading the other faces show (REQ-A1926)", async () => {
    // `system_health` refused (daemon down / restarting) while the host OS battery is
    // readable. The lock screen used to keep its own daemon→host copy whose first step
    // (`await systemHealth(); if (!raw) return null;`) abandoned the host layer, so it
    // drew nothing — while StatusBar / BatteryWidget / WidgetBattery, which all consume
    // `lib/batterySources`, still showed the real host level.
    installBridge(null, { level_pct: 61, charging: false });
    const { container } = render(LockScreen);
    await tick();
    await settle();
    const b = lockBatt(container);
    expect(b).not.toBeNull();
    expect(b?.textContent ?? "").toContain("61%");
  });
});

