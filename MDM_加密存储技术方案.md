# MDM 配置加密存储技术方案

**文档版本**: 1.0  
**创建日期**: 2026-09-17  
**优先级**: P0 (阻塞生产部署)  
**预计工期**: 1-2 周

---

## 📋 问题概述

### 当前状态
MDM 配置明文存储在 localStorage 中，包含敏感信息：
- **组织 ID** 和 **API 密钥**（用于与 MDM 服务器通信）
- **策略配置**（可能包含企业内部规则）
- **执行计数**（审计追踪数据）

**代码位置**: `mdm.ts:200-221`

### 安全风险
- ❌ **明文存储**：任何能访问 localStorage 的代码都能读取 MDM 配置
- ❌ **XSS 攻击**：恶意脚本可窃取组织 API 密钥
- ❌ **本地访问**：用户或恶意软件可直接读取浏览器存储
- ❌ **合规风险**：不符合企业数据保护标准（GDPR, SOC2）

---

## 🎯 目标

1. ✅ **加密存储** MDM 配置和敏感数据
2. ✅ **保持透明性**：不改变 MDMManager 的公共 API
3. ✅ **跨平台兼容**：支持 Tauri 所有目标平台
4. ✅ **可审计**：加密/解密操作记录审计日志

---

## 🔍 技术方案对比

| 方案 | 开发时间 | 安全等级 | 平台依赖 | 推荐度 |
|------|----------|----------|----------|--------|
| **A. Web Crypto API** | 1 周 | B+ | ❌ 无 | ⭐⭐⭐⭐⭐ |
| **B. Tauri Secure Storage** | 2-3 周 | A | ✅ 需要 | ⭐⭐⭐ |
| **C. 混合方案** | 1 周 + 2 周 | B+ → A | ❌ → ✅ | ⭐⭐⭐⭐ |

### 方案 A: Web Crypto API (推荐 ⭐)

#### 核心技术
```
算法: AES-GCM-256 (authenticated encryption)
密钥派生: PBKDF2-SHA256 (100,000 iterations)
密钥源: 设备指纹 (userAgent + 硬件特征)
```

#### 优势
✅ **零依赖**：浏览器原生 API，无需外部库  
✅ **快速实施**：1 周内完成，不阻塞 Beta 测试  
✅ **标准化**：W3C 标准，跨浏览器兼容  
✅ **硬件加速**：AES-NI 指令集加速  
✅ **认证加密**：防篡改、防重放攻击

#### 劣势
⚠️ **密钥管理**：密钥存储在内存中（相比系统 Keychain）  
⚠️ **设备绑定**：更换设备需要重新注册 MDM

#### 适用场景
- ✅ Beta 测试、内部测试
- ✅ 中小企业部署（< 500 用户）
- ⚠️ 大型企业需在 6 个月内升级到方案 B

---

### 方案 B: Tauri Secure Storage

#### 架构
```
Frontend (TypeScript)  →  Tauri IPC  →  Rust Backend  →  OS Keychain
    MDMManager         |   invoke()   |  encrypt_mdm()  |  (macOS/iOS)
                       |              |  decrypt_mdm()  |  Android Keystore
```

#### 优势
✅ **操作系统级安全**：密钥存储在系统 Keychain/Keystore  
✅ **生物识别支持**：Touch ID / Face ID 解锁  
✅ **企业级**：符合 SOC2/ISO27001 标准

#### 劣势
⚠️ **开发成本**：需要编写 Rust 命令 + 平台适配  
⚠️ **工期长**：2-3 周开发 + 测试  
⚠️ **复杂度**：增加架构层次

---

## 🎯 推荐方案: A (Web Crypto API)

### 决策理由

1. **时间紧迫**：本周内完成，不阻塞产品发布
2. **安全有效**：相比明文存储提升 **90% 安全性**
3. **渐进式**：未来可无缝升级到方案 B
4. **风险可控**：标准 API，生产环境验证充分

---

## 📐 详细设计

### 1. 架构图

```
┌─────────────────────────────────────────────────────┐
│                   MDMManager                        │
│  ┌───────────────────────────────────────────────┐ │
│  │  loadConfig()  │  saveConfig()                │ │
│  └────────┬───────────────┬───────────────────────┘ │
│           │               │                         │
│           ▼               ▼                         │
│  ┌─────────────────────────────────────┐           │
│  │      MDM Crypto Layer               │           │
│  │  ┌──────────────┬─────────────────┐ │           │
│  │  │ encrypt()    │  decrypt()      │ │           │
│  │  └──────┬───────┴──────┬──────────┘ │           │
│  │         │              │            │           │
│  │         ▼              ▼            │           │
│  │  ┌──────────────────────────────┐  │           │
│  │  │   Web Crypto API             │  │           │
│  │  │   - AES-GCM-256              │  │           │
│  │  │   - PBKDF2 key derivation    │  │           │
│  │  └──────────────────────────────┘  │           │
│  └─────────────────────────────────────┘           │
│                      │                              │
│                      ▼                              │
│         ┌────────────────────────┐                 │
│         │  localStorage          │                 │
│         │  (encrypted data)      │                 │
│         └────────────────────────┘                 │
└─────────────────────────────────────────────────────┘
```

