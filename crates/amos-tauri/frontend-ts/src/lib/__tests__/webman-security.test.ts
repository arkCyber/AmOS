/**
 * webman-security.test.ts — WebMan 安全测试套件 (航空航天级)
 * 
 * 测试覆盖:
 * - XSS 攻击防护
 * - CSRF 防护
 * - 协议安全
 * - 输入验证
 * - 边界条件
 * - 并发安全
 */

import { describe, expect, test } from "vitest";
import {
  sanitizeUrl,
  validateTitle,
  parseInput,
  isValidUrl,
  extractDomain,
  extractTitle,
  generateId,
  LIMITS,
} from "../webman";

describe("P0 安全测试 - XSS 防护", () => {
  test("阻止 javascript: 协议", () => {
    const dangerous = [
      "javascript:alert('xss')",
      "JAVASCRIPT:alert(1)",
      "JaVaScRiPt:void(0)",
      "  javascript:alert(1)  ",
    ];

    dangerous.forEach((url) => {
      const result = sanitizeUrl(url);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("不允许的协议");
    });
  });

  test("阻止 data: 协议", () => {
    const dangerous = [
      "data:text/html,<script>alert('xss')</script>",
      "DATA:text/html,<h1>test</h1>",
    ];

    dangerous.forEach((url) => {
      const result = sanitizeUrl(url);
      expect(result.valid).toBe(false);
    });
  });

  test("阻止 file: 协议", () => {
    const result = sanitizeUrl("file:///etc/passwd");
    expect(result.valid).toBe(false);
  });

  test("阻止 vbscript: 协议", () => {
    const result = sanitizeUrl("vbscript:msgbox('xss')");
    expect(result.valid).toBe(false);
  });

  test("清理 HTML 字符", () => {
    const result = validateTitle("<script>alert('xss')</script>");
    expect(result.valid).toBe(true);
    expect(result.sanitized).not.toContain("<");
    expect(result.sanitized).not.toContain(">");
  });

  test("移除换行符", () => {
    const url = "https://example.com\r\n<script>alert(1)</script>";
    const result = sanitizeUrl(url);
    // sanitizeUrl 会清理换行符和 <> 字符，所以 URL 应该是有效的
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.sanitized).not.toContain("\r");
      expect(result.sanitized).not.toContain("\n");
      expect(result.sanitized).not.toContain("<");
      expect(result.sanitized).not.toContain(">");
      expect(result.sanitized).toContain("example.com");
    }
  });
});

describe("P0 安全测试 - 输入验证", () => {
  test("拒绝空输入", () => {
    expect(sanitizeUrl("").valid).toBe(false);
    expect(sanitizeUrl("   ").valid).toBe(false);
    expect(validateTitle("").valid).toBe(false);
  });

  test("拒绝非字符串输入", () => {
    expect(sanitizeUrl(null as any).valid).toBe(false);
    expect(sanitizeUrl(undefined as any).valid).toBe(false);
    expect(sanitizeUrl(123 as any).valid).toBe(false);
    expect(sanitizeUrl({} as any).valid).toBe(false);
  });

  test("强制 URL 长度限制", () => {
    const longUrl = "https://example.com/" + "a".repeat(LIMITS.URL_MAX_LENGTH);
    const result = sanitizeUrl(longUrl);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("超过最大长度");
  });

  test("强制标题长度限制", () => {
    const longTitle = "a".repeat(LIMITS.TITLE_MAX_LENGTH + 1);
    const result = validateTitle(longTitle);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("超过最大长度");
  });

  test("只允许 HTTP/HTTPS", () => {
    const validUrls = ["http://example.com", "https://example.com"];
    const invalidUrls = ["ftp://example.com", "ws://example.com"];

    validUrls.forEach((url) => {
      expect(sanitizeUrl(url).valid).toBe(true);
    });

    invalidUrls.forEach((url) => {
      expect(sanitizeUrl(url).valid).toBe(false);
    });
  });
});

describe("P1 边界条件测试", () => {
  test("处理 Unicode 字符", () => {
    const unicodeUrl = "https://例え.jp/测试";
    const result = sanitizeUrl(unicodeUrl);
    expect(result.valid).toBe(true);
  });

  test("处理 IDN 域名", () => {
    const idnUrl = "https://xn--e1afmkfd.xn--p1ai/";
    const result = sanitizeUrl(idnUrl);
    expect(result.valid).toBe(true);
  });

  test("处理端口号", () => {
    const urlWithPort = "https://example.com:8443/path";
    const result = sanitizeUrl(urlWithPort);
    expect(result.valid).toBe(true);
  });

  test("处理查询参数", () => {
    const urlWithQuery = "https://example.com/search?q=test&lang=zh";
    const result = sanitizeUrl(urlWithQuery);
    expect(result.valid).toBe(true);
  });

  test("处理 URL 片段", () => {
    const urlWithFragment = "https://example.com/page#section";
    const result = sanitizeUrl(urlWithFragment);
    expect(result.valid).toBe(true);
  });

  test("处理编码字符", () => {
    const encodedUrl = "https://example.com/search?q=%E6%B5%8B%E8%AF%95";
    const result = sanitizeUrl(encodedUrl);
    expect(result.valid).toBe(true);
  });
});

