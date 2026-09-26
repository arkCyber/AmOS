/**
 * shortcutGallery.test.ts — 快捷指令库预设模板的**机械校验**（REQ-A500）。
 *
 * 这个文件的存在理由：模板是**数据**，而数据错了不会报错 —— 一个拼错的参数名、一个不存在的
 * 动作、一个字典里没有的 i18n 键，都会安静地让「装上去的快捷指令什么都不做」或让界面显示
 * `gallery.tpl.…` 这样的原始键。所以每一条都对着**真相之源**比对：
 *   • 动作 id ↔ `BUILTIN_ACTIONS`（真实目录）；
 *   • 参数名 ↔ 该动作**声明过**的参数 id（写错一个参数名不会抛，只会静默失效）；
 *   • i18n 键 ↔ zh / en 两份字典（`translate()` 是唯一的解析器，两侧都要能答）。
 */
import { describe, test, expect } from "bun:test";
import { BUILTIN_ACTIONS } from "../shortcuts";
import {
  GALLERY_TEMPLATES,
  actionsFromTemplate,
  isTemplateInstalled,
  resolveParamValue,
  templateOptions,
  templateTag,
  type GalleryTemplate,
} from "../shortcutGallery";
import { translate } from "../../svelte/i18n";
import { zh } from "../../i18n/locales/zh";
import { en } from "../../i18n/locales/en";

const ZH = zh as Record<string, string>;
const EN = en as Record<string, string>;
const byId = new Map(BUILTIN_ACTIONS.map((a) => [a.id, a]));

/** 逐层收集模板里出现的每个 i18n 键（含动作参数里的 `{ i18n }` 标记）。 */
function i18nKeys(tpl: GalleryTemplate): string[] {
  const keys = [tpl.nameKey, tpl.descKey];
  for (const a of tpl.actions) {
    for (const v of Object.values(a.parameters ?? {})) {
      if (v !== null && typeof v === "object") keys.push((v as { i18n: string }).i18n);
    }
  }
  return keys;
}

describe("REQ-A500: 预设模板只引用真实动作与真实参数", () => {
  test("模板本身自洽：id/名字键唯一、至少一个动作、色值是合法色", () => {
    expect(GALLERY_TEMPLATES.length).toBeGreaterThan(3);
    const ids = GALLERY_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const nameKeys = GALLERY_TEMPLATES.map((t) => t.nameKey);
    expect(new Set(nameKeys).size).toBe(nameKeys.length);
    for (const tpl of GALLERY_TEMPLATES) {
      expect(tpl.actions.length).toBeGreaterThan(0);
      expect(tpl.nameKey.startsWith("gallery.tpl.")).toBe(true);
      expect(tpl.descKey.startsWith("gallery.tpl.")).toBe(true);
      expect(tpl.color).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  test("每个动作 id 都在 `BUILTIN_ACTIONS` 里（拼错就是「装了什么都不做」）", () => {
    const unknown: string[] = [];
    for (const tpl of GALLERY_TEMPLATES) {
      for (const a of tpl.actions) {
        if (!byId.has(a.actionTypeId)) unknown.push(`${tpl.id}: ${a.actionTypeId}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  test("每个参数名都是该动作**声明过**的参数（多一个或少一个都是静默失效）", () => {
    const bad: string[] = [];
    for (const tpl of GALLERY_TEMPLATES) {
      for (const a of tpl.actions) {
        const declared = new Set((byId.get(a.actionTypeId)?.parameters ?? []).map((p) => p.id));
        for (const key of Object.keys(a.parameters ?? {})) {
          if (!declared.has(key)) bad.push(`${tpl.id}/${a.actionTypeId}: ${key}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("模板里的每个 i18n 键在 zh 与 en 都能解析（两侧都不许露出原始键）", () => {
    const missing: string[] = [];
    for (const tpl of GALLERY_TEMPLATES) {
      for (const key of i18nKeys(tpl)) {
        for (const [locale, dict] of [["zh", ZH], ["en", EN]] as const) {
          const out = translate(dict, key);
          if (out === key || out.trim() === "") missing.push(`${locale}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("REQ-A500: 安装路径（纯函数部分）", () => {
  test("`actionsFromTemplate` 铸新 id、按数组序写 `position`、把 `{ i18n }` 解析成当前语言", () => {
    let n = 0;
    const tpl = GALLERY_TEMPLATES[0]!;
    const actions = actionsFromTemplate(tpl, () => `a${++n}`, (k) => translate(ZH, k));

    expect(actions.length).toBe(tpl.actions.length);
    expect(actions.map((a) => a.position)).toEqual(tpl.actions.map((_, i) => i));
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
    // 文案已经**解析成当前语言**（不是把键原样写进用户的快捷指令里）。
    const textAction = actions.find((a) => a.actionTypeId === "text")!;
    expect(textAction.parameters.text).toBe(translate(ZH, "gallery.tpl.quickNote.text"));
    expect(String(textAction.parameters.text)).not.toContain("gallery.tpl.");
  });

  test("`templateOptions` 只给创建入口需要的东西：图标 / 色值 / 描述 / 动作 / 来源标签", () => {
    let n = 0;
    const opts = templateOptions(
      GALLERY_TEMPLATES[1]!,
      "Y",
      (k) => translate(ZH, k),
      () => `id${++n}`,
    );
    expect(opts.description).toBe("Y");
    expect(opts.tags).toEqual([templateTag(GALLERY_TEMPLATES[1]!.id)]);
    expect(opts.actions?.length).toBe(GALLERY_TEMPLATES[1]!.actions.length);
    // 名字与 id **不**在这里：前者是 `createShortcut(name, …)` 的独立入参，后者由它自己生成
    // （id 的所有者只有一个）。
    expect("name" in opts).toBe(false);
    expect("id" in opts).toBe(false);
  });

  test("`isTemplateInstalled` 认的是标签而非名字（装完之后改名仍然算装过）", () => {
    const tpl = GALLERY_TEMPLATES[0]!;
    const fake = (tags: unknown): never => ({ id: "s1", name: "随便改名", tags }) as never;
    expect(isTemplateInstalled([fake([templateTag(tpl.id)])], tpl.id)).toBe(true);
    expect(isTemplateInstalled([fake([templateTag("other_template")])], tpl.id)).toBe(false);
    expect(isTemplateInstalled([], tpl.id)).toBe(false);
    // 坏数据（tags 缺失/不是数组）不许把页面炸掉。
    expect(isTemplateInstalled([fake(undefined)], tpl.id)).toBe(false);
  });

  test("`resolveParamValue`：字符串 / 数字 / 布尔原样，`{ i18n }` 走翻译", () => {
    const t = (k: string) => `T(${k})`;
    expect(resolveParamValue("short", t)).toBe("short");
    expect(resolveParamValue(1500, t)).toBe(1500);
    expect(resolveParamValue(true, t)).toBe(true);
    expect(resolveParamValue({ i18n: "a.b" }, t)).toBe("T(a.b)");
  });
});

