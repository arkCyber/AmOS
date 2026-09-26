/**
 * webman-downloads.test.ts — WebMan 真下载管线的前端桥契约（lib/webmanDownloads.ts）。
 *
 * 覆盖两件事：
 *  1. 命令路由：`startDownload`/`cancelDownload`/`listCookies`/`clearCookies` 发到
 *     正确的命令名，参数用 camelCase，缺省字段显式为 null（Tauri v2 依据参数名
 *     反序列化，漏传键会被当成"没有这个参数"而不是默认值）。
 *  2. 事件校验：`asProgressEvent` 在 UI 信任之前逐字段收窄 —— 一个越界的 status
 *     若不挡下，就会落成一行"下次加载即消失"的下载记录。这是 `updateDownload`
 *     那层校验的反面同款 bug（见 webman-persistence.test.ts）。
 */

import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import * as wd from "../webmanDownloads";

type Recorded = { command: string; args: Record<string, unknown> | undefined };

let calls: Recorded[] = [];
let listeners: Map<string, (e: { payload: unknown }) => void>;
let respond: (command: string, args?: Record<string, unknown>) => unknown;

function installBridge(): void {
  calls = [];
  listeners = new Map();
  respond = () => null;
  const internals = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return respond(command, args);
    },
    listen: async (channel: string, handler: (e: { payload: unknown }) => void) => {
      listeners.set(channel, handler);
      return () => {
        listeners.delete(channel);
      };
    },
  };
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: internals,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

// ---------------------------------------------------------------------------
// asProgressEvent：纯粹收窄，不需要桥
// ---------------------------------------------------------------------------

const VALID: wd.DownloadProgressEvent = {
  id: "job-1",
  url: "https://example.com/a.bin",
  filename: "a.bin",
  location: "/tmp/a.bin",
  received: 100,
  total: 400,
  status: "downloading",
  error: null,
};

describe("asProgressEvent 逐字段收窄", () => {
  it("完整合法载荷原样通过", () => {
    expect(wd.asProgressEvent(VALID)).toEqual(VALID);
  });

  it("total=null（chunked 无 Content-Length）合法，不是错误", () => {
    const r = wd.asProgressEvent({ ...VALID, total: null });
    expect(r).not.toBeNull();
    expect(r!.total).toBeNull();
  });

  it("total 缺省（undefined）归一为 null", () => {
    const { total: _drop, ...noTotal } = VALID;
    const r = wd.asProgressEvent(noTotal);
    expect(r).not.toBeNull();
    expect(r!.total).toBeNull();
  });

  it("协议外的 status 被拒（否则会落成读侧丢弃的幽灵行）", () => {
    expect(wd.asProgressEvent({ ...VALID, status: "paused" })).toBeNull();
    expect(wd.asProgressEvent({ ...VALID, status: "" })).toBeNull();
    expect(wd.asProgressEvent({ ...VALID, status: 7 })).toBeNull();
  });

  it("id 缺失或空串被拒（没有关联键就无法与行对齐）", () => {
    expect(wd.asProgressEvent({ ...VALID, id: undefined })).toBeNull();
    expect(wd.asProgressEvent({ ...VALID, id: "" })).toBeNull();
  });

  it("received 必须是有限非负数", () => {
    expect(wd.asProgressEvent({ ...VALID, received: -1 })).toBeNull();
    expect(wd.asProgressEvent({ ...VALID, received: NaN })).toBeNull();
    expect(wd.asProgressEvent({ ...VALID, received: Infinity })).toBeNull();
    expect(wd.asProgressEvent({ ...VALID, received: "100" })).toBeNull();
  });

  it("total 为负被拒，但 null 放行", () => {
    expect(wd.asProgressEvent({ ...VALID, total: -5 })).toBeNull();
    expect(wd.asProgressEvent({ ...VALID, total: null })).not.toBeNull();
  });

  it("非对象载荷（null/字符串/数字）一律 null，不抛", () => {
    expect(wd.asProgressEvent(null)).toBeNull();
    expect(wd.asProgressEvent(undefined)).toBeNull();
    expect(wd.asProgressEvent("oops")).toBeNull();
    expect(wd.asProgressEvent(42)).toBeNull();
  });

  it("非字符串的 error 归一为 null，字符串保留", () => {
    expect(wd.asProgressEvent({ ...VALID, error: 42 })!.error).toBeNull();
    expect(wd.asProgressEvent({ ...VALID, status: "failed", error: "timeout" })!.error).toBe(
      "timeout",
    );
  });
});

// ---------------------------------------------------------------------------
// 命令路由
// ---------------------------------------------------------------------------

