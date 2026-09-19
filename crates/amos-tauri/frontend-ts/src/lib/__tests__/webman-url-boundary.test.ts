/**
 * webman-url-boundary.test.ts — `lib/webman.ts` 的 URL / 主机名边界（REQ-A405）。
 *
 * `webman.ts` 一直住在覆盖率名单的第一行（89 行真实缺失 / 86.1%），而它没被碰到的部分
 * 正好是"只会在异常/生产模式里走到"的分支。这轮把其中两条**真缺陷**先测出来：
 *
 *  (A) `extractDomain` / `extractTitle` 对**非字符串**输入**抛错**：它们的 `catch` 分支里
 *      重复了刚刚失败的那个表达式（`url.slice(0, 50)`），于是"错误处理"自己又抛了一次 ——
 *      一个注释写着「增强错误处理」的函数把 TypeError 交给了调用方。
 *
 *  (B) 生产模式的本地地址拦截**既漏又误杀**：
 *        * 漏：IPv6 回环 `[::1]`、唯一本地 `fc00::/7`、链路本地 `fe80::/10`，IPv4 链路本地
 *          `169.254.0.0/16`，以及 `*.localhost`（RFC 6761）—— 全部放行；
 *        * 误杀：`hostname.startsWith("172.")` 把整个 172/8 当成私网，而私网只有
 *          172.16.0.0/12 ⇒ 公网的 172.32.1.1 这类地址在生产环境被拒（用户打不开的站）。
 *
 * 这个文件**不注册 happy-dom**：`scripts/bun-iso-test.mjs` 只把纯文件计入 P2-1 覆盖率，
 * 注册了 DOM 的文件只跑正确性、不进分母。
 */
import { describe, expect, test } from "bun:test";
import { extractDomain, extractTitle, isLocalHostname, parseInput, sanitizeUrl } from "../webman";

/** 在"生产模式"下跑一段断言——`import.meta.env` 在 bun 里就是 `process.env` 的活视图。
 *  必须是**布尔** false：`sanitizeUrl` 判的是 `import.meta.env?.DEV !== false`，写字符串
 *  `"false"` 会得到 `"false" !== false ⇒ true`（开发模式），门根本没合上——第一版正是
 *  这样写的，四条"应当拦住"的断言全红，红的是测试自己。 */
function asProduction<T>(fn: () => T): T {
  const env = (import.meta as unknown as { env: Record<string, unknown> }).env;
  const previous = env.DEV;
  env.DEV = false;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete env.DEV;
    else env.DEV = previous;
  }
}

const blocked = (url: string) => asProduction(() => sanitizeUrl(url).valid === false);
const allowed = (url: string) => asProduction(() => sanitizeUrl(url).valid === true);

describe("extractDomain / extractTitle 对非字符串输入不得抛错（REQ-A405 A）", () => {
  test("非字符串：退化为空串，而不是 TypeError", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(() => extractDomain(bad as unknown as string)).not.toThrow();
      expect(extractDomain(bad as unknown as string)).toBe("");
      expect(() => extractTitle(bad as unknown as string)).not.toThrow();
      expect(extractTitle(bad as unknown as string)).toBe("");
    }
  });

  test("字符串路径不变：有效 URL 给主机名，无效输入给前 50 字符", () => {
    expect(extractDomain("https://api.example.com/x")).toBe("api.example.com");
    expect(extractTitle("https://example.com/a/b")).toBe("example.com/a/b");
    expect(extractDomain("not a url")).toBe("not a url");
    expect(extractTitle("javascript:alert(1)").length).toBeLessThanOrEqual(50);
    const long = "x".repeat(200);
    expect(extractDomain(long)).toBe(long.slice(0, 50));
  });
});

describe("parseInput 的非字符串输入同样不得抛错（REQ-A405 A）", () => {
  test("null / undefined / 数字 ⇒ 空串（与空输入同一答复）", () => {
    for (const bad of [null, undefined, 42, {}]) {
      expect(() => parseInput(bad as unknown as string, "google")).not.toThrow();
      expect(parseInput(bad as unknown as string, "google")).toBe("");
    }
  });
});

describe("生产模式的本地地址拦截：既要拦住本地，也不能误杀公网（REQ-A405 B）", () => {
  test("拦住：IPv4 私网 / 回环 / 0.0.0.0 / 链路本地", () => {
    for (const url of [
      "http://localhost/",
      "http://foo.localhost/",
      "http://127.0.0.1/",
      "http://127.8.8.8/",
      "http://0.0.0.0/",
      "http://10.1.2.3/",
      "http://192.168.1.5/",
      "http://172.16.0.1/",
      "http://172.31.255.254/",
      "http://169.254.1.1/",
    ]) {
      expect([url, blocked(url)]).toEqual([url, true]);
    }
  });

  test("拦住：IPv6 回环 / 唯一本地 / 链路本地", () => {
    for (const url of ["http://[::1]/", "http://[::]/", "http://[fc00::1]/", "http://[fd12:3456::1]/", "http://[fe80::1]/"]) {
      expect([url, blocked(url)]).toEqual([url, true]);
    }
  });

  test("放行：公网 IP 与域名（含被 172. 前缀误杀过的公网段）", () => {
    for (const url of [
      "https://example.com/",
      "http://8.8.8.8/",
      "http://172.32.0.1/",
      "http://172.15.255.255/",
      "http://11.0.0.1/",
      "http://192.169.0.1/",
      "http://169.255.0.1/",
      "http://[2001:db8::1]/",
    ]) {
      expect([url, allowed(url)]).toEqual([url, true]);
    }
  });

  test("拦住：IPv4-mapped IPv6（URL 会把它规范化成十六进制，只认点分会**被绕过**）", () => {
    // 实测（node/WHATWG）：`new URL("http://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]"`
    // —— 于是"IPv4-mapped 的 127.0.0.1 是回环"这件事在**浏览器交给你的字符串里**看不见：
    // 只匹配点分的判断放行了一个真正的回环地址（生产模式下就是一个绕过本地地址门的洞）。
    for (const url of [
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:c0a8:101]/",
      "http://[0:0:0:0:0:ffff:192.168.1.1]/",
    ]) {
      expect([url, blocked(url)]).toEqual([url, true]);
    }
    expect(isLocalHostname("::ffff:127.0.0.1")).toBe(true); // 手写点分形式同样要认
    expect(allowed("http://[::ffff:808:808]/")).toBe(true); // 公网的映射地址要放行
  });

  test("开发模式（DEV 未设）仍然允许 localhost —— 本机调试是既有契约", () => {
    expect(sanitizeUrl("http://localhost:3000/").valid).toBe(true);
    expect(sanitizeUrl("http://127.0.0.1/").valid).toBe(true);
  });

  test("DEV 值被还原（不把生产模式泄漏给同批次的其它文件）", () => {
    const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
    expect(env.DEV).toBeUndefined();
  });
});
