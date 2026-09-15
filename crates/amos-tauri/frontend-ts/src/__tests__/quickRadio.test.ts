/**
 * Tests for `lib/quickRadio.ts` — the **one** implementation of a radio tap.
 *
 * Before this module the same orchestration lived inside two components, so its branches
 * could only be exercised by mounting a 458-line notification centre (or the Settings
 * screen) with a fake host. Now the commands are a port, and every branch — offline,
 * gated, managed, applied, refused, unread — is pinned here with a fake.
 *
 * What each case protects:
 *   • the device is authoritative (a reply's snapshot wins over the stored intent);
 *   • a **refused** write is shown but **not** persisted (the store must not adopt a state
 *     the device did not accept — that erases the reason the screen is explaining);
 *   • a switch the platform owns is never attempted (`radio_set` could not land);
 *   • an answer we did not get is never read as "managed", nor as a state.
 */
import { describe, expect, test } from "vitest";
import {
  HOST_RADIO_COMMANDS,
  mergeRadioQuick,
  readManagedSwitches,
  syncQuickRadios,
  tapRadio,
  type RadioCommands,
} from "../lib/quickRadio";
import type { QuickSettings } from "../lib/settings";
import type { RadioControlReply, RadioPayload, RadioSetReply } from "../lib/backend";

const RADIOS: RadioPayload = { wifi: false, bluetooth: false, airplane: false, hotspot: false };

/**
 * A fake port: every command answerable per test, and **every call recorded** — the
 * recording wraps the override, so a test that replaces `openSettings` still sees the call
 * (getting this wrong would have made "the write was never attempted" a vacuous pass).
 */
function port(over: Partial<RadioCommands> = {}): RadioCommands & { calls: string[] } {
  const calls: string[] = [];
  const d: RadioCommands = {
    set: async (key, enabled) => setReply({ radio: key, requested: enabled }),
    status: async () => RADIOS,
    control: async () => null,
    openSettings: async () => true,
  };
  const cmds: RadioCommands = {
    set: (k, e) => {
      calls.push(`set:${k}:${e}`);
      return (over.set ?? d.set)(k, e);
    },
    status: () => {
      calls.push("status");
      return (over.status ?? d.status)();
    },
    control: (k) => {
      calls.push(`control:${k}`);
      return (over.control ?? d.control)(k);
    },
    openSettings: (k) => {
      calls.push(`openSettings:${k}`);
      return (over.openSettings ?? d.openSettings)(k);
    },
  };
  return Object.assign(cmds, { calls });
}

const setReply = (over: Partial<RadioSetReply>): RadioSetReply => ({
  radio: "wifi",
  requested: true,
  applied: true,
  state: RADIOS,
  refusal: null,
  ...over,
});

const controlReply = (over: Partial<RadioControlReply> = {}): RadioControlReply =>
  ({ radio: "wifi", app_controlled: true, surface: null, ...over }) as RadioControlReply;

const settings = (s: QuickSettings = {}): QuickSettings => ({ wifi: true, ...s });

describe("mergeRadioQuick", () => {
  test("writes the device's four radios over the settings and touches nothing else", () => {
    const merged = mergeRadioQuick(
      { wifi: true, dnd: true, darkmode: false },
      { wifi: false, bluetooth: true, airplane: true, hotspot: false },
    );
    expect(merged).toEqual({
      wifi: false,
      bluetooth: true,
      airplane: true,
      hotspot: false,
      dnd: true,
      darkmode: false,
    });
  });
});

describe("syncQuickRadios / readManagedSwitches", () => {
  test("a read that answers is merged; one that does not is reported as null", async () => {
    expect(await syncQuickRadios(settings(), port())).toMatchObject({ wifi: false });
    expect(await syncQuickRadios(settings(), port({ status: async () => null }))).toBeNull();
  });

  test("the platform is asked once per radio, and an unanswered question stays null", async () => {
    const cmds = port({
      control: async (key) =>
        key === "wifi" ? controlReply({ app_controlled: false, surface: "wifi_panel" }) : null,
    });
    const ctl = await readManagedSwitches(cmds);
    expect(cmds.calls).toEqual([
      "control:wifi",
      "control:bluetooth",
      "control:airplane",
      "control:hotspot",
    ]);
    expect(ctl.wifi?.app_controlled).toBe(false);
    // A failed *question* is not an answer: the switch must not be greyed on its strength.
    expect(ctl.bluetooth).toBeNull();
    expect(ctl.airplane).toBeNull();
    expect(ctl.hotspot).toBeNull();
  });

  test("the host port is the real commands (a fake is only ever injected by a caller)", () => {
    expect(Object.keys(HOST_RADIO_COMMANDS).sort()).toEqual([
      "control",
      "openSettings",
      "set",
      "status",
    ]);
  });
});

