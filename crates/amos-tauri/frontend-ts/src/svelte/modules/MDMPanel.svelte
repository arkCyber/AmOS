<script lang="ts">
  /**
   * MDMPanel.svelte — MDM 配置管理面板
   * 
   * 功能:
   * - 启用/禁用 MDM
   * - 配置服务器 URL 和组织 ID
   * - 管理策略和限制
   * - 查看设备注册状态
   * - 手动同步配置
   */

  import { onMount } from "svelte";
  import { mdmManager } from "../../lib/enterprise";
  import { DEFAULT_RESTRICTIONS } from "../../lib/enterprise/mdm";
  import { getCryptoInfo } from "../../lib/crypto/mdmCrypto";
  import { t } from "../locale.svelte";
  import type { MDMConfig, MDMConnectionResult, MDMRestrictions } from "../../lib/enterprise/mdm";
  import {
    MDM_NUMERIC_RANGES,
    readBoundedInt,
    type MDMNumericKey,
    type NumericFieldVerdict,
  } from "../../lib/enterprise/numericField";

  // ============================================================================
  // 状态管理
  // ============================================================================

  let config = $state<MDMConfig | null>(mdmManager.getConfig());
  let restrictions = $state<MDMRestrictions>(mdmManager.getRestrictions());
  let syncing = $state(false);
  let testingConnection = $state(false);
  let connectionStatus = $state<"success" | "error" | null>(null);
  let connectionMessage = $state("");

  /** 上一次落盘被存储拒收了吗（没有拒绝时为 `false`）。理由在标记里写死，
   *  所以这个状态只需要记「有没有」。 */
  let saveRefused = $state(false);

  /**
   * 配置落盘用的加密形态（REQ-A1440）。
   *
   * 「配置是加密写的」此前只写在文档与测试里，界面上没有任何一处能证实它 —— 而
   * `getCryptoInfo()` 也因此是一个零生产调用的死导出。把它放在面板上，管理员看得见
   * 算法与迭代次数，也能在**没有 Web Crypto 的环境**（配置只能明文落盘）看到那句提醒。
   * 纯函数、无副作用，构造时取一次即可。
   */
  const cryptoInfo = getCryptoInfo();

  /**
   * 把一次配置改动交给管理器，并**接住**落盘失败（REQ-A826）。
   *
   * `mdmManager.configure()` 的最后一步是 `await this.saveConfig()`，而 `saveConfig`
   * 在存储拒收时**抛**（`throw new Error("写入加密配置失败")`）。面板原先四处都写
   * `mdmManager.configure(...)` 即发即忘，于是那条拒绝变成一条**没人接的 rejection**：
   * 屏幕上照旧显示新值、一个字都不说，而磁盘上还是上一次的配置 —— 用户以为改好了，
   * 重启之后回落到旧值（和 REQ-A806 修掉的 `api.ts` 是同一个形状：**写入的答案被丢掉**）。
   *
   * 这里只接住、并把它说给用户听，**不改管理器**：`configure()` 先更新内存再落盘，
   * 被拒的是磁盘那一半，所以这次改动在本次运行内是生效的 —— 提示要说的正是这件事，
   * 而不是把面板退回旧值（那会让屏幕和系统重新各说各话）。
   */
  async function applyConfig(patch: Partial<MDMConfig>): Promise<void> {
    try {
      await mdmManager.configure(patch);
      saveRefused = false;
    } catch {
      saveRefused = true;
    }
  }

  /**
   * 挂载时先把**存下来的配置**读回来（REQ-A945）。
   *
   * 为什么必须有这一步：`config` / `restrictions` 这两个 `$state` 在组件构造时就从
   * 管理器读一次，而那份配置**重启后从没有人读回**（唯一的生产读入口
   * `mdmManager.initialize()` 挂在一个零调用者的函数上）。于是一个已经配好策略的
   * 设备重启后打开这个面板，看到的是 `getRestrictions()` 的**出厂默认**被当成现行
   * 策略显示（「允许创建 / 允许修改 / 允许删除…」全开、上限回到 300/1000/100/100），
   * 而磁盘上存的是管理员真正的策略 —— **面板替设备说了假话**。
   *
   * 诚实边界：`ensureInitialized()` 是异步的（解密走 Web Crypto），而这里的两个
   * `$state` 是构造时求值的，所以**第一帧**仍可能短暂显示未配置的状态，加载完成后
   * 由下面的两行刷新纠正。本轮不做"加载中"占位（那会改动这个面板的 DOM 结构，
   * 而它在 `svelte-tests/enterprise-panels.svelte.test.ts` 里是按文案逐条断言的）；
   * 这条时间窗记在 REQ-A945 的边界里，不假装它不存在。
   */
  onMount(() => {
    void mdmManager.ensureInitialized().then(() => {
      config = mdmManager.getConfig();
      restrictions = mdmManager.getRestrictions();
    });
  });

  // ============================================================================
  // 事件处理
  // ============================================================================

  function toggleMDM() {
    if (!config) return;
    void applyConfig({ ...config, enabled: !config?.enabled });
    config = mdmManager.getConfig();
    restrictions = mdmManager.getRestrictions();
  }

  function updateServerUrl(e: Event) {
    if (!config) return;
    const target = e.target as HTMLInputElement;
    void applyConfig({ ...config, serverUrl: target.value });
    config = mdmManager.getConfig();
  }

  function updateOrganizationId(e: Event) {
    if (!config) return;
    const target = e.target as HTMLInputElement;
    void applyConfig({ ...config, organizationId: target.value });
    config = mdmManager.getConfig();
  }

  function updateRestriction(key: keyof MDMRestrictions, value: boolean | number) {
    if (!config) return;
    restrictions = { ...restrictions, [key]: value };
    void applyConfig({ ...config, restrictions });
    config = mdmManager.getConfig();
    restrictions = mdmManager.getRestrictions();
  }

  /** 被拒绝的那个数字框（连同理由），没有拒绝时为 `null`。 */
  let numericRefusal = $state<{ key: MDMNumericKey; message: string } | null>(null);

  /** 把一条拒绝翻成人话。三次 `t()` 都是**字面量键**：`i18n-scan` 的「有没有人引用」
   *  只认字面量，动态键会让这三个键看起来是死的。 */
  function numericRefusalMessage(verdict: Extract<NumericFieldVerdict, { ok: false }>): string {
    switch (verdict.reason) {
      case "not-integer":
        return t("common.numberNotInteger");
      case "below-min":
        return t("common.numberBelowMin", { min: verdict.range.min });
      case "above-max":
        return t("common.numberAboveMax", { max: verdict.range.max });
    }
  }

  /**
   * 「使用限制」里一个数字框的输入处理（REQ-A821）。
   *
   * 收下就写入模型并清掉旧提示；**不收就什么都不写**，只把那句话显示出来 —— 原先的
   * `parseInt(v) || 1000` 会把用户没打过的数（`0`／空／`abc` 一律变成默认值）静默写进
   * 模型，而框里显示的还是用户打的字。越界的值（`max` 声明了却没人强制）现在也被拒绝。
   */
  function onNumericRestriction(key: MDMNumericKey, e: Event) {
    const target = e.target as HTMLInputElement;
    const verdict = readBoundedInt(target.value, MDM_NUMERIC_RANGES[key]);
    if (verdict.ok) {
      updateRestriction(key, verdict.value);
      numericRefusal = null;
      return;
    }
    numericRefusal = { key, message: numericRefusalMessage(verdict) };
  }

  /**
   * 离焦时把框里的字**收回模型的值**。
   *
   * 没有这一步，「拒绝」会把界面推回原来那种不一致：框里是用户打的 `0`，模型里是上一个
   * 合法值，两者差在哪里屏幕上没有痕迹。收回之后，框里显示的永远是系统真正持有的数 ——
   * 拒绝的理由在它上面那行字里。
   */
  function resyncNumericRestriction(key: MDMNumericKey, e: Event) {
    const target = e.target as HTMLInputElement;
    target.value = String(restrictions[key]);
  }

  /**
   * 同步配置 —— 只声称 `syncWithServer` **真的同意**的那件事（REQ-A819）。
   *
   * `syncWithServer()` **从不抛**：它把每一次失败（未启用、HTTP 非 2xx、`success:false`、
   * 连不上）都折成 `{ success: false, message }` 返回。原先这里 `await` 之后无条件说
   * 「同步成功」，于是「服务器把我们拒了」与「同步成功」在界面上逐字相同 —— 与 REQ-A806
   * 修掉的 `APISettings::saveConfig`、以及本文件原来的 `testConnection` 是同一个形状：
   * **把一个返回值当成「已完成」来读**。
   */
  async function syncConfig() {
    syncing = true;
    try {
      const result = await mdmManager.syncWithServer();
      config = mdmManager.getConfig();
      restrictions = mdmManager.getRestrictions();
      if (result.success) {
        connectionStatus = "success";
        connectionMessage = t("mdm.syncOk");
      } else {
        // 拒绝时**不**动「上次同步」：那块时间读的是 `config.lastSyncAt`，而管理器只在
        // 同步真的成功时推进它（`mdm.ts::syncWithServer` 的成功分支），失败只写
        // `lastSyncStatus` —— 所以一次被拒的同步不可能把「上次同步」显示成刚刚。
        connectionStatus = "error";
        connectionMessage = result.message
          ? t("mdm.syncFailedReason", { reason: result.message })
          : t("mdm.syncFailed");
      }
      setTimeout(() => { connectionStatus = null; }, 3000);
    } catch (error) {
      // 保留这条分支：`syncWithServer` 今天不抛，但界面不该因为实现细节的将来变化
      // 而把一次抛出当成成功。
      connectionStatus = "error";
      connectionMessage = error instanceof Error ? error.message : t("mdm.syncFailed");
    } finally {
      syncing = false;
    }
  }

  /**
   * 测试连接 —— **真的**去问服务器（REQ-A819）。
   *
   * 原先这里不联系任何东西：`setTimeout` 1 秒 + `serverUrl.startsWith("https://")`，
   * 然后报「连接成功」。一台拼错的、已下线的、或把我们挡在门外的服务器，全都得到
   * 同一个绿色提示 —— 而这正是用户按下这个按钮要问的那件事。真实请求与理由由
   * `mdmManager.checkConnection()` 负责（探 `GET {serverUrl}/health`，`crates/amos-mdm`
   * 真挂着的路由），这里只把**判别式**翻成词典里的一句人话。
   */
  async function testConnection() {
    if (!config) return;
    testingConnection = true;
    connectionStatus = null;
    const result = await mdmManager.checkConnection();
    if (result.ok) {
      connectionStatus = "success";
      connectionMessage = t("mdm.connectOk");
    } else {
      connectionStatus = "error";
      connectionMessage = connectionRefusal(result);
    }
    testingConnection = false;
    setTimeout(() => { connectionStatus = null; }, 3000);
  }

  /** 把连接检查的 `reason` 翻成一句人话。**不含**任何机器话（URL 解析器/超时的原文）。 */
  function connectionRefusal(result: MDMConnectionResult): string {
    if (result.ok) return t("mdm.connectOk");
    switch (result.reason) {
      case "no-server":
        return t("mdm.connectNoServer");
      case "insecure-url":
        return t("mdm.invalidServerUrl");
      case "http-status":
        return t("mdm.connectHttpStatus", { status: result.status });
      case "unexpected-body":
        return t("mdm.connectNotOurServer");
      case "unreachable":
        return t("mdm.connectUnreachable");
    }
  }

  /**
   * 「重置为默认」—— 默认表**只有一份**（REQ-A1328）。
   *
   * 这里此前逐字又抄了一遍 `DEFAULT_RESTRICTIONS`，而抄本已经漂了：`maxShortcutsPerUser`
   * 抄成 `500`，而 `mdm.ts:186` 的默认表、`deletePolicy()` 的恢复表、`normalizeRestrictions()`
   * 的兜底与「首次配置」全都是 `100`。于是「重置为默认」按下去得到的是一个**不是**默认值的
   * 上限，并且与同屏那条「删除策略 ⇒ 恢复默认值」对「默认」给出两个答案 —— 与
   * `scripts/mdm-restriction-scan.mjs` 记着的那个病（同一条限制写了不止一遍）同形，
   * 只是那份抄本在面板里，而那个闸门的扫描面只有一个文件，看不见它。
   *
   * 修法是删掉抄本：从 `DEFAULT_RESTRICTIONS` 展开。数组型的两项换成新的一份
   * （`[]` 的对象身份不共享，免得将来有人就地改到那份模块级常量），
   * `configure()` 会再走一次 `normalizeRestrictions()`，所以展开出来的表就是权威。
   */
  function resetToDefault() {
    if (!config) return;
    if (confirm(t("mdm.confirmReset"))) {
      void applyConfig({
        enabled: false,
        serverUrl: "",
        organizationId: "",
        deviceId: config.deviceId,
        enrolledAt: config?.enrolledAt,
        restrictions: {
          ...DEFAULT_RESTRICTIONS,
          disabledCategories: [],
          disabledActions: [],
        },
      });
      config = mdmManager.getConfig();
      restrictions = mdmManager.getRestrictions();
    }
  }

  function formatDate(timestamp: number | null): string {
    if (!timestamp) return t("mdm.neverSynced");
    const date = new Date(timestamp);
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<div class="mdm-panel">
  <header class="panel-header">
    <h2>📱 {t("mdm.title")}</h2>
    <p class="subtitle">{t("mdm.subtitle")}</p>
  </header>

  <!-- 落盘被拒（REQ-A826）—— 放在面板顶部，因为四个控件（开关／URL／组织 ID／
       使用限制）都走同一条落盘路径，谁被拒都该在这里看得见。 -->
  {#if saveRefused}
    <p class="save-refusal" role="alert" data-testid="mdm-save-refusal">{t("mdm.saveRefused")}</p>
  {/if}

  <!-- 主开关 -->
  <section class="card">
    <div class="toggle-row">
      <div>
        <div class="label">{t("mdm.enable")}</div>
        <div class="caption">{t("mdm.enableHint")}</div>
      </div>
      <label class="toggle-switch">
        <input
          type="checkbox"
          checked={config?.enabled}
          onchange={toggleMDM}
          role="switch"
          aria-label={t("mdm.enable")}
        />
        <span class="slider"></span>
      </label>
    </div>
  </section>

  <!-- 加密存储**能力**（REQ-A1440）：面板能证实的是"这个环境具备 Web Crypto，保存时会把配置
       加密"，证不出"盘上的字节此刻是信封" —— 迁移被写配额拒绝、或密文解不开被硬失败时，
       存储里就是明文。所以这里说的是能力，不是状态；状态只有一个来源能断言，那就是
       `loadConfig()` 自己的审计。 -->
  <section class="card" data-testid="mdm-crypto">
    <h3 class="section-title">{t("mdm.cryptoSection")}</h3>
    {#if cryptoInfo.available}
      <p class="caption" data-testid="mdm-crypto-ok">
        {t("mdm.cryptoActive", {
          algorithm: cryptoInfo.algorithm,
          kdf: cryptoInfo.keyDerivation,
          iterations: cryptoInfo.iterations,
        })}
      </p>
    {:else}
      <p class="save-refusal" role="alert" data-testid="mdm-crypto-unavailable">
        {t("mdm.cryptoUnavailable")}
      </p>
    {/if}
  </section>

  <!-- 服务器配置 -->
  <section class="card">
    <h3 class="section-title">{t("mdm.serverSection")}</h3>
    <div class="form-group">
      <label for="serverUrl" class="form-label">{t("mdm.serverUrl")}</label>
      <input
        id="serverUrl"
        type="url"
        class="form-input"
        value={config?.serverUrl ?? ""}
        oninput={updateServerUrl}
        placeholder="https://mdm.company.com"
        disabled={!config?.enabled}
      />
    </div>
    <div class="form-group">
      <label for="organizationId" class="form-label">{t("mdm.organizationId")}</label>
      <input
        id="organizationId"
        type="text"
        class="form-input"
        value={config?.organizationId ?? ""}
        oninput={updateOrganizationId}
        placeholder="org-12345"
        disabled={!config?.enabled}
      />
    </div>
    <div class="form-group">
      <label for="deviceId" class="form-label">{t("mdm.deviceId")}</label>
      <input
        id="deviceId"
        type="text"
        class="form-input disabled-input"
        value={config?.deviceId ?? ""}
        disabled
        readonly
      />
      <p class="help-text">{t("mdm.deviceIdHint")}</p>
    </div>
    <button
      class="btn-secondary"
      data-testid="mdm-test-connection"
      onclick={testConnection}
      disabled={!config?.enabled || testingConnection}
    >
      {testingConnection ? t("mdm.testing") : t("mdm.testConnection")}
    </button>
  </section>

  <!-- 权限策略 -->
  <section class="card">
    <h3 class="section-title">{t("mdm.permissionsSection")}</h3>
    <div class="permission-list">
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowUserCreate}
          onchange={() => updateRestriction("allowUserCreate", !restrictions.allowUserCreate)}
          disabled={!config?.enabled}
        />
        <span>{t("mdm.allowCreate")}</span>
      </label>
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowUserModify}
          onchange={() => updateRestriction("allowUserModify", !restrictions.allowUserModify)}
          disabled={!config?.enabled}
        />
        <span>{t("mdm.allowModify")}</span>
      </label>
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowUserDelete}
          onchange={() => updateRestriction("allowUserDelete", !restrictions.allowUserDelete)}
          disabled={!config?.enabled}
        />
        <span>{t("mdm.allowDelete")}</span>
      </label>
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowSharing}
          onchange={() => updateRestriction("allowSharing", !restrictions.allowSharing)}
          disabled={!config?.enabled}
        />
        <span>{t("mdm.allowSharing")}</span>
      </label>
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowImport}
          onchange={() => updateRestriction("allowImport", !restrictions.allowImport)}
          disabled={!config?.enabled}
        />
        <span>{t("mdm.allowImport")}</span>
      </label>
      <label class="permission-item">
        <input
          type="checkbox"
          checked={restrictions.allowExport}
          onchange={() => updateRestriction("allowExport", !restrictions.allowExport)}
          disabled={!config?.enabled}
        />
        <span>{t("mdm.allowExport")}</span>
      </label>
    </div>
  </section>

  <!-- 使用限制 -->
  <section class="card">
    <h3 class="section-title">{t("mdm.limitsSection")}</h3>
    <div class="limit-list">
      <div class="limit-item">
        <label for="maxShortcutsPerUser" class="limit-label">
          {t("mdm.maxShortcutsPerUser")}
        </label>
        <div class="number-input-group">
          <input
            id="maxShortcutsPerUser"
            type="number"
            class="number-input"
            value={restrictions.maxShortcutsPerUser}
            oninput={(e) => onNumericRestriction("maxShortcutsPerUser", e)}
            onblur={(e) => resyncNumericRestriction("maxShortcutsPerUser", e)}
            min={MDM_NUMERIC_RANGES.maxShortcutsPerUser.min}
            max={MDM_NUMERIC_RANGES.maxShortcutsPerUser.max}
            disabled={!config?.enabled}
          />
          <span class="unit">{t("mdm.unitCount")}</span>
        </div>
        {#if numericRefusal?.key === "maxShortcutsPerUser"}
          <p class="number-refusal" role="status" data-testid="mdm-number-refusal">{numericRefusal.message}</p>
        {/if}
      </div>
      <div class="limit-item">
        <label for="maxActionsPerShortcut" class="limit-label">
          {t("mdm.maxActionsPerShortcut")}
        </label>
        <div class="number-input-group">
          <input
            id="maxActionsPerShortcut"
            type="number"
            class="number-input"
            value={restrictions.maxActionsPerShortcut}
            oninput={(e) => onNumericRestriction("maxActionsPerShortcut", e)}
            onblur={(e) => resyncNumericRestriction("maxActionsPerShortcut", e)}
            min={MDM_NUMERIC_RANGES.maxActionsPerShortcut.min}
            max={MDM_NUMERIC_RANGES.maxActionsPerShortcut.max}
            disabled={!config?.enabled}
          />
          <span class="unit">{t("mdm.unitCount")}</span>
        </div>
        {#if numericRefusal?.key === "maxActionsPerShortcut"}
          <p class="number-refusal" role="status" data-testid="mdm-number-refusal">{numericRefusal.message}</p>
        {/if}
      </div>
      <div class="limit-item">
        <label for="maxExecutionsPerDay" class="limit-label">
          {t("mdm.maxExecutionsPerDay")}
        </label>
        <div class="number-input-group">
          <input
            id="maxExecutionsPerDay"
            type="number"
            class="number-input"
            value={restrictions.maxExecutionsPerDay}
            oninput={(e) => onNumericRestriction("maxExecutionsPerDay", e)}
            onblur={(e) => resyncNumericRestriction("maxExecutionsPerDay", e)}
            min={MDM_NUMERIC_RANGES.maxExecutionsPerDay.min}
            max={MDM_NUMERIC_RANGES.maxExecutionsPerDay.max}
            disabled={!config?.enabled}
          />
          <span class="unit">{t("mdm.unitTimes")}</span>
        </div>
        {#if numericRefusal?.key === "maxExecutionsPerDay"}
          <p class="number-refusal" role="status" data-testid="mdm-number-refusal">{numericRefusal.message}</p>
        {/if}
      </div>
      <!--
        单次执行时长（REQ-A824）。这一格此前**根本不存在**：`maxExecutionTime` 有声明、
        有默认值（300 秒）、服务端能下发、`getPolicy()` 能取回，而面板只显示另外三条 ——
        管理员既看不见它、也改不了它，而它是四条里**唯一**没有任何执行路径去读的一条。
      -->
      <div class="limit-item">
        <label for="maxExecutionTime" class="limit-label">
          {t("mdm.maxExecutionTime")}
        </label>
        <div class="number-input-group">
          <input
            id="maxExecutionTime"
            type="number"
            class="number-input"
            value={restrictions.maxExecutionTime}
            oninput={(e) => onNumericRestriction("maxExecutionTime", e)}
            onblur={(e) => resyncNumericRestriction("maxExecutionTime", e)}
            min={MDM_NUMERIC_RANGES.maxExecutionTime.min}
            max={MDM_NUMERIC_RANGES.maxExecutionTime.max}
            disabled={!config?.enabled}
          />
          <span class="unit">{t("mdm.unitSeconds")}</span>
        </div>
        {#if numericRefusal?.key === "maxExecutionTime"}
          <p class="number-refusal" role="status" data-testid="mdm-number-refusal">{numericRefusal.message}</p>
        {/if}
      </div>
    </div>
  </section>

  <!-- 同步状态 -->
  <section class="card sync-section">
    {#if connectionStatus}
      <div class="status-message" class:success={connectionStatus === "success"} class:error={connectionStatus === "error"}>
        {connectionStatus === "success" ? "✓" : "✗"} {connectionMessage}
      </div>
    {/if}
    
    <div class="sync-info">
      <span class="sync-label">{t("mdm.lastSync")}</span>
      <span class="sync-time" data-testid="mdm-last-sync">{formatDate(config?.lastSyncAt ?? 0)}</span>
    </div>
    
    <div class="action-buttons">
      <button
        class="btn-primary"
        data-testid="mdm-sync-config"
        onclick={syncConfig}
        disabled={!config?.enabled || syncing}
      >
        {syncing ? t("mdm.syncing") : t("mdm.syncConfig")}
      </button>
      <button
        class="btn-secondary"
        data-testid="mdm-reset"
        onclick={resetToDefault}
        disabled={syncing}
      >
        {t("mdm.resetToDefault")}
      </button>
    </div>
  </section>
</div>

<style>
  .mdm-panel {
    max-width: 800px;
    margin: 0 auto;
    padding: 24px;
  }

  .panel-header {
    margin-bottom: 24px;
  }

  .panel-header h2 {
    font-size: 24px;
    font-weight: 600;
    color: rgb(var(--label));
    margin: 0 0 8px 0;
  }

  .subtitle {
    font-size: 14px;
    color: rgb(var(--label-3));
    margin: 0;
  }

  .card {
    background: rgb(var(--surface));
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .section-title {
    font-size: 17px;
    font-weight: 600;
    color: rgb(var(--label));
    margin: 0 0 16px 0;
  }

  /* 开关行 */
  .toggle-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .label {
    font-size: 15px;
    font-weight: 500;
    color: rgb(var(--label));
    margin-bottom: 4px;
  }

  .caption {
    font-size: 13px;
    color: rgb(var(--label-3));
  }

  /* iOS 风格开关 */
  .toggle-switch {
    position: relative;
    display: inline-block;
    width: 51px;
    height: 31px;
  }

  .toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgb(var(--separator));
    transition: 0.3s;
    border-radius: 31px;
  }

  .slider:before {
    position: absolute;
    content: "";
    height: 27px;
    width: 27px;
    left: 2px;
    bottom: 2px;
    background-color: white;
    transition: 0.3s;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  input:checked + .slider {
    background-color: rgb(var(--success));
  }

  input:checked + .slider:before {
    transform: translateX(20px);
  }

  input:disabled + .slider {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* 表单 */
  .form-group {
    margin-bottom: 16px;
  }

  .form-group:last-child {
    margin-bottom: 0;
  }

  .form-label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: rgb(var(--label-2));
    margin-bottom: 8px;
  }

  .form-input {
    width: 100%;
    padding: 12px;
    border: 1px solid rgb(var(--separator));
    border-radius: 8px;
    font-size: 15px;
    background: rgb(var(--surface));
    transition: border-color 0.2s;
  }

  .form-input:focus {
    outline: none;
    border-color: rgb(var(--accent));
  }

  .form-input:disabled {
    background: rgb(var(--surface-2));
    color: rgb(var(--label-3));
    cursor: not-allowed;
  }

  .disabled-input {
    background: rgb(var(--surface-2));
    color: rgb(var(--label-3));
  }

  .help-text {
    font-size: 12px;
    color: rgb(var(--label-3));
    margin: 4px 0 0 0;
  }

  /* 权限列表 */
  .permission-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .permission-item {
    display: flex;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    font-size: 15px;
    color: rgb(var(--label));
  }

  .permission-item input[type="checkbox"] {
    width: 20px;
    height: 20px;
    cursor: pointer;
  }

  .permission-item input[type="checkbox"]:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* 限制列表 */
  .limit-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .limit-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .limit-label {
    font-size: 15px;
    color: rgb(var(--label));
  }

  .number-input-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .number-input {
    width: 80px;
    padding: 8px 12px;
    border: 1px solid rgb(var(--separator));
    border-radius: 8px;
    font-size: 15px;
    text-align: right;
  }

  .number-input:focus {
    outline: none;
    border-color: rgb(var(--accent));
  }

  .number-input:disabled {
    background: rgb(var(--surface-2));
    color: rgb(var(--label-3));
    cursor: not-allowed;
  }

  .unit {
    font-size: 15px;
    color: rgb(var(--label-3));
  }

  /* 同步区域 */
  .sync-section {
    border-top: 1px solid rgb(var(--separator));
    margin-top: 24px;
  }

  .status-message {
    padding: 12px;
    border-radius: 8px;
    font-size: 14px;
    margin-bottom: 16px;
  }

  .status-message.success {
    background: rgb(var(--success) / 0.15);
    color: rgb(var(--success));
  }

  .status-message.error {
    background: rgb(var(--danger) / 0.15);
    color: rgb(var(--danger));
  }

  /* 被拒绝的那个数字框下面的那行字（REQ-A821）—— 与 `.status-message.error` 同一套色，
   *  但更小、贴着字段，因为它是**这一个字段**的拒绝而不是整条连接的状态。 */
  .number-refusal {
    grid-column: 1 / -1;
    margin: 4px 0 0;
    font-size: 12px;
    color: rgb(var(--danger));
  }

  .save-refusal {
    margin: 0 0 12px;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(255, 59, 48, 0.1);
    border: 1px solid rgba(255, 59, 48, 0.35);
    font-size: 13px;
    color: rgb(var(--danger));
  }

  .sync-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    font-size: 14px;
  }

  .sync-label {
    color: rgb(var(--label-3));
  }

  .sync-time {
    color: rgb(var(--label-2));
  }

  .action-buttons {
    display: flex;
    gap: 12px;
  }

  /* 按钮 */
  .btn-primary,
  .btn-secondary {
    flex: 1;
    padding: 12px 24px;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .btn-primary {
    background: rgb(var(--accent));
    color: white;
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .btn-primary:hover:not(:disabled) {
    opacity: 0.8;
  }
  }

  .btn-secondary {
    background: rgb(var(--surface-2));
    color: rgb(var(--accent));
  }

  /* 指针契约：只在真能 hover 的设备上生效（REQ-A385） */
  @media (hover: hover) {
    .btn-secondary:hover:not(:disabled) {
    opacity: 0.8;
  }
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* 响应式 */
  @media (max-width: 768px) {
    .mdm-panel {
      padding: 16px;
    }

    .action-buttons {
      flex-direction: column;
    }

    .limit-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
  }
</style>
