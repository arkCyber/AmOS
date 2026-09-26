/**
 * DOM tests for the Svelte 5 Bluetooth LE screen (BleApp.svelte) — the consumer half of
 * the `ble_*` bridge (7 registered commands, no caller before this screen).
 *
 * What is locked here is the **honesty** of the screen, not its pixels:
 *  • three runtimes are told apart: no adapter at all (nothing offered), the Tauri/Kotlin
 *    bridge (the real device path), and Web Bluetooth (host);
 *  • a connect that the host refuses is never rendered as connected;
 *  • an empty device address is refused **locally** — no `ble_connect` is sent;
 *  • malformed hex and a malformed characteristic UUID are refused **locally** — nothing
 *    reaches the device (negative control: the invoke log must stay empty);
 *  • a discovery is read as the bridge reports it: a device that answered with a list, a
 *    device that **failed** to answer (`ok:false` + a reason), and an empty list (a real
 *    answer) are three different outcomes, never collapsed;
 *  • values are labelled by the event they arrived on (`read` vs `notification`).
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import BleApp from "../src/svelte/BleApp.svelte";
import { zh } from "../src/i18n/locales/zh";

/** Assert against the dictionary the screen actually renders (see the NFC suite). */
const T = (key: string): string => (zh as unknown as Record<string, string>)[key] ?? key;

/** The dictionary holds `{param}` placeholders; `t()` interpolates them at render time. */
const TP = (key: string, params: Record<string, string>): string =>
  Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, v), T(key));

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = () => new Promise((r) => setTimeout(r, 30));
const q = (h: { container: HTMLElement }, id: string) =>
  h.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

interface BridgeOpts {
  /** `null` = the host did not answer the command at all (`invoke` resolves `null`). */
  connect?: boolean | null;
  disconnect?: boolean | null;
  services?: unknown;
  read?: unknown;
  write?: unknown;
  subscribe?: boolean | null;
  unsubscribe?: boolean | null;
  /** The host refuses the `ble-value-changed` listen — `subscribe()` answers `null`. */
  listenRefused?: boolean;
}

/** `undefined` = "not configured"; an explicit `null` means the host answered nothing. */
const answer = <T,>(v: T | null | undefined, dflt: T): T | null =>
  v === undefined ? dflt : v;

function installBridge(opts: BridgeOpts = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const channels = new Map<string, (e: { payload: unknown }) => void>();

  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "ble_connect":
        return answer(opts.connect, true);
      case "ble_disconnect":
        return answer(opts.disconnect, true);
      case "ble_discover_services":
        // Heart Rate (0x180d) and Battery (0x180f), with the characteristics each really
        // carries and the property bits the platform reports for them. A fixture that omitted
        // `characteristics` would let the screen's own read of it crash instead of fail (and is
        // the shape that once hid a missing field entirely).
        return opts.services === undefined
          ? {
              ok: true,
              services: [
                {
                  uuid: "180d",
                  characteristics: [
                    { uuid: "2a37", properties: 0x10 }, // Notify
                    { uuid: "2a38", properties: 0x02 }, // Read
                    { uuid: "2a39", properties: 0x08 }, // Write
                  ],
                },
                {
                  uuid: "180f",
                  characteristics: [{ uuid: "2a19", properties: 0x12 }], // Read + Notify
                },
              ],
            }
          : opts.services;
      case "ble_read":
        return opts.read === undefined ? { ok: true, bytes: [1, 2, 255] } : opts.read;
      case "ble_write":
        return opts.write === undefined ? { ok: true } : opts.write;
      case "ble_subscribe":
        return answer(opts.subscribe, true);
      case "ble_unsubscribe":
        return answer(opts.unsubscribe, true);
      default:
        return null;
    }
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
      // `backend.subscribe` reads a non-function return as "the host refused" (`listen-failed`),
      // which is what makes `bleOnValueChanged` answer `null`.
      if (opts.listenRefused) return null;
      channels.set(channel, handler);
      return () => {};
    },
  };

  return {
    calls,
    value: (payload: unknown) => channels.get("ble-value-changed")?.({ payload }),
  };
}

