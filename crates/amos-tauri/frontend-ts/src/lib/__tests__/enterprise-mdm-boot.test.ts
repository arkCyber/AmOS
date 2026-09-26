/**
 * enterprise-mdm-boot.test.ts — 「存下来的那份配置，在**真实入口**上被读回来」
 * （REQ-A945 / FMEA F-SH-292）
 *
 * 这一族缺陷不是某条判据写错了，而是**判据读的那份配置从来没有人填**：
 * `mdmManager.initialize()` 的唯一生产调用点是 `enterprise/index.ts` 的
 * `initializeEnterprise()`，而那个函数在生产里**零调用者**。于是存盘的限制
 * 重启后没有任何人读它 —— `isEnabled()` 恒假 ⇒ 三个判据全部放行，
 * `getRestrictions()` 回落到出厂默认 ⇒ 面板把默认值当现行策略显示，
 * 远端锁定/擦除（只写在 `initialize()` 的抛错里）对设备的效果是零。
 *
 * 所以本文件**刻意不用 `setConfigForTest()`**（它把配置直接放进内存，正是绕开了
 * 被测的那条路），而是走真正的生产者与真正的读者：
 *
 *   `configure()` / `enrollDevice()` / `syncWithServer()`  ──写──▶  存储
 *   `executeShortcut()` 的门禁（`ensureInitialized()` → 三个判据）  ──读──▶  同一份
 *
 * 「重启」用 `shutdown()` 表达（它清空内存配置并把引导备忘解回 `null`，**不动存储**）。
 * 每条断言都配一条**反向对照**：同一份代码在"没重启/存的是另一份"时必须给出相反的结果，
 * 否则这条测试只是在一个恒真的分支上刷绿。
 *
 * 与 `shortcuts-engine.test.ts` 相同的存储缝：注入 `window.localStorage` 假体
 * （纯 bun 环境下没有宿主存储）。pure 批次是**一个进程跑所有文件**，所以桩只在本文件
 * 生命周期内存在（beforeAll 装 / afterAll 还原），并且 `afterAll` 要把 MDM 单例也收干净。
 */
