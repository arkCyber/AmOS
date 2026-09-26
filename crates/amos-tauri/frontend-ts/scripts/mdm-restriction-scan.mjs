#!/usr/bin/env node
/**
 * mdm-restriction-scan.mjs — 「同一条限制有几份定义」（REQ-A899）。
 *
 * ## 为什么需要它：这一族的缺陷都不是判据写错了，而是判据写了不止一遍
 *
 * 2026-09-22 在 `src/lib/enterprise/mdm.ts` 上量出来的三个形状，全部是同一个病：
 *
 *   1. **默认限制有三份表。** `DEFAULT_RESTRICTIONS`（`maxActionsPerShortcut: 100`）、
 *      `configure()` 的初始表、`deletePolicy()` 的恢复表 —— 后两份写的是 `50`。
 *      于是「删除策略 ⇒ 恢复默认值」恢复出来的**不是**默认值，而首次配置与重新注册
 *      得到两个不同的上限。**没有任何测试会红**，因为每一份单独看都自洽。
 *   2. **同一条判据有两份实现。** `checkCanExecute()` 把 `checkActionCount()` /
 *      `checkDailyExecutionLimit()` 手工内联了一遍，而内联的那份**丢掉了 NaN 折叠**
 *      （`policyExecutionSeconds` / `policyShortcutCap` 都有）。`undefined` 上限下
 *      `currentCount >= undefined` 恒为假 ⇒ **配额静默失效**（fail open）。
 *   3. **限制可以被整块抹掉。** 配置的三个入口（`loadConfig` / `configure` /
 *      `syncWithServer`）都整块替换 `restrictions`，而它的类型是
 *      `Partial<MDMRestrictions>` —— 服务端下发一个只含一项的增量，其余限制就变成
 *      `undefined`，接着落盘，重启依然如此。形状 2 的 fail-open 由此**从一条测试
 *      之外的真实路径**被触发。
 *
 * 三个形状的共同点是：**「同一个东西只写一次」这条约束，没有任何机器在核对。**
 * 本闸门就是那台机器。它不检查判据的逻辑（那是测试的事），只检查**定义的份数**。
 *
 * ## 判据
 *
 * * **① 默认表 ≡ 类型**：`DEFAULT_RESTRICTIONS` 对象字面量的键集 **等于**
 *   `MDMRestrictions` 接口的成员集（**双向**集合相等）。少一项 ⇒ 新增的限制项没有
 *   默认值（`undefined` 默认值配合折算是拒，不折就是放行，两种都是一片静默）；
 *   多一项 ⇒ 表里有个类型里不存在的键（写错了名字，永远读不到）。
 * * **② 读站点表 ≡ 声明表**：对每一个限制字段，**哪些方法读了它**这个集合必须与
 *   本文件里声明的 `READERS` 完全相等（**双向**）。这是形状 2 的探测器：`checkCanExecute()`
 *   里再内联一遍 `maxExecutionsPerDay`，这个字段的读集合就多了 `checkCanExecute` ⇒ 红。
 *   反方向同样要害：`policyDailyCap()` 若失去唯一读者，说明折叠没人用了。
 * * **③ 限制的数值只能写在默认表里**：`mdm.ts` 里任何一个**属性名是数值型限制字段、
 *   值是数值字面量**的属性赋值，只允许出现在 `DEFAULT_RESTRICTIONS` 的初始化器里。
 *   这是形状 1 的探测器 —— `maxActionsPerShortcut: 50` 不管写在哪个方法里都会红。
 *
 * ## 边界（量出来的）
 *
 * * **`bool` / 数组字段不参与 ③。** 它们的「默认」是 `true`/`false`/`[]`，在代码里
 *   到处都是同形字面量（`{ enabled: true }`、`return []`），做文本匹配只会造出假阳性。
 *   形状 1 的可观测后果（上限差一倍）只在数值字段上，所以只管数值字段。
 * * **只扫一个文件。** 判据说的是 `MDMRestrictions` / `MDMConfig` 与 `MDMManager` 之间的
 *   内部一致性，这三样都在 `mdm.ts` 里。扫描面写在这里是**刻意的**：将来有人把限制表
 *   搬出去，`①` 会先因为找不到 `DEFAULT_RESTRICTIONS` 而红，而不是悄悄扫了个空。
 * * **别名解析只认一层。** 方法体里 `const restrictions = this.config.restrictions`
 *   之后再 `restrictions.maxExecutionsPerDay` 会被算进去（`checkPermission()` 就是这么
 *   写的）；再包一层（`const a = b; const b = …restrictions`）会漏。判据是**保守**的
 *   —— 它可能漏报一次读取，不会把没读的报成读了（误报会让闸门失去信誉，漏报只是回到
 *   没有闸门的状态，而 `dead-member-scan` 在另一头兜着）。
 * * **不用正则猜结构。** 与 `lib-coverage-gate.mjs` / `dead-member-scan.mjs` 同一个先例：
 *   `require("typescript")`；拿不到就**报错退出**，不降级 —— 一个「看不见任何东西
 *   所以全绿」的闸门正是这套审计要防的东西。
 *
 * 用法（在 frontend-ts 下）：
 *   node scripts/mdm-restriction-scan.mjs              # 闸门（有新增即非零退出）
 *   node scripts/mdm-restriction-scan.mjs --json       # 机器可读
 *   node scripts/mdm-restriction-scan.mjs --selftest   # 钉住提取器与判据
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `.mjs` 里没有 `require`；typescript 是 CJS 包，走 createRequire（同 dead-member-scan.mjs）。
const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MDM_TS = join(ROOT, "src/lib/enterprise/mdm.ts");
const TYPE_NAME = "MDMRestrictions";
const DEFAULTS_NAME = "DEFAULT_RESTRICTIONS";

/** 数值型限制字段：默认值是数字，所以「第二份表」的样子是 `字段: 数字`。 */
export const NUMERIC_FIELDS = [
  "maxExecutionTime",
  "maxExecutionsPerDay",
  "maxActionsPerShortcut",
  "maxShortcutsPerUser",
];