/** Drive the screen to a connected state with a service + characteristic selected. */
async function connectAndSelect(h: { container: HTMLElement }) {
  await fireEvent.input(q(h, "ble-address") as HTMLElement, {
    target: { value: "AA:BB:CC:DD:EE:FF" },
  });
  await fireEvent.click(q(h, "ble-connect") as HTMLElement);
  await settle();
  await fireEvent.input(q(h, "ble-service-uuid") as HTMLElement, { target: { value: "180d" } });
  await fireEvent.input(q(h, "ble-char-uuid") as HTMLElement, {
    target: { value: "2a37" },
  });
  await settle();
}

describe("BleApp — runtime detection", () => {
  test("no bridge and no Web Bluetooth: unavailable, nothing offered", async () => {
    const h = render(BleApp);
    await settle();
    expect(q(h, "ble-unavailable")).not.toBeNull();
    expect(q(h, "ble-connect")).toBeNull();
    expect(q(h, "ble-log")).toBeNull();
  });

  test("the Tauri bridge is named as the device path", async () => {
    installBridge();
    const h = render(BleApp);
    await settle();
    expect(q(h, "ble-adapter")?.textContent).toContain(T("ble.adapterTauri"));
    expect(q(h, "ble-connection")?.textContent).toContain(T("ble.disconnected"));
  });
});

describe("BleApp — connecting is reported as it happened", () => {
  test("an empty address is refused locally, with no command sent", async () => {
    const b = installBridge();
    const h = render(BleApp);
    await settle();
    await fireEvent.click(q(h, "ble-connect") as HTMLElement);
    await settle();
    expect(q(h, "ble-notice")?.textContent).toContain(T("ble.addressRequired"));
    expect(b.calls.some((c) => c.cmd === "ble_connect")).toBe(false);
    expect(q(h, "ble-connection")?.textContent).toContain(T("ble.disconnected"));
  });

  test("a refused connect never renders as connected", async () => {
    const b = installBridge({ connect: false });
    const h = render(BleApp);
    await settle();
    await fireEvent.input(q(h, "ble-address") as HTMLElement, {
      target: { value: "AA:BB:CC:DD:EE:FF" },
    });
    await fireEvent.click(q(h, "ble-connect") as HTMLElement);
    await settle();
    expect(b.calls.some((c) => c.cmd === "ble_connect")).toBe(true);
    expect(q(h, "ble-connection")?.textContent).toContain(T("ble.disconnected"));
    expect(q(h, "ble-connect")).not.toBeNull(); // still offering to connect
    expect(q(h, "ble-disconnect")).toBeNull();
  });

  test("a refused disconnect is not rendered as a disconnection", async () => {
    // The defect this pins: `disconnect()` moved `connected = false`, cleared the discovered
    // services and wrote 「已断开连接」 into the log even when the host answered `false` — the
    // one honest line being `ble.disconnectFailed`, which says 「系统没有确认」. The badge and
    // the log thus claimed a transition the notice denied, and the GATT client was still live
    // (REQ-A1162 / F-SH-461). `toggleSubscribe` already applies this rule to an unsubscribe.
    const b = installBridge({ disconnect: false });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-disconnect") as HTMLElement);
    await settle();
    expect(b.calls.some((c) => c.cmd === "ble_disconnect")).toBe(true);
    // The host did not confirm: the screen must not claim it is disconnected.
    expect(q(h, "ble-connection")?.textContent).toContain(T("ble.connected"));
    expect(q(h, "ble-disconnect")).not.toBeNull();
    expect(q(h, "ble-notice")?.textContent).toContain(T("ble.disconnectFailed"));
    // …and the log must not record a disconnection that did not happen.
    expect(h.container.textContent ?? "").not.toContain(T("ble.logDisconnected"));
  });

  test("a successful connect switches the screen to the connected surface", async () => {
    const b = installBridge({ connect: true });
    const h = render(BleApp);
    await settle();
    await fireEvent.input(q(h, "ble-address") as HTMLElement, {
      target: { value: "AA:BB:CC:DD:EE:FF" },
    });
    await fireEvent.click(q(h, "ble-connect") as HTMLElement);
    await settle();
    expect(q(h, "ble-connection")?.textContent).toContain(T("ble.connected"));
    expect(q(h, "ble-disconnect")).not.toBeNull();
    expect(b.calls.find((c) => c.cmd === "ble_connect")?.args?.address).toBe("AA:BB:CC:DD:EE:FF");
  });

  test("discover lists the services the host returned and fills the selected uuid", async () => {
    const b = installBridge();
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-discover") as HTMLElement);
    await settle();
    expect(b.calls.some((c) => c.cmd === "ble_discover_services")).toBe(true);
    expect(q(h, "ble-service-180d")).not.toBeNull();
    expect(q(h, "ble-service-180f")).not.toBeNull();
    await fireEvent.click(q(h, "ble-service-180f") as HTMLElement);
    await settle();
    expect((q(h, "ble-service-uuid") as HTMLInputElement).value).toBe("180f");
  });

  test("a discovery the device failed to answer is a failure, not 'no services'", async () => {
    // The defect this pins: the old command answered `[]` when it could not obtain a list,
    // so the screen rendered an empty service list as if the device had none (REQ-A1157).
    installBridge({ services: { ok: false, error: "no service list within 5s" } });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-discover") as HTMLElement);
    await settle();
    expect(q(h, "ble-notice")?.textContent).toContain(
      TP("ble.discoverFailed", { error: "no service list within 5s" }),
    );
    expect(q(h, "ble-notice")?.textContent).not.toContain(T("ble.discovered"));
    expect(q(h, "ble-no-services")).not.toBeNull();
  });

  test("an empty list the device really returned is still a successful discovery", async () => {
    installBridge({ services: { ok: true, services: [] } });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-discover") as HTMLElement);
    await settle();
    expect(q(h, "ble-notice")?.textContent).toContain(T("ble.discovered"));
    expect(q(h, "ble-no-services")).not.toBeNull();
  });
});


