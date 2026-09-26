/**
 * cellularHost.test.ts — A6 蜂窝信号格：宿主读数的前端真源 + 跨语言负控。
 *
 * Why this file exists:
 *   * `lib/cellularHost.ts::radioSignalFrom` 把 `cellular_signal` 的线格式收窄成
 *     `RadioSignal`（`svelte/cellularRadio.ts` 的 store 形状）。这条映射过去**不存在** ——
 *     `setCellularRadio` 在 production 里没有调用者，于是有 SIM 的真机也永远不画信号格。
 *   * 键的分档（`1..=4`）在两端各有一份：Rust `cellular.rs` 的 fold 与这里的收窄。
 *     一条结构性负控直接读 Rust 源码，把越界读数钉成「读不到」而不是「满格」。
 *   * 诚实边界：`supported:false`（平板 / 桌面）与 `present:false`（无 SIM）都必须落到
 *     「没有 radio」这一句，绝不能拿一个编造的 `0` 冒充信号。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { radioSignalFrom } from "../cellularHost";
import { cellularService, defaultRadioSignal } from "../cellularService";
import type { CellularPrefs } from "../cellular";

const DATA_ON: CellularPrefs = { data: true, roaming: false };

describe("radioSignalFrom · 线格式收窄", () => {
  test("真机有 SIM 有信号：原样穿过 store", () => {
    expect(radioSignalFrom({ supported: true, present: true, signal: 3 })).toEqual({
      present: true,
      signal: 3,
    });
  });

  test("平板（supported:false）落到默认：不画永远不会亮的格子", () => {
    expect(radioSignalFrom({ supported: false, present: false, signal: null })).toEqual(
      defaultRadioSignal(),
    );
  });

  test("无 SIM（present:false）：即使宿主给了 signal 也不采用", () => {
    // 负控：present 是权威的「有没有 radio」，一个矛盾的高信号值不能把 tile 点亮。
    expect(radioSignalFrom({ supported: true, present: false, signal: 4 })).toEqual(
      defaultRadioSignal(),
    );
  });

  test("supported 缺失时以 present 为准（旧宿主 / 手改的回包）", () => {
    expect(radioSignalFrom({ present: true, signal: 2 })).toEqual({ present: true, signal: 2 });
  });

  test("越界或非整数读数一律成为 null（读不到），不是满格也不是 0", () => {
    // 这一组是**负控**：把 `7` 读成 `7`、把 `0` 读成 `0` 都会让界面画出设备从未报过的格数。
    for (const bad of [0, 5, 7, -1, 1.5, "3", true, undefined]) {
      expect(radioSignalFrom({ present: true, signal: bad })).toEqual({
        present: true,
        signal: null,
      });
    }
  });

  test("signal 缺失（null / 无此键）是「有 radio 但拿不到信号」", () => {
    expect(radioSignalFrom({ supported: true, present: true, signal: null })).toEqual({
      present: true,
      signal: null,
    });
    expect(radioSignalFrom({ supported: true, present: true })).toEqual({
      present: true,
      signal: null,
    });
  });

  test("不是一个带 present 的对象 → null（「问不到」而不是「无调制解调器」）", () => {
    for (const bad of [null, undefined, "no", 42, [], {}]) {
      expect(radioSignalFrom(bad)).toBeNull();
    }
  });

  test("收窄后的三个读数各自落到正确的一条服务状态", () => {
    // 端到端：映射的输出要能直接喂给 `cellularService`（而不是某些形状只是「看起来像」）。
    const connected = radioSignalFrom({ supported: true, present: true, signal: 2 })!;
    expect(cellularService(DATA_ON, connected)).toBe("connected");

    const noSignal = radioSignalFrom({ supported: true, present: true, signal: 0 })!;
    expect(cellularService(DATA_ON, noSignal)).toBe("no-signal");

    const tablet = radioSignalFrom({ supported: false, present: false, signal: null })!;
    expect(cellularService(DATA_ON, tablet)).toBe("no-radio");
  });
});

describe("蜂窝 · 跨语言负控（前端分档 == Rust fold）", () => {
  const RUST = readFileSync(new URL("../../../../src/cellular.rs", import.meta.url), "utf8");

  test("Rust fold 用 1..=4 分档 —— 与 radioSignalFrom 的收窄同一把尺", () => {
    expect(RUST).toContain("(1..=4).contains(l)");
  });

  test("Rust 侧注册的命令名就是前端调用的字面量", () => {
    // 命令名两端各写一次；`tauri-command-scan` 管「有没有消费者」，这里管
    // 「名字有没有拼错」—— 拼错时 `invoke` 只会得到 null，界面安静地保持无信号。
    expect(RUST).toContain("pub fn cellular_signal()");
  });
});