/**
 * 每个限制字段的**唯一**读者集合（声明，不是量出来的）。
 *
 * 这张表就是「一条限制只有一处实现」的书面形式：改代码时它要么仍然成立，要么红给你看。
 * 加一个读者（比如又在别处内联了一遍）→ 红；一个读者消失（比如折叠没人用了）→ 红。
 */
export const READERS = {
  // 四个数值字段各有一个私有规范值助手 —— 折叠（NaN/负数 ⇒ 0）只写在那里
  maxExecutionTime: ["policyExecutionSeconds"],
  maxExecutionsPerDay: ["policyDailyCap"],
  maxActionsPerShortcut: ["policyActionCap"],
  maxShortcutsPerUser: ["policyShortcutCap"],
  // 两个数组：唯一定义是 checkActionAllowed（isActionDisabled 是它的适配器，不直接读）
  disabledCategories: ["checkActionAllowed"],
  disabledActions: ["checkActionAllowed"],
  // 六个开关 + 三个审批：checkPermission 一处读全
  allowUserCreate: ["checkPermission"],
  allowUserModify: ["checkPermission"],
  allowUserDelete: ["checkPermission"],
  allowSharing: ["checkPermission"],
  allowExport: ["checkPermission"],
  allowImport: ["checkPermission"],
  requireApprovalForCreate: ["checkPermission"],
  requireApprovalForModify: ["checkPermission"],
  requireApprovalForSharing: ["checkPermission"],
};

// ============================================================================
// 提取器
// ============================================================================

