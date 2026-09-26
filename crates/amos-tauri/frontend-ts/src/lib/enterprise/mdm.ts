/**
 * enterprise/mdm.ts — Mobile Device Management (MDM) 支持
 * 
 * 功能:
 * - MDM 配置管理
 * - 策略引擎
 * - 限制检查
 * - 配置同步
 * 
 * 安全特性:
 * - 配置加密存储
 * - 策略签名验证
 * - 设备锁定
 * - 远程擦除
 */

import { readStoreValue, writeStoreValueChecked } from "../amosStore";
import { emitWebhookEvent } from "./webhooks";
import type { ActionCategory } from "../shortcuts";
// Type-only import: erased at runtime, so it cannot create the `mdm ⇄ audit`
// cycle that a value import would (`audit.ts` imports `mdmManager` from here).
import type { AuditEventCategory, AuditEventType, AuditLogLevel, AuditResult } from "./audit";
import { localId } from "../localId";

// ============================================================================
// 类型定义
// ============================================================================

/** MDM API 响应 - 注册 */
interface MDMEnrollResponse {
  organizationId: string;
  organizationName: string;
  apiKey: string;
  enrolledBy?: string;
}

/** MDM API 响应 - 策略同步数据 */
export interface MDMPoliciesData {
  policies: MDMPolicy[];
  restrictions: MDMRestrictions;
  enforcedShortcuts: string[];
  enforcedTemplates: string[];
}

/** MDM 策略类型 */
export type MDMPolicyType =
  | "feature_disable"      // 禁用功能
  | "execution_limit"      // 执行限制
  | "sharing_control"      // 分享控制
  | "approval_required"    // 需要审批
  | "forced_shortcuts"     // 强制快捷指令
  | "data_retention";      // 数据保留策略

/** MDM 策略 */
export interface MDMPolicy {
  id: string;
  type: MDMPolicyType;
  name: string;
  description: string;
  config: Record<string, unknown>;
  enabled: boolean;
  priority: number;        // 优先级，数字越大优先级越高
  createdAt: number;
  updatedAt: number;
}

/** MDM 限制配置 */
export interface MDMRestrictions {
  // 功能限制
  disabledCategories: ActionCategory[];
  disabledActions: string[];
  
  // 执行限制
  maxExecutionTime: number;        // 最大执行时间（秒）
  maxExecutionsPerDay: number;     // 每天最大执行次数
  maxActionsPerShortcut: number;   // 每个快捷指令最大操作数
  maxShortcutsPerUser: number;     // 每个用户最大快捷指令数
  
  // 用户权限
  allowUserCreate: boolean;        // 允许用户创建
  allowUserModify: boolean;        // 允许用户修改
  allowUserDelete: boolean;        // 允许用户删除
  allowSharing: boolean;           // 允许分享
  allowExport: boolean;            // 允许导出
  allowImport: boolean;            // 允许导入
  
  // 审批流程
  requireApprovalForCreate: boolean;
  requireApprovalForModify: boolean;
  requireApprovalForSharing: boolean;
}

/** MDM 配置 */
export interface MDMConfig {
  enabled: boolean;
  organizationId: string;
  organizationName: string;
  deviceId: string;
  deviceName: string;
  
  // 服务器配置
  serverUrl: string;
  apiKey: string;
  
  // 策略和限制
  policies: MDMPolicy[];
  restrictions: MDMRestrictions;
  
  // 强制快捷指令
  enforcedShortcuts: string[];     // 强制安装的快捷指令 ID
  enforcedTemplates: string[];     // 强制安装的模板 ID
  
  // 同步配置
  syncInterval: number;            // 同步间隔（秒）
  lastSyncAt: number;
  lastSyncStatus: "success" | "failure" | "pending";
  lastSyncError?: string;
  
  // 设备状态
  deviceStatus: "active" | "locked" | "wiped";
  lockMessage?: string;
  
  // 元数据
  enrolledAt: number;
  enrolledBy: string;
  version: string;
}

/** MDM 同步响应 */
export interface MDMSyncResponse {
  success: boolean;
  config?: MDMConfig;
  message?: string;
  serverTime: number;
}

/** MDM 操作结果 */
export interface MDMCheckResult {
  allowed: boolean;
  reason?: string;
  policyId?: string;
}

/**
 * 「测试连接」的结果（REQ-A819）。
 *
 * 是**判别式**而不是一个 `boolean`：一个只说「没连上」的结果没法让界面说出为什么，
 * 而这个按钮的整个价值就在那句为什么（URL 根本没填／是明文 http／服务器没应答／
 * 应答不是我们的服务器）。`status` 只在 `http-status` 时有值。
 */
export type MDMConnectionResult =
  | { ok: true }
  | { ok: false; reason: "no-server" }
  | { ok: false; reason: "insecure-url" }
  | { ok: false; reason: "unreachable" }
  | { ok: false; reason: "unexpected-body" }
  | { ok: false; reason: "http-status"; status: number };

// ============================================================================
// 常量
// ============================================================================

const STORE_KEYS = {
  MDM_CONFIG: "amos.shortcuts.mdm.config",
  MDM_EXECUTION_COUNT: "amos.shortcuts.mdm.execution_count",
};

/**
 * 「默认限制」的**唯一**一份定义。
 *
 * 导出是为了能被断言（`enterprise-mdm-restrictions.test.ts`）与核对 —— 这份表曾经有
 * **三份**副本：本表、`configure()` 的初始表、`deletePolicy()` 的恢复表，而后两份把
 * `maxActionsPerShortcut` 写成 `50`（本表是 `100`）。后果是可观测的：「删除策略 ⇒ 恢复
 * 默认值」恢复出来的**不是**默认值，而首次配置与重装得到两个不同的上限。
 * `scripts/mdm-restriction-scan.mjs` 现在把「第二份表」钉成红色。
 *
 * 全字段必填（`MDMRestrictions` 的每个键都在）也由那个闸门核对：新增一个限制项却忘了
 * 给默认值，才是真正的静默失守 —— `undefined` 默认值配合折算是拒，不折就是放行。
 */
export const DEFAULT_RESTRICTIONS: MDMRestrictions = {
  disabledCategories: [],
  disabledActions: [],
  maxExecutionTime: 300,           // 5 分钟
  maxExecutionsPerDay: 1000,
  maxActionsPerShortcut: 100,
  maxShortcutsPerUser: 100,        // 每个用户最多 100 个快捷指令
  allowUserCreate: true,
  allowUserModify: true,
  allowUserDelete: true,
  allowSharing: true,
  allowExport: true,
  allowImport: true,
  requireApprovalForCreate: false,
  requireApprovalForModify: false,
  requireApprovalForSharing: false,
};

/** 数组型限制的默认（`[]` 的对象身份每次都换一份，免得被就地改到共享的那一份）。 */
function emptyArray<T>(): T[] {
  return [];
}

/**
 * 把一份**可能不完整**的 `restrictions` 补成完整的限制表（REQ-A899）。
 *
 * 为什么需要它：限制的三个入口过去都是**整块替换** —— `configure()` 里
 * `config.restrictions ?? this.config.restrictions`、`syncWithServer()` 里
 * `{ ...this.config, ...serverConfig }`（浅展开，`restrictions` 是叶子所以整块换掉）、
 * `loadConfig()` 直接把 `JSON.parse` 的结果断言成 `MDMConfig`。于是服务端下发一个只含
 * `maxExecutionTime` 的增量、或一份旧版本存下来的配置，都能让其余限制变成 `undefined`；
 * 而 `checkCanExecute()` 的内联判据在 `undefined` 上恒为假 ⇒ **限额静默失效**，
 * 紧接着 `saveConfig()` 还会把这个空壳落盘。
 *
 * 两条规则，边界取决于「提到没提到」而不是「值好不好」：
 *
 * - **键不存在** ⇒ 用 `base` 的同名项（`base` 缺则用 `DEFAULT_RESTRICTIONS`）。服务端
 *   没说这一项，就是没有新意见，不是「取消这一项限制」。
 * - **键存在但值不可解释**（`NaN`／`Infinity`／负数／字符串／`null`）⇒ **折成 0**，
 *   与 `policyExecutionSeconds()` / `policyShortcutCap()` 同一条规矩：它**不是**
 *   「没有上限」。这一层与判据自己的折叠并不重复 —— 本层管**在不在**，判据管
 *   **能不能解释**，而 `setConfigForTest()` 之类的直投路径不经过本层。
 *
 * 布尔型没有「不可解释」的中间态（不是布尔就按 `base` 处理，`??` 的语义），因为一个
 * 「半真的允许」没有可判定的一侧；数值型才有朝严格折叠的那一侧。
 */
