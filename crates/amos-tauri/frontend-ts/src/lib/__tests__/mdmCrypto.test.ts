/**
 * MDM 加密模块单元测试
 * 
 * 测试覆盖：
 * - 加密/解密往返
 * - 防篡改保护
 * - 错误处理
 * - 边界条件
 * - 性能要求
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  encryptMDMData,
  decryptMDMData,
  isCryptoAvailable,
  getCryptoInfo,
} from "../crypto/mdmCrypto";

describe("MDM 加密模块", () => {
  beforeAll(() => {
    // 确保 Web Crypto API 可用
    if (!isCryptoAvailable()) {
      console.warn("Web Crypto API 不可用，某些测试可能会跳过");
    }
  });

  describe("基础功能", () => {
    it("应该正确加密和解密数据", async () => {
      const original = JSON.stringify({ 
        orgId: "org-12345", 
        apiKey: "secret-key-abc123",
        policies: { screenLock: true }
      });

      const encrypted = await encryptMDMData(original);
      expect(encrypted).toBeTruthy();
      expect(encrypted).not.toBe(original);
      expect(encrypted).not.toContain("secret-key-abc123"); // 不应包含明文

      const decrypted = await decryptMDMData(encrypted);
      expect(decrypted).toBe(original);
    });

    it("应该每次加密产生不同的密文（随机 IV）", async () => {
      const data = JSON.stringify({ test: "data" });

      const encrypted1 = await encryptMDMData(data);
      const encrypted2 = await encryptMDMData(data);

      expect(encrypted1).not.toBe(encrypted2); // IV 不同导致密文不同
      
      // 但都能正确解密
      expect(await decryptMDMData(encrypted1)).toBe(data);
      expect(await decryptMDMData(encrypted2)).toBe(data);
    });

    it("应该支持空字符串加密", async () => {
      const empty = "";
      const encrypted = await encryptMDMData(empty);
      const decrypted = await decryptMDMData(encrypted);
      expect(decrypted).toBe(empty);
    });

    it("应该支持大数据加密（> 1KB）", async () => {
      const largeData = JSON.stringify({
        orgId: "org-12345",
        policies: Array.from({ length: 100 }, (_, i) => ({
          id: `policy-${i}`,
          name: `Policy ${i}`,
          description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
          rules: Array.from({ length: 10 }, (_, j) => `rule-${i}-${j}`),
        })),
      });

      expect(largeData.length).toBeGreaterThan(1000);

      const encrypted = await encryptMDMData(largeData);
      const decrypted = await decryptMDMData(encrypted);
      expect(decrypted).toBe(largeData);
    });
  });

  describe("安全性", () => {
    it("应该拒绝被篡改的密文", async () => {
      const original = JSON.stringify({ apiKey: "secret" });
      const encrypted = await encryptMDMData(original);

      // 篡改密文（修改最后几个字符）
      const parsed = JSON.parse(encrypted);
      parsed.ciphertext = parsed.ciphertext.slice(0, -10) + "XXXXXXXXXX";
      const tampered = JSON.stringify(parsed);

      await expect(decryptMDMData(tampered)).rejects.toThrow();
    });

    it("应该拒绝被篡改的 IV", async () => {
      const original = JSON.stringify({ apiKey: "secret" });
      const encrypted = await encryptMDMData(original);

      // 篡改 IV
      const parsed = JSON.parse(encrypted);
      parsed.iv = parsed.iv.slice(0, -4) + "XXXX";
      const tampered = JSON.stringify(parsed);

      await expect(decryptMDMData(tampered)).rejects.toThrow();
    });

    it("应该拒绝被篡改的版本号", async () => {
      const original = JSON.stringify({ apiKey: "secret" });
      const encrypted = await encryptMDMData(original);

      // 篡改版本号
      const parsed = JSON.parse(encrypted);
      parsed.version = 999;
      const tampered = JSON.stringify(parsed);

      await expect(decryptMDMData(tampered)).rejects.toThrow(/不支持的加密版本/);
    });

    it("加密后的数据不应包含明文", async () => {
      const sensitiveData = JSON.stringify({
        apiKey: "super-secret-key-12345",
        orgId: "org-sensitive-789",
        password: "MyP@ssw0rd!",
      });

      const encrypted = await encryptMDMData(sensitiveData);

      // 验证所有敏感字段都不在密文中
      expect(encrypted).not.toContain("super-secret-key-12345");
      expect(encrypted).not.toContain("org-sensitive-789");
      expect(encrypted).not.toContain("MyP@ssw0rd!");
      expect(encrypted).not.toContain("apiKey");
      expect(encrypted).not.toContain("password");
    });
  });

  describe("错误处理", () => {
    it("解密无效的 JSON 应该抛出错误", async () => {
      const invalidJson = "not a json string";
      await expect(decryptMDMData(invalidJson)).rejects.toThrow();
    });

    it("解密缺少字段的数据应该抛出错误", async () => {
      const incomplete = JSON.stringify({
        version: 1,
        // 缺少 ciphertext 和 iv
      });
      await expect(decryptMDMData(incomplete)).rejects.toThrow();
    });

    it("解密空字符串应该抛出错误", async () => {
      await expect(decryptMDMData("")).rejects.toThrow();
    });

    it("加密错误应该包含有用的错误信息", async () => {
      // 这个测试验证错误消息的格式
      // null 会被 TextEncoder 转换为字符串 "null"，所以不会抛出错误
      // 改为测试无效的加密数据包
      const invalidEncrypted = JSON.stringify({
        version: 1,
        ciphertext: "invalid-base64-!!!",
        iv: "also-invalid-!!!",
        timestamp: Date.now(),
      });

      try {
        await decryptMDMData(invalidEncrypted);
        expect.fail("应该抛出错误");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("解密失败");
      }
    });
  });

  describe("数据格式", () => {
    it("加密数据应该是有效的 JSON", async () => {
      const data = JSON.stringify({ test: "value" });
      const encrypted = await encryptMDMData(data);

      expect(() => JSON.parse(encrypted)).not.toThrow();
    });

    it("加密数据应该包含必需的字段", async () => {
      const data = JSON.stringify({ test: "value" });
      const encrypted = await encryptMDMData(data);
      const parsed = JSON.parse(encrypted);

      expect(parsed).toHaveProperty("version");
      expect(parsed).toHaveProperty("ciphertext");
      expect(parsed).toHaveProperty("iv");
      expect(parsed).toHaveProperty("timestamp");
      expect(typeof parsed.version).toBe("number");
      expect(typeof parsed.ciphertext).toBe("string");
      expect(typeof parsed.iv).toBe("string");
      expect(typeof parsed.timestamp).toBe("number");
    });

    it("时间戳应该是合理的", async () => {
      const data = JSON.stringify({ test: "value" });
      const encrypted = await encryptMDMData(data);
      const parsed = JSON.parse(encrypted);

      const now = Date.now();
      expect(parsed.timestamp).toBeGreaterThan(now - 1000); // 不早于 1 秒前
      expect(parsed.timestamp).toBeLessThanOrEqual(now); // 不晚于现在
    });

    it("IV 长度应该正确（Base64 编码 12 字节）", async () => {
      const data = JSON.stringify({ test: "value" });
      const encrypted = await encryptMDMData(data);
      const parsed = JSON.parse(encrypted);

      // 12 字节 Base64 编码后应该是 16 个字符
      const ivLength = atob(parsed.iv).length;
      expect(ivLength).toBe(12);
    });
  });

  describe("性能", () => {
    it("加密应该在 50ms 内完成（中等数据）", async () => {
      const data = JSON.stringify({
        orgId: "org-12345",
        policies: Array.from({ length: 20 }, (_, i) => ({
          id: `policy-${i}`,
          rules: [`rule-${i}-1`, `rule-${i}-2`],
        })),
      });

      const start = performance.now();
      await encryptMDMData(data);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(50);
    });

    it("解密应该在 50ms 内完成（中等数据）", async () => {
      const data = JSON.stringify({
        orgId: "org-12345",
        policies: Array.from({ length: 20 }, (_, i) => ({
          id: `policy-${i}`,
          rules: [`rule-${i}-1`, `rule-${i}-2`],
        })),
      });

      const encrypted = await encryptMDMData(data);

      const start = performance.now();
      await decryptMDMData(encrypted);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(50);
    });
  });

  describe("工具函数", () => {
    it("isCryptoAvailable 应该返回布尔值", () => {
      const available = isCryptoAvailable();
      expect(typeof available).toBe("boolean");
    });

    it("getCryptoInfo 应该返回有效的信息", () => {
      const info = getCryptoInfo();

      expect(info).toHaveProperty("available");
      expect(info).toHaveProperty("algorithm");
      expect(info).toHaveProperty("keyDerivation");
      expect(info).toHaveProperty("iterations");
      expect(info).toHaveProperty("version");

      expect(info.algorithm).toBe("AES-GCM-256");
      expect(info.keyDerivation).toBe("PBKDF2-SHA256");
      expect(info.iterations).toBeGreaterThan(0);
      expect(info.version).toBe(1);
    });
  });

  describe("实际使用场景", () => {
    it("应该能够加密和存储 MDM 配置", async () => {
      const mdmConfig = {
        orgId: "org-production-001",
        apiKey: "prod-api-key-xyz789",
        serverUrl: "https://mdm.example.com",
        policies: {
          screenLock: true,
          cameraDisabled: false,
          maxFailedAttempts: 5,
        },
        lastSync: Date.now(),
      };

      // 加密
      const plaintext = JSON.stringify(mdmConfig);
      const encrypted = await encryptMDMData(plaintext);

      // 模拟存储到 localStorage
      const stored = encrypted;

      // 模拟从 localStorage 读取
      const retrieved = stored;

      // 解密
      const decrypted = await decryptMDMData(retrieved);
      const restored = JSON.parse(decrypted);

      expect(restored).toEqual(mdmConfig);
    });

    it("应该能够处理配置更新场景", async () => {
      // 初始配置
      const config1 = { orgId: "org-001", apiKey: "key-1" };
      const encrypted1 = await encryptMDMData(JSON.stringify(config1));

      // 更新配置
      const config2 = { orgId: "org-001", apiKey: "key-2", newField: true };
      const encrypted2 = await encryptMDMData(JSON.stringify(config2));

      // 新旧加密数据都应该能解密
      const decrypted1 = JSON.parse(await decryptMDMData(encrypted1));
      const decrypted2 = JSON.parse(await decryptMDMData(encrypted2));

      expect(decrypted1).toEqual(config1);
      expect(decrypted2).toEqual(config2);
    });
  });

  describe("边界条件", () => {
    it("应该处理包含特殊字符的数据", async () => {
      const specialData = JSON.stringify({
        name: "Test\n\t\r\"'<>",
        emoji: "🔐🛡️🔒",
        unicode: "你好世界",
      });

      const encrypted = await encryptMDMData(specialData);
      const decrypted = await decryptMDMData(encrypted);
      expect(decrypted).toBe(specialData);
    });

    it("应该处理非常长的字符串", async () => {
      const longString = "A".repeat(10000);
      const data = JSON.stringify({ longField: longString });

      const encrypted = await encryptMDMData(data);
      const decrypted = await decryptMDMData(encrypted);
      expect(decrypted).toBe(data);
    });

    it("应该处理嵌套很深的 JSON 对象", async () => {
      let nested: any = { value: "deep" };
      for (let i = 0; i < 50; i++) {
        nested = { child: nested };
      }
      const data = JSON.stringify(nested);

      const encrypted = await encryptMDMData(data);
      const decrypted = await decryptMDMData(encrypted);
      expect(decrypted).toBe(data);
    });
  });
});