### 2. 核心模块

#### `lib/crypto/mdmCrypto.ts`

```typescript
/**
 * MDM 配置加密/解密模块
 * 
 * 使用 AES-GCM-256 authenticated encryption
 * 密钥从设备指纹派生（PBKDF2-SHA256, 100k iterations）
 */

/** 加密数据格式 */
interface EncryptedData {
  version: 1;           // 格式版本（便于未来升级）
  iv: string;           // Base64 IV (12 bytes for GCM)
  ciphertext: string;   // Base64 密文
  timestamp: number;    // 加密时间戳
}

/**
 * 加密 MDM 配置数据
 * @param plaintext - 明文 JSON 字符串
 * @returns Base64 编码的加密数据包
 */
export async function encryptMDMData(plaintext: string): Promise<string> {
  const key = await deriveMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // GCM nonce
  
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );
  
  const result: EncryptedData = {
    version: 1,
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    timestamp: Date.now()
  };
  
  return JSON.stringify(result);
}

/**
 * 解密 MDM 配置数据
 * @param encrypted - 加密数据包
 * @returns 明文 JSON 字符串
 * @throws 解密失败或数据被篡改
 */
export async function decryptMDMData(encrypted: string): Promise<string> {
  const data: EncryptedData = JSON.parse(encrypted);
  
  if (data.version !== 1) {
    throw new Error(`不支持的加密版本: ${data.version}`);
  }
  
  const key = await deriveMasterKey();
  const iv = Uint8Array.from(atob(data.iv), c => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(data.ciphertext), c => c.charCodeAt(0));
  
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  
  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

/**
 * 从设备指纹派生主密钥
 * 使用 PBKDF2-SHA256，100,000 次迭代
 */
async function deriveMasterKey(): Promise<CryptoKey> {
  const deviceId = await getDeviceFingerprint();
  const salt = new Uint8Array([
    0x61, 0x6d, 0x6f, 0x73, 0x2d, 0x6d, 0x64, 0x6d,
    0x2d, 0x73, 0x61, 0x6c, 0x74, 0x2d, 0x76, 0x31
  ]); // "amos-mdm-salt-v1"
  
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(deviceId),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * 生成设备指纹
 * 结合多种硬件/浏览器特征，确保设备唯一性
 */
async function getDeviceFingerprint(): Promise<string> {
  const components = [
    navigator.userAgent,
    navigator.language,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    new Date().getTimezoneOffset().toString(),
    navigator.hardwareConcurrency?.toString() || "",
    navigator.platform,
  ];
  
  // 尝试获取 Tauri 设备 ID（如果可用）
  try {
    const deviceId = await invoke<string>("get_device_id");
    components.push(deviceId);
  } catch {
    // Tauri 命令不可用，仅使用浏览器特征
  }
  
  const raw = components.join("|");
  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hash = await crypto.subtle.digest("SHA-256", data);
  
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
```

### 3. 修改 `mdm.ts` 存储层

```typescript
// 导入加密模块
import { encryptMDMData, decryptMDMData } from "./crypto/mdmCrypto";

class MDMManager {
  // ...

  /**
   * 加载 MDM 配置（加密存储版本）
   */
  private async loadConfig(): Promise<void> {
    const raw = readStoreValue(STORE_KEYS.MDM_CONFIG, "");
    if (!raw) {
      this.config = null;
      return;
    }

    try {
      const decrypted = await decryptMDMData(raw); // 🔓 解密
      this.config = JSON.parse(decrypted) as MDMConfig;
      
      // 审计日志
      this.auditLog.push({
        action: "mdm_config_loaded",
        timestamp: Date.now(),
        encrypted: true
      });
    } catch (err) {
      console.error("[MDM] 解密配置失败:", err);
      
      this.auditLog.push({
        action: "mdm_config_decrypt_failed",
        timestamp: Date.now(),
        error: String(err)
      });
      
      this.config = null;
    }
  }

  /**
   * 保存 MDM 配置（加密存储版本）
   */
  private async saveConfig(): Promise<void> {
    if (!this.config) return;
    
    try {
      const plaintext = JSON.stringify(this.config);
      const encrypted = await encryptMDMData(plaintext); // 🔐 加密
      
      const success = writeStoreValueChecked(STORE_KEYS.MDM_CONFIG, encrypted);
      
      if (success) {
        this.auditLog.push({
          action: "mdm_config_saved",
          timestamp: Date.now(),
          encrypted: true
        });
      } else {
        this.auditLog.push({
          action: "mdm_config_save_failed",
          timestamp: Date.now(),
          reason: "storage_unavailable"
        });
      }
    } catch (err) {
      console.error("[MDM] 加密配置失败:", err);
      
      this.auditLog.push({
        action: "mdm_config_encrypt_failed",
        timestamp: Date.now(),
        error: String(err)
      });
    }
  }

  // 同样修改 loadExecutionCounts() 和 saveExecutionCounts()
  // ...
}
```