export function normalizeRestrictions(
  raw: unknown = {},
  base: MDMRestrictions = DEFAULT_RESTRICTIONS,
): MDMRestrictions {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  /** 提到没提到：`undefined` ⇒ 用基准；否则原样交给下面的类型判定。 */
  const given = (key: keyof MDMRestrictions): unknown => (key in r ? r[key] : base[key]);

  /** 数组：不是数组（含缺席但基准也不是数组）⇒ 空表，绝不留下一个 `.includes` 会抛的值。 */
  const array = (key: "disabledCategories" | "disabledActions"): string[] => {
    const value = given(key);
    return Array.isArray(value) ? (value.filter((x) => typeof x === "string") as string[]) : emptyArray<string>();
  };

  /**
   * 数值：缺席（`undefined`）⇒ 基准；其余不可解释的一律 0。
   *
   * 注意这里**不做** `>= 0` 之外的裁剪：负数由判据那层的折叠接住（折成 0），
   * 本层只负责「键在不在」，免得同一个规则在两个地方各写一遍（那正是本轮要消灭的形状）。
   */
  const number = (
    key: "maxExecutionTime" | "maxExecutionsPerDay" | "maxActionsPerShortcut" | "maxShortcutsPerUser",
  ): number => {
    const value = given(key);
    if (value === undefined) return 0; // base 也是 undefined ⇒ 交给判据折叠
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    return 0;
  };

  const bool = (
    key:
      | "allowUserCreate" | "allowUserModify" | "allowUserDelete" | "allowSharing"
      | "allowExport" | "allowImport"
      | "requireApprovalForCreate" | "requireApprovalForModify" | "requireApprovalForSharing",
  ): boolean => {
    const value = given(key);
    return typeof value === "boolean" ? value : (base[key] ?? DEFAULT_RESTRICTIONS[key]);
  };

  return {
    disabledCategories: array("disabledCategories") as ActionCategory[],
    disabledActions: array("disabledActions"),
    maxExecutionTime: number("maxExecutionTime"),
    maxExecutionsPerDay: number("maxExecutionsPerDay"),
    maxActionsPerShortcut: number("maxActionsPerShortcut"),
    maxShortcutsPerUser: number("maxShortcutsPerUser"),
    allowUserCreate: bool("allowUserCreate"),
    allowUserModify: bool("allowUserModify"),
    allowUserDelete: bool("allowUserDelete"),
    allowSharing: bool("allowSharing"),
    allowExport: bool("allowExport"),
    allowImport: bool("allowImport"),
    requireApprovalForCreate: bool("requireApprovalForCreate"),
    requireApprovalForModify: bool("requireApprovalForModify"),
    requireApprovalForSharing: bool("requireApprovalForSharing"),
  };
}

// ============================================================================
// MDM 管理器
// ============================================================================

export class MDMManager {
  private config: MDMConfig | null = null;
  private executionCounts: Map<string, number> = new Map();
  /** 自动同步的定时器句柄（`null` = 未启动）。 */
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * `ensureInitialized()` 的备忘（`null` = 还没人问过）。
   *
   * 用 **promise** 而不是布尔：`loadConfig()` 是异步的（解密走 Web Crypto），
   * 而幂等必须在**任何 await 之前**成立 —— 两个调用者同时进门时，先到的那个把
   * promise 放进来，后到的拿到同一份，于是"加载"只发生一次。
   * （与 `audit.ts` 的 `ensureInitialized()` 同一形状；那边同步，所以它用布尔。
   * 同一条规矩，各自按自己的能力选载体，见 REQ-A945 的说明。）
   */
  private bootstrapPromise: Promise<void> | null = null;

  /**
   * 记录一条 MDM 配置事件到**企业审计轨**（`lib/enterprise/audit.ts`
   * 的 `auditLogger` —— `api.ts` 写的是同一条轨）。
   *
   * 两个刻意的性质：
   * - **动态 import**：`audit.ts` 已经 import 本模块的 `mdmManager`，静态 import
   *   会形成环；两处调用都在 async 方法里，所以事件真的发生时才加载。
   * - **永不抛错**：审计写入不得让配置的加载/保存失败（否则它报告的"失败"
   *   就是它自己造成的）。审计是 best-effort，配置路径才是权威。
   */
  private async audit(params: {
    eventType: AuditEventType;
    eventCategory: AuditEventCategory;
    eventDescription: string;
    level?: AuditLogLevel;
    result?: AuditResult;
    resourceType?: "shortcut" | "template" | "config" | "policy";
    resourceId?: string;
    resourceName?: string;
    actionDetails?: Record<string, unknown>;
    errorMessage?: string;
  }): Promise<void> {
    try {
      const { auditLogger } = await import("./audit");
      await auditLogger.log(params);
    } catch {
      /* 审计轨不可用时静默：配置的权威性不因它而改变 */
    }
  }

  /**
   * 引导：把**存下来的配置读回来**（幂等；由真正的使用者触发）—— REQ-A945。
   *
   * 为什么不能只依赖 `initialize()`：它的**唯一**生产调用点在
   * `enterprise/index.ts` 的 `initializeEnterprise()` 里，而**那个函数在生产里零调用者**
   * （全仓只在测试里被调用；本文件对面 `audit.ts` 的 `ensureInitialized()` 文档
   * 也记着同一件事）。于是这条链在设备上从来没有跑过：
   *
   *   1. **存下来的配置从不被读回** —— 管理员在面板里设好的限制落在存储里，
   *      重启后再没有任何人读它。`isEnabled()` 恒为假 ⇒ `checkActionAllowed()` /
   *      `checkPermission()` / `checkCanExecute()` 全部**放行**，而
   *      `getRestrictions()` 回落到"出厂默认"，于是面板**把默认值当成现行策略显示**。
   *      这一条尤其要紧：它让下面这些判据自身的修复（REQ-A824 / REQ-A842 / REQ-A899）
   *      在真机上是**不可达**的 —— 判据写对了，可它读的那份配置从来没人填。
   *   2. **自动同步从不启动**（`startAutoSync()` 也只在这个入口里）。
   *   3. **远端锁定与远端擦除从不触发** —— 它们同样只写在 `initialize()` 里。
   *
   * 所以把"我准备好了"这句话系在**真正需要它的入口**上：执行门禁
   * （`lib/shortcuts.ts::executeShortcut`，那条路上所有 MDM 判据的读者）与
   * 管理面板的挂载。任何一条被用到，配置就先自己站起来。
   *
   * **范围刻意收窄**：这里只做"读配置 + 读回当日执行计数"这两件**本地**的事。
   * `startAutoSync()`（会开始按 `syncInterval` 打网络）与 `initialize()` 的设备状态
   * 抛错留在原处 —— 前者是**产品决定**（是否让壳自己联网轮询），后者会在启动时
   * 打断整个应用。两者都在 REQ-A945 的边界里写明，不在本方法里顺手接上。
   */
  async ensureInitialized(): Promise<void> {
    if (this.bootstrapPromise === null) {
      this.bootstrapPromise = this.bootstrap();
    }
    return this.bootstrapPromise;
  }

  /**
   * "装载"这一份，只有这一处（`initialize()` 与 `ensureInitialized()` 共用；
   * 两份字节相同的引导正是本仓反复在修的形状）。
   */
  private async bootstrap(): Promise<void> {
    await this.loadConfig();
    this.loadExecutionCounts();
  }

