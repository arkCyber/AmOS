/**
 * template-library-select-params.svelte.test.ts — 模板库的 `select` 参数，屏幕上画的是选项，
 * 交回去的是它的值（REQ-A1534 ∕ F-SH-776）。
 *
 * 为什么这个文件存在：`TemplateParameter.options` 的声明是 `Array<{ label: string; value: unknown }>`
 * —— 与 `templates.ts::validateParameters` 里逐字那句 `param.options.map(opt => opt.value)` 同一份
 * 形状，也与 `enterprise-templates.test.ts` 播种的 `options: [{ label: "A", value: "a" }]` 同一份
 * 形状。渲染侧却把每个 `option` 当**标量**用：
 *
 *     {#each param.options as option}
 *       <option value={option}>{option}</option>
 *     {/each}
 *
 * 于是两件事同时发生，而且都不出声：
 *
 *   * `<option>` 的文本与 value 都被 `String(option)` 折成字面量 `[object Object]` —— 下拉框里
 *     每个选项都叫这个名字，用户看不出哪条是哪条；
 *   * 用户真的改了这个下拉框之后，`onchange` 交回来的是那个字符串，`validateParameters` 拿它
 *     去 `options.map(o => o.value).includes(value)` ⇒ 永远不在范围内 ⇒ 安装被拒，而屏幕上那句
 *     拒绝是「值不在允许范围内」——一句把渲染缺陷说成用户选错的话。（不动下拉框时用的是
 *     `defaultValue`，恰好合法，所以只有「改了」的那一次会踩到；必填的 select 参数没有默认值时
 *     则是**每次都装不上**。）
 *
 * 判据按这个家族一贯的写法：不看内部状态，看**屏幕上出现了什么**，再问一句「选中的那个值是不是
 * 真的进了那条被建出来的快捷指令」。两条都要成立。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import TemplateLibrary from "../src/svelte/modules/TemplateLibrary.svelte";
import {
  templateManager,
  TEMPLATES_KEY,
  type EnterpriseTemplate,
  type TemplateParameter,
} from "../src/lib/enterprise/templates";
import { loadShortcuts } from "../src/lib/shortcuts";
import { mdmManager } from "../src/lib/enterprise/mdm";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

/** 按模块自己的读法播种（`saveTemplates` 的双层编码，与 catalogue 那份测试同一套）。 */
function seedTemplates(templates: EnterpriseTemplate[]): void {
  window.localStorage.setItem(TEMPLATES_KEY, JSON.stringify(JSON.stringify(templates)));
}

/** 一个 `select` 参数：模型里它是 `{ label, value }` 对。 */
function modeParam(): TemplateParameter {
  return {
    key: "mode",
    name: "模式",
    type: "select",
    defaultValue: "prod",
    required: true,
    description: "",
    options: [
      { label: "生产", value: "prod" },
      { label: "测试", value: "test" },
    ],
  };
}