/** `interface MDMRestrictions { … }` 的成员名（含可选属性的 `?` 已由 ts 去掉）。 */
export function typeMembers(ts, source, typeName) {
  const sf = ts.createSourceFile("mdm.ts", source, ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      for (const m of node.members) {
        if (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) out.push(m.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** `const DEFAULT_RESTRICTIONS: MDMRestrictions = { … }` 的键集。 */
export function defaultsKeys(ts, source, declName) {
  const sf = ts.createSourceFile("mdm.ts", source, ts.ScriptTarget.Latest, true);
  let keys = null;
  const visit = (node) => {
    if (
      keys === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declName &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      keys = node.initializer.properties
        .filter((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name)
        .map((p) => p.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys ?? [];
}

/**
 * 限制字段的读站点：字段 → 读过它的方法名集合（排序）。
 *
 * 别名解析：方法体里任何 `X.restrictions` 的形状（`this.config.restrictions`、
 * `this.config?.restrictions`）赋给一个标识符后，该标识符上的属性访问也算读取
 * —— `checkPermission()` 正是这么写的（`const restrictions = this.config.restrictions`），
 * 不认别名会把它读的九个字段全漏掉。
 */
export function readers(ts, source, { classNames, fields } = {}) {
  const wanted = fields ? new Set(fields) : null;
  const sf = ts.createSourceFile("mdm.ts", source, ts.ScriptTarget.Latest, true);
  const found = new Map();

  /** 这个表达式是不是 `…restrictions`（含 `?.` 形态）。 */
  const isRestrictionsAccess = (expr) =>
    ts.isPropertyAccessExpression(expr) && expr.name.text === "restrictions";

  const walkMethod = (member) => {
    const methodName = member.name && ts.isIdentifier(member.name) ? member.name.text : null;
    if (methodName === null || !member.body) return;
    const aliases = new Set(["this.config.restrictions"]); // 直接形态由下面的后缀判断覆盖
    const hits = new Set();

    const visit = (node) => {
      // `const restrictions = this.config.restrictions;`
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        // `this.config.restrictions` 与 `this.config?.restrictions` 在 AST 里都是
        // PropertyAccessExpression（`?.` 只体现在 `questionDotToken` 上）
        if (ts.isPropertyAccessExpression(node.initializer) && isRestrictionsAccess(node.initializer)) {
          aliases.add(node.name.text);
        }
      }
      if (ts.isPropertyAccessExpression(node) && node.name && ts.isIdentifier(node.name)) {
        const field = node.name.text;
        if (wanted ? wanted.has(field) : READERS[field] !== undefined) {
          const target = node.expression;
          const byAlias = ts.isIdentifier(target) && aliases.has(target.text);
          const direct =
            ts.isPropertyAccessExpression(target) && isRestrictionsAccess(target);
          // `restrictions?.field`：可选链会让 target 仍是 `restrictions` 的 PropertyAccess
          const byOptional = ts.isPropertyAccessChain(target) && isRestrictionsAccess(target);
          if (byAlias || direct || byOptional) hits.add(field);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(member.body);
    for (const field of hits) {
      if (!found.has(field)) found.set(field, new Set());
      found.get(field).add(methodName);
    }
  };

  const visitTop = (node) => {
    if (ts.isClassDeclaration(node)) {
      const cls = node.name ? node.name.text : "";
      if (!classNames || classNames.has(cls)) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
            walkMethod(member);
          }
        }
      }
    }
    ts.forEachChild(node, visitTop);
  };
  visitTop(sf);

  const out = {};
  for (const [field, set] of found) out[field] = [...set].sort();
  return out;
}

/**
 * 「第二份默认表」：属性名是数值型限制字段、值是**数值字面量**的属性赋值，
 * 且不在 `DEFAULT_RESTRICTIONS` 的初始化器里。
 */
export function strayNumericDefaults(ts, source, declName, numericFields) {
  const sf = ts.createSourceFile("mdm.ts", source, ts.ScriptTarget.Latest, true);
  const inside = new Set(); // 默认表初始化器里的节点
  let defaultsNode = null;
  const findDefaults = (node) => {
    if (
      defaultsNode === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declName
    ) {
      defaultsNode = node.initializer ?? null;
    }
    ts.forEachChild(node, findDefaults);
  };
  findDefaults(sf);
  if (defaultsNode) {
    const mark = (node) => {
      inside.add(node);
      ts.forEachChild(node, mark);
    };
    mark(defaultsNode);
  }

  const strays = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name && ts.isIdentifier(node.name)) {
      const field = node.name.text;
      if (numericFields.includes(field) && ts.isNumericLiteral(node.initializer) && !inside.has(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        strays.push({ field, value: Number(node.initializer.text), line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return strays;
}

// ============================================================================
// 判据
// ============================================================================

/** 双向差集。返回 `{ missing, extra }` —— 两个方向都要报，只报一个方向是半个闸门。 */
export function setDiff(expected, actual) {
  const a = new Set(expected);
  const b = new Set(actual);
  return {
    missing: [...a].filter((x) => !b.has(x)).sort(),
    extra: [...b].filter((x) => !a.has(x)).sort(),
  };
}

/**
 * 判据本体。**闸门与自检走同一条路** —— 自检若另写一遍判定，它钉住的就是那个副本。
 *
 * 三个检查各自双向：只查「A 里的都在 B 里」会让 B 里多出来的东西永远合法，
 * 而这一族缺陷恰恰是「多出来一份」（多一份默认表、多一个读取点）。
 */
export function judge({ members, keys, read, strays, readersDecl = READERS, defaultsName = DEFAULTS_NAME }) {
  const problems = [];

  // ① 默认表 ≡ 类型（双向）
  const d1 = setDiff(members, keys);
  if (d1.missing.length)
    problems.push(`默认表缺字段（类型里有、${defaultsName} 里没有）：${d1.missing.join(", ")}`);
  if (d1.extra.length)
    problems.push(`${defaultsName} 有多余字段（类型里没有）：${d1.extra.join(", ")}`);

  // ② 读站点表 ≡ 声明表（双向）
  const declared = Object.keys(readersDecl);
  const d2 = setDiff(declared, Object.keys(read));
  if (d2.missing.length) problems.push(`声明了读者但一个都没量到：${d2.missing.join(", ")}`);
  if (d2.extra.length) problems.push(`量到未声明的限制字段（新字段？）：${d2.extra.join(", ")}`);
  for (const field of declared) {
    const expected = readersDecl[field];
    const got = read[field] ?? [];
    const d = setDiff(expected, got);
    if (d.missing.length)
      problems.push(`${field}：读者消失（声明 ${expected.join("/")}，实际缺 ${d.missing.join("/")}）`);
    if (d.extra.length)
      problems.push(
        `${field}：出现新的读取点（${d.extra.join("/")}）—— 一条限制只应有一处实现；` +
          `要么并入既有读者，要么把声明表一起改掉并说明理由`,
      );
  }

  // ③ 数值默认只能写在默认表里
  for (const s of strays) {
    problems.push(
      `第 ${s.line} 行：${s.field}: ${s.value} —— 限制的数值只能写在 ${defaultsName} 里` +
        `（第二份默认表已经造成过「恢复默认值恢复的不是默认值」）`,
    );
  }

  return problems;
}

export function census(ts, source) {
  const members = typeMembers(ts, source, TYPE_NAME);
  const keys = defaultsKeys(ts, source, DEFAULTS_NAME);
  const read = readers(ts, source, { classNames: new Set(["MDMManager"]) });
  const strays = strayNumericDefaults(ts, source, DEFAULTS_NAME, NUMERIC_FIELDS);

  return { members, keys, read, strays, problems: judge({ members, keys, read, strays }) };
}

// ============================================================================
// 自检（钉住提取器与判据本身）
// ============================================================================

/**
 * 自检夹具。每个夹具是一段**自带类型 `R`、默认表 `D`、类 `M`** 的最小源码，外加它对
 * 三个检查的**期望问题数**与**期望问题里必须出现的字样**。
 *
 * `expect: 0` 的夹具是**反向控制** —— 一个只会喊红的检查过不了它们（前两版就在这里
 * 露了馅：字段集写死成真实限制字段，夹具的 `a`/`b` 一个都没数到，于是「干净的一份」
 * 与「第二份实现」都得到 0 个问题，看着全绿其实什么也没测）。
 */
const FIXTURES = [
  {
    name: "干净的一份：类型、默认表、唯一读者三者一致",
    src: `
export interface R { a: number; b: boolean; c: string[]; }
export const D: R = { a: 1, b: true, c: [] };
class M {
  policyA() { return this.config.restrictions.a; }
  readB() { const r = this.config.restrictions; return r.b; }
  readC() { return this.config.restrictions?.c.length; }
}`,
    readers: { a: ["policyA"], b: ["readB"], c: ["readC"] },
    expect: 0,
  },
  {
    name: "① 默认表少一项 ⇒ 红",
    src: `
export interface R { a: number; b: boolean; }
export const D: R = { a: 1 };
class M { policyA() { return this.config.restrictions.a; } }`,
    readers: { a: ["policyA"] },
    expect: 1,
    has: "默认表缺字段",
  },
  {
    name: "① 默认表多一项（写错名字）⇒ 红",
    src: `
export interface R { a: number; }
export const D: R = { a: 1, aa: 2 };
class M { policyA() { return this.config.restrictions.a; } }`,
    readers: { a: ["policyA"] },
    expect: 1,
    has: "多余字段",
  },
  {
    name: "② 内联第二份实现（多出一个读取点）⇒ 红",
    src: `
export interface R { a: number; }
export const D: R = { a: 1 };
class M {
  policyA() { return this.config.restrictions.a; }
  checkX() { return this.config.restrictions.a > 0; }
}`,
    readers: { a: ["policyA"] },
    expect: 1,
    has: "出现新的读取点",
  },
  {
    name: "② 反向控制：读者全都在声明里 ⇒ 绿（只会喊红的检查过不了这条）",
    src: `
export interface R { a: number; }
export const D: R = { a: 1 };
class M {
  policyA() { return this.config.restrictions.a; }
  checkX() { return this.config.restrictions.a > 0; }
}`,
    readers: { a: ["checkX", "policyA"] },
    expect: 0,
  },
  {
    name: "② 别名读法必须被认出来（认不出就会漏报）",
    src: `
export interface R { a: number; }
export const D: R = { a: 1 };
class M { useAlias() { const r = this.config.restrictions; return r.a > 0; } }`,
    readers: { a: ["useAlias"] },
    expect: 0,
  },
  {
    name: "② 可选链读法（`restrictions?.a`）必须被认出来",
    src: `
export interface R { a: number; }
export const D: R = { a: 1 };
class M { opt() { return this.config.restrictions?.a; } }`,
    readers: { a: ["opt"] },
    expect: 0,
  },
  {
    name: "③ 第二条默认表（`a: 50` 写在别的方法里）⇒ 红",
    src: `
export interface R { a: number; }
export const D: R = { a: 100 };
class M {
  reset() { const d = { a: 50 }; return d; }
  policyA() { return this.config.restrictions.a; }
}`,
    readers: { a: ["policyA"] },
    numericFields: ["a"],
    expect: 1,
    has: "第二份默认表",
  },
  {
    name: "③ 反向控制：数值只写在默认表里 ⇒ 绿",
    src: `
export interface R { a: number; b: number; }
export const D: R = { a: 100, b: 300 };
class M { policyA() { return this.config.restrictions.a; } }`,
    readers: { a: ["policyA"] },
    numericFields: ["a", "b"],
    expect: 0,
  },
  {
    name: "③ 只认数值字面量：`a: someConst` 不是「第二份默认表」",
    src: `
export interface R { a: number; }
const OTHER = 50;
export const D: R = { a: 100 };
class M { reset() { const d = { a: OTHER }; return d; } policyA() { return this.config.restrictions.a; } }`,
    readers: { a: ["policyA"] },
    numericFields: ["a"],
    expect: 0,
  },
  {
    name: "别的类里的读取点不算（只认 MDMManager，避免跨类同名误报）",
    src: `
export interface R { a: number; }
export const D: R = { a: 1 };
class Other { m() { return this.config.restrictions.a; } }
class MDMManager { policyA() { return this.config.restrictions.a; } }`,
    readers: { a: ["policyA"] },
    classes: ["MDMManager"],
    expect: 0,
  },
];

function selftest(ts) {
  let failed = 0;
  for (const fixture of FIXTURES) {
    const members = typeMembers(ts, fixture.src, "R");
    const keys = defaultsKeys(ts, fixture.src, "D");
    const fieldsFor = fixture.readers ?? {};
    const read = readers(ts, fixture.src, {
      classNames: new Set(fixture.classes ?? ["M", "MDMManager"]),
      fields: Object.keys(fieldsFor),
    });
    const strays = strayNumericDefaults(ts, fixture.src, "D", fixture.numericFields ?? []);

    // 与闸门**同一条**判定（`judge`），不是另写一遍
    const problems = judge({
      members,
      keys,
      read,
      strays,
      readersDecl: fieldsFor,
      defaultsName: "D",
    });

    const enough = fixture.expect === 0 ? problems.length === 0 : problems.length >= fixture.expect;
    const matches = fixture.has ? problems.some((p) => p.includes(fixture.has)) : true;
    if (enough && matches) {
      console.log(`  ✓ ${fixture.name}`);
    } else {
      failed++;
      console.error(
        `  ✗ ${fixture.name}\n    期望 ${fixture.expect}${fixture.has ? `（含「${fixture.has}」）` : ""}，` +
          `实得 ${problems.length}：${JSON.stringify(problems)}`,
      );
    }
  }
  if (failed) {
    console.error(`selftest 失败：${failed}/${FIXTURES.length}`);
    process.exit(1);
  }
  console.log(`selftest 通过：${FIXTURES.length}/${FIXTURES.length}`);
}

// ============================================================================
// main
// ============================================================================

function main() {
  let ts;
  try {
    ts = require("typescript");
  } catch {
    console.error("mdm-restriction-scan: 需要 typescript（不降级 —— 看不见任何东西的闸门等于没有闸门）");
    process.exit(2);
  }

  if (process.argv.includes("--selftest")) {
    selftest(ts);
    return;
  }

  const source = readFileSync(MDM_TS, "utf8");
  const result = census(ts, source);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.problems.length ? 1 : 0);
  }

  console.log(`mdm-restriction-scan: ${MDM_TS.replace(ROOT + "/", "")}`);
  console.log(`  类型字段 ${result.members.length} 个 / 默认表 ${result.keys.length} 项 / 有读者的字段 ${Object.keys(result.read).length} 个`);
  if (result.problems.length === 0) {
    console.log("  ✓ 每一条限制只有一份定义（默认表 ≡ 类型；每个字段的读者集合 = 声明表；数值默认只在默认表里）");
    return;
  }
  console.error(`  ✗ ${result.problems.length} 处：`);
  for (const p of result.problems) console.error(`    - ${p}`);
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("mdm-restriction-scan.mjs")) {
  main();
}
