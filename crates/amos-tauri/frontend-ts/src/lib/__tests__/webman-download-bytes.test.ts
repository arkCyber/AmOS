/**
 * webman-download-bytes.test.ts —— 「剪掉一批下载 id 的字节计数」只有一处实现（REQ-A1169）。
 *
 * `downloadBytes` 是按下载 id 建的实时字节账（进度事件累积），行删了 id 不会复用 ⇒ 落单的条目
 * 永远不再被读，却在内存里一直沉。删一行（`removeDownloadEntry`）与清一批（`onClearCompleted`）
 * 是同一份账的两个入口；把「剪」抽成纯函数后，两个调用点不再是各写一遍的兄弟拷贝。
 *
 * 失败原因表（`WebManApp` 的 `downloadErrors`，REQ-A1171）是**同一份账的另一个字段** ——
 * 同一个 id、同一次删除/清除要一起剪。所以「剪」泛化成 `pruneById<T>`，两者共用一处实现。
 */
import { describe, expect, test } from "bun:test";
import { pruneById, pruneDownloadBytes, type DownloadByteCount } from "../webman";

const A: DownloadByteCount = { received: 100, total: 1000 };
const B: DownloadByteCount = { received: 0, total: null };

describe("pruneDownloadBytes", () => {
  test("剪一个：只丢目标 id，别的条目原样在", () => {
    const out = pruneDownloadBytes({ a: A, b: B }, ["a"]);
    expect(out).toEqual({ b: B });
    expect(out.a).toBeUndefined();
  });

  test("剪一批：一次清掉多个 id（「清除已完成」的形态）", () => {
    const out = pruneDownloadBytes({ a: A, b: B, c: { received: 5, total: 5 } }, ["a", "c"]);
    expect(out).toEqual({ b: B });
  });

  test("空 id 列表 ⇒ 内容不变（不是空表）", () => {
    const out = pruneDownloadBytes({ a: A }, []);
    expect(out).toEqual({ a: A });
  });

  test("不修改入参（返回新表，调用方按引用比较触发重渲染）", () => {
    const input = { a: A };
    const out = pruneDownloadBytes(input, ["a"]);
    expect(input).toEqual({ a: A });
    expect(out).not.toBe(input);
  });
});

describe("pruneById", () => {
  test("同一张表对任意值类型都成立（失败原因表是 string）", () => {
    const out = pruneById<string>({ a: "HTTP 404", b: "写盘失败" }, ["a"]);
    expect(out).toEqual({ b: "写盘失败" });
  });

  test("没有这个 id ⇒ 不凭空造一个条目", () => {
    const out = pruneById<string>({ b: "x" }, ["a"]);
    expect(out).toEqual({ b: "x" });
  });

  test("不修改入参（返回新表）", () => {
    const input = { a: "x" };
    const out = pruneById(input, ["a"]);
    expect(input).toEqual({ a: "x" });
    expect(out).not.toBe(input);
  });
});