function template(overrides: Partial<EnterpriseTemplate> = {}): EnterpriseTemplate {
  return {
    id: "tpl-select",
    name: "发布助手",
    description: "按模式发布",
    category: "生产力",
    department: "全员",
    icon: "🚀",
    color: "#3366ff",
    version: "1.0.0",
    // 占位符替换的落点：选中的模式应当出现在这条指令的描述里。
    shortcutData: {
      id: "sc-template",
      name: "发布助手",
      icon: "star",
      color: "#111111",
      description: "mode={{mode}}",
      actions: [],
      quickActions: [],
      triggers: [],
      createdAt: 0,
      updatedAt: 0,
      runCount: 0,
    },
    parameters: [modeParam()],
    targetRoles: [],
    targetDepartments: [],
    isForced: false,
    allowCustomization: true,
    autoUpdate: false,
    publishStatus: "published",
    installedCount: 0,
    successCount: 0,
    failureCount: 0,
    organizationId: "org-seed",
    createdBy: "admin",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

let alertCalls: string[] = [];

beforeEach(() => {
  templateManager.resetForTest();
  alertCalls = [];
  vi.stubGlobal("alert", (msg: string) => {
    alertCalls.push(String(msg));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  setLocale("zh");
  window.localStorage.clear();
  templateManager.resetForTest();
  mdmManager.clearConfigForTest();
});

/** 打开那唯一一张卡片的详情，交回 `select` 元素。 */
async function openDetailAndGetSelect(container: HTMLElement): Promise<HTMLSelectElement> {
  (container.querySelector(".template-card") as HTMLButtonElement).click();
  await tick();
  const sel = container.querySelector("#tpl-param-mode") as HTMLSelectElement | null;
  expect(sel).not.toBeNull();
  return sel!;
}

describe("模板库：select 参数画的是 label ∕ value（REQ-A1534 ∕ F-SH-776）", () => {
  test("下拉框里每个选项的可见文字是它的 label，不是 [object Object]", async () => {
    seedTemplates([template()]);
    const { container } = render(TemplateLibrary);

    const sel = await openDetailAndGetSelect(container);

    const labels = Array.from(sel.options).map((o) => o.textContent);
    expect(labels).toEqual([zh["templates.selectPlaceholder"], "生产", "测试"]);
    // 最直白的一句：屏幕上不该出现把对象字符串化之后的那个字面量。
    expect(labels.join("|")).not.toContain("[object Object]");
  });

  test("每个选项的 value 是那个选项的 value（与 validateParameters 判的是同一份）", async () => {
    seedTemplates([template()]);
    const { container } = render(TemplateLibrary);

    const sel = await openDetailAndGetSelect(container);

    const values = Array.from(sel.options).map((o) => o.value);
    expect(values).toEqual(["", "prod", "test"]);
  });

  test("选了第二个选项 ⇒ 装得上，且选中的值真的进了那条被建出来的快捷指令", async () => {
    seedTemplates([template()]);
    const { container } = render(TemplateLibrary);

    const sel = await openDetailAndGetSelect(container);

    // 用户把默认的「生产」改成「测试」。
    fireEvent.change(sel, { target: { value: "test" } });
    await tick();

    (container.querySelector(".modal-footer .btn-primary") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(templateManager.getInstalledTemplates()).toHaveLength(1);
    });

    // 屏幕上那句回执必须是「安装成功」，不能是那句把渲染缺陷说成用户选错的拒绝。
    expect(alertCalls).toHaveLength(1);
    const installed = templateManager.getInstalledTemplates()[0]!;
    expect(alertCalls[0]).toBe(
      zh["templates.installSuccess"].replace("{id}", installed.shortcutId),
    );

    // 选中的值一路走到了落盘的那条快捷指令上（`{{mode}}` 占位符被替换）。
    const created = loadShortcuts().find((s) => s.name === "发布助手");
    expect(created).toBeDefined();
    expect(created?.description).toBe("mode=test");
  });

  test("选项的 value 不是字符串时（`unknown`），落回模型的仍是原始那个值", async () => {
    seedTemplates([
      template({
        parameters: [
          {
            key: "mode",
            name: "等级",
            type: "select",
            defaultValue: 1,
            required: true,
            description: "",
            options: [
              { label: "低", value: 1 },
              { label: "高", value: 2 },
            ],
          },
        ],
      }),
    ]);
    const { container } = render(TemplateLibrary);

    const sel = await openDetailAndGetSelect(container);

    // 可见文字仍是 label；DOM 上的 value 只能是字符串。
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual([
      zh["templates.selectPlaceholder"],
      "低",
      "高",
    ]);
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["", "1", "2"]);

    fireEvent.change(sel, { target: { value: "2" } });
    await tick();

    (container.querySelector(".modal-footer .btn-primary") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(templateManager.getInstalledTemplates()).toHaveLength(1);
    });
    // 交回去的是数字 `2`，不是字符串 `"2"` —— `validateParameters` 的
    // `options.map(o => o.value).includes(value)` 判的就是这个。
    expect(loadShortcuts().find((s) => s.name === "发布助手")?.description).toBe("mode=2");
  });
});