describe("BleApp — GATT actions validate locally before touching the device", () => {
  test("read is disabled until connected with both uuids", async () => {
    installBridge();
    const h = render(BleApp);
    await settle();
    expect((q(h, "ble-read") as HTMLButtonElement).disabled).toBe(true);
    await connectAndSelect(h);
    expect((q(h, "ble-read") as HTMLButtonElement).disabled).toBe(false);
  });

  test("a malformed characteristic uuid keeps read/subscribe disabled", async () => {
    const b = installBridge();
    const h = render(BleApp);
    await settle();
    await fireEvent.input(q(h, "ble-address") as HTMLElement, {
      target: { value: "AA:BB:CC:DD:EE:FF" },
    });
    await fireEvent.click(q(h, "ble-connect") as HTMLElement);
    await settle();
    await fireEvent.input(q(h, "ble-service-uuid") as HTMLElement, { target: { value: "180d" } });
    await fireEvent.input(q(h, "ble-char-uuid") as HTMLElement, { target: { value: "not-a-uuid" } });
    await settle();
    expect((q(h, "ble-read") as HTMLButtonElement).disabled).toBe(true);
    expect((q(h, "ble-subscribe") as HTMLButtonElement).disabled).toBe(true);
    expect(b.calls.some((c) => c.cmd === "ble_read")).toBe(false);
  });

  test("read shows the hex the host returned, and a failed read shows its error", async () => {
    installBridge({ read: { ok: true, bytes: [1, 2, 255] } });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-read") as HTMLElement);
    await settle();
    expect(q(h, "ble-value")?.textContent).toContain("0102ff");

    cleanup();
    installBridge({ read: { ok: false, error: "gatt 137" } });
    const h2 = render(BleApp);
    await settle();
    await connectAndSelect(h2);
    await fireEvent.click(q(h2, "ble-read") as HTMLElement);
    await settle();
    expect(q(h2, "ble-notice")?.textContent).toContain("gatt 137");
    expect(q(h2, "ble-value")?.textContent).toContain(T("ble.noValue"));
  });

  test("malformed hex is refused locally — nothing is written to the device", async () => {
    const b = installBridge();
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.input(q(h, "ble-write-hex") as HTMLElement, { target: { value: "0g" } });
    await fireEvent.click(q(h, "ble-write") as HTMLElement);
    await settle();
    expect(q(h, "ble-notice")?.textContent).toContain(T("ble.invalidHex"));
    expect(b.calls.some((c) => c.cmd === "ble_write")).toBe(false);
  });
});


