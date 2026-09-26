/**
 * stage.ts — Stage Manager（舞台管理器）的桥接层与类型。
 *
 * 宿主侧是 `crates/amos-tauri/src/stage.rs`；几何（轨道宽度、工作区内缩、一键整理的网格）
 * 在 `crates/amos-wm/src/form.rs` + `src/stage.rs` 两个纯模块里，跟这里无关。
 *
 * ## 桥契约
 *
 * 五个命令全部返回 `Result<StageSnapshot, AmosError>`，所以：
 *   * 成功是**对象**，拒绝是 `null`（`invoke` 把失败吞进诊断台账）。这里不出现
 *     "返回 `()` 的命令"那种陷阱 —— `spaces.ts` 的 `unitMutationOk` 注释记录了它
 *     （`() `在 wire 上是 `null`，与失败同形，布尔判据恒假）。
 *   * 拒绝的**原因**在 `bridgeDiag("stage_park").detail.code` 里，取值是
 *     `amos.stage.*`；[`stageFailure`] 是把它翻成一句话的**唯一**规则。
 *
 * ## 轨道视图是**派生**的，不是第二个账本
 *
 * `parked` / `on_stage` 不是这里维护的列表，而是宿主从**窗口模型**里读回来的
 * （`WindowInfo.state == "Hidden"` 且 `kind == "App"`）。关掉一个停在轨道上的窗口时，
 * 窗口模型自己把它移除，轨道**跟着**少一块 —— 不需要任何人通知轨道。这与
 * `lib/spaces.ts::fileableWindows` 同一条纪律。
 */

import { bridgeDiag, invoke } from "./backend";

/** 一个停在轨道上的窗口 —— 与 `stage.rs::StageWindow` 逐字段对应。 */
export interface StageWindow {
  /** Tauri 窗口标签（`files`、`files_2`）。 */
  label: string;
  /** 该窗口显示的 **app id**（`WindowInfo::app`）。 */
  app: string;
  /** 该 app 的第几个实例。 */
  instance: number;
}

/**
 * 宿主侧 `StageSnapshot` 的镜像。
 *
 * **没有 title 字段**，这是有意的：窗口的人类可读名字只有一个解析器
 * （`locale.svelte.ts::windowName`），宿主在 Rust 里造的名字只能是原始 app id，
 * 于是同一个窗口在非英文语言下会有两个互相矛盾的名字 —— 正是 REQ-A473 修掉的那种漂移。
 *
 * **也没有几何**：轨道占多宽是*布局*事实，由 `LayoutSnapshot::rail_width` 报告
 * （`lib/wm.ts`，与 shell 画舞台所用的同一份 `screen_w/h` 同源）。两边都报一次，
 * 就有了同一个数字的两份读数 —— 轨道自己与桌面图标网格的内缩正是这样对不上的。
 * 所以这里只回答"模式开着吗、谁在哪里"。
 */
export interface StageSnapshot {
  /** 模式开着吗？无轨道类别（手机 / 平板）恒为 `false`。 */
  enabled: boolean;
  /**
   * 在台上的窗口（可见或聚焦的、本宿主自己的），顺序按模型的顺序。
   *
   * 与 `parked` 是同一种记录而不是裸标签：界面要用**唯一**的名字解析器
   * （`locale.svelte.ts::windowName`）给窗口命名，裸标签只能印出 `files_2` 这样的线协议
   * id。界面读它的长度来决定"整理"是否可用。
   */
  on_stage: StageWindow[];
  /** 轨道视图：一个停着的窗口一条，顺序按模型自己的顺序。 */
  parked: StageWindow[];
}

// ─── 命令 ─────────────────────────────────────────────────────────────

/**
 * 读整个 Stage Manager 状态。
 *
 * 只读且**不**以"模式开着"为门禁：界面要能问出"开着吗"才能画自己的开关，
 * 在这里拒绝会让"关着"这个状态读不出来。拒绝时 `null`。
 */
export async function stageSnapshot(): Promise<StageSnapshot | null> {
  const raw = await invoke<StageSnapshot>("stage_snapshot");
  return raw === null || raw === undefined ? null : normalizeStageSnapshot(raw);
}

/** 开关 Stage Manager。无轨道类别上会被拒（`amos.stage.unsupported`）。 */
export async function stageSetEnabled(enabled: boolean): Promise<StageSnapshot | null> {
  const raw = await invoke<StageSnapshot>("stage_set_enabled", { enabled });
  return raw === null || raw === undefined ? null : normalizeStageSnapshot(raw);
}

/**
 * 把一个窗口停到轨道上。
 *
 * 拒绝是**具名**的，从不静默：模式关着（`StageDisabled`）、目标是启动器
 * （`StageWindowIsScreen`）、窗口在分屏里（`StageWindowInSplit`）、标签未注册
 * （`StageWindowUnknown`）—— 用 [`stageFailure`] 读出是哪一条。
 */
export async function stagePark(label: string): Promise<StageSnapshot | null> {
  const raw = await invoke<StageSnapshot>("stage_park", { label });
  return raw === null || raw === undefined ? null : normalizeStageSnapshot(raw);
}