  /**
   * 「内存里已经有一份配置了」—— 把引导标记为已完成。
   *
   * 谁该调它：**任何在内存里放下一份配置的生产者**（`configure()` / `enrollDevice()` /
   * `syncWithServer()`）。理由与「同一份判据只写一遍」同源：配置的**权威**在
   * 一次会话里只能有一处。生产者已经把配置放进内存之后，再去盘上读一份来覆盖它，
   * 最好不过是多余，最坏是**回退用户刚做的改动** —— `saveConfig()` 的写是可能被
   * 拒绝的（存储配额/加密不可用），那时内存比盘上**新**，一次迟到的 `loadConfig()`
   * 会把管理员的刚设的限制悄悄退回去。反过来"重启"必须真的重读，那是 `shutdown()`
   * 清空备忘的职责（它把 `bootstrapPromise` 置回 `null`）。
   */
  private markConfigProduced(): void {
    this.bootstrapPromise = Promise.resolve();
  }

  /**
   * 初始化 MDM 管理器
   *
   * 装载走 `ensureInitialized()`（**唯一**一份），这里只剩"装载之后要做的三件
   * 与启动有关的事"：起自动同步、以及在设备被锁/被擦时**打断启动**。
   * 后两件仍然只在这里 —— 它们要抛错，而"抛错打断整个应用"该由启动者决定，
   * 不该由一个被门禁顺手调用的引导去做（门禁要的是**判词**，见 `deviceBlockVerdict()`）。
   */
  async initialize(): Promise<void> {
    await this.ensureInitialized();
    
    if (this.config?.enabled) {
      // 启动自动同步
      this.startAutoSync();
      
      // 检查设备状态
      if (this.config.deviceStatus === "locked") {
        throw new Error(`设备已锁定: ${this.config.lockMessage || "请联系管理员"}`);
      }
      if (this.config.deviceStatus === "wiped") {
        await this.wipeLocalData();
        throw new Error("设备数据已被远程擦除");
      }
    }
  }

  /**
   * 加载 MDM 配置。
   *
   * 存储里的字节**要么是一个加密信封，要么是一份旧版本的明文配置** —— 这两条路必须
   * 先分开，再谈"失败怎么办"（REQ-A1440 / F-SH-698）：
   *
   * - **是信封** ⇒ 唯一能读懂它的路是解密。解密失败（被篡改 / 设备指纹漂移 /
   *   版本升级）是**硬失败**：`config = null`、写一条 error 审计、**保留原密文**。
   * - **不是信封** ⇒ 旧明文，走 `JSON.parse` + 迁移到加密格式（向后兼容）。
   *
   * 为什么不能像原来那样"解密失败就回退明文"：一个信封（`{version,ciphertext,iv,…}`）
   * **本身就是合法 JSON**，所以 `JSON.parse(raw)` 一定成功，回退会收下一份只有
   * `ciphertext`/`iv` 的垃圾配置（没有 `enabled` ⇒ `isEnabled()` 恒假 ⇒ **MDM 静默
   * 停用**，三个门禁全部放行），而紧随其后的"自动迁移"还会把这份垃圾**加密覆盖回
   * 原密文** —— apiKey / 组织 ID / 策略**永久丢失**，审计里却只留下一句"回退明文加载"。
   * 用 {@link isEncryptedEnvelope} 把两种字节分开，才谈得上"解密失败时保留原密文"。
   */
  private async loadConfig(): Promise<void> {
    const raw = readStoreValue(STORE_KEYS.MDM_CONFIG, "");
    if (!raw) {
      this.config = null;
      return;
    }

    try {
      const { decryptMDMData, isCryptoAvailable, isEncryptedEnvelope } = await import("../crypto/mdmCrypto");

      if (isEncryptedEnvelope(raw)) {
        // 信封存在，但连解密的工具都没有 ⇒ 同样是硬失败：绝不能把信封当明文吃下去。
        if (!isCryptoAvailable()) {
          console.warn("[MDM] 存储是加密配置，但 Web Crypto 不可用 —— 保留原密文");
          await this.audit({
            eventType: "error_occurred",
            eventCategory: "security",
            eventDescription: "MDM 加密配置无法读取：Web Crypto 不可用（已保留原密文）",
            level: "error",
            result: "failure",
            errorMessage: "crypto_unavailable",
          });
          this.config = null;
          return;
        }

        try {
          const decrypted = await decryptMDMData(raw);
          this.adoptStoredConfig(JSON.parse(decrypted));

          // 审计：配置以加密格式加载成功
          await this.audit({
            eventType: "mdm_config_update",
            eventCategory: "security",
            eventDescription: "MDM 配置解密加载成功",
            actionDetails: { storage: "encrypted" },
          });

          return;
        } catch (decryptErr) {
          // 硬失败：数据可能被篡改，或密钥已随环境指纹漂移。**原密文一个字节都不动** ——
          // 既不当明文收下，也不触发下面的"自动迁移"覆盖（见方法头注释）。
          console.warn("[MDM] 加密配置解密失败，保留原密文:", decryptErr);
          await this.audit({
            eventType: "error_occurred",
            eventCategory: "security",
            eventDescription: "MDM 配置解密失败（数据可能被篡改或密钥已变更），已保留原密文",
            level: "error",
            result: "failure",
            errorMessage: String(decryptErr),
          });
          this.config = null;
          return;
        }
      }

      // 回退：明文格式（旧版本），**只有非信封字节才走到这里**。
      this.adoptStoredConfig(JSON.parse(raw));

      // 迁移到加密格式是一次**额外的写**，它与"这次读取成不成功"是两件事。让它的异常冒泡到
      // 外层 catch，会把一份**已经读好的配置**丢掉（那个 catch 做的是 `this.config = null`），
      // 并记下"配置加载失败"这个**错误的因果** —— 用户莫名失去 MDM，而真正的原因是写配额。
      // 读成功就是读成功：迁移没写成，本次照旧用明文配置跑，并把这件事如实记成迁移失败。
      if (this.config && isCryptoAvailable()) {
        console.info("[MDM] 检测到明文配置，自动迁移到加密存储");
        try {
          await this.saveConfig(); // 重新保存为加密格式
        } catch (migrateErr) {
          console.warn("[MDM] 明文配置迁移到加密存储失败，本次仍以明文配置运行:", migrateErr);
          await this.audit({
            eventType: "error_occurred",
            eventCategory: "security",
            eventDescription: "MDM 明文配置迁移加密失败（本次仍以明文运行）",
            level: "error",
            result: "failure",
            errorMessage: String(migrateErr),
          });
        }
      }
    } catch (err) {
      console.error("[MDM] 加载配置失败:", err);
      await this.audit({
        eventType: "error_occurred",
        eventCategory: "system",
        eventDescription: "MDM 配置加载失败",
        level: "error",
        result: "failure",
        errorMessage: String(err),
      });
      this.config = null;
    }
  }

  /**
   * 收下一份**来自存储**的配置：`restrictions` 补齐成完整的限制表，其余字段原样。
   *
   * 为什么不能只做 `JSON.parse(raw) as MDMConfig`：存储里的东西是**上一个版本写的**。
   * 一个新增的限制项在旧记录里当然不存在，断言它存在只是把编译器的检查换成一句谎 ——
   * 于是 `restrictions.maxExecutionsPerDay` 是 `undefined`，而今天的判据在
   * `undefined` 上恒为假（`currentCount >= undefined`），配额就此静默失效。
   * 基准取 `DEFAULT_RESTRICTIONS`：存储里没提这一项，就是没有新意见。
   */
  private adoptStoredConfig(parsed: unknown): void {
    const stored = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Partial<MDMConfig>;
    this.config = {
      ...(stored as MDMConfig),
      restrictions: normalizeRestrictions(stored.restrictions, DEFAULT_RESTRICTIONS),
    };
  }

