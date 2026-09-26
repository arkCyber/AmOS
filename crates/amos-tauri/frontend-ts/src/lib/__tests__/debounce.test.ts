/**
 * debounce.test.ts — 防抖工具函数测试
 *
 * 注意：使用真实定时器，因为 Bun 不支持 vi.useFakeTimers()
 *
 * 因此**每一条判断都由墙上时钟决定**，这就带来一个陷阱：用例原本用「睡一段时间再看」来
 * 判断「触发了没有／还没触发」，而窗口只有 5–10 ms 宽（50 ms 防抖 vs 20 ms∕60 ms 的等待）。
 * 机器一忙，睡眠就会超时越界，判断随之翻转 —— `应该防抖后续调用` 的两次 `wait(20)` 累计
 * 一旦超过 50 ms，第三次调用就不再被防抖，于是「仍然只有第一次」变成 2 次：
 * 它在 3915 条用例的整批运行里**两次皆红**，单独跑却 20/20 全绿（REQ-A1151 / F-SH-456）。
 *
 * 现在的两条规则让判断与负载无关：
 * - **到达窗**（「必须已触发」）不再猜时间，改用 `waitFor` 轮询真实事件，判据是事件本身；
 * - **保持窗**（「必须还没触发」）把防抖间隔抬到 `DELAY`，而睡眠只占它的很小一部分，
 *   每个判决的余量 ≥ 140 ms —— 调度抖动跨不过去。
 * 每个用例钉住的语义（谁被执行、执行几次、带着哪个参数）一字未改。
 */

import { describe, it, expect, mock } from "bun:test";
import { debounce, debounceCancellable, debounceLeading } from "../utils/debounce";

// 辅助函数：等待指定时间
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等到条件成立，或抛错。
 *
 * 「事件到达了没有」是**事件自己**回答的问题：轮询它，而不是猜一个睡眠时长。超时值是
 * 兜底（防止一个再也到不了的事件把套件挂死），不是判据 —— 正常情况下 `waitFor` 在事件
 * 发生的当下就返回。
 */
const waitFor = async (cond: () => boolean, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!cond() && Date.now() < deadline) await wait(5);
  if (!cond()) throw new Error(`waitFor 超时（${timeout}ms）：被等待的事件没有发生`);
};

/** 防抖间隔。抬到 200 ms 是为了让「还没触发」的睡眠余量 ≥ 140 ms。 */
const DELAY = 200;
/** 长延迟用例的间隔。 */
const LONG_DELAY = 400;
/** 自动保存场景的间隔。 */
const AUTOSAVE_DELAY = 320;