describe("BleApp — more GATT actions and value labelling", () => {
  test("the value header names the characteristic the reading came from", async () => {
    // The defect this pins: `valueHex` was one unlabelled slot that any frame overwrote —
    // a read of the selected characteristic, or a notification from *any* subscribed one. With
    // `2a38` selected, a frame from `2a37` silently became 「值」 under inputs that name `2a38`,
    // and nothing on screen said whose bytes those were (REQ-A1191 / F-SH-480).
    const b = installBridge({ read: { ok: true, bytes: [0x0a] } });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);

    b.value({ event: "notification", uuid: "2a37", value: [0x0a] });
    await settle();
    expect(q(h, "ble-value")?.textContent).toContain("2a37");
    expect(q(h, "ble-value")?.textContent).toContain("0a");

    // Re-point the selection: the frame that arrives now is still `2a37`'s, and the surface
    // must keep saying so rather than presenting it as the selected characteristic's value.
    await fireEvent.input(q(h, "ble-char-uuid") as HTMLElement, { target: { value: "2a38" } });
    await settle();
    b.value({ event: "notification", uuid: "2a37", value: [0x0b] });
    await settle();
    expect(q(h, "ble-value")?.textContent).toContain("2a37");
    expect(q(h, "ble-value-other")).not.toBeNull();

    // …and a read of the *selected* characteristic is attributed to it, with no such note.
    await fireEvent.click(q(h, "ble-read") as HTMLElement);
    await settle();
    expect(q(h, "ble-value")?.textContent).toContain("2a38");
    expect(q(h, "ble-value")?.textContent).toContain("0a");
    expect(q(h, "ble-value-other")).toBeNull();
    expect(b.calls.some((c) => c.cmd === "ble_read")).toBe(true);
  });

  test("a valid write sends the parsed bytes and the with-response flag", async () => {
    const b = installBridge({ write: { ok: true } });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.input(q(h, "ble-write-hex") as HTMLElement, { target: { value: "01a2" } });
    await fireEvent.click(q(h, "ble-write-response") as HTMLElement);
    await fireEvent.click(q(h, "ble-write") as HTMLElement);
    await settle();
    const call = b.calls.find((c) => c.cmd === "ble_write");
    expect(call?.args?.value).toEqual([0x01, 0xa2]);
    expect(call?.args?.withResponse).toBe(true);
    expect(call?.args?.serviceUuid).toBe("180d");
    expect(call?.args?.characteristicUuid).toBe("2a37");
    expect(q(h, "ble-notice")?.textContent).toContain(TP("ble.writeOk", { n: "2" }));
  });

  test("a refused write surfaces the bridge's error and claims nothing", async () => {
    installBridge({ write: { ok: false, error: "writeCharacteristic refused" } });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.input(q(h, "ble-write-hex") as HTMLElement, { target: { value: "01" } });
    await fireEvent.click(q(h, "ble-write") as HTMLElement);
    await settle();
    expect(q(h, "ble-notice")?.textContent).toContain("writeCharacteristic refused");
    expect(q(h, "ble-notice")?.textContent).not.toContain(T("ble.writeOk"));
  });

  test("subscribe and unsubscribe both reach the host", async () => {
    const b = installBridge();
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();
    expect(b.calls.some((c) => c.cmd === "ble_subscribe")).toBe(true);
    expect(q(h, "ble-notice")?.textContent).toContain(T("ble.subscribed"));
    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();
    expect(b.calls.some((c) => c.cmd === "ble_unsubscribe")).toBe(true);
    expect(q(h, "ble-notice")?.textContent).toContain(T("ble.unsubscribed"));
  });

  test("a refused unsubscribe leaves the toggle subscribed, not silently off", async () => {
    // The defect this pins: `notifying = ok && want` folds a *refused* unsubscribe into
    // `false`, so the screen read 「订阅」 with `aria-pressed=false` for a stream the device
    // was still sending — the values kept arriving in the log under a button offering to
    // subscribe (REQ-A1161 / F-SH-460).
    const b = installBridge({ subscribe: true, unsubscribe: false });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();
    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("true");
    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();
    expect(b.calls.some((c) => c.cmd === "ble_unsubscribe")).toBe(true);
    // The device never acknowledged the unsubscribe: it is still notifying, so the
    // control must not claim otherwise.
    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("true");
    expect(q(h, "ble-subscribe")?.textContent).toContain(T("ble.unsubscribe"));
    expect(q(h, "ble-notice")?.textContent).toContain(T("ble.unsubscribeFailed"));
    expect(q(h, "ble-notice")?.textContent).not.toContain(T("ble.unsubscribed"));
  });

  test("the subscribe toggle answers about the selected characteristic, not the last one", async () => {
    // The defect this pins: `notifying` was one flag for the whole screen, while the
    // characteristic it describes is freely editable. Subscribe on `2a37`, then select
    // `2a38`: the button still read 「取消订阅」 with `aria-pressed=true` for a
    // characteristic that was never subscribed — and pressing it sent
    // `unsubscribe(2a38)`, whose vacuous success flipped the screen back to 「订阅」
    // while `2a37` kept notifying, re-opening REQ-A1161 through a second door
    // (REQ-A1178 / F-SH-471).
    installBridge({ subscribe: true, unsubscribe: true });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();
    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("true");

    await fireEvent.input(q(h, "ble-char-uuid") as HTMLElement, { target: { value: "2a38" } });
    await settle();
    // A characteristic that was never subscribed must not read as subscribed.
    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("false");
    expect(q(h, "ble-subscribe")?.textContent).toContain(T("ble.subscribe"));
    expect(q(h, "ble-subscribe")?.textContent).not.toContain(T("ble.unsubscribe"));

    await fireEvent.input(q(h, "ble-char-uuid") as HTMLElement, { target: { value: "2a37" } });
    await settle();
    // …and returning to the one that was stays subscribed.
    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("true");
  });

  test("a subscription survives the same UUID written in another case", async () => {
    // The defect this pins: `selKey` joins the two inputs with `.trim()` only, so the
    // subscription's identity is case-*sensitive* while `isPlausibleBleUuid` accepts
    // `[0-9a-fA-F]` — the inputs are case-insensitive by validation and case-sensitive by
    // identity. `sameUuid` (added for the value label, REQ-A1191) sits two lines from that
    // join and normalizes case; the join beside it does not. So subscribe on `2a37`, then
    // write the same characteristic as `2A37` — as a device manual does — and the screen
    // answers 「订阅」 with `aria-pressed=false` for a characteristic the device is still
    // notifying on, while the log keeps filling with its values. The next click
    // "subscribes" a second copy, and unsubscribing that copy leaves the first entry
    // standing, so the button reads 「取消订阅」 for a device that was just told to stop.
    // REQ-A1199 / F-SH-489.
    installBridge({ subscribe: true, unsubscribe: true });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();
    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("true");

    await fireEvent.input(q(h, "ble-char-uuid") as HTMLElement, { target: { value: "2A37" } });
    await settle();
    // Same characteristic, different spelling — the host's acknowledgement still stands.
    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("true");
    expect(q(h, "ble-subscribe")?.textContent).toContain(T("ble.unsubscribe"));

    // …and one unsubscribe stops it once: writing it back in the original case must read
    // as unsubscribed, not as the leftover duplicate entry.
    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();
    await fireEvent.input(q(h, "ble-char-uuid") as HTMLElement, { target: { value: "2a37" } });
    await settle();
    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("false");
  });

  test("a read result and a notification are not conflated in the log", async () => {
    const b = installBridge();
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    b.value({ event: "read_result", uuid: "2a37", value: [0x0a] });
    b.value({ event: "notification", uuid: "2a37", value: [0x0b] });
    await settle();
    const rows = [...h.container.querySelectorAll('[data-testid="ble-log-row"]')]
      .map((r) => r.textContent ?? "")
      .filter((r) => r.includes("2a37"));
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.includes("0a"))).toBe(true);
    expect(rows.some((r) => r.includes("0b"))).toBe(true);
    const body = h.container.textContent ?? "";
    expect(body).toContain("read");
    expect(body).toContain("notification");
  });

  test("a status frame without a uuid is not shown as a value", async () => {
    const b = installBridge();
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    b.value({ event: "connected" });
    b.value({ event: "services_discovered" });
    await settle();
    // Only the connect row: no fake value row may come out of a status frame.
    expect(h.container.querySelectorAll('[data-testid="ble-log-row"]').length).toBe(1);
  });

  test("the log can be cleared", async () => {
    const b = installBridge();
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    b.value({ event: "notification", uuid: "2a37", value: [1] });
    await settle();
    await fireEvent.click(q(h, "ble-clear-log") as HTMLElement);
    await settle();
    expect(q(h, "ble-log-empty")).not.toBeNull();
  });
});