  /**
   * 保存 MDM 配置
   *
   * 使用加密存储保护敏感数据（API 密钥、组织 ID 等）。
   */
  private async saveConfig(): Promise<void> {
    if (!this.config) return;
    
    try {
      const { encryptMDMData, isCryptoAvailable } = await import("../crypto/mdmCrypto");
      
      const plaintext = JSON.stringify(this.config);
      
      if (isCryptoAvailable()) {
        // 加密存储（推荐）
        const encrypted = await encryptMDMData(plaintext);
        const success = writeStoreValueChecked(STORE_KEYS.MDM_CONFIG, encrypted);
        
        if (success) {
          await this.audit({
            eventType: "mdm_config_update",
            eventCategory: "security",
            eventDescription: "MDM 配置加密保存成功",
            actionDetails: { storage: "encrypted", dataSize: encrypted.length },
          });
        } else {
          throw new Error("写入加密配置失败");
        }
      } else {
        // 回退：明文存储（不推荐，仅用于不支持 Web Crypto 的环境）
        console.warn("[MDM] Web Crypto API 不可用，使用明文存储（不安全）");
        // 这次写入就是本方法的目的：存储拒收必须被当成失败报出来，而不是照旧
        // 记一条"已保存"（write-scan / audit P1-3 的同一规则）。
        if (!writeStoreValueChecked(STORE_KEYS.MDM_CONFIG, plaintext)) {
          throw new Error("写入明文配置失败");
        }

        // 明文存储是一次**安全降级**，必须留下 warning，而不是静默发生。
        await this.audit({
          eventType: "warning_occurred",
          eventCategory: "security",
          eventDescription: "MDM 配置以明文保存（Web Crypto 不可用）",
          level: "warning",
          result: "warning",
          actionDetails: { storage: "plaintext", warning: "encryption_unavailable" },
        });
      }
    } catch (err) {
      console.error("[MDM] 保存配置失败:", err);
      await this.audit({
        eventType: "error_occurred",
        eventCategory: "system",
        eventDescription: "MDM 配置保存失败",
        level: "error",
        result: "failure",
        errorMessage: String(err),
      });
      throw err; // 向上传播错误
    }
  }

  /**
   * 加载执行计数
   *
   * 形状必须与 `saveExecutionCounts` 一致：那里写的是
   * `{ date: "yyyy-mm-dd", counts: { "<yyyy-mm-dd>-<shortcutId>": n } }`。
   * 这里原来把**整个对象**当成"键 → 次数"的扁平表读（`new Map(Object.entries(data))`），
   * 于是读回来的键只会是 `"date"` / `"counts"` 两个字面量 —— **每一个真实计数都被丢掉**，
   * 而 `raw.includes(today)` 又因为 `date` 字段里就有今天的日期而不清空 ⇒
   * `checkDailyExecutionLimit` 拿到 `undefined`、按 0 处理 ⇒
   * **每日执行配额在每次重启/重载后静默失效**（`saveExecutionCounts` 的告警恰好把这句
   * "当日配额会重新开始"写成"存储拒绝时才会发生"，而正常路径就是那样）。
   */
  private loadExecutionCounts(): void {
    const raw = readStoreValue<string>(STORE_KEYS.MDM_EXECUTION_COUNT, "");
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as { date?: unknown; counts?: unknown };
      const today = new Date().toISOString().split("T")[0] || "";

      // 形状不认识、或存的是**别的日子** ⇒ 清空：配额是"每日"的，昨天的计数今天不算数。
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        parsed.date !== today ||
        parsed.counts === null ||
        typeof parsed.counts !== "object" ||
        Array.isArray(parsed.counts)
      ) {
        this.executionCounts.clear();
        return;
      }