import { describe, test as it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { createShortcut, executeShortcut, saveShortcuts } from "../shortcuts";
import type { ActionInstance } from "../shortcuts";
import { DEFAULT_RESTRICTIONS, mdmManager } from "../enterprise/mdm";
import type { MDMConfig, MDMRestrictions } from "../enterprise/mdm";

const storageMap = new Map<string, string>();
const mockStorage: Storage = {
  getItem: (key) => storageMap.get(key) ?? null,
  setItem: (key, value) => void storageMap.set(key, String(value)),
  removeItem: (key) => void storageMap.delete(key),
  clear: () => storageMap.clear(),
  key: (index) => [...storageMap.keys()][index] ?? null,
  get length() {
    return storageMap.size;
  },
};

const globals = globalThis as Record<string, unknown>;
const prevWindow = globals.window;
const prevLocalStorage = globals.localStorage;
const prevNavigator = globals.navigator;

beforeAll(() => {
  globals.window = { localStorage: mockStorage, dispatchEvent: () => true };
  globals.localStorage = mockStorage;
  globals.navigator = { platform: "test-platform", userAgent: "test-agent" };
});

afterAll(() => {
  if (prevWindow === undefined) delete globals.window;
  else globals.window = prevWindow;
  if (prevLocalStorage === undefined) delete globals.localStorage;
  else globals.localStorage = prevLocalStorage;
  if (prevNavigator === undefined) delete globals.navigator;
  else globals.navigator = prevNavigator;

  // 本文件开的东西本文件收干净：MDM 是跨文件共享的单例，而 pure 批次是一个进程跑所有文件。
  mdmManager.stopAutoSync();
  mdmManager.shutdown();
});

const realFetch = globalThis.fetch;

/** 打桩 `fetch`：返回值当 JSON 响应。 */
function stubFetch(handler: (url: string, init: RequestInit) => { body: unknown } | Error): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const result = handler(String(input), init ?? {});
    if (result instanceof Error) throw result;
    return { json: async () => result.body, status: 200 } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** 一份最小可用的配置；限制项按用例覆盖。 */
function config(restrictions: Partial<MDMRestrictions> = {}, extra: Partial<MDMConfig> = {}): MDMConfig {
  return {
    enabled: true,
    organizationId: "org-1",
    organizationName: "Acme",
    deviceId: "device-test",
    deviceName: "Test Mac",
    serverUrl: "https://mdm.example.test",
    apiKey: "key-1",
    policies: [],
    restrictions: { ...DEFAULT_RESTRICTIONS, ...restrictions },
    enforcedShortcuts: [],
    enforcedTemplates: [],
    syncInterval: 3600,
    lastSyncAt: 0,
    lastSyncStatus: "success",
    deviceStatus: "active",
    enrolledAt: 0,
    enrolledBy: "admin",
    version: "1.0.0",
    ...extra,
  };
}

let seq = 0;
const action = (actionTypeId: string, parameters: Record<string, unknown> = {}): ActionInstance => ({
  id: `act-${++seq}`,
  actionTypeId,
  parameters,
  position: seq,
});

/** 造一条指令并返回它的 id（`createShortcut` 写存储，门禁从存储读）。 */
function shortcut(actions: ActionInstance[]): string {
  const sc = createShortcut(`MDM 引导-${++seq}`, { actions });
  if (!sc) throw new Error("测试前提失败：createShortcut 返回 null");
  return sc.id;
}

beforeEach(() => {
  storageMap.clear();
  saveShortcuts([]);
  mdmManager.clearConfigForTest(); // 每条用例从"全新会话"开始（内存空、备忘解回 null）
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mdmManager.stopAutoSync();
  mdmManager.shutdown();
  storageMap.clear();
});

// ============================================================================
// ① 存盘的限制在"重启"之后仍然拦得住
// ============================================================================

describe("存下来的配置在真实入口上被读回来（REQ-A945）", () => {
  it("重启之后，门禁按**盘上那份**限制拒绝，而不是放行", async () => {
    await mdmManager.configure(config({ disabledCategories: ["scripting"] }));
    expect(mdmManager.isEnabled()).toBe(true);

    mdmManager.shutdown(); // = 重启：内存里的配置丢掉，引导备忘解回 null
    expect(mdmManager.getConfig()).toBeNull(); // 前提：真的"重启"了，内存里没有任何配置
    expect(mdmManager.isEnabled()).toBe(false);

    const id = shortcut([action("if")]);
    const r = await executeShortcut(id);

    expect(r.success).toBe(false);
    expect(r.error).toContain("分类"); // 判词来自 `checkActionAllowed`，不是兜底句
    expect(r.actionsCompleted).toBe(0);
    // 读回来这件事本身也要看得见：否则上面那句可能来自别的分支
    expect(mdmManager.getConfig()).not.toBeNull();
  });

  it("反向对照：盘上那份是**放行**的，同一条指令就必须跑起来", async () => {
    await mdmManager.configure(config({ disabledCategories: [] }));

    mdmManager.shutdown();
    const id = shortcut([action("if")]);
    const r = await executeShortcut(id);

    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("`getRestrictions()` 读到盘上那份，而不是出厂默认", async () => {
    await mdmManager.configure(config({ maxExecutionsPerDay: 3, maxShortcutsPerUser: 42 }));

    mdmManager.shutdown();
    // 反向对照：还没装载时，读者拿到的是**出厂默认** —— 这正是缺陷现场
    // （面板把默认值当现行策略显示），也是下面两条断言的对照组。
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(DEFAULT_RESTRICTIONS.maxExecutionsPerDay);
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).not.toBe(3);

    await mdmManager.ensureInitialized();

    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(3);
    expect(mdmManager.getRestrictions().maxShortcutsPerUser).toBe(42);
  });

  it("远端锁定：门禁用**管理员自己那句话**拒绝", async () => {
    const lockMessage = "这台设备已被 IT 收回，请联系服务台";
    await mdmManager.configure(config({}, { deviceStatus: "locked", lockMessage }));

    mdmManager.shutdown();
    const id = shortcut([action("text", { text: "hi" })]);
    const r = await executeShortcut(id);

    // `getDeviceStatus()` / `getLockMessage()` 至此才第一次有了生产读者：
    // 在这条路之前，锁定的全部效果只是 `initialize()` 里一次没人调的抛错。
    expect(r.success).toBe(false);
    expect(r.error).toBe(lockMessage);
  });

  it("远端擦除：用源码里同一句话拒绝", async () => {
    await mdmManager.configure(config({}, { deviceStatus: "wiped" }));

    mdmManager.shutdown();
    const id = shortcut([action("text", { text: "hi" })]);
    const r = await executeShortcut(id);

    expect(r.success).toBe(false);
    expect(r.error).toBe("设备数据已被远程擦除");
  });

  it("顺序：设备 > 内容 > 配额（三件事同时成立时说最重的那句）", async () => {
    const lockMessage = "设备已被管理员锁定";
    await mdmManager.configure(
      config(
        { disabledCategories: ["scripting"], maxExecutionsPerDay: 0 },
        { deviceStatus: "locked", lockMessage },
      ),
    );

    mdmManager.shutdown();
    const id = shortcut([action("if")]);
    const r = await executeShortcut(id);

    // ②（分类被禁）与③（每日配额 0）在这一刻**也都成立**：这里断言的是"先说设备"，
    // 所以对照组是另外两句判词（见上面两条用例，它们各自单独取到过自己的措辞）。
    expect(r.error).toBe(lockMessage);
  });

  it("`syncWithServer()` 落盘的那份也会被读回（第三个生产者）", async () => {
    await mdmManager.configure(config({}, { serverUrl: "https://mdm.example.test" }));
    mdmManager.shutdown();
    await mdmManager.ensureInitialized(); // 先有一份盘上配置，服务端才同步得动

    stubFetch(() => ({
      body: {
        success: true,
        data: { restrictions: { maxExecutionsPerDay: 2 }, version: "2.0.0" },
      },
    }));
    const synced = await mdmManager.syncWithServer();
    expect(synced.success).toBe(true);
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(2);

    mdmManager.shutdown(); // 重启
    await mdmManager.ensureInitialized();

    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(2);
    expect(mdmManager.getConfig()?.version).toBe("2.0.0");
  });

  it("`enrollDevice()` 注册出来的那份也不会被迟到的装载冲掉", async () => {
    // 真正的"注册"（`callMDMApi` 要的就是 `{ success, data }` 这层信封；返回 `data`
    // 本体的话 `response.success` 是 `undefined` ⇒ 早退，用例会在一棵空配置上刷绿）。
    stubFetch(() => ({
      body: {
        success: true,
        data: { organizationId: "org-1", organizationName: "Acme", apiKey: "k", enrolledBy: "it@acme.test" },
      },
    }));
    const enrolled = await mdmManager.enrollDevice("https://mdm.example.test", "token", "Test Mac");
    expect(enrolled.success).toBe(true); // 前提：注册真的成功了
    expect(mdmManager.isEnabled()).toBe(true);

    // 存储写失败（配额/加密不可用）时注册出来的那份只在内存里；迟到的装载不得把它抹掉。
    storageMap.clear();
    await mdmManager.ensureInitialized();

    expect(mdmManager.isEnabled()).toBe(true);
    expect(mdmManager.getConfig()?.apiKey).toBe("k");
  });
});

// ============================================================================
// ② 装载只发生一次，而且不会把内存里更新的那份覆盖掉
// ============================================================================

describe("引导自己（REQ-A945）", () => {
  it("`ensureInitialized()` 幂等：备忘挡住第二次装载", async () => {
    mdmManager.setConfigForTest(config({ maxExecutionsPerDay: 7 }));

    // 抽掉存储：若备忘失效、装载真的再跑一遍，`loadConfig()` 读到空存储会把
    // `this.config` 置为 `null`（这正是下面那条对照走的结果）。
    storageMap.clear();
    await mdmManager.ensureInitialized();
    await mdmManager.ensureInitialized();

    expect(mdmManager.getConfig()).not.toBeNull();
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(7);

    // 反向对照：解开备忘（= 重启）之后，同一次调用**必须**去读盘上那份。
    mdmManager.shutdown();
    await mdmManager.ensureInitialized();
    expect(mdmManager.getConfig()).toBeNull();
  });

  it("`configure()` 放进内存的那份不会被迟到的装载覆盖", async () => {
    await mdmManager.configure(config({ maxExecutionsPerDay: 9 }));

    // 存储写失败（配额/加密不可用）时内存比盘上**新**：一次迟到的 `loadConfig()`
    // 会把管理员刚设的限制悄悄退回去。这条用的是"存储整个空了"这个更强的形状。
    storageMap.clear();
    await mdmManager.ensureInitialized();

    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(9);
    expect(mdmManager.isEnabled()).toBe(true);
  });

  it("引导只装载，**不抛错**：锁定的抛错仍然只属于 `initialize()`", async () => {
    await mdmManager.configure(config({}, { deviceStatus: "locked", lockMessage: "IT 已收回" }));
    mdmManager.shutdown();

    // 门禁顺路调的这句必须是安全的：它要的是**判词**（见上），不是把执行路径炸掉。
    await expect(mdmManager.ensureInitialized()).resolves.toBeUndefined();
    expect(mdmManager.isEnabled()).toBe(true);

    // 而"打断整个应用"这件事仍然只发生在启动者手里。
    await expect(mdmManager.initialize()).rejects.toThrow("IT 已收回");
    mdmManager.stopAutoSync(); // `initialize()` 起过自动同步的定时器，别泄漏给后面的文件
  });

  it("`initialize()` 自己也装载：锁定的抛错在**只**调它的情况下也成立", async () => {
    await mdmManager.configure(config({}, { deviceStatus: "locked", lockMessage: "IT 已收回" }));
    mdmManager.shutdown();

    // 这一条与上一条的区别是"配置是谁读回来的"：上一条里 `ensureInitialized()` 已经
    // 把配置放进内存了，所以 `initialize()` 即使**完全不装载**也能抛错（负控证明：
    // 把它的 `ensureInitialized()` 换成"只标记已引导"，上一条仍然全绿）。
    // 这里只有 `initialize()` 一个调用者 —— 它必须自己把配置读回来。
    await expect(mdmManager.initialize()).rejects.toThrow("IT 已收回");
    mdmManager.stopAutoSync();
  });
});

// ============================================================================
// ③ 加密信封解不开时：**保留原密文**，绝不把它当明文吃下 / 覆盖
// ============================================================================

/**
 * 这一族缺陷（REQ-A1440 / F-SH-698）的形状是"解密失败 ⇒ 回退明文"：
 * 一个信封本身就是合法 JSON，所以 `JSON.parse(raw)` 一定成功 —— 回退会收下一份只有
 * `ciphertext`/`iv` 的垃圾配置（`isEnabled()` 恒假 ⇒ MDM 静默停用），紧接着的
 * "自动迁移"又把这份垃圾**加密覆盖回原密文**，把 apiKey / 组织 / 策略永久抹掉。
 *
 * 三条用例分别钉住：篡改 ⇒ 硬失败且原密文原封不动；信封 + 无 Web Crypto ⇒ 同样硬失败；
 * 旧明文 ⇒ 仍然走迁移（负控：证明"硬失败"没有把合法的明文兼容路一起关掉）。
 */
describe("加密信封解不开时保留原密文（REQ-A1440 / F-SH-698）", () => {
  const KEY = "amos.shortcuts.mdm.config";
  /** amosStore 把值 `JSON.stringify` 一层，所以取回信封字符串要再解析一层。 */
  const readEnvelopeString = (): string => JSON.parse(storageMap.get(KEY)!) as string;

  it("密文被篡改 ⇒ 硬失败：config 为 null，且盘上原密文一个字节都不动", async () => {
    await mdmManager.configure(config({ disabledCategories: ["scripting"] }, { apiKey: "secret-key" }));
    const envelope = JSON.parse(readEnvelopeString()) as { ciphertext: string };
    envelope.ciphertext = envelope.ciphertext.slice(0, -6) + "AAAAAA";
    storageMap.set(KEY, JSON.stringify(JSON.stringify(envelope)));
    const before = storageMap.get(KEY)!;

    mdmManager.shutdown(); // = 重启
    await mdmManager.ensureInitialized();

    // 硬失败：不静默停用成一个"空配置"，而是承认配置读不出来。
    expect(mdmManager.getConfig()).toBeNull();
    expect(mdmManager.isEnabled()).toBe(false);
    // 原密文没被覆盖（既没被当明文吃下后重加密，也没被清空）。
    expect(storageMap.get(KEY)).toBe(before);

    // 反向对照：同一条路在密文**没**被篡改时必须读得回来（否则上面两条只是在一个
    // "永远读不出来"的分支上刷绿）。
    const fresh = config({}, { apiKey: "secret-key" });
    await mdmManager.configure(fresh);
    mdmManager.shutdown();
    await mdmManager.ensureInitialized();
    expect(mdmManager.getConfig()?.apiKey).toBe("secret-key");
  });

  it("存储是信封但 Web Crypto 不可用 ⇒ 同样硬失败，保留原密文", async () => {
    await mdmManager.configure(config({}, { apiKey: "secret-key" }));
    const before = storageMap.get(KEY)!;

    // `crypto.subtle` 本身不可配置，但 `globalThis.crypto` 可写可配置（实测）——
    // 换掉整个对象即可表达"这个宿主没有 Web Crypto"。
    const realCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      mdmManager.shutdown();
      await mdmManager.ensureInitialized();
      expect(mdmManager.getConfig()).toBeNull();
      expect(storageMap.get(KEY)).toBe(before);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true });
    }

    // 负控：工具回来后，同一份密文能正常读回（证明上面的 null 来自"缺工具"，不是密文坏了）。
    mdmManager.shutdown();
    await mdmManager.ensureInitialized();
    expect(mdmManager.getConfig()?.apiKey).toBe("secret-key");
  });

  it("旧明文配置仍然走迁移（负控：信封硬失败没有关掉明文兼容路）", async () => {
    const plain = config({ maxExecutionsPerDay: 5 }, { apiKey: "legacy-key" });
    storageMap.set(KEY, JSON.stringify(JSON.stringify(plain)));

    mdmManager.shutdown();
    await mdmManager.ensureInitialized();

    expect(mdmManager.isEnabled()).toBe(true);
    expect(mdmManager.getConfig()?.apiKey).toBe("legacy-key");
    // 迁移真的发生了：盘上再取出来已经是一个信封。
    expect(readEnvelopeString()).toContain("ciphertext");
  });

  it("迁移的**写**被拒 ⇒ 已读好的明文配置不被丢弃（读失败与写失败是两回事）", async () => {
    const plain = config({ maxExecutionsPerDay: 5 }, { apiKey: "legacy-key" });
    storageMap.set(KEY, JSON.stringify(JSON.stringify(plain)));

    // 只让**写**被拒（配额），读不受影响 —— 迁移是这条路上唯一的一次写。
    const realSetItem = mockStorage.setItem;
    mockStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      mdmManager.shutdown();
      await mdmManager.ensureInitialized();

      // 读是成功的：配置在内存里、MDM 仍然生效；迁移的写入被拒不该连读一起否定。
      // （修复前这里会走 loadConfig 的外层 catch，把 config 置 null ⇒ isEnabled() 为假，
      //   并记一条"配置加载失败"—— 而加载根本没失败。）
      expect(mdmManager.isEnabled()).toBe(true);
      expect(mdmManager.getConfig()?.apiKey).toBe("legacy-key");
      // 迁移确实没写成：盘上仍是那份明文，既没被清空也没被覆盖。
      expect(readEnvelopeString()).not.toContain("ciphertext");
    } finally {
      mockStorage.setItem = realSetItem;
    }

    // 负控：写恢复后重启，同一份明文能正常迁移（证明上面的明文残留来自"写被拒"，不是路坏了）。
    mdmManager.shutdown();
    await mdmManager.ensureInitialized();
    expect(readEnvelopeString()).toContain("ciphertext");
  });
});