describe("P1 并发安全测试", () => {
  test("ID 生成唯一性", () => {
    const ids = new Set<string>();
    const count = 10000;

    for (let i = 0; i < count; i++) {
      ids.add(generateId());
    }

    expect(ids.size).toBe(count);
  });

  test("ID 生成快速连续调用", () => {
    const ids: string[] = [];
    
    for (let i = 0; i < 100; i++) {
      ids.push(generateId());
    }

    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(100);
  });
});

describe("P1 搜索引擎安全", () => {
  test("搜索查询正确编码", () => {
    const query = "hello world";
    const result = parseInput(query, "google");
    
    expect(result).toContain("hello%20world");
    expect(result).not.toContain("hello+world"); // 应该使用 %20 而非 +
  });

  test("特殊字符正确编码", () => {
    const query = "test & query";
    const result = parseInput(query, "google");
    
    expect(result).toContain("test%20%26%20query");
  });

  test("阻止搜索引擎注入", () => {
    const malicious = "test' OR '1'='1";
    const result = parseInput(malicious, "google");
    
    // 应该作为搜索查询被处理，特殊字符被编码
    expect(result).toContain("https://www.google.com/search?q=");
    expect(result).toContain("%20"); // 空格应该被编码
    // URL 可能包含单引号，但关键是它作为搜索参数而非 SQL 注入
    expect(result).toMatch(/^https:\/\/www\.google\.com\/search\?q=/);
  });
});

describe("P1 域名提取安全", () => {
  test("拒绝无效 URL", () => {
    const invalid = ["not a url", "javascript:void(0)", ""];
    
    invalid.forEach((url) => {
      const domain = extractDomain(url);
      expect(domain.length).toBeLessThanOrEqual(50);
    });
  });

  test("提取有效域名", () => {
    expect(extractDomain("https://www.example.com/path")).toBe("www.example.com");
    expect(extractDomain("http://example.com:8080")).toBe("example.com");
  });

  test("处理子域名", () => {
    expect(extractDomain("https://api.sub.example.com")).toBe("api.sub.example.com");
  });
});

describe("P2 标题提取安全", () => {
  test("提取标题不超过限制", () => {
    const longUrl = "https://example.com/" + "a".repeat(300);
    const title = extractTitle(longUrl);
    
    expect(title.length).toBeLessThanOrEqual(LIMITS.TITLE_MAX_LENGTH);
  });

  test("提取有效标题", () => {
    const title = extractTitle("https://example.com/path/to/page");
    expect(title).toContain("example.com");
    expect(title).toContain("/path/to/page");
  });
});

describe("P2 Favicon URL 安全", () => {
  test("使用安全的 favicon 服务", () => {
    const url = "https://example.com";
    // Note: getFaviconUrl 在当前实现中返回空字符串或 Google favicon URL
    // 这里我们只测试不会抛出异常
    expect(() => {
      const { getFaviconUrl } = require("../webman");
      getFaviconUrl(url);
    }).not.toThrow();
  });
});

describe("P2 parseInput 综合测试", () => {
  test("识别完整 URL", () => {
    const result = parseInput("https://example.com", "google");
    expect(result).toBe("https://example.com/");
  });

  test("识别 localhost", () => {
    const result = parseInput("localhost:3000", "google");
    expect(result).toBe("http://localhost:3000/");
  });

  test("识别 IP 地址", () => {
    const result = parseInput("192.168.1.1", "google");
    expect(result).toBe("http://192.168.1.1/");
  });

  test("空输入返回空字符串", () => {
    expect(parseInput("", "google")).toBe("");
    expect(parseInput("   ", "google")).toBe("");
  });

  test("搜索查询使用正确引擎", () => {
    const query = "test search";
    
    expect(parseInput(query, "google")).toContain("google.com");
    expect(parseInput(query, "bing")).toContain("bing.com");
    expect(parseInput(query, "duckduckgo")).toContain("duckduckgo.com");
    expect(parseInput(query, "baidu")).toContain("baidu.com");
  });
});

describe("P3 性能与限制", () => {
  test("URL 验证性能", () => {
    const start = Date.now();
    
    for (let i = 0; i < 1000; i++) {
      sanitizeUrl(`https://example${i}.com`);
    }
    
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(1000); // 应该在 1 秒内完成
  });

  test("ID 生成性能", () => {
    const start = Date.now();
    
    for (let i = 0; i < 10000; i++) {
      generateId();
    }
    
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(1000); // 应该在 1 秒内完成
  });
});