describe("BleApp — the device's described characteristics gate the controls", () => {
  test("each discovered service lists its characteristics, and picking one fills both uuids", async () => {
    // The defect this pins: discovery answered with services only, so the screen could
    // enumerate services but not their characteristics — the user copied a characteristic UUID
    // out of the device's manual, and every action looked available until the device refused it
    // (REQ-A1198 / F-SH-487).
    const b = installBridge();
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-discover") as HTMLElement);
    await settle();

    expect(q(h, "ble-service-180d")?.textContent).toContain(TP("ble.characteristics", { n: "3" }));
    await fireEvent.click(q(h, "ble-service-180d") as HTMLElement);
    await settle();
    expect(q(h, "ble-characteristic-2a37")).not.toBeNull();
    expect(q(h, "ble-characteristic-2a38")).not.toBeNull();
    // The row carries the device's own vocabulary for what the characteristic permits.
    expect(q(h, "ble-characteristic-2a37")?.textContent).toContain(T("ble.prop.notify"));

    await fireEvent.click(q(h, "ble-characteristic-2a38") as HTMLElement);
    await settle();
    expect((q(h, "ble-service-uuid") as HTMLInputElement).value).toBe("180d");
    expect((q(h, "ble-char-uuid") as HTMLInputElement).value).toBe("2a38");
    expect(b.calls.some((c) => c.cmd === "ble_read")).toBe(false); // picking is not acting
    // …and the selected characteristic's capabilities are spelled out beside the controls.
    expect(q(h, "ble-caps")?.textContent).toContain(
      TP("ble.capabilities", { caps: T("ble.prop.read") }),
    );
  });

  test("a read-only characteristic disables subscribe and write", async () => {
    installBridge();
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-discover") as HTMLElement);
    await settle();
    await fireEvent.click(q(h, "ble-characteristic-2a38") as HTMLElement); // Read
    await settle();
    expect((q(h, "ble-read") as HTMLButtonElement).disabled).toBe(false);
    expect((q(h, "ble-subscribe") as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(q(h, "ble-write-hex") as HTMLElement, { target: { value: "01" } });
    await settle();
    expect((q(h, "ble-write") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a notify-only characteristic disables read and write but keeps subscribe", async () => {
    installBridge();
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-discover") as HTMLElement);
    await settle();
    await fireEvent.click(q(h, "ble-characteristic-2a37") as HTMLElement); // Notify
    await settle();
    expect((q(h, "ble-subscribe") as HTMLButtonElement).disabled).toBe(false);
    expect((q(h, "ble-read") as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(q(h, "ble-write-hex") as HTMLElement, { target: { value: "01" } });
    await settle();
    expect((q(h, "ble-write") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a write-without-response bit carries the write until the user asks for a response", async () => {
    // A with-response write is a Write *Request*; a device that advertises only
    // `PROPERTY_WRITE_NO_RESPONSE` refuses one. The gate therefore follows the toggle as well
    // as the characteristic, which is why it is re-evaluated rather than read once.
    installBridge({
      services: {
        ok: true,
        services: [{ uuid: "180d", characteristics: [{ uuid: "2a39", properties: 0x04 }] }],
      },
    });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-discover") as HTMLElement);
    await settle();
    await fireEvent.input(q(h, "ble-char-uuid") as HTMLElement, { target: { value: "2a39" } });
    await fireEvent.input(q(h, "ble-write-hex") as HTMLElement, { target: { value: "01" } });
    await settle();
    expect((q(h, "ble-write") as HTMLButtonElement).disabled).toBe(false);

    await fireEvent.click(q(h, "ble-write-response") as HTMLElement);
    await settle();
    expect((q(h, "ble-write") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a characteristic the device never described keeps every action offered", async () => {
    // The other half of the gate: **no description is not a denial**. A hand-typed UUID the
    // payload does not carry must behave exactly as it did before the device's bits were read —
    // only the device can answer for a characteristic it never described, and this screen
    // inventing a refusal there would disable worked actions.
    installBridge({ services: { ok: true, services: [{ uuid: "180d", characteristics: [] }] } });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-discover") as HTMLElement);
    await settle();
    expect(q(h, "ble-caps")).toBeNull();
    expect((q(h, "ble-read") as HTMLButtonElement).disabled).toBe(false);
    expect((q(h, "ble-subscribe") as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.input(q(h, "ble-write-hex") as HTMLElement, { target: { value: "01" } });
    await settle();
    expect((q(h, "ble-write") as HTMLButtonElement).disabled).toBe(false);
  });

  test("stopping an acknowledged subscription is never gated by the device's bits", async () => {
    // The gate is on **starting** a stream, never on stopping one. A later discovery that no
    // longer reports the characteristic as notifiable must not strand a live stream behind a
    // disabled button: the device would keep pushing with no way to tell it to stop.
    const opts: BridgeOpts = { subscribe: true };
    installBridge(opts);
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-discover") as HTMLElement);
    await settle();
    await fireEvent.click(q(h, "ble-characteristic-2a37") as HTMLElement); // Notify
    await settle();
    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();
    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("true");

    // The device is re-discovered as read-only — the stream it acknowledged is still live.
    opts.services = {
      ok: true,
      services: [{ uuid: "180d", characteristics: [{ uuid: "2a37", properties: 0x02 }] }],
    };
    await fireEvent.click(q(h, "ble-discover") as HTMLElement);
    await settle();
    expect(q(h, "ble-caps")?.textContent).toContain(T("ble.prop.read"));
    expect((q(h, "ble-subscribe") as HTMLButtonElement).disabled).toBe(false);
    expect(q(h, "ble-subscribe")?.textContent).toContain(T("ble.unsubscribe"));
  });
});

describe("BleApp — lifetime", () => {
  test("unmounting disconnects a live GATT connection", async () => {
    const b = installBridge();
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    h.unmount();
    await settle();
    expect(b.calls.some((c) => c.cmd === "ble_disconnect")).toBe(true);
  });

  test("unmounting without a connection sends nothing", async () => {
    const b = installBridge();
    const h = render(BleApp);
    await settle();
    h.unmount();
    await settle();
    expect(b.calls.some((c) => c.cmd === "ble_disconnect")).toBe(false);
  });
});

describe("BleApp — a refused value channel is stated, not promised away", () => {
  test("with no value sink the screen says so, and a subscribe promises no log", async () => {
    installBridge({ listenRefused: true });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);

    // The limitation is on screen before any action is taken.
    expect(q(h, "ble-sink-lost")?.textContent).toContain(T("ble.sinkLost"));

    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();
    // The device acked (ble_subscribe answered true), so the toggle is subscribed — but the
    // notice must not claim values will appear, because nothing can deliver them.
    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("true");
    const notice = q(h, "ble-notice")?.textContent ?? "";
    expect(notice).toContain(T("ble.subscribedNoSink"));
    expect(notice).not.toContain(T("ble.subscribed"));
  });

  test("a live value channel keeps the ordinary promise and shows no limitation", async () => {
    installBridge();
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);

    expect(q(h, "ble-sink-lost")).toBeNull();

    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();
    expect(q(h, "ble-notice")?.textContent).toContain(T("ble.subscribed"));
    expect(q(h, "ble-notice")?.textContent).not.toContain(T("ble.subscribedNoSink"));
  });
});


/**
 * 「宿主没作答」必须与「设备拒绝」分开（REQ-A1337 / F-SH-603）。
 *
 * `invoke` 从不 reject，被拒 ∕ 无回包一律 resolve `null`；而 `lib/ble.ts` 把七个可被拒绝的读
 * 折成了值（四个 `?? false`、三处合成的 `{ ok: false, error: "not bridged" }`），于是本屏
 * 把「我们的命令被拒」画成了关于**远端设备**的断言：`ble.connectFailed` 说「设备拒绝或超出了
 * 范围」，`ble.subscribeFailed` 说「订阅被设备拒绝」，`ble.unsubscribeFailed` 更直接断言
 * 「设备仍在推送」—— 这三句都指名设备是拒绝者，而设备从来没被问过。
 */
describe("BleApp — 宿主没作答（REQ-A1337 / F-SH-603）", () => {
  const deviceClaims = new Set([
    T("ble.connectFailed"),
    T("ble.subscribeFailed"),
    T("ble.unsubscribeFailed"),
  ]);

  test("宿主没答 connect ⇒ 说「宿主未作答」，绝不指名设备", async () => {
    const b = installBridge({ connect: null });
    const h = render(BleApp);
    await settle();
    await fireEvent.input(q(h, "ble-address") as HTMLElement, {
      target: { value: "AA:BB:CC:DD:EE:FF" },
    });
    await fireEvent.click(q(h, "ble-connect") as HTMLElement);
    await settle();

    expect(b.calls.some((c) => c.cmd === "ble_connect")).toBe(true);
    const notice = q(h, "ble-notice")?.textContent ?? "";
    expect(notice).toContain(T("ble.connectUnanswered"));
    expect([...deviceClaims].some((s) => notice.includes(s))).toBe(false);
    // 没答成"连上了"，就不许画成已连接。
    expect(q(h, "ble-connection")?.textContent).toContain(T("ble.disconnected"));
    expect(q(h, "ble-disconnect")).toBeNull();
  });

  test("宿主没答 disconnect ⇒ 不画成已断开，也不说「系统没有确认」", async () => {
    installBridge({ disconnect: null });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-disconnect") as HTMLElement);
    await settle();

    expect(q(h, "ble-connection")?.textContent).toContain(T("ble.connected"));
    const notice = q(h, "ble-notice")?.textContent ?? "";
    expect(notice).toContain(T("ble.disconnectUnanswered"));
    expect(notice).not.toContain(T("ble.disconnectFailed"));
    expect(h.container.textContent ?? "").not.toContain(T("ble.logDisconnected"));
  });

  test("宿主没答 subscribe ⇒ 说「宿主未作答」，不把它当已订阅，也不说设备拒绝", async () => {
    installBridge({ subscribe: null });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();

    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("false");
    expect(q(h, "ble-subscribe")?.textContent).toContain(T("ble.subscribe"));
    const notice = q(h, "ble-notice")?.textContent ?? "";
    expect(notice).toContain(T("ble.subscribeUnanswered"));
    expect(notice).not.toContain(T("ble.subscribeFailed"));
    expect(notice).not.toContain(T("ble.subscribed"));
  });

  test("宿主没答 unsubscribe ⇒ 提示里不许断言「设备仍在推送」", async () => {
    installBridge({ subscribe: true, unsubscribe: null });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();
    await fireEvent.click(q(h, "ble-subscribe") as HTMLElement);
    await settle();

    // 没答成取消，就不能当作取消：控件仍显示已订阅。
    expect(q(h, "ble-subscribe")?.getAttribute("aria-pressed")).toBe("true");
    const notice = q(h, "ble-notice")?.textContent ?? "";
    expect(notice).toContain(T("ble.unsubscribeUnanswered"));
    expect(notice).not.toContain(T("ble.unsubscribeFailed"));
    expect(notice).not.toContain(T("ble.unsubscribed"));
  });

  test("宿主没答 read ∕ write ⇒ 说「宿主未作答」，不印本侧杜撰的原因，也不进记录", async () => {
    installBridge({ read: null, write: null });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);

    await fireEvent.click(q(h, "ble-read") as HTMLElement);
    await settle();
    let notice = q(h, "ble-notice")?.textContent ?? "";
    expect(notice).toContain(T("ble.readUnanswered"));
    expect(notice).not.toContain("not bridged");
    // 没答成"读到了"，就不许把任何字节画成读数。
    expect(q(h, "ble-value")?.textContent).toContain(T("ble.noValue"));

    await fireEvent.input(q(h, "ble-write-hex") as HTMLElement, { target: { value: "01" } });
    await fireEvent.click(q(h, "ble-write") as HTMLElement);
    await settle();
    notice = q(h, "ble-notice")?.textContent ?? "";
    expect(notice).toContain(T("ble.writeUnanswered"));
    expect(notice).not.toContain("not bridged");
    expect(h.container.textContent ?? "").not.toContain(TP("ble.writeOk", { n: "1" }));
  });

  test("宿主没答 discover ⇒ 「没有拿到服务列表」，而不是本侧杜撰的失败原因", async () => {
    installBridge({ services: null });
    const h = render(BleApp);
    await settle();
    await connectAndSelect(h);
    await fireEvent.click(q(h, "ble-discover") as HTMLElement);
    await settle();

    const notice = q(h, "ble-notice")?.textContent ?? "";
    expect(notice).toContain(T("ble.discoveryUnavailable"));
    expect(notice).not.toContain("not bridged");
    expect(notice).not.toContain(T("ble.discovered"));
  });
});