describe("debounce", () => {
  it("应该延迟执行函数", async () => {
    const fn = mock();
    const debounced = debounce(fn, DELAY);

    debounced("test");
    expect(fn).not.toHaveBeenCalled();

    await wait(60); // 60 ms ≪ 200 ms：还没到
    expect(fn).not.toHaveBeenCalled();

    await waitFor(() => fn.mock.calls.length === 1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("test");
  });

  it("应该取消之前的调用", async () => {
    const fn = mock();
    const debounced = debounce(fn, DELAY);

    debounced("first");
    await wait(40);

    debounced("second");
    await wait(40);

    debounced("third");
    await waitFor(() => fn.mock.calls.length === 1);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("third");
  });

  it("应该传递正确的参数", async () => {
    const fn = mock();
    const debounced = debounce(fn, DELAY);

    debounced(1, "test", { key: "value" }, [1, 2, 3]);
    await waitFor(() => fn.mock.calls.length === 1);

    expect(fn).toHaveBeenCalledWith(1, "test", { key: "value" }, [1, 2, 3]);
  });

  it("应该保持 this 上下文", async () => {
    let result: number | undefined;
    const obj = {
      value: 42,
      fn: function (this: any, x: number) {
        result = this.value + x;
        return result;
      },
    };

    const debounced = debounce(obj.fn, DELAY);
    debounced.call(obj, 8);

    await waitFor(() => result !== undefined);
    expect(result).toBe(50);
  });

  it("应该支持多次独立调用", async () => {
    const fn = mock();
    const debounced = debounce(fn, DELAY);

    debounced("first");
    await waitFor(() => fn.mock.calls.length === 1);
    await wait(DELAY + 100); // 让下一次调用落在一个新的窗口里

    debounced("second");
    await waitFor(() => fn.mock.calls.length === 2);

    expect(fn.mock.calls[0]).toEqual(["first"]);
    expect(fn.mock.calls[1]).toEqual(["second"]);
  });

  it("应该支持 0ms 延迟", async () => {
    const fn = mock();
    const debounced = debounce(fn, 0);

    debounced("test");
    await waitFor(() => fn.mock.calls.length === 1);

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("debounceCancellable", () => {
  it("应该支持取消执行", async () => {
    const fn = mock();
    const { execute, cancel } = debounceCancellable(fn, DELAY);

    execute("test");
    await wait(50); // 远小于 DELAY：定时器还在

    cancel();
    await wait(DELAY + 100);

    expect(fn).not.toHaveBeenCalled();
  });

  it("应该在取消后仍然支持新的调用", async () => {
    const fn = mock();
    const { execute, cancel } = debounceCancellable(fn, DELAY);

    execute("first");
    cancel();

    execute("second");
    await waitFor(() => fn.mock.calls.length === 1);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("second");
  });

  it("应该支持多次取消", async () => {
    const fn = mock();
    const { execute, cancel } = debounceCancellable(fn, DELAY);

    execute("test");
    cancel();
    cancel(); // 重复取消应该安全

    await wait(DELAY + 100);
    expect(fn).not.toHaveBeenCalled();
  });

  it("取消空定时器应该安全", () => {
    const fn = mock();
    const { cancel } = debounceCancellable(fn, DELAY);

    expect(() => cancel()).not.toThrow();
  });
});

describe("debounceLeading", () => {
  it("应该立即执行第一次调用", async () => {
    const fn = mock();
    const debounced = debounceLeading(fn, DELAY);

    debounced("first");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("first");
  });

  it("应该防抖后续调用", async () => {
    const fn = mock();
    const debounced = debounceLeading(fn, DELAY);

    debounced("first"); // 立即执行
    expect(fn).toHaveBeenCalledTimes(1);

    await wait(40); // 两次等待合计 80 ms ≪ 200 ms：整个窗口内
    debounced("second"); // 被防抖

    await wait(40);
    debounced("third"); // 被防抖

    expect(fn).toHaveBeenCalledTimes(1); // 仍然只有第一次

    await waitFor(() => fn.mock.calls.length === 2); // 防抖结束，执行最后一次
    expect(fn.mock.calls[1]).toEqual(["third"]);
  });

  it("应该在延迟后允许再次立即执行", async () => {
    const fn = mock();
    const debounced = debounceLeading(fn, DELAY);

    debounced("first");
    expect(fn).toHaveBeenCalledTimes(1);

    await waitFor(() => fn.mock.calls.length === 1);
    await wait(DELAY + 100); // 窗口过去了

    debounced("second");
    expect(fn).toHaveBeenCalledTimes(2); // 立即执行
    expect(fn).toHaveBeenCalledWith("second");
  });

  it("应该正确处理快速连续调用", async () => {
    const fn = mock();
    const debounced = debounceLeading(fn, DELAY);

    debounced("1"); // 立即执行
    debounced("2");
    debounced("3");
    debounced("4");
    debounced("5");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("1");

    await waitFor(() => fn.mock.calls.length === 2);

    expect(fn.mock.calls[1]).toEqual(["5"]); // 最后一次调用
  });
});

describe("性能和边界情况", () => {
  it("应该正确处理大量调用", async () => {
    const fn = mock();
    const debounced = debounce(fn, DELAY);

    // 模拟用户快速输入 20 个字符（20 × 3 ms = 60 ms ≪ 200 ms：全程在同一个窗口内）
    for (let i = 0; i < 20; i++) {
      debounced(`query-${i}`);
      await wait(3);
    }

    // 只有最后一次应该被执行
    expect(fn).not.toHaveBeenCalled();
    await waitFor(() => fn.mock.calls.length === 1);
    expect(fn).toHaveBeenCalledWith("query-19");
  });

  it("应该处理异步函数", async () => {
    const fn = mock(async (x: number) => x * 2);
    const debounced = debounce(fn, DELAY);

    debounced(21);
    await waitFor(() => fn.mock.calls.length === 1);

    expect(fn).toHaveBeenCalledWith(21);
  });

  it("应该处理返回值的函数", async () => {
    const fn = mock((x: number) => x * 2);
    const debounced = debounce(fn, DELAY);

    debounced(21);
    await waitFor(() => fn.mock.calls.length === 1);

    expect(fn).toHaveBeenCalledWith(21);
    expect(fn.mock.results[0]!.value).toBe(42);
  });

  it("应该支持长延迟", async () => {
    const fn = mock();
    const debounced = debounce(fn, LONG_DELAY);

    debounced("test");
    await wait(150); // 150 ms ≪ 400 ms：还没到
    expect(fn).not.toHaveBeenCalled();

    await waitFor(() => fn.mock.calls.length === 1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("真实场景模拟", () => {
  it("模拟搜索输入防抖", async () => {
    const searchAPI = mock();
    const handleSearch = debounce(searchAPI, DELAY);

    // 用户输入 "hello"（4 × 20 ms = 80 ms ≪ 200 ms）
    handleSearch("h");
    await wait(20);
    handleSearch("he");
    await wait(20);
    handleSearch("hel");
    await wait(20);
    handleSearch("hell");
    await wait(20);
    handleSearch("hello");

    // 窗口尚未结束：一次都不该调用
    expect(searchAPI).not.toHaveBeenCalled();

    // 窗口结束后只调用一次，且带最后一次输入
    await waitFor(() => searchAPI.mock.calls.length === 1);
    expect(searchAPI).toHaveBeenCalledWith("hello");
  });

  it("模拟自动保存防抖", async () => {
    const saveToServer = mock();
    const autoSave = debounce(saveToServer, AUTOSAVE_DELAY);

    // 用户编辑文档
    autoSave({ content: "Hello" });
    await wait(40);

    autoSave({ content: "Hello World" });
    await wait(40);

    autoSave({ content: "Hello World!" });

    // 40 + 40 + 150 = 230 ms ≪ 320 ms：还没到
    await wait(150);
    expect(saveToServer).not.toHaveBeenCalled();

    // 窗口结束后保存最新版本
    await waitFor(() => saveToServer.mock.calls.length === 1);
    expect(saveToServer).toHaveBeenCalledWith({ content: "Hello World!" });
  });
});