describe("命令路由与参数形态", () => {
  beforeEach(installBridge);

  it("startDownload 发 webman_download_start，用 camelCase 键", async () => {
    respond = () => ({ id: "j1", url: "u", filename: "f", location: "/p" });
    await wd.startDownload("https://example.com/a.bin", "a.bin", "row-7");
    expect(calls).toEqual([
      {
        command: "webman_download_start",
        args: { url: "https://example.com/a.bin", filename: "a.bin", id: "row-7" },
      },
    ]);
  });

  it("startDownload 缺省 filename/id 显式传 null", async () => {
    await wd.startDownload("https://example.com/a.bin");
    expect(calls[0]!.args).toEqual({
      url: "https://example.com/a.bin",
      filename: null,
      id: null,
    });
  });

  it("cancelDownload 发 webman_download_cancel，返回布尔", async () => {
    respond = () => true;
    expect(await wd.cancelDownload("row-7")).toBe(true);
    expect(calls[0]).toEqual({ command: "webman_download_cancel", args: { id: "row-7" } });
  });

  it("cancelDownload 逐字带回宿主的 false（「宿主没有这次传输」是一句事实）", async () => {
    respond = () => false;
    expect(await wd.cancelDownload("row-7")).toBe(false);
  });

  it("cancelDownload 未桥接时是 null，而不是 false（REQ-A1343）", async () => {
    // 与 listCookies 同一个折叠（REQ-A1318），但代价更高：调用方对 `false` 的读法
    // （「这次传输不在跑」⇒ 把行画成 failed、长出重试；或直接删行）是一句**关于宿主**的
    // 断言，而「宿主没有这次传输」与「没能问」是两个事实。退化成 `false` 时，桥抖一下就会
    // 把一条**在跑**的传输播报成已中断、并把行删掉，而字节还在流。
    delete (globalThis as { window?: unknown }).window;
    expect(await wd.cancelDownload("row-7")).toBeNull();
  });

  it("listCookies 逐字返回宿主给的数组", async () => {
    respond = () => [{ name: "sid", value: "x", domain: "", path: "/", secure: true, httpOnly: true }];
    expect((await wd.listCookies())?.[0]!.name).toBe("sid");
    expect(calls[0]!.command).toBe("webman_cookies_list");
  });

  it("listCookies 未桥接时是 null，而不是空数组（REQ-A1318）", async () => {
    // 「没能问」与「问到了、罐是空的」是两个事实。退化成 `[]` 会让面板替一个没被问到的 jar
    // 说「没有站点数据」—— 一句关于 jar 的断言，而真实情况是我们根本没得到答复。
    delete (globalThis as { window?: unknown }).window;
    expect(await wd.listCookies()).toBeNull();
  });

  it("clearCookies 未桥接时是 null，而不是 0（REQ-A1318）", async () => {
    // 同理：「清掉了 0 条」与「没能清」不是同一句话，而 0 会让调用方播报「已清除」。
    delete (globalThis as { window?: unknown }).window;
    expect(await wd.clearCookies()).toBeNull();
  });

  it("clearCookies 桥接时逐字返回清除计数", async () => {
    respond = () => 3;
    expect(await wd.clearCookies()).toBe(3);
    expect(calls[0]!.command).toBe("webman_cookies_clear");
  });

  it("未桥接时 startDownload 返回 null（不撒谎说开始下载了）", async () => {
    delete (globalThis as { window?: unknown }).window;
    expect(await wd.startDownload("https://example.com/a.bin")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 事件订阅
// ---------------------------------------------------------------------------

describe("onDownloadProgress 订阅与过滤", () => {
  beforeEach(installBridge);

  it("订阅固定频道，只把合法载荷交给回调", async () => {
    const seen: wd.DownloadProgressEvent[] = [];
    await wd.onDownloadProgress((e) => seen.push(e));
    const h = listeners.get(wd.DOWNLOAD_PROGRESS_EVENT);
    expect(typeof h).toBe("function");
    h!({ payload: VALID });
    h!({ payload: { ...VALID, status: "bogus" } }); // 越界状态：挡下
    h!({ payload: null });
    expect(seen).toEqual([VALID]);
  });

  it("退订后频道被移除", async () => {
    const unsub = await wd.onDownloadProgress(() => {});
    expect(unsub).not.toBeNull(); // REQ-A838：已建立才有可退订的句柄
    unsub!();
    expect(listeners.has(wd.DOWNLOAD_PROGRESS_EVENT)).toBe(false);
  });

  it("未桥接时返回 null（不是 no-op），进度条不会假装在跟着传输（REQ-A838）", async () => {
    delete (globalThis as { window?: unknown }).window;
    expect(await wd.onDownloadProgress(() => {})).toBeNull();
  });
});
