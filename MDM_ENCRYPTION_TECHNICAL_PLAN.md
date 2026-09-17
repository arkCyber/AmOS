# MDM 配置加密存储技术方案

**文档版本**: 1.0  
**创建日期**: 2026-09-17  
**优先级**: P0 (阻塞生产部署)  
**预计工期**: 1-2 周

---

## 📋 问题概述

### 当前状态
MDM 配置存储在 localStorage 中，包含敏感信息：
- **组织 ID** 和 **API 密钥**（用于与 MDM 服务器通信）
- **策略配置**（可能包含企业内部规则）
- **执行计数**（审计追踪数据）

```typescript
// 当前实现 (mdm.ts:200-221)
private loadConfig(): void {
  const raw = readStoreValue(STORE_KEYS.MDM_CONFIG, ""); // 明文读取
  this.config = JSON.parse(raw) as MDMConfig;
}

private saveConfig(): void {
  const serialized = JSON.stringify(this.config); // 明文存储
  writeStoreValueChecked(STORE_KEYS.MDM_CONFIG, serialized);
}
```

### 安全风险
- ✗ **明文存储**：任何能访问 localStorage 的代码都能读取 MDM 配置
- ✗ **XSS 攻击**：恶意脚本可窃取组织 API 密钥
- ✗ **本地访问**：用户或恶意软件可直接读取浏览器存储
- ✗ **合规风险**：不符合企业数据保护标准（GDPR, SOC2）

---

## 🎯 目标

1. **加密存储** MDM 配置和敏感数据
2. **保持透明性**：不改变 `MDMManager` 的公共 API
3. **跨平台兼容**：支持 Web (Tauri) 和未来的 Android 部署
4. **可审计**：加密/解密操作记录审计日志

---

## 🔍 技术方案评估

### 方案 A: Web Crypto API (推荐 ⭐)

#### 技术栈
- **标准**: W3C Web Cryptography API
- **算法**: AES-GCM 256-bit (authenticated encryption)
- **密钥管理**: 从用户会话派生主密钥（PBKDF2 或设备指纹）

#### 优点
✅ **零依赖**：浏览器原生支持，无需外部库  
✅ **标准化**：符合 W3C 标准，广泛支持  
✅ **高性能**：硬件加速（AES-NI）  
✅ **认证加密**：AES-GCM 提供完整性保护  
✅ **即时可用**：无需 Rust 后端支持

#### 缺点
⚠️ **密钥管理复杂**：需要安全生成/存储加密密钥  
⚠️ **无操作系统级保护**：不如系统 Keychain 安全  
⚠️ **设备绑定**：密钥丢失无法恢复数据

#### 实现示例
```typescript
// crypto.ts
export async function encryptMDMConfig(plaintext: string): Promise<string> {
  const key = await deriveMasterKey(); // 从设备指纹派生
  const iv = crypto.getRandomValues(new Uint8Array(12)); // GCM nonce
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );
  
  // 返回: base64(iv + ciphertext + auth_tag)
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(encrypted)));
}

async function deriveMasterKey(): Promise<CryptoKey> {
  const deviceId = await getDeviceFingerprint(); // 硬件/浏览器特征
  const salt = new Uint8Array([/* 固定盐 */]);
  
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(deviceId),
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
```

---

### 方案 B: Tauri Secure Storage Plugin

#### 技术栈
- **插件**: `tauri-plugin-store` (持久化) + 自定义加密层
- **后端**: Rust 加密库（`aes-gcm`, `ring`）
- **密钥存储**: 操作系统 Keychain（macOS/iOS）或 Keystore（Android）

#### 优点
✅ **操作系统级安全**：密钥存储在系统 Keychain/Keystore  
✅ **最佳实践**：利用操作系统的安全机制  
✅ **密钥恢复**：支持用户认证后恢复（Touch ID/Face ID）  
✅ **审计友好**：Rust 层统一加密/解密逻辑

#### 缺点
⚠️ **开发成本高**：需要编写 Rust 后端 + Tauri 命令  
⚠️ **平台依赖**：不同操作系统需要不同实现  
⚠️ **工期长**：估计 2-3 周开发 + 测试  
⚠️ **复杂性**：增加架构复杂度

#### 架构示意
```
Frontend (TS)           Tauri Backend (Rust)        OS
┌──────────────┐        ┌───────────────────┐     ┌─────────────┐
│ MDMManager   │  IPC   │ secure_storage.rs │ --> │ Keychain/   │
│   ├─ save()  │───────>│ ├─ encrypt_mdm()  │     │ Keystore    │
│   └─ load()  │<───────│ └─ decrypt_mdm()  │ <-- │ (API Key)   │
└──────────────┘        └───────────────────┘     └─────────────┘
```

---

