/**
 * shortcutGallery.ts — 快捷指令库的**预设模板**（REQ-A500）。
 *
 * 为什么是"预设模板"而不是挂载企业模板库：`ShortcutsApp` 的 `view === "gallery"` 是**可达**的
 * （工具栏里就有入口），它的描述写着「探索预设模板，快速创建实用的快捷指令」，而它此前只画一句
 * `🚧 快捷指令库即将推出`。企业模板库（`modules/TemplateLibrary.svelte`）是**另一件事**：
 * `docs/SHORTCUTS_ENTERPRISE_UI_SPEC.md` 把它定在「设置 → 企业功能」页，而且它的数据源
 * （`templateManager.syncTemplates`）在本仓**没有任何生产侧生产者**（实测：只有测试在调）
 * ⇒ 挂上去只会得到一块永远空的屏。所以这里做的是**描述真正承诺的那件事**：随应用一起发布的预设。
 *
 * 三条设计约束（都是实测出来的，不是偏好）：
 *  1. **文案必须可本地化**：模板名/描述/通知文案全部走 i18n 键（`{ i18n: "键" }` 标记在安装时
 *     由 `t()` 解析）。把中文字符串表写死在数据里就等于做一个单语言 UI —— 那正是 `i18n-scan`
 *     存在的理由，数据表不该是它的后门。
 *  2. **只用真实动作、真实参数**：每个动作 id 必须在 `BUILTIN_ACTIONS` 里，每个参数名必须是该
 *     动作**声明过**的（测试逐条比对）—— 写错一个参数名不会报错，只会安静地什么都不做。
 *  3. **不做"结果去哪儿"的假承诺**：本引擎**没有插值**（实测：`show_notification` 只读自己的
 *     `title`/`body`，`format_date` 只读自己的 `date`，没有 `{{var}}` 机制）⇒ 模板**不可能**
 *     把上一步的输出带进通知里。因此这里的模板是"装上就能跑、并且真的做了点什么"的**积木**，
 *     用户再在编辑器里接自己的数据 —— 而不是假装它们是一条数据管线。
 */
import type { ActionInstance, Shortcut } from "./shortcuts";

/**
 * 参数值。字符串/数字/布尔直接写入；`{ i18n: "键" }` 表示**安装时**用当前语言解析
 * （模板文案必须可本地化，见文件头约束 1）。
 */
export type GalleryParamValue = string | number | boolean | { i18n: string };

export interface GalleryTemplateAction {
  actionTypeId: string;
  parameters?: Record<string, GalleryParamValue>;
}

export interface GalleryTemplate {
  /** 稳定标识：既是"我装过它"的标记，也是 i18n 键的一部分。 */
  id: string;
  icon: string;
  /** 取自 `SHORTCUT_COLORS` 的合法色值（与编辑器里的调色板同一组）。 */
  color: string;
  nameKey: string;
  descKey: string;
  actions: GalleryTemplateAction[];
}

/** 随应用发布的预设模板（顺序即展示顺序）。 */
export const GALLERY_TEMPLATES: readonly GalleryTemplate[] = [
  {
    id: "quick_note",
    icon: "📝",
    color: "#FFCC00",
    nameKey: "gallery.tpl.quickNote.name",
    descKey: "gallery.tpl.quickNote.desc",
    actions: [
      { actionTypeId: "text", parameters: { text: { i18n: "gallery.tpl.quickNote.text" } } },
      {
        actionTypeId: "copy_to_clipboard",
        parameters: { text: { i18n: "gallery.tpl.quickNote.text" } },
      },
      {
        actionTypeId: "show_notification",
        parameters: {
          title: { i18n: "gallery.tpl.quickNote.name" },
          body: { i18n: "gallery.tpl.quickNote.notified" },
        },
      },
    ],
  },
  {
    id: "focus_timer",
    icon: "⏱️",
    color: "#007AFF",
    nameKey: "gallery.tpl.focusTimer.name",
    descKey: "gallery.tpl.focusTimer.desc",
    actions: [
      { actionTypeId: "wait", parameters: { seconds: 1500 } },
      {
        actionTypeId: "show_notification",
        parameters: {
          title: { i18n: "gallery.tpl.focusTimer.name" },
          body: { i18n: "gallery.tpl.focusTimer.done" },
        },
      },
    ],
  },
  {
    id: "silent_ping",
    icon: "📳",
    color: "#FF2D55",
    nameKey: "gallery.tpl.silentPing.name",
    descKey: "gallery.tpl.silentPing.desc",
    actions: [
      { actionTypeId: "vibrate", parameters: { pattern: "short" } },
      {
        actionTypeId: "show_notification",
        parameters: {
          title: { i18n: "gallery.tpl.silentPing.name" },
          body: { i18n: "gallery.tpl.silentPing.body" },
        },
      },
    ],
  },
  {
    id: "open_files",
    icon: "📁",
    color: "#30B0C7",
    nameKey: "gallery.tpl.openFiles.name",
    descKey: "gallery.tpl.openFiles.desc",
    actions: [{ actionTypeId: "open_app", parameters: { app: "files" } }],
  },
];

/** 「这条快捷指令来自某个模板」的标记。用既有的 `tags` 承载 —— 不新增 schema 字段。 */
export function templateTag(templateId: string): string {
  return `gallery:${templateId}`;
}

/** 该模板是否已经装过（按标签判断，不维护第二本账）。 */
export function isTemplateInstalled(
  shortcuts: readonly Shortcut[],
  templateId: string,
): boolean {
  const tag = templateTag(templateId);
  return shortcuts.some((s) => Array.isArray(s.tags) && s.tags.includes(tag));
}

/** 解析一个参数值（`{ i18n }` 走当前语言的 `t()`；其余原样）。 */
export function resolveParamValue(
  value: GalleryParamValue,
  translate: (key: string) => string,
): unknown {
  if (value !== null && typeof value === "object") return translate(value.i18n);
  return value;
}

/**
 * 模板 → 动作实例（纯函数）。
 *
 * `newId` 由调用方注入：id 的所有者只有一个（`lib/localId.ts`），这个模块不去自己铸 id；
 * 位置（`position`）按数组序确定 —— 执行器按它排序，缺失会让顺序不确定。
 */
export function actionsFromTemplate(
  template: GalleryTemplate,
  newId: () => string,
  translate: (key: string) => string,
): ActionInstance[] {
  return template.actions.map((a, index) => ({
    id: newId(),
    actionTypeId: a.actionTypeId,
    parameters: Object.fromEntries(
      Object.entries(a.parameters ?? {}).map(([k, v]) => [k, resolveParamValue(v, translate)]),
    ),
    position: index,
  }));
}

/**
 * 模板 → `createShortcut(name, options)` 的 options（**不碰存储**）。
 *
 * 创建一律走 `createShortcut`：它带着 MDM 权限检查、名字校验与上限，是这条路径上唯一的入口
 * （在这里直接写 store 就等于绕过那三道）。名字不在返回值里 —— 它是 `createShortcut` 的独立
 * 入参，由调用方从 `t(template.nameKey)` 取（翻译只在组件层发生一次）。
 */
export function templateOptions(
  template: GalleryTemplate,
  description: string,
  translate: (key: string) => string,
  newId: () => string,
): Partial<Omit<Shortcut, "id" | "createdAt" | "updatedAt" | "runCount">> {
  return {
    icon: template.icon,
    color: template.color,
    description,
    actions: actionsFromTemplate(template, newId, translate),
    tags: [templateTag(template.id)],
  };
}