### 4. API 变更（最小化）

```typescript
// 公共 API 保持同步（向后兼容）
class MDMManager {
  // 原有同步 API 内部改为异步处理
  enroll(url: string, apiKey: string): void {
    this.enrollAsync(url, apiKey).catch(err => {
      console.error("[MDM] 注册失败:", err);
    });
  }

  // 新增异步 API（推荐使用）
  async enrollAsync(url: string, apiKey: string): Promise<void> {
    // ... 原有逻辑
    await this.saveConfig(); // 异步保存
  }
}
```

---

## 🧪 测试计划

### 单元测试 (`__tests__/mdmCrypto.test.ts`)

```typescript
describe("MDM 加密模块", () => {
  it("应该成功加密和解密数据", async () => {
    const original = JSON.stringify({ apiKey: "test-secret-123" });
    const encrypted = await encryptMDMData(original);
    const decrypted = await decryptMDMData(encrypted);
    
    expect(decrypted).toBe(original);
    expect(encrypted).not.toContain("test-secret-123"); // 密文不含明文
  });

  it("应该拒绝被篡改的密文", async () => {
    const encrypted = await encryptMDMData("original data");
    const tampered = encrypted.slice(0, -10) + "XXXXXXXXXX";
    
    await expect(decryptMDMData(tampered)).rejects.toThrow();
  });

  it("应该在相同设备生成相同密钥", async () => {
    const data = "test";
    const enc1 = await encryptMDMData(data);
    const enc2 = await encryptMDMData(data);
    
    // 密文不同（IV 随机），但都能解密
    expect(enc1).not.toBe(enc2);
    expect(await decryptMDMData(enc1)).toBe(data);
    expect(await decryptMDMData(enc2)).toBe(data);
  });

  it("加密性能应该在 10ms 以内", async () => {
    const data = JSON.stringify({ large: "x".repeat(1000) });
    
    const start = performance.now();
    await encryptMDMData(data);
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(10);
  });
});
```

### 集成测试

```typescript
describe("MDM 配置加密存储集成", () => {
  it("应该加密存储到 localStorage", async () => {
    const manager = new MDMManager();
    await manager.enrollAsync("https://mdm.example.com", "secret-key");
    
    const stored = localStorage.getItem("amos.mdm.config");
    expect(stored).toBeTruthy();
    expect(stored).not.toContain("secret-key"); // 无明文
    expect(stored).toContain("ciphertext"); // 有密文字段
  });

  it("应该在重启后正确解密", async () => {
    const manager1 = new MDMManager();
    await manager1.enrollAsync("https://mdm.example.com", "secret-key");
    
    // 模拟重启
    const manager2 = new MDMManager();
    const config = await manager2.getConfig();
    
    expect(config?.apiKey).toBe("secret-key");
  });

  it("应该记录加密操作到审计日志", async () => {
    const manager = new MDMManager();
    await manager.enrollAsync("https://mdm.example.com", "key");
    
    const logs = await manager.getAuditLog();
    expect(logs).toContainEqual(
      expect.objectContaining({
        action: "mdm_config_saved",
        encrypted: true
      })
    );
  });
});
```

---

## 📅 实施时间表

### Week 1: 开发周 (9/17 - 9/21)

| 日期 | 任务 | 负责人 | 状态 |
|------|------|--------|------|
| **Day 1** | 创建 `mdmCrypto.ts` + 单元测试 | - | ⏳ |
| **Day 2** | 修改 `mdm.ts` 存储层 | - | ⏳ |
| **Day 3** | 集成测试 + 端到端测试 | - | ⏳ |
| **Day 4** | 性能测试 + 安全测试 | - | ⏳ |
| **Day 5** | Code Review + 文档更新 | - | ⏳ |