      const restored = new Map<string, number>();
      for (const [key, value] of Object.entries(parsed.counts as Record<string, unknown>)) {
        // 只收自己能解释的条目：一个坏条目不该把整份配额读成 NaN/字符串。
        if (typeof value === "number" && Number.isFinite(value)) restored.set(key, value);
      }
      this.executionCounts = restored;
    } catch (err) {
      console.error("[MDM] 加载执行计数失败:", err);
      this.executionCounts.clear();
    }
  }

  /**
   * 保存执行计数
   */
  private saveExecutionCounts(): void {
    const today = new Date().toISOString().split("T")[0];
    const data: Record<string, number> = {};
    
    this.executionCounts.forEach((count, key) => {
      data[key] = count;
    });
    
    const serialized = JSON.stringify({ date: today, counts: data });
    // 每日执行计数丢失 = 管理员设的上限当天会重新开始，必须报（write-scan 判据）。
    if (!writeStoreValueChecked(STORE_KEYS.MDM_EXECUTION_COUNT, serialized)) {
      console.error("[MDM] 执行计数写入被存储拒绝 —— 当日配额会在重启后重新开始");
    }
  }

  /**
   * 注册设备到 MDM
   */
  async enrollDevice(
    serverUrl: string,
    enrollmentToken: string,
    deviceName: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      const deviceId = this.generateDeviceId();
      
      // 调用注册 API（**真的**发出去：`callMDMApi` 是一次 `fetch`，`crates/amos-mdm`
      // 在 `/api/mdm/enroll` 上真的挂着这条路由。「模拟」这个旧说法与本文件里那个
      // 「不联系任何东西的测试连接」是同一场误会，REQ-A819 一并更正。）
      const response = await this.callMDMApi<MDMEnrollResponse>(`${serverUrl}/api/mdm/enroll`, {
        method: "POST",
        body: JSON.stringify({
          enrollmentToken,
          deviceId,
          deviceName,
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          timestamp: Date.now(),
        }),
      });

      if (!response.success || !response.data) {
        return { success: false, message: response.message || "注册失败" };
      }

      // 创建初始配置
      this.config = {
        enabled: true,
        organizationId: response.data.organizationId,
        organizationName: response.data.organizationName,
        deviceId,
        deviceName,
        serverUrl,
        apiKey: response.data.apiKey,
        policies: [],
        restrictions: DEFAULT_RESTRICTIONS,
        enforcedShortcuts: [],
        enforcedTemplates: [],
        syncInterval: 3600, // 1 小时
        lastSyncAt: Date.now(),
        lastSyncStatus: "success",
        deviceStatus: "active",
        enrolledAt: Date.now(),
        enrolledBy: response.data.enrolledBy || "admin",
        version: "1.0.0",
      };
      this.markConfigProduced(); // 注册即已配置：一次迟到的 `loadConfig()` 不得覆盖它

      await this.saveConfig();

      // 首次同步
      await this.syncWithServer();

      return { success: true, message: "设备注册成功" };
    } catch (err) {
      console.error("[MDM] 注册失败:", err);
      return { success: false, message: err instanceof Error ? err.message : "注册失败" };
    }
  }

  /**
   * 取消注册
   */
  async unenrollDevice(): Promise<void> {
    if (!this.config) return;

    try {
      // 通知服务器
      await this.callMDMApi(`${this.config.serverUrl}/api/mdm/unenroll`, {
        method: "POST",
        body: JSON.stringify({
          deviceId: this.config.deviceId,
          timestamp: Date.now(),
        }),
      });
    } catch (err) {
      console.error("[MDM] 取消注册失败:", err);
    }

    // 清理本地数据（同 `clearStoredState`：必须落到**存储**，否则一次"取消注册"之后
    // 加密配置原样留在盘上，下次启动又把它读回来，设备"退不掉"。）
    this.clearStoredState();
  }

  /**
   * **真的**去问那台服务器它在不在（「测试连接」按钮的实现，REQ-A819）。
   *
   * 为什么需要它：面板上那个按钮原先不联系任何东西 —— 它 `setTimeout` 1 秒，
   * 然后只看 `serverUrl.startsWith("https://")`，就报「连接成功」。一台拼错的、
   * 已下线的、或把我们挡在门外的服务器，都会得到同一个绿色提示。
   *
   * 探的是 `GET {serverUrl}/health`：`crates/amos-mdm/src/lib.rs:98` 真的挂了这条路由
   * （`handlers::health_check` 返回纯文本 `OK`，**未认证**），也正是隔壁「API 集成」
   * 面板的测试连接在探的那条（`APISettings.svelte::testConnection`）。**不新造端点**。
   *
   * 为什么不用 `callMDMApi`：那个助手**假定 JSON** 并 `await response.json()`，
   * 而 `/health` 回的是 `text/plain` ⇒ 一个健康的服务器会被它判成解析失败。这里按
   * 纯文本读，且**不抛**：调用的地方（一个按钮）需要的是「成没成 + 为什么」，
   * 不是一个异常。
   */
  async checkConnection(): Promise<MDMConnectionResult> {
    const serverUrl = (this.config?.serverUrl ?? "").trim();
    if (!serverUrl) return { ok: false, reason: "no-server" };
    // 明文 http 不是「连接失败」，是**根本不该发**：MDM 的注册令牌与设备标识都在这条
    // 连接上走，所以这里拒绝得比「前缀不对」更早，也不产生任何请求。
    if (!serverUrl.startsWith("https://")) return { ok: false, reason: "insecure-url" };

    // 去掉尾部的 `/`：`https://mdm.example.test/` 与 `.../health` 直接相接会得到
    // `//health`，而 axum 把它当**另一条路径**（404）—— 一台好服务器会被判成
    // 「服务器返回 HTTP 404」。测试里钉着这一条。
    const base = serverUrl.replace(/\/+$/, "");

    try {
      const response = await fetch(`${base}/health`, { method: "GET" });
      if (!response.ok) return { ok: false, reason: "http-status", status: response.status };
      const body = (await response.text()).trim();
      // 200 不等于「这是我们的服务器」——代理、登录门户、任意一个 web 服务都能回 200。
      if (body !== "OK") return { ok: false, reason: "unexpected-body" };
      return { ok: true };
    } catch {
      // 连不上（DNS／TLS／超时／被拒）。**不抛**，也**不**把 `TimeoutError: …`
      // 这类机器话当成给用户看的理由 —— 理由由调用方按 `reason` 取词典。
      return { ok: false, reason: "unreachable" };
    }
  }

  /**
   * 与服务器同步配置
   */
  async syncWithServer(): Promise<MDMSyncResponse> {
    if (!this.config) {
      return {
        success: false,
        message: "MDM 未启用",
        serverTime: Date.now(),
      };
    }

    try {
      const response = await this.callMDMApi<Partial<MDMConfig>>(
        `${this.config.serverUrl}/api/mdm/sync`,
        {
          method: "POST",
          body: JSON.stringify({
            deviceId: this.config.deviceId,
            lastSyncAt: this.config.lastSyncAt,
            currentVersion: this.config.version,
          }),
        }
      );

      if (!response.success || !response.data) {
        this.config.lastSyncStatus = "failure";
        this.config.lastSyncError = response.message;
        await this.saveConfig();
        return {
          success: false,
          message: response.message,
          serverTime: Date.now(),
        };
      }

      // 更新配置
      //
      // `restrictions` 单独走 `normalizeRestrictions()`：它的类型是 `Partial<MDMConfig>`
      // 而对象展开是**浅**的，所以服务端下发 `{ restrictions: { maxExecutionTime: 60 } }`
      // 时，展开会把整个 `restrictions` 子树换成只有一项的对象 —— 其余限制变成
      // `undefined` ⇒ 判据恒放行（fail open），而下面这一行 `saveConfig()` 还把这个
      // 空壳**落盘**，重启后依然如此。没提到的项保持原值，才是「增量」该有的语义。
      const serverConfig = response.data;
      this.config = {
        ...this.config,
        ...serverConfig,
        restrictions: normalizeRestrictions(serverConfig.restrictions, this.config.restrictions),
        lastSyncAt: Date.now(),
        lastSyncStatus: "success",
        lastSyncError: undefined,
      };
      // 这里**不**调 `markConfigProduced()`：本来写了，但它是不可达的陈述 —— 本方法
      // 开头 `if (!this.config) return`，所以走到这里时配置必然已经存在，而 `this.config`
      // 只有两条来路：`loadConfig()`（自己就标记了）或一个生产者 `configure()` /
      // `enrollDevice()`（它们各自标记）。一个改不动任何行为的"标记"正是本仓反复在修的
      // 形状（写了两遍的同一条规则），所以删掉、把这句留给不变量的两处真holder。
      await this.saveConfig();

      return {
        success: true,
        config: this.config,
        serverTime: Date.now(),
      };
    } catch (err) {
      console.error("[MDM] 同步失败:", err);
      if (this.config) {
        this.config.lastSyncStatus = "failure";
        this.config.lastSyncError = err instanceof Error ? err.message : "同步失败";
        await this.saveConfig();
      }
      return {
        success: false,
        message: err instanceof Error ? err.message : "同步失败",
        serverTime: Date.now(),
      };
    }
  }

  /**
   * 启动自动同步
   *
   * 定时器**必须留句柄**：原来这里连 id 都不存、也没有任何停止路径，于是
   * ①重复 `initialize()` 会叠出多只定时器（每次 syncInterval 就多发一轮同步），
   * ②壳是长期存活的，谁也无法停掉它 —— lifetime-scan 的判据（REQ-A385）。
   */
  private startAutoSync(): void {
    if (!this.config) return;

    this.stopAutoSync(); // 幂等：重复启动不得叠加
    this.syncTimer = setInterval(() => {
      this.syncWithServer().catch((err) => {
        console.error("[MDM] 自动同步失败:", err);
      });
    }, this.config.syncInterval * 1000);
  }

  /** 停止自动同步（幂等；`shutdownEnterprise` 会调它）。 */
  stopAutoSync(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * 检查操作是否允许（按分类和操作 ID）
   */
  checkActionAllowed(category: ActionCategory, actionId: string): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    // 两个数组都可能是「配置里根本没有这一项」（存量配置 / 服务端增量下发）。
    // `normalizeRestrictions()` 在三个入口上补齐了它，但 `setConfigForTest()` 与
    // 直接赋值仍然能绕过 —— 于是这里也按「缺席 = 空表」读，读不出数组就不拦：
    // 一张**说不出来**的禁用表不是「全部禁用」，而且它绝不该让权限检查抛异常
    // （`.includes` on undefined 抛出去的地方是一次放行/拒绝的判定，不是错误边界）。
    const disabledCategories = this.config.restrictions?.disabledCategories;
    const disabledActions = this.config.restrictions?.disabledActions;

    // 检查分类限制
    if (Array.isArray(disabledCategories) && disabledCategories.includes(category)) {
      return {
        allowed: false,
        reason: `操作分类 "${category}" 已被管理员禁用`,
      };
    }

    // 检查特定操作限制
    if (Array.isArray(disabledActions) && disabledActions.includes(actionId)) {
      return {
        allowed: false,
        reason: `操作 "${actionId}" 已被管理员禁用`,
      };
    }

    return { allowed: true };
  }

  /**
   * 检查权限
   */
  checkPermission(permission: "create" | "modify" | "delete" | "share" | "export" | "import"): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    const restrictions = this.config.restrictions;

    switch (permission) {
      case "create":
        if (!restrictions.allowUserCreate) {
          return { allowed: false, reason: "管理员已禁止创建快捷指令" };
        }
        if (restrictions.requireApprovalForCreate) {
          return { allowed: false, reason: "创建快捷指令需要管理员审批" };
        }
        break;

      case "modify":
        if (!restrictions.allowUserModify) {
          return { allowed: false, reason: "管理员已禁止修改快捷指令" };
        }
        if (restrictions.requireApprovalForModify) {
          return { allowed: false, reason: "修改快捷指令需要管理员审批" };
        }
        break;

      case "delete":
        if (!restrictions.allowUserDelete) {
          return { allowed: false, reason: "管理员已禁止删除快捷指令" };
        }
        break;

      case "share":
        if (!restrictions.allowSharing) {
          return { allowed: false, reason: "管理员已禁止分享快捷指令" };
        }
        if (restrictions.requireApprovalForSharing) {
          return { allowed: false, reason: "分享快捷指令需要管理员审批" };
        }
        break;

      case "export":
        if (!restrictions.allowExport) {
          return { allowed: false, reason: "管理员已禁止导出快捷指令" };
        }
        break;

      case "import":
        if (!restrictions.allowImport) {
          return { allowed: false, reason: "管理员已禁止导入快捷指令" };
        }
        break;
    }

    return { allowed: true };
  }

  /**
   * 策略里「每用户最多多少条快捷指令」的**规范值**（REQ-A842）。
   *
   * 与 `policyExecutionSeconds()` 同一条规矩、同一个理由：`NaN`／`Infinity`／负数一律折成
   * `0`，因为它们**不是**「没有限制」。一个 `NaN` 上限会让 `count >= NaN` 恒为假 ——
   * 那条策略一纸空文，而它在面板上看起来还在配置里（这正是本条要修的缺陷的形状）。
   * 折成 `0` 是**朝严格的一侧失败**：这是限制，沉默放行才是危险的那一侧。
   */
  private policyShortcutCap(): number {
    const cap = this.config?.restrictions?.maxShortcutsPerUser;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) return 0;
    return cap;
  }

  /**
   * 检查是否允许创建快捷指令。
   *
   * `currentCount` 是**必填**的：`maxShortcutsPerUser` 从落地起就被声明、有默认值、
   * 服务端能下发、面板上有一个诚实的数字框、`getPolicy` 能取回 —— 却**没有任何一处读它**
   * （REQ-A842）。上游 `createShortcut()` 在调用前就已经把列表读进内存了，数得出来。
   *
   * 参数**不给默认值**是刻意的：可选参数等于给下一个调用点留一条「忘了传就静默不设限」
   * 的路，而这条限制的整个缺陷就是「没人读」。必填 ⇒ 漏传是编译错误，不是安全洞。
   */
  checkCanCreate(currentCount: number): MDMCheckResult {
    const permission = this.checkPermission("create");
    if (!permission.allowed) return permission;

    if (!this.config?.enabled) {
      return { allowed: true };
    }

    const cap = this.policyShortcutCap();
    if (currentCount >= cap) {
      return {
        allowed: false,
        reason: `每用户快捷指令数已达上限（${cap}）`,
      };
    }

    return { allowed: true };
  }

  /**
   * 检查是否允许修改快捷指令。
   *
   * 「开关 + 审批」那半**委托给 `checkPermission("modify")`**：这两条原先在这里被
   * 逐字重写了一遍（`!allowUserModify` → "管理员已禁止修改快捷指令"、
   * `requireApprovalForModify` → "修改快捷指令需要管理员审批"，与 `checkPermission`
   * 里的**一字不差**）。是 `mdm-restriction-scan` 的读站点表把这两处量出来的 ——
   * 同一个开关出现了两个读取点。`checkCanCreate()` 早就是委托写法，这里只是补齐。
   *
   * 顺序保留：**强制安装**的判定在开关之前（既有测试钉着「优先于开关」）。
   */
  checkCanModify(shortcutId: string): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    // 强制快捷指令不可修改（`enforcedShortcuts` 缺席 ⇒ 没有强制项，绝不抛）
    if (this.config.enforcedShortcuts?.includes(shortcutId)) {
      return {
        allowed: false,
        reason: "此快捷指令由管理员强制安装，不可修改",
      };
    }

    return this.checkPermission("modify");
  }

  /**
   * 检查是否允许删除快捷指令（同上：开关那半委托给 `checkPermission("delete")`）。
   */
  checkCanDelete(shortcutId: string): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    // 强制快捷指令不可删除（同上：缺席即没有强制项）
    if (this.config.enforcedShortcuts?.includes(shortcutId)) {
      return {
        allowed: false,
        reason: "此快捷指令由管理员强制安装，不可删除",
      };
    }

    return this.checkPermission("delete");
  }

  /**
   * 检查是否允许执行
   *
   * **这是两条命名判据的组合，不是它们的第三份实现**（REQ-A899）。原来这里把
   * `checkActionCount()` / `checkDailyExecutionLimit()` 各内联了一遍，于是同一个上限
   * 有了两份代码：命名的那份带 NaN 折叠（折成 0 = 拒绝），内联的那份没有 ——
   * `actionCount > undefined` 与 `currentCount >= undefined` 都恒为假，
   * **限额在 `undefined` 上限下静默失效**；而那两个名字因为没人调用，在
   * `dead-member-scan` 里一直是「死了的判据」。同一份规则写两遍，两遍就会分叉。
   *
   * 顺序：**内容**（操作数上限）先于**配额**（每日次数）—— 与 `shortcuts.ts` 的调用点
   * 一致（那里把「被禁的操作」排在 `checkCanExecute()` 之前，理由同样是让永久性的理由
   * 先于今天暂时用完的额度）。
   */
  checkCanExecute(shortcutId: string, actionCount: number): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    const byCount = this.checkActionCount(actionCount);
    if (!byCount.allowed) return byCount;

    return this.checkDailyExecutionLimit(shortcutId);
  }

  /**
   * 策略里「单次执行最长多少秒」的**规范值**（REQ-A824）。
   *
   * 这是 `checkExecutionTime` 与 `executionTimeLimitMs` **共用的唯一定义** —— 两个读者
   * 读同一个数，才不会有第二个地方悄悄用别的规则算一遍。
   *
   * `NaN`／`Infinity`／负数一律折成 `0`：它们**不是**「没有限制」。`NaN` 会让
   * `durationSeconds > NaN` 恒为假（于是这条策略一纸空文，而它看起来还在配置里），
   * 负数则在新旧语义下都把每次执行判成越界。折成 `0` 是**朝严格的一侧失败** ——
   * 这是安全限制，沉默放行才是危险的那一侧。
   */
  private policyExecutionSeconds(): number {
    const seconds = this.config?.restrictions?.maxExecutionTime;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return 0;
    return seconds;
  }

  /**
   * 检查执行时间限制
   */
  checkExecutionTime(durationSeconds: number): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    const limit = this.policyExecutionSeconds();
    if (!Number.isFinite(durationSeconds) || durationSeconds > limit) {
      return {
        allowed: false,
        reason: `执行时间超过最大执行时间限制（${limit}秒）`,
      };
    }

    return { allowed: true };
  }

  /**
   * 执行引擎要读的那一个数：策略允许的单次执行时长，**毫秒**；`null` 表示**没有**策略上限
   * （MDM 未启用，或没有配置）。
   *
   * 为什么要有它（REQ-A824）：`checkExecutionTime` 从落地起只有测试调用过 —— 没有任何
   * 一处**执行路径**问过它。于是这条限制是**声明了、有默认值、服务端能下发、
   * `getPolicy("maxExecutionTime")` 能取回、界面上却看不见、也没有任何东西去执行**的一条。
   * 引擎当时只看自己的常量 `LIMITS.MAX_EXECUTION_TIME_MS`，两套上限互不知情，
   * 而 `mdm.enableHint` 的「启用后将应用企业策略和使用限制」对它而言是假的。
   */
  executionTimeLimitMs(): number | null {
    if (!this.config?.enabled) return null;
    return this.policyExecutionSeconds() * 1000;
  }

  /**
   * 策略里「单条快捷指令最多多少个操作」的**规范值**（REQ-A899）。
   *
   * 与 `policyExecutionSeconds()` / `policyShortcutCap()` 同一条规矩、同一个理由：
   * `NaN`／`Infinity`／负数一律折成 `0`，因为它们**不是**「没有上限」——
   * 一个 `undefined` 或 `NaN` 上限会让 `count > cap` 恒为假，那条策略一纸空文，
   * 而它在面板上看起来还在配置里。折成 `0` 是**朝严格的一侧失败**。
   */
  private policyActionCap(): number {
    const cap = this.config?.restrictions?.maxActionsPerShortcut;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) return 0;
    return cap;
  }

  /**
   * 策略里「每天最多执行多少次」的**规范值**（REQ-A899）。折叠规则同上。
   */
  private policyDailyCap(): number {
    const cap = this.config?.restrictions?.maxExecutionsPerDay;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) return 0;
    return cap;
  }

  /**
   * 操作数上限的**唯一定义**（`checkCanExecute()` 组合它，不再自己算一遍）。
   *
   * 措辞与 `checkCanExecute()` 内联时代的用户可见文案保持一致 —— `reason` 会经
   * `shortcuts.ts` 的 `error` 字段显示给用户，取一句话、说清上限是多少。
   */
  checkActionCount(count: number): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    const cap = this.policyActionCap();
    if (count > cap) {
      return {
        allowed: false,
        reason: `快捷指令操作数超过最大操作数限制（${cap}）`,
      };
    }

    return { allowed: true };
  }

  /**
   * 每日执行次数上限的**唯一定义**（`checkCanExecute()` 组合它）。措辞同上：
   * 沿用用户已经看到过的那一句。
   */
  checkDailyExecutionLimit(shortcutId: string): MDMCheckResult {
    if (!this.config?.enabled) {
      return { allowed: true };
    }

    const today = new Date().toISOString().split("T")[0];
    const countKey = `${today}-${shortcutId}`;
    const currentCount = this.executionCounts.get(countKey) || 0;

    const cap = this.policyDailyCap();
    if (currentCount >= cap) {
      return {
        allowed: false,
        reason: `已达到每日最大执行次数（${cap}）`,
      };
    }

    return { allowed: true };
  }

  /**
   * 记录执行
   */
  recordExecution(shortcutId: string): void {
    if (!this.config?.enabled) return;

    const today = new Date().toISOString().split("T")[0];
    const countKey = `${today}-${shortcutId}`;
    const currentCount = this.executionCounts.get(countKey) || 0;
    
    this.executionCounts.set(countKey, currentCount + 1);
    this.saveExecutionCounts();
  }

  /**
   * 检查操作是否被禁用（`checkActionAllowed()` 的布尔适配器）。
   *
   * 它原来是一份**独立实现**：同样的两个数组、同样的两次 `.includes`，而它的形参顺序
   * 与 `checkActionAllowed(category, actionId)` **相反**（`(actionId, category)`）。
   * 因为生产里零调用者，这个颠倒从没造成过错误 —— 但这是一个「接线那天才会炸」的地雷：
   * 两个参数都是字符串，接错顺序能编译、能跑，只是问了另一个问题。现在它转发给那一份
   * 唯一定义（在转发点上按正确顺序传参），这条规则就只有一个实现。
   *
   * 顺带解决了原来的第二个问题：数组字段被抹掉时 `.includes` 会**从一次权限检查里
   * 抛出**。`normalizeRestrictions()` 保证进来的数组一定是数组。
   *
   * @deprecated 形参顺序与 `checkActionAllowed(category, actionId)` 相反，而两者都是
   * 字符串 —— 接错顺序不会报错，只会问错另一个问题。新调用点请直接用
   * `checkActionAllowed(category, actionId)`（它同时给出理由，那是用户看得见的那一句）。
   */
  isActionDisabled(actionId: string, category: ActionCategory): boolean {
    if (!this.config?.enabled) return false;

    return !this.checkActionAllowed(category, actionId).allowed;
  }

  /**
   * 获取当前配置
   */
  getConfig(): MDMConfig | null {
    return this.config;
  }

  /**
   * 获取限制配置
   */
  getRestrictions(): MDMRestrictions {
    return this.config?.restrictions || DEFAULT_RESTRICTIONS;
  }

  /**
   * 获取设备状态
   */
  /**
   * 设备级门禁：远端把设备**锁了**或**擦了**，此时任何指令都不该再跑 —— REQ-A945。
   *
   * 为什么要有这个方法（它此前**不存在**，而后果比一个缺失的方法大得多）：
   * 「锁 / 擦」这两件事的**已知表述**只有一处，在 `initialize()` 里 ——
   * `throw new Error(\`设备已锁定: ${lockMessage}\`)` 与"擦除后抛错"。
   * 而 `initialize()` 在生产里没人调用，所以：
   *
   *   - `getDeviceStatus()` 与 `getLockMessage()` 是**零生产读者**的一对
   *     （`dead-member-allowlist.json` 已登记，理由是"先要一起设计界面"）——
   *     登记得没错，但它没说出更重的那半：**它们的执行侧也只存在于那个没人调的
   *     入口里**，所以远端锁一台设备，设备上既看不见、也不生效。
   *   - 于是"远端锁定"这条 MDM 最核心的合规动作，在真机上的效果是**零**。
   *
   * 这里把它变成**判词**（而不是抛错），因为调用它的地方是执行门禁：门禁要把理由
   * 渲染给用户，而不是把一个异常扔进一个没有 catch 的栈里。
   *
   * 措辞**取设备自己的话**：锁定的理由是管理员在服务端写下的 `lockMessage`
   * （`initialize()` 用的也是它）；只有它缺席时才用本仓那句兜底。擦除那一侧同理 ——
   * 用的是 `initialize()` 里那句已经在源码里的话，一个字都不新编。
   *
   * **不做破坏性动作**：真实擦除（`wipeLocalData()`）仍然只在 `initialize()` 里。
   * 把一个不可逆的本地擦除挂在"用户跑了一条指令"这条路上，等于给门禁配一把枪。
   */
  deviceBlockVerdict(): MDMCheckResult {
    const status = this.getDeviceStatus();
    if (status === "locked") {
      return { allowed: false, reason: this.getLockMessage() || "设备已被管理员锁定" };
    }
    if (status === "wiped") {
      return { allowed: false, reason: "设备数据已被远程擦除" };
    }
    return { allowed: true };
  }

  getDeviceStatus(): "active" | "locked" | "wiped" {
    return this.config?.deviceStatus || "active";
  }

  /**
   * 获取锁定消息
   */
  getLockMessage(): string | undefined {
    return this.config?.lockMessage;
  }

  /**
   * 是否已启用 MDM
   */
  isEnabled(): boolean {
    return this.config?.enabled ?? false;
  }

  /**
   * 配置 MDM（手动）
   */
  async configure(config: Partial<MDMConfig>): Promise<void> {
    if (!this.config) {
      // 如果没有配置，创建默认配置。限制表取 `DEFAULT_RESTRICTIONS` —— 这里曾经有一份
      // **内联的副本**（`maxActionsPerShortcut: 50`，而声明的默认是 `100`），于是
      // 「首次配置」与「删除策略恢复默认」/「注册得到」三条路给出两个不同的上限。
      this.config = {
        enabled: false,
        serverUrl: "",
        deviceId: this.generateDeviceId(),
        deviceName: "",
        organizationId: "",
        organizationName: "",
        apiKey: "",
        policies: [],
        lastSyncAt: 0,
        syncInterval: 3600,
        lastSyncStatus: "pending",
        deviceStatus: "active",
        enrolledAt: 0,
        enrolledBy: "",
        version: "1.0.0",
        restrictions: normalizeRestrictions(),
        enforcedShortcuts: [],
        enforcedTemplates: [],
      };
    }

    // 更新配置（确保必需字段存在）
    if (!this.config) return;

    // 注意：这里逐字段重建，**新增字段必须一起列进来**。`lockMessage` 与
    // `lastSyncError` 曾经不在表里 ⇒ 每次 `configure()`（ enrolment / 同步 / 手动设置
    // 都会走到这里）都会把管理员下发的锁定说明与上次同步错误**静默丢掉**：
    // 锁定屏会显示通用措辞，而"为什么同步失败"再也查不到。
    // （`enterprise-mdm-restrictions.test.ts` 用 `Required<MDMConfig>` 逐字段往返钉住了
    // 这张表的完整性 —— 类型新增字段而这里没补，那个对象字面量就编译不过。）
    const restrictions =
      config.restrictions === undefined
        ? this.config.restrictions
        : // **一层深合并**，不是整块替换：`Partial<MDMRestrictions>` 的浅语义会让
          // 「只下发了一项」变成「其余项全被取消」。没提到的项保持原值。
          normalizeRestrictions(config.restrictions, this.config.restrictions);

    this.config = {
      enabled: config.enabled ?? this.config.enabled,
      organizationId: config.organizationId ?? this.config.organizationId,
      organizationName: config.organizationName ?? this.config.organizationName,
      deviceId: config.deviceId ?? this.config.deviceId,
      deviceName: config.deviceName ?? this.config.deviceName,
      serverUrl: config.serverUrl ?? this.config.serverUrl,
      apiKey: config.apiKey ?? this.config.apiKey,
      policies: config.policies ?? this.config.policies,
      restrictions,
      enforcedShortcuts: config.enforcedShortcuts ?? this.config.enforcedShortcuts,
      enforcedTemplates: config.enforcedTemplates ?? this.config.enforcedTemplates,
      syncInterval: config.syncInterval ?? this.config.syncInterval,
      lastSyncAt: config.lastSyncAt ?? this.config.lastSyncAt,
      lastSyncStatus: config.lastSyncStatus ?? this.config.lastSyncStatus,
      lastSyncError: config.lastSyncError ?? this.config.lastSyncError,
      deviceStatus: config.deviceStatus ?? this.config.deviceStatus,
      lockMessage: config.lockMessage ?? this.config.lockMessage,
      enrolledAt: config.enrolledAt ?? this.config.enrolledAt,
      enrolledBy: config.enrolledBy ?? this.config.enrolledBy,
      version: config.version ?? this.config.version,
    };
    this.markConfigProduced(); // 见 `markConfigProduced()`：内存里这份比盘上那份新
    await this.saveConfig();

    // 企业 webhook（REQ-A980）：`configure()` 是**生产里唯一真的会改到限制表**的路径
    // （注册 / 同步 / 手动设置都走它；`addPolicy`／`deletePolicy` 在生产里零调用者）。
    // 只在调用方**这一趟真的下发了** `restrictions` 时发：`undefined` 表示"没提到限制"，
    // 那不叫一次策略变更（同一个方向判据见 `mdm.ts` 里"只在开启分享时问"的那一段）。
    if (config.restrictions !== undefined) {
      emitWebhookEvent("mdm_policy_change", {
        organizationId: this.config.organizationId,
        deviceId: this.config.deviceId,
        restrictions: { ...this.config.restrictions },
      });
    }
  }

  /**
   * 添加策略
   */
  async addPolicy(policyKey: keyof MDMConfig["restrictions"], value: any): Promise<void> {
    if (!this.config) {
      await this.configure({});
    }
    
    if (this.config && this.config.restrictions) {
      (this.config.restrictions as any)[policyKey] = value;
      await this.saveConfig();
    }
  }

  /**
   * 获取策略
   */
  getPolicy(policyKey: keyof MDMConfig["restrictions"]): any {
    return this.config?.restrictions[policyKey];
  }

  /**
   * 获取所有策略（按优先级排序）
   */
  getPolicies(): MDMPolicy[] {
    const policies = this.config?.policies || [];
    return [...policies].sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取限制策略
   */
  getRestrictionPolicies(): MDMConfig["restrictions"] | null {
    return this.config?.restrictions ?? null;
  }

  /**
   * 删除策略（恢复默认值）
   *
   * `async` 不是因为"看起来更现代"：恢复默认值之后必须**持久化**（`saveConfig`），
   * 而写盘是异步的 —— 一个同步返回的 `true` 会在写入还没落地时就告诉调用方
   * "已删除"，落盘失败时（`saveConfig` 会抛）调用方已经拿到 `true` 了。
   */
  async deletePolicy(policyKey: keyof MDMConfig["restrictions"]): Promise<boolean> {
    if (!this.config?.restrictions) return false;

    // 恢复默认值 —— 取 `DEFAULT_RESTRICTIONS`，这里曾经是**第二份内联副本**
    // （`maxActionsPerShortcut: 50`，而声明是 `100`）。也就是说「删除策略 ⇒ 恢复默认值」
    // 恢复出来的**不是**默认值：同一个上限在「首次配置」和「恢复默认」下差一倍。
    // `normalizeRestrictions()`（而不是直接引用 `DEFAULT_RESTRICTIONS`）还顺手给出**独立的
    // 数组**：否则恢复出来的空表会与那份声明共享同一个数组对象，一次就地 push 就改了"默认"。
    const defaults = normalizeRestrictions();

    // 恢复该键的默认值（类型的键是联合类型，赋值要走一次受控的窄化）
    (this.config.restrictions as unknown as Record<string, unknown>)[policyKey] = defaults[policyKey];
    await this.saveConfig();
    await this.audit({
      eventType: "mdm_policy_change",
      eventCategory: "management",
      eventDescription: "MDM 策略被删除（恢复默认值）",
      resourceType: "policy",
      resourceId: String(policyKey),
      actionDetails: { policy: String(policyKey), restoredTo: defaults[policyKey] },
    });

    // 企业 webhook（REQ-A980）：与上面那条审计同一个时刻。`deletePolicy` 目前在生产里
    // 零调用者，但这条发射点留着 —— 面板上的 `mdm_policy_change` 是"策略变了"，
    // 而"把一项恢复成默认值"正是它；真接上调用方的那一轮不需要再回来补发射点。
    emitWebhookEvent("mdm_policy_change", {
      deviceId: this.config.deviceId,
      policy: String(policyKey),
      restoredTo: defaults[policyKey],
    });
    return true;
  }

  /**
   * 生成设备 ID
   */
  private generateDeviceId(): string {
    return localId("device");
  }

  /**
   * 调用 MDM API
   */
  private async callMDMApi<T = unknown>(
    url: string,
    options: RequestInit
  ): Promise<{ success: boolean; data?: T; message?: string }> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // 合并自定义 headers
      if (options.headers) {
        const customHeaders = options.headers as Record<string, string>;
        Object.assign(headers, customHeaders);
      }

      if (this.config?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(url, {
        ...options,
        headers,
      });

      const data = await response.json();
      return data;
    } catch (err) {
      console.error("[MDM] API 调用失败:", err);
      throw err;
    }
  }

  /**
   * 把"本机受管状态"从存储里清干净（远程擦除 / 取消注册共用）。
   *
   * 关键点是**必须落到存储**：`saveConfig()` 在 `config === null` 时直接 `return`，
   * 所以"先把内存字段置空、再 saveConfig()"实际上一个字节都没删 —— 下次启动会把
   * 加密配置（含 apiKey / organizationId）原样读回来。空串是"没有配置"的既有编码
   * （`readStoreValue(KEY, "")` 为假 ⇒ `loadConfig` 归 null），且仍然走 `amosStore`
   * 的写路径（durable 副本 + 跨窗口总线），桥那一侧的副本因此也会被清掉。
   *
   * 两次写入都**检查结果**：存储拒收必须被说出来（write-scan 判据）—— 静默失败
   * 正是"已擦除"这句谎话的来源。
   */
  private clearStoredState(): void {
    if (!writeStoreValueChecked(STORE_KEYS.MDM_CONFIG, "")) {
      console.error("[MDM] 擦除配置写入被存储拒绝 —— 受管配置仍留在本地");
    }
    this.config = null;
    this.executionCounts.clear();
    if (!writeStoreValueChecked(STORE_KEYS.MDM_EXECUTION_COUNT, "")) {
      console.error("[MDM] 擦除执行计数写入被存储拒绝 —— 旧计数仍留在本地");
    }
  }

  /**
   * 擦除本地数据
   */
  private async wipeLocalData(): Promise<void> {
    // 见 `clearStoredState` 的说明：擦除必须落到存储，否则设备会永远停在
    // "每次启动都读到旧配置、又报一次已被擦除"的循环里。
    this.clearStoredState();

    // 清理其他企业数据（快捷指令、模板等）
    // 这里可以添加更多清理逻辑
  }

  /**
   * 关闭 MDM 管理器（用于测试清理）
   */
  shutdown(): void {
    // 清理资源
    this.executionCounts.clear();
    // 清空配置
    this.config = null;
    // 解除引导备忘：这是在测试里表达"**重启**"的那一步 —— 之后任何一次
    // `ensureInitialized()` 都会**重新从存储里读**（否则一个用例刚写进存储的配置
    // 会被上一次的备忘挡住）。REQ-A945。
    this.bootstrapPromise = null;
  }

  /**
   * 设置配置（测试辅助方法）
   * @internal 仅用于测试
   */
  setConfigForTest(config: MDMConfig): void {
    this.config = config;
    // **测试注入的配置就是权威**：把它记成"已经引导过"，于是执行门禁上那句
    // `await ensureInitialized()` 不会反过来去读存储、把注入的配置冲掉。
    // 需要测"从存储读回来"的用例请走 `shutdown()`（= 重启）而不是本方法 —— REQ-A945。
    this.bootstrapPromise = Promise.resolve();
  }

  /**
   * 清空配置（测试辅助方法）
   * @internal 仅用于测试
   */
  clearConfigForTest(): void {
    this.config = null;
    this.executionCounts.clear();
    this.bootstrapPromise = null; // 同 `shutdown()`：下一次 `ensureInitialized()` 要真的去读
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const mdmManager = new MDMManager();
