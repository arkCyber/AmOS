/**
 * 一次被 **QoS 策略丢弃**的投递，不能被读成「传输层数不到订阅者」（REQ-A1541 ∕ F-SH-784）。
 *
 * `robot.ts::receiptLevel` 修前逐字
 *   `return r.delivered > 0 ? "reached" : "unknown";`
 * —— 它只看 `delivered`。而 `LinkPublishOut` 是**四**个计数：`seq` ∕ `matched` ∕ `delivered` ∕
 * `dropped`。`dropped` 逐字是「Frames dropped by a QoS policy」（`link.rs:334`，本地计数，不是
 * 网络传输那个「数不到」的 `matched`）。于是 `{ matched: 1, delivered: 0, dropped: 1 }` 这一份
 * 回执会被折成 `"unknown"`，而 `"unknown"` 的那句话逐字是
 *   「传输层数不到订阅者（0）—— 这既不是"没人收到"，也不是"已生效"。网络传输上永远是 0。」
 * —— 一句**断言了「数不到」这个原因**的话，而同一块面板上 `receiptSummary` 正逐字印着
 * `delivered=0 dropped=1`：传输层明明数到了，它数到的就是**丢了一帧**。
 *
 * 判据（同一份数据里两个字段，一个被测、一个被忽略）：`dropped` 与 `delivered` 同处一个
 * `LinkPublishOut`，Rust 侧逐字分列「accepted by a subscriber queue」与「dropped by a QoS
 * policy」，网络传输的「数不到」只落在 `matched` 上（`link.rs:332`）。`receiptLevel` 的文档自己
 * 写下了它的前置条件——「一个 0 是『数不到』……因为**控制台并不知道**」——而 `dropped > 0` 正是
 * 控制台**知道**的那种 0。
 */
import { describe, expect, test } from "bun:test";
import { receiptKey, receiptLevel, receiptSummary, type LinkPublishOut } from "../lib/robot";

/** 一帧被 QoS 策略丢弃：传输层数到了丢的这一帧，没有任何订阅者队列接受它。 */
const dropped: LinkPublishOut = { seq: 9, matched: 1, delivered: 0, dropped: 1 };

describe("REQ-A1541 — 被 QoS 丢弃的一帧要说「丢了」，不是「数不到」", () => {
  test("`delivered=0 && dropped>0` ⇒ 不是「unknown」（修前正是 unknown）", () => {
    expect(receiptLevel(dropped)).toBe("dropped");
  });

  test("它的那句话是「被丢弃」，不是「数不到订阅者」", () => {
    expect(receiptKey(receiptLevel(dropped))).toBe("robot.receiptDropped");
    expect(receiptKey(receiptLevel(dropped))).not.toBe("robot.receiptUnknown");
  });

  test("正控 · `delivered>0` 仍是「reached」，哪怕同时也有丢弃（有人收到了）", () => {
    const partial: LinkPublishOut = { seq: 3, matched: 2, delivered: 1, dropped: 1 };
    expect(receiptLevel(partial)).toBe("reached");
    expect(receiptKey(receiptLevel(partial))).toBe("robot.receiptReached");
  });

  test("正控 · 真的什么都没数到（dropped 也是 0）⇒ 仍是「unknown」", () => {
    const nothing: LinkPublishOut = { seq: 4, matched: 0, delivered: 0, dropped: 0 };
    expect(receiptLevel(nothing)).toBe("unknown");
    expect(receiptKey(receiptLevel(nothing))).toBe("robot.receiptUnknown");
  });

  test("正控 · 那条一行回执仍然把四个计数都印出来（dropped 不会被这句话藏掉）", () => {
    expect(receiptSummary(dropped)).toBe("seq=9 matched=1 delivered=0 dropped=1");
  });
});