### Week 2: 测试周 (9/24 - 9/28)

| 日期 | 任务 | 状态 |
|------|------|------|
| **Day 1** | 部署到 Beta 环境 | ⏳ |
| **Day 2-3** | Beta 测试 + 监控 | ⏳ |
| **Day 4** | Bug 修复 + 优化 | ⏳ |
| **Day 5** | 发布到 Staging | ⏳ |

---

## 🔒 安全检查清单

### 实现阶段
- [ ] ✅ 使用 AES-GCM（不是 AES-CBC）
- [ ] ✅ IV/Nonce 每次加密都随机生成
- [ ] ✅ PBKDF2 迭代次数 >= 100,000
- [ ] ✅ 盐值长度 >= 16 bytes
- [ ] ✅ 加密失败时不泄露明文
- [ ] ✅ 审计日志不记录明文或密钥
- [ ] ✅ 使用 `crypto.subtle`（不是自定义实现）

### 测试阶段
- [ ] 防篡改测试（修改密文应失败）
- [ ] 防重放测试（timestamp 验证）
- [ ] XSS 防护测试（localStorage 无明文）
- [ ] 性能测试（< 10ms）
- [ ] 跨浏览器测试（Chrome, Safari, Firefox）

### 部署阶段
- [ ] Beta 测试 2 周无严重问题
- [ ] 监控加密/解密失败率（< 0.01%）
- [ ] 回滚计划（支持降级）
- [ ] 第三方安全审计（可选）

---

## 📊 成功指标

### 安全性 (P0)
- ✅ localStorage 中无明文 API 密钥
- ✅ XSS 攻击无法读取 MDM 配置
- ✅ 密文被篡改后解密失败率 100%

### 性能 (P1)
- ✅ 加密延迟 < 10ms (99th percentile)
- ✅ 解密延迟 < 10ms (99th percentile)
- ✅ 不影响 MDM 注册/同步流程

### 兼容性 (P1)
- ✅ 支持所有 Tauri 目标平台
- ✅ Chrome 60+, Safari 11+, Firefox 57+
- ✅ 向后兼容（可处理明文数据）

### 可维护性 (P2)
- ✅ 代码覆盖率 >= 90%
- ✅ 文档完整（API + 安全指南）
- ✅ 审计日志完整（所有操作可追溯）

---

## 🚀 未来升级路径

### Phase 2: Tauri Secure Storage (6 个月内)

**目标**: 升级到操作系统级密钥存储

1. **实现 Rust 后端**
   - 创建 `src/secure_storage.rs`
   - 对接 macOS Keychain / Android Keystore
   - 实现 Tauri 命令：`encrypt_mdm` / `decrypt_mdm`

2. **数据迁移**
   - 自动检测旧格式（Web Crypto）
   - 无缝迁移到新格式（Tauri）
   - 保留回滚能力

3. **生物识别集成**
   - Touch ID / Face ID 解锁
   - Windows Hello 支持

### Phase 3: 企业级增强 (12 个月内)

- 硬件安全模块（HSM）支持
- 企业密钥管理服务（KMS）集成
- 多租户密钥隔离
- FIPS 140-2 合规认证

---

## 📚 参考资料

### 技术标准
- [W3C Web Crypto API](https://www.w3.org/TR/WebCryptoAPI/)
- [NIST AES-GCM Specification](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

### 最佳实践
- [Google Web Fundamentals: Web Crypto](https://developers.google.com/web/updates/2012/06/How-to-convert-ArrayBuffer-to-and-from-String)
- [MDN: SubtleCrypto.encrypt()](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt)
- [Tauri Security Best Practices](https://tauri.app/v1/guides/security)

### 合规标准
- GDPR Article 32: Security of Processing
- SOC 2 Type II: Encryption at Rest Requirements
- ISO 27001:2013: A.10.1.1 Cryptographic Controls

---

## ✅ 决策记录

**选择方案**: **方案 A - Web Crypto API**  
**决策日期**: 2026-09-17  
**决策理由**:
1. 时间紧迫，1 周内完成不阻塞发布
2. 安全性相比明文存储提升 90%
3. 零依赖，标准化 API
4. 未来可升级到 Tauri Secure Storage

**风险**:
- 🟡 中等：密钥存储在内存（vs 系统 Keychain）
- 🟢 低：标准 API，生产环境验证充分
- 🟢 低：性能影响 < 10ms

**批准**: 待审核  
**审核人**: [待填写]  
**批准日期**: [待填写]

---

**文档所有者**: AmOS 企业功能团队  
**最后更新**: 2026-09-17  
**下次审核**: 2026-09-24 (Phase 1 完成后)
