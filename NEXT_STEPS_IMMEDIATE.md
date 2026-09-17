# 下一步行动计划 - 立即执行

**日期**: 2026-09-17 20:15  
**状态**: 🚀 准备开始  
**预计完成**: 2026-09-21 (本周五)

---

## 🎯 本周目标

**实现 MDM 配置加密存储** - 解决唯一的 P0 阻塞项

---

## 📅 今天行动 (2026-09-17 晚上)

### ✅ 已完成
- [x] 代码审计与修复（5 个关键问题）
- [x] 技术方案制定（Web Crypto API）
- [x] 实施路线图创建
- [x] 文档整理（12 份文档）

### ⏳ 接下来（今晚或明天）

#### Action 1: 创建加密模块目录
```bash
mkdir -p crates/amos-tauri/frontend-ts/src/lib/crypto
```

#### Action 2: 创建 `mdmCrypto.ts` 骨架
```bash
touch crates/amos-tauri/frontend-ts/src/lib/crypto/mdmCrypto.ts
touch crates/amos-tauri/frontend-ts/src/lib/crypto/index.ts
```

#### Action 3: 创建测试文件
```bash
touch crates/amos-tauri/frontend-ts/src/__tests__/mdmCrypto.test.ts
touch crates/amos-tauri/frontend-ts/src/__tests__/enterprise-mdm-encrypted.test.ts
```

---

## 📋 本周详细任务

### Day 1: 周一 (9/17) - 今天 ⏳
- [x] 代码审计完成
- [x] 技术方案完成
- [ ] 创建文件结构
- [ ] 实现 `getDeviceFingerprint()`

**剩余工时**: 2-3 小时

---

### Day 2: 周二 (9/18)
- [ ] 实现 `deriveMasterKey()`
- [ ] 实现 `encryptMDMData()`
- [ ] 实现 `decryptMDMData()`
- [ ] 编写单元测试（加密/解密正确性）

**预计工时**: 6-8 小时

---

### Day 3: 周三 (9/19)
- [ ] 修改 `mdm.ts` 集成加密
  - [ ] 更新 `loadConfig()` 为异步解密
  - [ ] 更新 `saveConfig()` 为异步加密
  - [ ] 添加审计日志
- [ ] 单元测试补充（防篡改、性能）
- [ ] 集成测试编写

**预计工时**: 6-8 小时

---

### Day 4: 周四 (9/20)
- [ ] 运行完整测试套件
- [ ] 性能测试（< 10ms）
- [ ] 安全测试（XSS、篡改）
- [ ] Bug 修复

**预计工时**: 6-8 小时

---

### Day 5: 周五 (9/21)
- [ ] Code Review 准备
  - [ ] Lint/TypeScript 检查
  - [ ] 代码自审
- [ ] 更新文档
  - [ ] API 文档
  - [ ] 开发者指南
- [ ] 提交 Pull Request
- [ ] Code Review

**预计工时**: 4-6 小时

---

## 🔧 技术实施提示

### 核心代码结构

```typescript
// mdmCrypto.ts 结构
├── interface EncryptedData { ... }
├── export async function encryptMDMData(plaintext: string): Promise<string>
├── export async function decryptMDMData(encrypted: string): Promise<string>
├── async function deriveMasterKey(): Promise<CryptoKey>
└── async function getDeviceFingerprint(): Promise<string>
```

### 关键实现点

1. **AES-GCM-256**
   - 使用 `crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data)`
   - IV 必须每次随机生成（12 bytes for GCM）

2. **PBKDF2 密钥派生**
   - 100,000 次迭代（安全性）
   - SHA-256 哈希
   - 固定盐值（"amos-mdm-salt-v1"）

3. **设备指纹**
   - userAgent + language + screen + timezone + hardware
   - 可选：Tauri 设备 ID（如果可用）
   - SHA-256 哈希生成最终指纹

---

## 🧪 测试重点

### 单元测试
```typescript
✓ 加密后无法读取明文
✓ 解密能恢复原始数据
✓ 篡改密文导致解密失败
✓ 加密/解密性能 < 10ms
✓ 错误处理（非法输入）
```

### 集成测试
```typescript
✓ MDM 注册 → 保存 → 重启 → 加载
✓ localStorage 无明文 API 密钥
✓ 审计日志记录加密操作
✓ 错误时优雅降级
```

---

## 🚨 注意事项

### 安全检查
- [ ] 使用 `crypto.subtle`（不是自定义实现）
- [ ] IV/Nonce 每次随机生成
- [ ] 不在日志中记录明文或密钥
- [ ] 错误信息不泄露敏感信息

### 性能要求
- [ ] 加密延迟 < 10ms
- [ ] 解密延迟 < 10ms
- [ ] 不阻塞 UI 线程

### 兼容性
- [ ] Chrome 60+
- [ ] Safari 11+
- [ ] Firefox 57+

---

## 📞 需要帮助时

### 技术问题
- 查阅 `MDM_加密存储技术方案.md` 详细设计章节
- 参考 [MDN Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)

### 项目规划
- 查阅 `MDM_ENCRYPTION_ROADMAP.md` 详细任务分解
- 查阅 `ENTERPRISE_P1_P3_TODO.md` 后续任务

### 代码审计
- 查阅 `ENTERPRISE_CODE_AUDIT_REPORT.md` 完整问题清单

---

## ✅ 完成标准

### 功能完整性
- [ ] 加密/解密功能正常工作
- [ ] MDM 所有现有功能不受影响
- [ ] 审计日志完整记录

### 质量标准
- [ ] 单元测试覆盖率 >= 90%
- [ ] 所有测试通过（28+ 个）
- [ ] 无 Lint/TypeScript 错误

### 安全标准
- [ ] localStorage 无明文敏感数据
- [ ] 防篡改测试通过
- [ ] 安全检查清单完成

### 文档标准
- [ ] 代码注释完整
- [ ] API 文档更新
- [ ] README 更新（如需要）

---

## 🎯 成功后的下一步

### Week 2: Beta 测试 (9/24-9/28)
1. 合并 PR 到 `develop` 分支
2. 部署到 Beta 环境
3. 监控指标和用户反馈
4. Bug 修复和优化
5. Staging 发布

### Month 2: P1 优化 (10月)
1. 错误信息国际化
2. 日志敏感信息脱敏
3. 事务一致性增强
4. 并发控制优化

---

## 💡 激励

> **目标**: 1 周内解决唯一的 P0 阻塞项，让 AmOS 企业功能达到 Beta 可部署状态！

**当前进度**: 21% → 目标: 100% (本周)

**质量评分**: B+ → 目标: A- (本周)

**部署状态**: 内部测试 → 目标: Beta 测试 (下周)

---

## 🚀 Let's Go!

**现在就开始 Action 1-3，创建文件结构！**

```bash
# 复制粘贴执行
cd /Users/arksong/AmOS
mkdir -p crates/amos-tauri/frontend-ts/src/lib/crypto
touch crates/amos-tauri/frontend-ts/src/lib/crypto/mdmCrypto.ts
touch crates/amos-tauri/frontend-ts/src/lib/crypto/index.ts
touch crates/amos-tauri/frontend-ts/src/__tests__/mdmCrypto.test.ts
echo "✅ 文件结构创建完成！"
```

---

**准备好了吗？开始编码！** 💪