describe("tapRadio — what the device answered decides what the store holds", () => {
  test("applied: the device's snapshot wins (the store stops disagreeing with the device)", async () => {
    const state: RadioPayload = { wifi: false, bluetooth: true, airplane: false, hotspot: false };
    const out = await tapRadio({
      key: "wifi",
      settings: settings({ wifi: true }),
      host: true,
      cmds: port({ set: async () => setReply({ state }) }),
    });
    expect(out).toMatchObject({ kind: "applied", persist: true });
    expect(out.next).toMatchObject({ wifi: false, bluetooth: true });
  });

  test("applied with no state: the settings are left as they were (nothing invented)", async () => {
    const before = settings({ dnd: true });
    const out = await tapRadio({
      key: "wifi",
      settings: before,
      host: true,
      cmds: port({ set: async () => setReply({ state: null }) }),
    });
    expect(out).toMatchObject({ kind: "applied" });
    expect(out.next).toEqual(before);
  });

  test("refused: the device's state is shown, the user's intent is NOT overwritten", async () => {
    const state: RadioPayload = { wifi: true, bluetooth: false, airplane: false, hotspot: false };
    const out = await tapRadio({
      key: "wifi",
      settings: settings({ wifi: false, dnd: true }),
      host: true,
      cmds: port({
        set: async () =>
          setReply({
            applied: false,
            state,
            refusal: {
              kind: "provider_refused",
              radio: "wifi",
              detail: "setWifiEnabled(false) failed",
            },
          }),
      }),
    });
    expect(out.kind).toBe("refused");
    expect(out.persist).toBe(false); // persisting would erase the reason being explained
    expect(out.next).toMatchObject({ wifi: true, dnd: true });
    if (out.kind !== "refused") throw new Error(`expected a refusal, got ${out.kind}`);
    expect(out.key).toBe("wifi");
    expect(out.refusal.noteKey).toBe("radio.refused.device");
  });

  test("refused with a kind nobody understands: no invented sentence", async () => {
    const out = await tapRadio({
      key: "hotspot",
      settings: settings(),
      host: true,
      cmds: port({
        set: async () => setReply({ applied: false, refusal: { kind: "brain_lock" } as never }),
      }),
    });
    if (out.kind !== "refused") throw new Error(`expected a refusal, got ${out.kind}`);
    expect(out.refusal).toEqual({ noteKey: "", surface: null });
  });

  test("refused by the airplane guard names the guard, not the radio asked", async () => {
    const out = await tapRadio({
      key: "bluetooth",
      settings: settings(),
      host: true,
      cmds: port({
        set: async () =>
          setReply({ applied: false, refusal: { kind: "airplane_active", radio: "bluetooth" } }),
      }),
    });
    if (out.kind !== "refused") throw new Error(`expected a refusal, got ${out.kind}`);
    expect(out.refusal.noteKey).toBe("radio.refused.airplaneActive");
  });

  test("the failed write is re-read: the device's answer becomes the state (intent kept)", async () => {
    const live: RadioPayload = { wifi: false, bluetooth: false, airplane: true, hotspot: false };
    const cmds = port({ set: async () => null, status: async () => live });
    const out = await tapRadio({ key: "wifi", settings: settings({ wifi: true }), host: true, cmds });
    // Nothing was confirmed, so the store keeps the user's intent (persist false) while the
    // screen shows what the device actually holds.
    expect(out).toMatchObject({ kind: "unread", persist: false });
    expect(out.next).toMatchObject({ wifi: false, airplane: true });
    expect(cmds.calls).toEqual(["set:wifi:false", "status"]);
  });

  test("nothing at all answers: the state is left exactly as it was", async () => {
    const before = settings({ bluetooth: true });
    const out = await tapRadio({
      key: "bluetooth",
      settings: before,
      host: true,
      cmds: port({ set: async () => null, status: async () => null }),
    });
    expect(out).toMatchObject({ kind: "unread" });
    expect(out.next).toEqual(before);
  });

  test("the tap asks for the opposite of the stored bit", async () => {
    const cmds = port();
    await tapRadio({ key: "hotspot", settings: { hotspot: true }, host: true, cmds });
    expect(cmds.calls).toContain("set:hotspot:false");
  });
});

describe("tapRadio — who is allowed to touch the device", () => {
  test("offline: the local policy applies (airplane cascades) and it is persisted", async () => {
    const out = await tapRadio({ key: "airplane", settings: settings({ bluetooth: true }), host: false });
    expect(out).toMatchObject({ kind: "offline", persist: true });
    expect(out.next).toEqual({ wifi: false, bluetooth: false, airplane: true, hotspot: false });
  });

  test("gated: under airplane mode the other radios are not even attempted", async () => {
    const cmds = port();
    const out = await tapRadio({ key: "wifi", settings: settings({ airplane: true }), host: true, cmds });
    expect(out).toMatchObject({ kind: "gated", persist: false });
    expect(cmds.calls).toEqual([]); // no `set`, no `status` — nothing was touched
  });

  test("managed: the system surface is opened instead of a write that cannot land", async () => {
    const cmds = port({ openSettings: async (k) => k === "wifi" });
    const out = await tapRadio({
      key: "wifi",
      settings: settings(),
      host: true,
      managed: { managed: true, noteKey: "radio.managed.wifi", surface: "wifi_panel" },
      cmds,
    });
    expect(out).toMatchObject({ kind: "managed", persist: false, opened: true, key: "wifi" });
    expect(cmds.calls).toEqual(["openSettings:wifi"]); // `radio_set` was never called
  });

  test("managed but the surface would not open: the caller is told (never a silent tap)", async () => {
    const out = await tapRadio({
      key: "bluetooth",
      settings: settings(),
      host: true,
      managed: { managed: true, noteKey: "radio.managed.bluetooth", surface: "bt_panel" },
      cmds: port({ openSettings: async () => null }),
    });
    expect(out).toMatchObject({ kind: "managed", opened: false });
  });

  test("unmanaged + no answer: the write is attempted (a failed question never greys a switch)", async () => {
    const cmds = port({ control: async () => null });
    const out = await tapRadio({ key: "wifi", settings: settings({ wifi: true }), host: true, cmds });
    expect(out).toMatchObject({ kind: "applied" });
    expect(cmds.calls).toContain("set:wifi:false");
  });
});