/**
 * 把停着的窗口带回台上。
 *
 * 走宿主的 `WmState::reveal`（**不是** `WmState::open`），即**显示并聚焦**：轨道上的一块
 * 瓷砖是"点一个窗口"，回来却不聚焦的话用户会对着它后面的窗口打字。
 *
 * 为什么不是 `open`：那是**启动**动词，它的同一性门（REQ-A473）只认一个 app 的**第一个**
 * 窗口，其余 label 一律拒绝。第二个实例（`notes_2`）在轨道上是自己的一块瓷砖
 * （`views_of` 的判定），用 `open` 取回来的话会被拒绝——于是它停得下去、再也回不来。
 */
export async function stageBring(label: string): Promise<StageSnapshot | null> {
  const raw = await invoke<StageSnapshot>("stage_bring", { label });
  return raw === null || raw === undefined ? null : normalizeStageSnapshot(raw);
}

/**
 * 一键整理（"Tidy"）：把台上每个窗口铺进工作区的网格。
 *
 * 几何在 `LayoutPolicy::arrange_stage`（纯、有测试），放不下时**拒绝**
 * （`amos.stage.arrange_impossible`）而不是给出一个用户分辨不出的半成品布局。
 * 空台是 no-op，不是错误。
 */
export async function stageArrange(): Promise<StageSnapshot | null> {
  const raw = await invoke<StageSnapshot>("stage_arrange");
  return raw === null || raw === undefined ? null : normalizeStageSnapshot(raw);
}

/**
 * 把宿主回包**收窄**成类型化视图（从不抛）。
 *
 * `parked` 里没有可用 `label` 的条目被**丢掉** —— 一个叫不出名字的窗口无法被任何命令
 * 寻址（`wm.ts::normalizeWindows` 同一条规则，理由相同）。其余字段取最保守的值：
 * 一个畸形回包退化成"模式关着、没有窗口"，而不是抛出去。
 */
export function normalizeStageSnapshot(raw: unknown): StageSnapshot {
  const s = (raw ?? {}) as {
    enabled?: unknown;
    on_stage?: unknown;
    parked?: unknown;
  };
  return {
    enabled: s.enabled === true,
    on_stage: recordsOf(s.on_stage),
    parked: recordsOf(s.parked),
  };
}

/** 一组窗口记录；不是数组就是空（"没有窗口"），条目各自收窄。 */
function recordsOf(v: unknown): StageWindow[] {
  return Array.isArray(v)
    ? v.map(stageWindowOf).filter((w): w is StageWindow => w !== null)
    : [];
}

/** 一条轨道记录，或在它没有可用 label / app 时 `null`。 */
function stageWindowOf(v: unknown): StageWindow | null {
  if (v === null || typeof v !== "object") return null;
  const w = v as Partial<StageWindow>;
  if (typeof w.label !== "string" || w.label === "") return null;
  return {
    label: w.label,
    app: typeof w.app === "string" ? w.app : "",
    instance: typeof w.instance === "number" && Number.isFinite(w.instance) ? w.instance : 0,
  };
}

// ─── 拒绝的措辞 ───────────────────────────────────────────────────────

/**
 * 一条 `stage_*` 命令为什么被拒 —— 把类型化的 `amos.stage.*` 码翻成用户读到的那句话的
 * **唯一**规则（与 `spaces.ts::spacesFailure` 同形）。
 *
 * 规则只写一份的理由：同一族拒绝会有**多个面**（轨道自己的按钮、Window 菜单的"整理"、
 * 设置里的开关），每个面各写一份 switch 就是同一件事的多套说法。参数化与语言由调用点的
 * `t()` 负责。
 *
 * `hostMessage` 是宿主自己写下的句子，只在**没有任何已知 code** 可映射时才给。
 *
 * `bridgeDiag` 是**按命令名**保留最近一次读数的，所以调用点必须传它自己刚跑的那条命令。
 */
export function stageFailure(command: string): { key: string; hostMessage?: string } {
  const diag = bridgeDiag(command);
  if (diag.ok) return { key: "stage.errorUnknown" };
  const detail =
    diag.kind === "command-failed" && diag.detail && typeof diag.detail === "object"
      ? (diag.detail as { code?: string; message?: string })
      : null;
  switch (detail?.code) {
    case "amos.stage.disabled":
      return { key: "stage.errorDisabled" };
    case "amos.stage.unsupported":
      return { key: "stage.errorUnsupported" };
    case "amos.stage.window_unknown":
      return { key: "stage.errorWindowUnknown" };
    case "amos.stage.window_is_screen":
      return { key: "stage.errorWindowIsScreen" };
    case "amos.stage.window_in_split":
      return { key: "stage.errorWindowInSplit" };
    case "amos.stage.arrange_impossible":
      return { key: "stage.errorArrangeImpossible" };
    case "amos.stage.lock_failed":
      return { key: "stage.errorLockFailed" };
    // The family's last code, and the one this switch used to fold into `errorUnknown`
    // while its sibling family (`spaces.ts::spacesFailure`) maps every `amos.spaces.*` —
    // so a persistence refusal showed the user 「操作失败」 and the host's own sentence,
    // which is the fallback, not a sentence (REQ-A1683).
    case "amos.stage.persist_failed":
      return { key: "stage.errorPersistFailed" };
    default:
      return { key: "stage.errorUnknown", hostMessage: detail?.message };
  }
}