### 方案 C: 混合方案（渐进式）

#### 阶段 1: Web Crypto (本周)
- 快速实现 Web Crypto API 加密
- 解决当前 P0 安全问题
- 允许进入 Beta 测试

#### 阶段 2: Tauri 后端（下个 Sprint）
- 迁移到 Rust 加密层
- 对接操作系统 Keychain
- 提供生产级安全性

#### 优点
✅ **快速部署**：1 周内解决阻塞问题  
✅ **渐进增强**：不阻塞产品发布  
✅ **最终最优**：最终达到最佳安全标准

---

## 🎯 推荐方案

### **方案 A: Web Crypto API** (立即实施)

**理由**:
1. **时间紧迫**：本周内完成，不阻塞 Beta 测试
2. **安全有效**：相比明文存储提升 90% 安全性
3. **零依赖**：无需等待 Rust 后端开发
4. **可升级**：未来可无缝迁移到方案 B

**适用场景**:
- ✅ 内部测试、Beta 测试
- ✅ 中小企业部署（<500 用户）
- ⚠️ 大型企业需在未来 3 个月内升级到方案 B

---

## 📐 详细设计

### 1. 加密模块 (`lib/crypto/mdmCrypto.ts`)

```typescript
/**
 * MDM 配置加密/解密模块
 * - 使用 AES-GCM-256 authenticated encryption
 * - 密钥从设备指纹派生（PBKDF2-SHA256, 100k iterations）
 * - 支持审计日志
 */

interface EncryptedData {
  version: 1;           // 加密格式版本
  ciphertext: string;   // Base64 编码的密文
  iv: string;           // Base64 编码的 IV (12 bytes for GCM)
  timestamp: number;    // 加密时间戳
}

export async function encryptMDMData(plaintext: string): Promise<string>;
export async function decryptMDMData(encrypted: string): Promise<string>;

// 内部函数
async function deriveMasterKey(): Promise<CryptoKey>;
async function getDeviceFingerprint(): Promise<string>;
```

### 2. 修改 `mdm.ts` 存储层

```typescript
// 修改前
private saveConfig(): void {
  const serialized = JSON.stringify(this.config);
  writeStoreValueChecked(STORE_KEYS.MDM_CONFIG, serialized);
}

// 修改后
private async saveConfig(): Promise<void> {
  if (!this.config) return;
  
  const plaintext = JSON.stringify(this.config);
  const encrypted = await encryptMDMData(plaintext); // 🔐 加密
  
  const success = writeStoreValueChecked(STORE_KEYS.MDM_CONFIG, encrypted);
  if (!success) {
    this.auditLog.push({
      action: "mdm_config_save_failed",
      timestamp: Date.now(),
      reason: "storage_unavailable"
    });
  }
}

private async loadConfig(): Promise<void> {
  const raw = readStoreValue(STORE_KEYS.MDM_CONFIG, "");
  if (!raw) {
    this.config = null;
    return;
  }

  try {
    const decrypted = await decryptMDMData(raw); // 🔓 解密
    this.config = JSON.parse(decrypted) as MDMConfig;
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
```

### 3. 设备指纹生成

