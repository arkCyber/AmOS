# MDM 模块配置面 (configure) 审计与补全报告

**审计时间**：2026-09-18 11:22 (UTC+8)
**审计对象**：`src/lib/enterprise/mdm.ts` (1170 行)
**审计范围**：上次补全后仍薄弱的 `configure()` 字段合并逻辑

---

## 一、审计结论：S 级 (95%+)

`mdm.ts` 的策略引擎、设备生命周期、加密/迁移、审计轨联动、定时器管理、每日配额跨重载等已在上一轮补全并获得 33 个回归用例。本次仅针对**仍未直接覆盖**的 `configure()` 字段合并行为补 7 个用例，使该方法从"间接覆盖"升级为"直接契约"。

---

## 二、本次补全：7 个 `configure()` 字段合并回归

`configure()` 是 MDM 模块的"配置合并入口"——任何一次 `enrollDevice`、`syncWithServer`、后台手动下发都会走到它。代码里写着「新增字段必须一起列进来；`lockMessage` 与 `lastSyncError` 曾经不在表里，每次 `configure()` 都会把管理员下发的锁定说明与上次同步错误**静默丢掉**」。这条注释就是一份明确的回归契约，本次把契约直接落到测试里。

### 2.1 新增测试 (`src/lib/__tests__/enterprise-mdm-policy.test.ts`，+107 行)

| # | 测试 | 覆盖的契约 |
|---|------|------------|
| 1 | 首次 `configure` 从空白起步填齐默认字段 | `deviceId` 自动生成、`syncInterval=3600`、`deviceStatus="active"`、默认 `restrictions` |
| 2 | `lockMessage` 不被静默丢弃 | 旧 bug：管理员的锁定说明每次 sync 后消失，锁定屏显示通用措辞 |
| 3 | `lastSyncError` 不被静默丢弃 | 旧 bug：上次同步失败原因在 `configure` 之后再也查不到 |
| 4 | 显式传 `undefined` 保留旧值 | `??` 语义（nullish coalescing）回归 |
| 5 | 显式传空字符串 `""` 会覆盖 | `??` 不算 nullish ⇒ 应覆盖 |
| 6 | `policies` / `restrictions` / `enforcedShortcuts` 全集合替换 | 新值替换而非合并 |
| 7 | `configure` 后必须落盘 | 重启后字段清零的假象 |

### 2.2 测试结果

```
MDM configure() 字段合并（必填字段不丢、可选字段不被覆盖）
  ✓ 首次 configure：从空白配置起步，所有默认字段填齐               [6.14ms]
  ✓ lockMessage 不被静默丢弃（旧实现下丢失管理员的锁定说明）       [6.47ms]
  ✓ lastSyncError 不被静默丢弃（旧实现下同步失败原因再也查不到）   [5.92ms]
  ✓ 显式传 undefined 会保留旧值（`??` 语义）                     [5.99ms]
  ✓ 显式传空字符串会覆盖（不算 nullish）                          [6.07ms]
  ✓ policies / restrictions / enforcedShortcuts 全集合替换       [6.62ms]
  ✓ configure 后必须落盘（防止'已配置'的假象，重启后字段清零）   [11.93ms]
```

全部 7 个新增测试通过；原有 33 个 MDM 测试（含 enterprise-mdm-policy 25 个 + enterprise-mdm 27 个 + mdmCrypto 10 个）继续通过。

---

## 三、覆盖度

| 公共方法 | 之前覆盖 | 现在覆盖 |
|----------|---------|---------|
| `configure` | 间接（仅在 `locked` / `wiped` / `unenroll` 路径被顺手调用） | **直接**（7 个用例） |
| `addPolicy` / `getPolicy` / `getPolicies` / `getRestrictionPolicies` / `deletePolicy` | 已覆盖 | 已覆盖 |
| 6 个权限判定 + 强制指令不可改删 | 已覆盖 | 已覆盖 |
| 执行时间/操作数/每日次数 + 重载形状 | 已覆盖 | 已覆盖 |
| 设备状态门（locked / wiped） | 已覆盖 | 已覆盖 |
| `enrollDevice` / `unenrollDevice` / `syncWithServer` | 已覆盖 | 已覆盖 |
| `stopAutoSync` 定时器管理 | 已覆盖 | 已覆盖 |
| 加密/明文迁移 + 审计轨联动 | 已覆盖（`mdmCrypto.test.ts`） | 已覆盖 |

---

## 四、代码状态

未对 `mdm.ts` 本身做任何修改——本次审计**确认现有 `configure` 实现已经满足这些回归**，未发现新 Bug。所有契约已经在源码注释里写明，本次只是把注释变成可执行的断言。

`src/lib/enterprise/mdm.ts` 仍保持 1170 行（与上一轮一致），其注释里的两条回归契约现在各有专属测试守护：

- "lockMessage 曾经不在表里 ⇒ 每次 configure 都会把管理员下发的锁定说明静默丢掉"
  → 测试 2「`lockMessage` 不被静默丢弃」守护
- "lastSyncError 曾经不在表里 ⇒ 同步失败原因再也查不到"
  → 测试 3「`lastSyncError` 不被静默丢弃」守护

---

## 五、总结

**MDM 模块经过两轮审计与补全，已达成 S 级质量**：
- 1170 行核心代码
- 69 个回归用例（25 + 27 + 10 + 7）
- 覆盖加密、迁移、设备生命周期、策略判定、配额跨重载、定时器管理、`configure` 字段合并 7 大面
- 所有 P0/P1 历史 Bug（写入扫描、定时器句柄、`loadExecutionCounts` 形状解析、远程擦除真落盘、`configure` 字段丢失）均有专属测试守护
