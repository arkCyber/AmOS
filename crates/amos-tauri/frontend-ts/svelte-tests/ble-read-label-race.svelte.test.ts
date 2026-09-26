/**
 * ble-read-label-race.svelte.test.ts — 一次 `read` 落地时把**当时的**选中特征值当成来源
 * （REQ-A1207 / FMEA F-SH-494）。
 *
 * `BleApp.svelte::read` 在 await 之后这样写标签：
 *
 *     const out = await client.read(serviceUuid, characteristicUuid);
 *     ...
 *     lastValue = { uuid: characteristicUuid.trim(), hex: bytesToHex(out.bytes) };
 *
 * 命令的**目标**是同步取的（`client.read(...)` 的两个参数在调用那一刻求值），所以读的确实是
 * 用户点下时的那个特征值；可**标签**是在 `await` 之后读的**活** `$state`。同一趟改动里，
 * 孪生函数 `toggleSubscribe` 恰恰为这件事把键**先捕获再 await**，注释逐字写着：
 *
 *     // The characteristic this request is about, captured before the await: the user may
 *     // re-point the inputs while the host is deciding, and the acknowledgement belongs to
 *     // *this* key, not to whatever is selected when the reply lands (REQ-A1178 / F-SH-471).
 *
 * 于是同一个文件里两条异步路径对同一条规则一个遵守、一个不遵守 —— 而这正是上一轮
 * （REQ-A1191 / F-SH-480）立这块招牌要治的病：**「值」这一格必须标明它的来源**。README
 * 引理再补一句：这一格的 `valueFromOther` 派生也是拿活值比的，所以它同样不会报警。
 *
 * 可达性：两个 UUID 输入框**没有** `disabled={busy !== ""}`（只有动作按钮有），用户在
 * 一次读还在路上时把特征值改掉是普通操作 —— 手打手册上的另一个 UUID、或从下方列表里点
 * 另一个特征值（`ble-characteristic-{uuid}` 也是活的）。
 *
 * 判据：一次读落地后，`ble-value` 这一格命名的必须是**这次读所针对的**特征值。
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import BleApp from "../src/svelte/BleApp.svelte";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = () => new Promise((r) => setTimeout(r, 30));
const q = (h: { container: HTMLElement }, id: string) =>
  h.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = (h: { container: HTMLElement }, id: string) => q(h, id)?.textContent ?? "";

/** A bridge whose `ble_read` answer is resolved by the test, so the in-flight window can be
 *  observed instead of guessed at. */
function installBridge() {
  let releaseRead: (() => void) | null = null;
  const invoke = async (cmd: string) => {
    switch (cmd) {
      case "ble_connect":
        return true;
      case "ble_discover_services":
        return {
          ok: true,
          services: [
            {
              uuid: "180d",
              characteristics: [
                { uuid: "2a37", properties: 0x10 }, // Notify
                { uuid: "2a38", properties: 0x02 }, // Read
              ],
            },
          ],
        };
      case "ble_read":
        // Held open until `releaseRead()` — the whole point of this suite.
        await new Promise<void>((r) => (releaseRead = r));
        return { ok: true, bytes: [1, 2, 255] };
      default:
        return null;
    }
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
  return { release: () => releaseRead?.() };
}

async function connectAndSelect(h: { container: HTMLElement }) {
  await fireEvent.input(q(h, "ble-address") as HTMLElement, {
    target: { value: "AA:BB:CC:DD:EE:FF" },
  });
  await fireEvent.click(q(h, "ble-connect") as HTMLElement);
  await settle();
  await fireEvent.input(q(h, "ble-service-uuid") as HTMLElement, { target: { value: "180d" } });
  await fireEvent.input(q(h, "ble-char-uuid") as HTMLElement, { target: { value: "2a37" } });
  await settle();
}

describe("BleApp — a reading names the characteristic the read was addressed to", () => {
  test("re-pointing the inputs while a read is in flight does not re-label its bytes", async () => {
    const { release } = installBridge();
    const h = render(BleApp);
    await connectAndSelect(h);

    // Read `2a37`, then — before the host answers — point the screen at `2a38`.
    await fireEvent.click(q(h, "ble-read") as HTMLElement);
    await fireEvent.input(q(h, "ble-char-uuid") as HTMLElement, { target: { value: "2a38" } });

    release();
    await settle();

    expect(
      text(h, "ble-value"),
      "the bytes came from the read addressed to 2a37 — the header must name it, not whatever " +
        "the inputs say when the reply lands",
    ).toContain("2a37");
    expect(text(h, "ble-value"), "the reply is not the newly selected characteristic's").not.toContain(
      "2a38",
    );
  });

  test("a read that lands with the inputs unchanged still names its characteristic", async () => {
    const { release } = installBridge();
    const h = render(BleApp);
    await connectAndSelect(h);

    await fireEvent.click(q(h, "ble-read") as HTMLElement);
    release();
    await settle();

    expect(text(h, "ble-value")).toContain("2a37");
    expect(text(h, "ble-value")).toContain("0102ff");
  });
});
