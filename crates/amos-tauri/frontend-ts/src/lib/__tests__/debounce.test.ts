/**
 * debounce.test.ts — 防抖工具函数测试
 * 
 * 注意：使用真实定时器，因为 Bun 不支持 vi.useFakeTimers()
 */

import { describe, it, expect, mock } from "bun:test";
import { debounce, debounceCancellable, debounceLeading } from "../utils/debounce";

// 辅助函数：等待指定时间
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("debounce", () => {
  it("应该延迟执行函数", async () => {
    const fn = mock();
    const debounced = debounce(fn, 50);

    debounced("test");
    expect(fn).not.toHaveBeenCalled();

    await wait(30);
    expect(fn).not.toHaveBeenCalled();

    await wait(25);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("test");
  });

  it("应该取消之前的调用", async () => {
    const fn = mock();
    const debounced = debounce(fn, 50);

    debounced("first");
    await wait(20);

    debounced("second");
    await wait(20);

    debounced("third");
    await wait(60);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("third");
  });

  it("应该传递正确的参数", async () => {
    const fn = mock();
    const debounced = debounce(fn, 50);

    debounced(1, "test", { key: "value" }, [1, 2, 3]);
    await wait(60);

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

    const debounced = debounce(obj.fn, 50);
    debounced.call(obj, 8);
    
    await wait(60);
    expect(result).toBe(50);
  });

  it("应该支持多次独立调用", async () => {
    const fn = mock();
    const debounced = debounce(fn, 50);

    debounced("first");
    await wait(60);

    debounced("second");
    await wait(60);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0]).toEqual(["first"]);
    expect(fn.mock.calls[1]).toEqual(["second"]);
  });

  it("应该支持 0ms 延迟", async () => {
    const fn = mock();
    const debounced = debounce(fn, 0);

    debounced("test");
    await wait(5);

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("debounceCancellable", () => {
  it("应该支持取消执行", async () => {
    const fn = mock();
    const { execute, cancel } = debounceCancellable(fn, 50);

    execute("test");
    await wait(20);

    cancel();
    await wait(50);

    expect(fn).not.toHaveBeenCalled();
  });

  it("应该在取消后仍然支持新的调用", async () => {
    const fn = mock();
    const { execute, cancel } = debounceCancellable(fn, 50);

    execute("first");
    cancel();

    execute("second");
    await wait(60);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("second");
  });

  it("应该支持多次取消", async () => {
    const fn = mock();
    const { execute, cancel } = debounceCancellable(fn, 50);

    execute("test");
    cancel();
    cancel(); // 重复取消应该安全

    await wait(60);
    expect(fn).not.toHaveBeenCalled();
  });

  it("取消空定时器应该安全", () => {
    const fn = mock();
    const { cancel } = debounceCancellable(fn, 50);

    expect(() => cancel()).not.toThrow();
  });
});

describe("debounceLeading", () => {
  it("应该立即执行第一次调用", async () => {
    const fn = mock();
    const debounced = debounceLeading(fn, 50);

    debounced("first");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("first");
  });

  it("应该防抖后续调用", async () => {
    const fn = mock();
    const debounced = debounceLeading(fn, 50);

    debounced("first"); // 立即执行
    expect(fn).toHaveBeenCalledTimes(1);

    await wait(20);
    debounced("second"); // 被防抖

    await wait(20);
    debounced("third"); // 被防抖

    expect(fn).toHaveBeenCalledTimes(1); // 仍然只有第一次

    await wait(40);
    expect(fn).toHaveBeenCalledTimes(2); // 防抖结束，执行最后一次
    expect(fn.mock.calls[1]).toEqual(["third"]);
  });

  it("应该在延迟后允许再次立即执行", async () => {
    const fn = mock();
    const debounced = debounceLeading(fn, 50);

    debounced("first");
    expect(fn).toHaveBeenCalledTimes(1);

    await wait(60);

    debounced("second");
    expect(fn).toHaveBeenCalledTimes(2); // 立即执行
    expect(fn).toHaveBeenCalledWith("second");
  });

  it("应该正确处理快速连续调用", async () => {
    const fn = mock();
    const debounced = debounceLeading(fn, 50);

    debounced("1"); // 立即执行
    debounced("2");
    debounced("3");
    debounced("4");
    debounced("5");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("1");

    await wait(60);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1]).toEqual(["5"]); // 最后一次调用
  });
});

describe("性能和边界情况", () => {
  it("应该正确处理大量调用", async () => {
    const fn = mock();
    const debounced = debounce(fn, 50);

    // 模拟用户快速输入 20 个字符
    for (let i = 0; i < 20; i++) {
      debounced(`query-${i}`);
      await wait(2);
    }

    // 只有最后一次应该被执行
    await wait(60);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("query-19");
  });

  it("应该处理异步函数", async () => {
    const fn = mock(async (x: number) => x * 2);
    const debounced = debounce(fn, 50);

    debounced(21);
    await wait(60);

    expect(fn).toHaveBeenCalledWith(21);
  });

  it("应该处理返回值的函数", async () => {
    const fn = mock((x: number) => x * 2);
    const debounced = debounce(fn, 50);

    debounced(21);
    await wait(60);

    expect(fn).toHaveBeenCalledWith(21);
    expect(fn.mock.results[0]!.value).toBe(42);
  });

  it("应该支持长延迟", async () => {
    const fn = mock();
    const debounced = debounce(fn, 100);

    debounced("test");
    await wait(80);
    expect(fn).not.toHaveBeenCalled();

    await wait(25);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("真实场景模拟", () => {
  it("模拟搜索输入防抖", async () => {
    const searchAPI = mock();
    const handleSearch = debounce(searchAPI, 50);

    // 用户输入 "hello"
    handleSearch("h");
    await wait(10);
    handleSearch("he");
    await wait(10);
    handleSearch("hel");
    await wait(10);
    handleSearch("hell");
    await wait(10);
    handleSearch("hello");

    // 50ms 前不应调用 API
    expect(searchAPI).not.toHaveBeenCalled();

    // 50ms 后只调用一次
    await wait(60);
    expect(searchAPI).toHaveBeenCalledTimes(1);
    expect(searchAPI).toHaveBeenCalledWith("hello");
  });

  it("模拟自动保存防抖", async () => {
    const saveToServer = mock();
    const autoSave = debounce(saveToServer, 80);

    // 用户编辑文档
    autoSave({ content: "Hello" });
    await wait(20);

    autoSave({ content: "Hello World" });
    await wait(20);

    autoSave({ content: "Hello World!" });

    // 80ms 内不保存
    await wait(70);
    expect(saveToServer).not.toHaveBeenCalled();

    // 80ms 后保存最新版本
    await wait(15);
    expect(saveToServer).toHaveBeenCalledTimes(1);
    expect(saveToServer).toHaveBeenCalledWith({ content: "Hello World!" });
  });
});