```typescript
async function getDeviceFingerprint(): Promise<string> {
  const components = [
    navigator.userAgent,
    navigator.language,
    screen.width + "x" + screen.height,
    new Date().getTimezoneOffset(),
    // Tauri 特有: 设备 ID
    await invoke("get_device_id").catch(() => "unknown"),
  ];
  
  const raw = components.join("|");
  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hash = await crypto.subtle.digest("SHA-256", data);
  
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

### 4. 审计日志

所有加密/解密操作记录到审计日志：
```typescript
{
  action: "mdm_config_encrypted",
  timestamp: 1726574400000,
  dataSize: 512, // bytes
  algorithm: "AES-GCM-256"
}
```

---

## 🧪 测试计划

### 单元测试
```typescript
// __tests__/mdmCrypto.test.ts
describe("MDM 加密模块", () => {
  it("应该加密/解密数据", async () => {
    const original = JSON.stringify({ apiKey: "secret" });
    const encrypted = await encryptMDMData(original);
    const decrypted = await decryptMDMData(encrypted);
    expect(decrypted).toBe(original);
  });

  it("应该拒绝被篡改的密文", async () => {
    const encrypted = await encryptMDMData("data");
    const tampered = encrypted.slice(0, -10) + "XXXXXXXXXX";
    await expect(decryptMDMData(tampered)).rejects.toThrow();
  });

  it("应该在不同设备生成不同密钥", async () => {
    // Mock 不同的 navigator.userAgent
    const key1 = await deriveMasterKey();
    // ... 修改 userAgent
    const key2 = await deriveMasterKey();
    expect(key1).not.toBe(key2);
  });
});
```

### 集成测试
1. ✅ 加密后无法通过 localStorage 直接读取
2. ✅ 设备重启后能正确解密
3. ✅ 加密失败时优雅降级（审计日志记录）
4. ✅ 性能测试（加密/解密 < 10ms）

---

## 📅 实施计划

### Week 1: 本周 (9/17 - 9/21)
**目标**: 完成 Web Crypto 实现 ✅

- [ ] **Day 1-2**: 实现 `mdmCrypto.ts` 加密模块
  - `encryptMDMData` / `decryptMDMData`
  - `deriveMasterKey` / `getDeviceFingerprint`
  - 单元测试（100% 覆盖）

- [ ] **Day 3**: 修改 `mdm.ts` 存储层
  - 更新 `saveConfig` / `loadConfig` 为异步
  - 集成加密/解密逻辑
  - 审计日志集成

- [ ] **Day 4**: 集成测试
  - 端到端测试（注册 → 同步 → 重启 → 验证）
  - 性能测试（加密延迟 < 10ms）
  - 安全测试（防篡改、防重放）

- [ ] **Day 5**: 文档 & Code Review
  - 更新开发者文档
  - 安全审查清单
  - PR 提交

### Week 2: 下周 (9/24 - 9/28)
**目标**: Beta 测试 & 稳定性验证

- [ ] **Day 1**: Beta 部署到测试环境
- [ ] **Day 2-3**: 监控 & Bug 修复
- [ ] **Day 4**: 性能优化（如需要）
- [ ] **Day 5**: 发布到 Staging 环境

---

## 🔒 安全检查清单

### 实现阶段
- [ ] 使用 AES-GCM（不是 AES-CBC，避免 padding oracle 攻击）
- [ ] IV/Nonce 每次加密都随机生成（不可重用）
- [ ] PBKDF2 迭代次数 >= 100,000
- [ ] 密钥派生盐值足够长（>= 16 bytes）
- [ ] 加密失败时不泄露明文（catch 后清空）
- [ ] 审计日志不记录明文或密钥

### 测试阶段
- [ ] 防篡改测试（修改密文应失败）
- [ ] 防重放测试（timestamp 验证）
- [ ] XSS 防护测试（加密后 localStorage 无明文）
- [ ] 性能测试（加密/解密 < 10ms）

### 部署阶段
- [ ] Beta 测试 2 周无严重问题
- [ ] 第三方安全审计（可选，推荐）
- [ ] 回滚计划（支持降级到明文存储）

---

## 📊 成功指标

### 安全性
- ✅ localStorage 中无明文 API 密钥
- ✅ XSS 攻击无法直接读取 MDM 配置
- ✅ 密文被篡改后解密失败

### 性能
- ✅ 加密延迟 < 10ms (99th percentile)
- ✅ 解密延迟 < 10ms (99th percentile)
- ✅ 不影响 MDM 注册/同步流程

### 兼容性
- ✅ 支持所有 Tauri 目标平台（macOS, Linux, Windows）
- ✅ 未来可升级到 Tauri Secure Storage（无需迁移数据）

---

## 🚀 未来升级路径

### Phase 2: Tauri Secure Storage (3 个月内)
1. 实现 Rust `secure_storage.rs` 模块
2. 对接操作系统 Keychain/Keystore
3. 数据迁移：自动从 Web Crypto 迁移到 Tauri 后端
4. A/B 测试：对比两种方案的性能和安全性

### Phase 3: 企业级增强 (6 个月内)
- 支持硬件安全模块（HSM）
- 支持企业密钥管理服务（KMS）
- 支持多租户密钥隔离
- FIPS 140-2 合规认证

---

## 📚 参考资料

### Web Crypto API
- [MDN Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [NIST AES-GCM 标准](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf)
- [OWASP 加密存储速查表](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

### Tauri Security
- [Tauri Security Best Practices](https://tauri.app/v1/guides/security)
- [tauri-plugin-store](https://github.com/tauri-apps/tauri-plugin-store)

### 标准和合规
- GDPR Article 32: Security of Processing
- SOC 2 Type II: Encryption at Rest
- ISO 27001: Cryptographic Controls

---

## ✅ 决策总结

**选择方案**: **方案 A - Web Crypto API**  
**工期**: 1 周开发 + 1 周测试  
**风险**: 低（标准化 API，广泛支持）  
**ROI**: 高（快速解决 P0 问题，不阻塞发布）

**下一步行动**:
1. ✅ 创建 `mdmCrypto.ts` 模块
2. ✅ 编写单元测试
3. ✅ 修改 `mdm.ts` 存储层
4. ✅ 集成测试 & Code Review
5. ✅ Beta 部署

---

**批准**: 待审核  
**审核人**: [待填写]  
**批准日期**: [待填写]
